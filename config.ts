// Builds configs/<SET>.config.json from nothing but a pokepricelab.com catalog URL.
//
//   bun run config.ts "https://pokepricelab.com/catalog?q=&set=<slug>&language=all&condition=all&grade=all"
//
// Everything is derived from the same primary sources scrape.ts uses (all fetches
// cached, so scrape.ts reuses them):
//   - pokepricelab.com          set identification + ≤10 sample rows with cardmarket ids
//     (used to find and verify the set everywhere else)
//   - limitlesstcg.com          set id + Japanese set name + release date + total cards
//   - www.pokemon-card.com      official product id (pg), official card count,
//     the era's resistance value (printed on the card pages)
//   - downloads.s3.cardmarket.com  public product catalog → per-card cardmarket ids
//
// manualDex and secrets stay empty — generate.ts fails loudly when they are needed.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clean, fetchCached, stripTags } from './lib'

const input = process.argv[2]
const args = process.argv.slice(3)
const repoIdx = args.indexOf('--repo')
const repo = repoIdx !== -1 ? args[repoIdx + 1] : '../cards-database'
const setIdx = args.indexOf('--set')
const forcedSetId = setIdx !== -1 ? args[setIdx + 1] : null
const force = args.includes('--force')
if (!input) {
	console.error('usage: bun run config.ts <pokepricelab-catalog-url | set name> [--set <limitless-id>] [--repo <cards-database>] [--force]')
	process.exit(1)
}

// the set is given as a pokepricelab catalog URL or as a set name, which is resolved
// against the set list every pokepricelab catalog page renders server-side; candidates
// are tried in order and international prints (mirror sets like the English "Double
// Crisis" next to the Japanese CP1) are skipped via the listing languages
async function resolveSlugCandidates(): Promise<string[]> {
	if (input.startsWith('http')) {
		const s = new URL(input).searchParams.get('set')
		if (!s) throw new Error('the URL has no set= parameter')
		return [s]
	}
	const root = await fetchCached('https://pokepricelab.com/catalog', `${import.meta.dir}/out/.bootstrap/catalog-root.html`)
	const sets = [...root.matchAll(/\{\\"slug\\":\\"([a-z0-9-]+)\\",\\"name\\":\\"([^\\"]+)\\"\}/g)].map((m) => ({ slug: m[1], name: m[2] }))
	if (!sets.length) throw new Error('could not parse the pokepricelab set list')
	const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim()
	const q = norm(input)
	const ranked = [
		...sets.filter((s) => norm(s.name) === q || s.slug === input),
		...sets.filter((s) => norm(s.name).includes(q)),
		...sets
			.map((s) => ({ ...s, score: jaccard(tokens(s.name), tokens(input)) }))
			.filter((s) => s.score >= 0.5)
			.sort((a, b) => b.score - a.score),
	]
	const slugs = [...new Set(ranked.map((s) => s.slug))].slice(0, 5)
	if (!slugs.length) throw new Error(`no pokepricelab set matches "${input}" — pass the catalog URL instead`)
	return slugs
}

// tokens are singularized (decks → deck) so wording variants still overlap
const tokens = (s: string) => new Set(s.toLowerCase().normalize('NFKC').split(/[^a-z0-9]+/).filter(Boolean).map((t) => t.replace(/s$/, '')))
function jaccard(a: Set<string>, b: Set<string>): number {
	const inter = [...a].filter((t) => b.has(t)).length
	return inter / (a.size + b.size - inter)
}

// ---------- pokepricelab: pick the (Japanese) set and read the sample rows ----------

interface PplRow { num: number, cardmarket: number, rarity: string | null, languages: string[] }

function parsePplRows(html: string): PplRow[] {
	const rows: PplRow[] = []
	for (const m of html.matchAll(/\\"card_number\\":\\"(\d+)\\",\\"cardmarket_id\\":(\d+)/g)) {
		// rarity and listing languages belong to the same card object → nearest preceding keys
		const before = html.slice(Math.max(0, m.index! - 2000), m.index!)
		const r = [...before.matchAll(/\\"rarity\\":\\"([^\\"]+)\\"/g)].pop()
		const l = [...before.matchAll(/\\"languages\\":\[([^\]]*)\]/g)].pop()
		rows.push({
			num: parseInt(m[1], 10),
			cardmarket: parseInt(m[2], 10),
			rarity: r ? r[1] : null,
			languages: l ? [...l[1].matchAll(/\\"([A-Z-]+)\\"/g)].map((x) => x[1]) : [],
		})
	}
	return rows
}

let slug = ''
let BOOT = ''
let catalogHtml = ''
let samples: PplRow[] = []
for (const cand of await resolveSlugCandidates()) {
	const boot = `${import.meta.dir}/out/.bootstrap/${cand}`
	mkdirSync(boot, { recursive: true })
	const html = await fetchCached(`https://pokepricelab.com/catalog?set=${cand}`, `${boot}/ppl-catalog.html`)
	const rows = parsePplRows(html)
	if (!rows.length) continue
	// a Japanese set is listed in JA (and KO), never in EN — mirror prints are skipped
	if (!rows.some((s) => s.languages.includes('JA')) || rows.some((s) => s.languages.includes('EN'))) {
		console.log(`skipped pokepricelab set "${cand}" (international print)`)
		continue
	}
	slug = cand; BOOT = boot; catalogHtml = html; samples = rows
	break
}
if (!slug) throw new Error(`no matching Japanese pokepricelab set for "${input}" — pass the catalog URL of the Japanese listing`)

const pplName = catalogHtml.match(new RegExp(`\\\\"name\\\\":\\\\"([^\\\\"]+)\\\\",\\\\"slug\\\\":\\\\"${slug}\\\\"`))
console.log(`pokepricelab: set "${pplName ? pplName[1] : slug}", ${samples.length} sample cards`)

// ---------- cardmarket expansion (anchored by a sample product id) ----------

// Cardmarket publishes its full Pokémon singles catalog on S3 (idProduct, name,
// idExpansion — no collection numbers). The expansion's product count is exact, which
// also pins down the right limitless set below.
const CM_CACHE = `${import.meta.dir}/out/.cardmarket/products_singles_6.json`
const catalog = JSON.parse(await fetchCached(
	'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json',
	CM_CACHE
)) as { products: { idProduct: number, name: string, idExpansion: number }[] }
const sampleProduct = catalog.products.find((p) => p.idProduct === samples[0].cardmarket)
if (!sampleProduct) throw new Error(`cardmarket catalog has no product ${samples[0].cardmarket} — delete ${CM_CACHE} to refresh`)
const expansion = catalog.products
	.filter((p) => p.idExpansion === sampleProduct.idExpansion)
	.sort((a, b) => a.idProduct - b.idProduct)
console.log(`cardmarket: expansion ${sampleProduct.idExpansion}, ${expansion.length} products`)

// ---------- limitless: which set is this? ----------

interface LlSet { id: string, name: string, date: string }

function parseLimitlessSets(html: string): LlSet[] {
	const out: LlSet[] = []
	for (const m of html.matchAll(/<a href="\/cards\/jp\/([A-Za-z0-9-]+)">(?:<img[^>]*>)?\s*([^<]+?)\s*<span class="code annotation">[\s\S]*?<a href="\/cards\/jp\/\1">([0-9]{1,2} [A-Z][a-z]{2} [0-9]{2})<\/a>/g)) {
		out.push({ id: m[1], name: clean(m[2]), date: m[3] })
	}
	return out
}

/** limitless set list page → collection number → rarity label */
function parseLimitlessList(html: string, setId: string): Map<number, string> {
	const out = new Map<number, string>()
	for (const row of html.matchAll(new RegExp(`<tr[^>]*data-hover="[^"]*/tpc/${setId}/[^"]*"[^>]*>([\\s\\S]*?)</tr>`, 'g'))) {
		const link = row[1].match(new RegExp(`<a href="/cards/jp/${setId}/(\\d+)">`))
		const tds = [...row[1].matchAll(/<td class="md-only">\s*<a[^>]*>\s*([^<]*?)\s*</g)].map((m) => m[1])
		if (link) out.set(parseInt(link[1], 10), tds[tds.length - 1] ?? '')
	}
	return out
}

const setsHtml = await fetchCached('https://limitlesstcg.com/cards/jp', `${BOOT}/limitless-sets.html`)
const allSets = parseLimitlessSets(setsHtml)
if (!allSets.length) throw new Error('could not parse the limitless set index')
const pplTokens = tokens(pplName ? pplName[1] : slug.replace(/-/g, ' '))
const candidates = forcedSetId
	? allSets.filter((s) => s.id === forcedSetId).map((s) => ({ ...s, score: 1 }))
	: allSets
		.map((s) => ({ ...s, score: jaccard(tokens(s.name), pplTokens) }))
		.filter((s) => s.score >= 0.2)
		.sort((a, b) => b.score - a.score)
		.slice(0, 8)
if (!candidates.length) throw new Error(forcedSetId ? `limitless has no set "${forcedSetId}"` : `no limitless set matches "${[...pplTokens].join(' ')}"`)

// pick the candidate by hard data, the name similarity only breaks ties:
//  - a candidate listing more cards than the cardmarket expansion has products is impossible
//  - the C/U/R/RR rarity labels of the sample rows (shared vocabulary of cardmarket and
//    limitless) must not contradict; numbers beyond the candidate's list are unknowable
//    (limitless lags behind on secret rares) — the id assignment re-verifies every sample
//  - a candidate whose card count equals the expansion's product count wins outright
const BASE_RARITIES = new Set(['Common', 'Uncommon', 'Rare', 'Double Rare'])
const verified: (typeof candidates[0] & { list: Map<number, string> })[] = []
for (const c of candidates) {
	const listHtml = await fetchCached(`https://limitlesstcg.com/cards/jp/${c.id}?display=list`, `${BOOT}/limitless-list-${c.id}.html`)
	const list = parseLimitlessList(listHtml, c.id)
	if (!list.size || list.size > expansion.length) continue
	const contradiction = samples.some((s) => {
		const label = list.get(s.num)
		return label !== undefined && s.rarity != null
			&& BASE_RARITIES.has(s.rarity) && BASE_RARITIES.has(label) && s.rarity !== label
	})
	if (!contradiction) verified.push({ ...c, list })
}
const exact = verified.filter((c) => c.list.size === expansion.length)
const pool = exact.length ? exact : verified
if (!pool.length || (pool.length > 1 && pool[0].score === pool[1].score)) {
	throw new Error(`set is ambiguous or unknown — candidates: ${candidates.map((c) => `${c.id} (${c.name}, ${c.score.toFixed(2)}${verified.some((v) => v.id === c.id) ? ', plausible' : ''})`).join('; ')} — pass --set <limitless-id> to pick one`)
}
const set = pool[0]
console.log(`limitless: ${set.id} "${set.name}", released ${set.date}, ${set.list.size} cards listed`)

const CACHE = `${import.meta.dir}/out/${set.id}/cache`
mkdirSync(CACHE, { recursive: true })
const llCount = set.list.size

// ---------- Japanese set name (list page tooltip) + release date ----------

const listHtml = await fetchCached(`https://limitlesstcg.com/cards/jp/${set.id}?display=list`, `${CACHE}/limitless-list.html`)
const jpTooltip = [...listHtml.matchAll(/data-tooltip="([^"]*[぀-ヿ㐀-鿿][^"]*)"/g)].map((m) => clean(m[1]))[0]
if (!jpTooltip) throw new Error('no Japanese set name tooltip on the limitless list page')
const wrapped = jpTooltip.match(/「([^」]+)」/)
const nameJa = wrapped ? wrapped[1] : jpTooltip

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }
const dm = set.date.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2})$/)
if (!dm || !MONTHS[dm[2]]) throw new Error(`cannot parse release date "${set.date}"`)
const releaseDate = `${parseInt(dm[3], 10) >= 90 ? '19' : '20'}${dm[3]}-${MONTHS[dm[2]]}-${dm[1].padStart(2, '0')}`

// ---------- official database: pg id + official card count ----------

const firstNum = Math.min(...set.list.keys())
const cardHtml = await fetchCached(
	`https://limitlesstcg.com/cards/jp/${set.id}/${firstNum}`,
	`${CACHE}/limitless-${String(firstNum).padStart(3, '0')}.html`
)
const title = cardHtml.match(/<span class="card-text-name"><a[^>]*>([^<]+)<\/a><\/span>/)
if (!title) throw new Error(`no card name on limitless page ${set.id}/${firstNum}`)
const name001 = clean(title[1])
const regulationMarks = /([A-Z])\s*Regulation Mark/.test(cardHtml)

const search = JSON.parse(await fetchCached(
	`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=${encodeURIComponent(name001)}&regulation_sidebar_form=all&sm_and_keyword=true`,
	`${CACHE}/official-search-${String(firstNum).padStart(3, '0')}.json`
)) as { cardList: { cardID: string, cardNameViewText: string }[] }

// the official pages write the set name with an ideographic space — compare NFKC-normalized
const hasSetName = (s: string) => s.normalize('NFKC').includes(nameJa.normalize('NFKC'))

let pg: number | null = null
let officialCardCount: number | null = null
let detailsPage: string | null = null
for (const hit of search.cardList.filter((c) => c.cardNameViewText === name001)) {
	const page = await fetchCached(
		`https://www.pokemon-card.com/card-search/details.php/card/${hit.cardID}/regu/all`,
		`${CACHE}/official-${hit.cardID}.html`
	)
	const col = page.match(/&nbsp;(\d{3})&nbsp;\/&nbsp;(\d{3})&nbsp;/)
	if (!col || parseInt(col[1], 10) !== firstNum || !hasSetName(page)) continue
	officialCardCount = parseInt(col[2], 10)
	detailsPage = page
	break
}
if (officialCardCount == null || detailsPage == null) {
	throw new Error(`no official details page for "${name001}" with number ${firstNum} and the set name`)
}

// pg id, recent sets: the card-search page inlines the product list ({ name: "pg", value, label })
// — labels look like 拡張パック「アビスアイ」 or 強化拡張パック「ポケモンカード151（イチゴーイチ）」
// (the trailing parenthetical is a reading hint, not part of the set name)
const searchPage = await fetchCached('https://www.pokemon-card.com/card-search/', `${BOOT}/official-card-search.html`)
const pgEntries = [...searchPage.matchAll(/\{ name: "pg", value: "(\d+)"[^}]*label: "([^"]*)"/g)]
	.filter((m) => {
		const label = m[2].normalize('NFKC')
		const bracket = label.match(/「([^」]+)」/)
		// deck products carry no 「…」 around the name — then the whole label must match
		return (bracket ? bracket[1] : label).replace(/\([^)]*\)$/, '').trim() === nameJa.normalize('NFKC')
	})
if (pgEntries.length === 1) {
	pg = parseInt(pgEntries[0][1], 10)
} else if (pgEntries.length > 1) {
	throw new Error(`several official products match 「${nameJa}」: ${pgEntries.map((m) => `${m[1]} (${m[2]})`).join('; ')}`)
} else {
	// older sets: the card details page links its product page, which links the card list
	const product = detailsPage.match(/href="(\/products\/[^"]+\.html)"/)
	if (!product) throw new Error(`could not derive the official pg id for 「${nameJa}」 — neither in the card-search product list nor via a product page link`)
	const productHtml = await fetchCached(`https://www.pokemon-card.com${product[1]}`, `${CACHE}/official-product.html`)
	const pgm = productHtml.match(/card-search\/index\.php\?mode=statuslist&pg=(\d+)/)
	if (!pgm) throw new Error(`product page ${product[1]} has no card list link`)
	pg = parseInt(pgm[1], 10)
}

// sanity: the pg listing covers at least the printed main set; secret rares and (for
// deck products) energies/variants can push it above the printed count, but a grossly
// different size means the label matched the wrong product
const api = JSON.parse(await fetchCached(
	`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=&pg=${pg}&regulation_sidebar_form=all&sm_and_keyword=true&page=1`,
	`${CACHE}/official-api-1.json`
)) as { hitCnt: number, cardList: { cardID: string }[] }
if (api.hitCnt < officialCardCount || api.hitCnt > 2 * Math.max(officialCardCount, llCount)) {
	throw new Error(`pg=${pg} lists ${api.hitCnt} cards — implausible for ${officialCardCount} official / ${llCount} limitless cards`)
}
console.log(`official: pg=${pg}, ${officialCardCount} cards, regulation marks: ${regulationMarks}`)

// ---------- era resistance value (printed on the official card pages) ----------

let resistanceValue: string | null = null
for (const c of api.cardList) {
	const page = await fetchCached(
		`https://www.pokemon-card.com/card-search/details.php/card/${c.cardID}/regu/all`,
		`${CACHE}/official-${c.cardID}.html`
	)
	const m = page.match(/<th>抵抗力<\/th>[\s\S]*?<td><span class="icon-\w+ icon"><\/span>[－-](\d+)<\/td>/)
	if (m) { resistanceValue = `-${m[1]}`; break }
}
if (resistanceValue) console.log(`era resistance value: ${resistanceValue}`)

// ---------- cardmarket ids ----------

// Within one expansion the products sorted by idProduct follow the collection-number
// order; this assignment is verified against every pokepricelab sample row and the run
// aborts on any disagreement. (Reproduces the hand-curated CP1 and M5 configs exactly,
// and SV2a's full dex-ordered numbering.)

const numbers = [...set.list.keys()].sort((a, b) => a - b)
if (numbers[0] !== 1 || numbers[numbers.length - 1] !== llCount) {
	throw new Error(`limitless numbering is not contiguous 1..${llCount} — extend config.ts`)
}

// deck products list the deck's basic energies as cardmarket products while limitless
// numbers only the real cards (they become letter-coded cards like MC G) — exclude them
// when that makes the counts meet; the sample verification backstops the decision
let numbered = expansion
if (expansion.length !== llCount) {
	const basics = expansion.filter((p) => /^Basic .+ Energy$/.test(p.name))
	if (basics.length && expansion.length - basics.length >= llCount) {
		numbered = expansion.filter((p) => !/^Basic .+ Energy$/.test(p.name))
		console.log(`note: ${basics.length} basic-energy products excluded from the numbering (${basics.map((p) => p.idProduct).join(', ')})`)
	}
}

// cardmarket usually lists secret rares before limitless does — its expansion size is
// then the real total; any wrong assignment (or a wrong set match) trips on the samples
const cardmarketIds: Record<string, number> = {}
let totalCards = llCount
if (numbered.length >= llCount) {
	totalCards = numbered.length
	numbered.forEach((p, i) => { cardmarketIds[String(i + 1)] = p.idProduct })
	for (const s of samples) {
		if (cardmarketIds[String(s.num)] !== s.cardmarket) {
			throw new Error(`cardmarket id order broken at card ${s.num}: catalog order says ${cardmarketIds[String(s.num)]}, pokepricelab says ${s.cardmarket} — wrong set match or non-sequential expansion`)
		}
	}
	console.log(`cardmarket ids: ${numbered.length} (expansion ${sampleProduct.idExpansion}, verified against ${samples.length} pokepricelab samples)`)
	if (numbered.length > llCount) {
		console.log(`note: cards ${llCount + 1}–${numbered.length} are not on limitless yet — add them to "secrets" in the config (see M5.config.json)`)
	}
} else {
	console.log(`WARNING: cardmarket expansion ${sampleProduct.idExpansion} has only ${numbered.length} usable products for ${llCount} cards — cardmarketIds left empty; fill them by hand or delete ${CM_CACHE} to refresh`)
	for (const p of numbered) console.log(`  ${p.idProduct} ${p.name}`)
}

// ---------- serie (existing set stub in the repo, else longest matching serie dir) ----------

let serie: string | null = null
const dataAsia = join(repo, 'data-asia')
if (existsSync(dataAsia)) {
	for (const dir of readdirSync(dataAsia, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
		if (existsSync(join(dataAsia, dir, `${set.id}.ts`))) { serie = dir; break }
	}
	if (!serie) {
		serie = readdirSync(dataAsia, { withFileTypes: true })
			.filter((e) => e.isDirectory() && set.id.startsWith(e.name))
			.map((e) => e.name)
			.sort((a, b) => b.length - a.length)[0] ?? null
	}
}
if (!serie) throw new Error(`cannot derive the data-asia serie for ${set.id} — pass --repo or add "serie" to the config by hand`)

// ---------- write ----------

// deck products carry no rarities at all (every list label is empty)
const rarityless = [...set.list.values()].every((r) => r === '')

const config: Record<string, unknown> = {
	setId: set.id,
	nameJa,
	nameEn: set.name,
	releaseDate,
	serie,
	...(regulationMarks ? {} : { regulationMarks: false }),
	...(rarityless ? { rarities: false } : {}),
	...(resistanceValue && resistanceValue !== '-30' ? { resistanceValue } : {}),
	officialProductId: pg,
	officialCardCount,
	totalCards,
	manualDex: {},
	cardmarketIds,
}
const path = `${import.meta.dir}/configs/${set.id}.config.json`
if (existsSync(path) && !force) {
	console.log(`\nconfig: configs/${set.id}.config.json (existing file kept — pass --force to overwrite)`)
} else {
	writeFileSync(path, JSON.stringify(config, null, '\t') + '\n')
	console.log(`\nconfig: configs/${set.id}.config.json`)
	console.log('note: manualDex/secrets are empty; generate.ts will fail loudly if the set needs them')
}
