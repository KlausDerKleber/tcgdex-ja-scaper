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
import { ENERGY_CODES, clean, fetchCached, stripTags } from './lib'

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

/** limitless set list page → collection number → Japanese card name */
function parseLimitlessNames(html: string, setId: string): Map<number, string> {
	const out = new Map<number, string>()
	for (const row of html.matchAll(new RegExp(`<tr[^>]*data-hover="[^"]*/tpc/${setId}/[^"]*"[^>]*>([\\s\\S]*?)</tr>`, 'g'))) {
		const links = [...row[1].matchAll(new RegExp(`<a href="/cards/jp/${setId}/(\\d+)">([^<]+)</a>`, 'g'))]
		if (!links.length) continue
		const name = links.map((m) => clean(m[2])).sort((a, b) => b.length - a.length)[0]
		out.set(parseInt(links[0][1], 10), name)
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

// the official pages write set names with ideographic/extra spaces (TAG TEAM GX タッグ…
// vs the tooltip's TAG TEAM GXタッグ…) — compare NFKC-normalized and space-free
const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')
const hasSetName = (s: string) => squash(s).includes(squash(nameJa))

let pg: number | null = null
let officialCardCount: number | null = null
let detailsPage: string | null = null
// cardNameViewText comes back HTML-encoded (フェローチェ&amp;マッシブーンGX) — clean() decodes
for (const hit of search.cardList.filter((c) => clean(c.cardNameViewText) === name001)) {
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
		return squash((bracket ? bracket[1] : label).replace(/\([^)]*\)$/, '')) === squash(nameJa)
	})
if (pgEntries.length === 1) {
	pg = parseInt(pgEntries[0][1], 10)
} else if (pgEntries.length > 1) {
	throw new Error(`several official products match 「${nameJa}」: ${pgEntries.map((m) => `${m[1]} (${m[2]})`).join('; ')}`)
} else {
	// older sets link their product page (…/products/xy/cp1.html) or their expansion
	// mini-site (/ex/sm12a) from the card details page — both carry the card list link
	const product = detailsPage.match(/href="(\/products\/[^"]+\.html)"/) ?? detailsPage.match(/href="(\/ex\/[a-z0-9-]+)\/?"/)
	if (!product) throw new Error(`could not derive the official pg id for 「${nameJa}」 — neither in the card-search product list nor via a product/ex page link`)
	const productHtml = await fetchCached(`https://www.pokemon-card.com${product[1]}`, `${CACHE}/official-product.html`)
	const pgs = [...new Set([...productHtml.matchAll(/[?&]pg=(\d+)/g)].map((m) => m[1]))]
	if (pgs.length !== 1) throw new Error(`${product[1]} links ${pgs.length} different pg ids (${pgs.join(', ')})`)
	pg = parseInt(pgs[0], 10)
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

// ---------- number assignment helpers ----------

let probeCount = 0
/** pokepricelab row of one specific product: search server-side for the product's
 * name — the returned rows carry number, cardmarket id and cardmarket rarity, so the
 * id pins the card. null when pokepricelab does not list the product. */
async function probeRow(setSlug: string, p: { idProduct: number, name: string }): Promise<PplRow | null> {
	const q = p.name.replace(/\s*\[.*$/, '').trim()
	const html = await fetchCached(
		`https://pokepricelab.com/catalog?q=${encodeURIComponent(q)}&set=${setSlug}`,
		`${BOOT}/probe-${p.idProduct}.html`
	)
	probeCount += 1
	return parsePplRows(html).find((r) => r.cardmarket === p.idProduct) ?? null
}

async function probeNumber(setSlug: string, p: { idProduct: number, name: string }): Promise<number | null> {
	return (await probeRow(setSlug, p))?.num ?? null
}

/** number per id-sorted product. Usually the sorted order IS the collection order, but
 * cardmarket occasionally creates products late (M2a: card 016 got the set's last id;
 * SM12a: the nine numbered basic energies) — anchors from the sample rows plus targeted
 * probes repair relocations; products pokepricelab does not list are assigned by
 * elimination (remaining ids ↔ remaining numbers, both ascending) and reported. */
async function assignNumbers(items: { idProduct: number, name: string }[], anchors: Map<number, number>, setSlug: string, jpNames: Map<number, string>): Promise<Map<number, number>> {
	const nums = new Array<number | null>(items.length).fill(null)
	const unprobeable = new Set<number>()
	items.forEach((p, i) => { const a = anchors.get(p.idProduct); if (a != null) nums[i] = a })
	const num = async (i: number): Promise<number | null> => {
		if (nums[i] != null || unprobeable.has(i)) return nums[i]
		const n = await probeNumber(setSlug, items[i])
		if (n == null) unprobeable.add(i)
		else nums[i] = n
		return n
	}
	// a probeable anchor near each end
	for (let i = 0; i < items.length && (await num(i)) == null; i++);
	for (let i = items.length - 1; i >= 0 && (await num(i)) == null; i--);
	const fill = async (lo: number, hi: number): Promise<void> => {
		if (nums[hi]! - nums[lo]! === hi - lo) {
			for (let i = lo + 1; i < hi; i++) {
				if (nums[i] != null && nums[i] !== nums[lo]! + (i - lo)) throw new Error(`anchor contradicts uniform range at position ${i + 1}`)
				nums[i] = nums[lo]! + (i - lo)
			}
			return
		}
		if (hi - lo <= 1) return // adjacent, numbers just skip here (relocated or absent numbers)
		const mid = (lo + hi) >> 1
		// probe the middle; when pokepricelab does not list it, try its neighbours
		for (let step = 0; mid - step > lo || mid + step < hi; step++) {
			if (mid - step > lo && (await num(mid - step)) != null) break
			if (step && mid + step < hi && (await num(mid + step)) != null) break
		}
		const inner = nums.map((n, i) => (n != null && i > lo && i < hi ? i : -1)).filter((i) => i >= 0)
		if (!inner.length) return // nothing probeable inside — the whole segment goes to elimination
		let prev = lo
		for (const i of [...inner, hi]) {
			await fill(prev, i)
			prev = i
		}
	}
	const known = nums.map((n, i) => (n != null ? i : -1)).filter((i) => i >= 0)
	for (let k = 0; k + 1 < known.length; k++) await fill(known[k], known[k + 1])
	// products pokepricelab cannot see: basic energies are matched via their Japanese
	// name on the limitless list; the rest by elimination only when it is unambiguous
	const assigned = new Set(nums.filter((n): n is number => n != null))
	if (assigned.size !== nums.filter((n) => n != null).length) throw new Error('number assignment has duplicates')
	let open = nums.map((n, i) => (n == null ? i : -1)).filter((i) => i >= 0)
	if (open.length) {
		for (const idx of [...open]) {
			const m = items[idx].name.match(/^(?:Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy$/)
			if (!m) continue
			const jp = Object.values(ENERGY_CODES).find((e) => e.type === m[1])!.jp
			const hits = [...jpNames].filter(([n, nm]) => nm === `基本${jp}エネルギー` && !assigned.has(n))
			if (hits.length === 1) {
				nums[idx] = hits[0][0]
				assigned.add(hits[0][0])
			}
		}
		open = nums.map((n, i) => (n == null ? i : -1)).filter((i) => i >= 0)
	}
	if (open.length) {
		const maxNum = Math.max(...assigned, items.length)
		const missing = Array.from({ length: maxNum }, (_, i) => i + 1).filter((n) => !assigned.has(n))
		if (open.length !== missing.length) {
			throw new Error(`cannot place ${open.length} unlisted products (${open.map((i) => `${items[i].idProduct} ${items[i].name.slice(0, 30)}`).join('; ')}) onto ${missing.length} free numbers (${missing.join(', ')}) — add them to cardmarketIds by hand`)
		}
		open.forEach((idx, k) => { nums[idx] = missing[k] })
		console.log(`note: ${open.length} products assigned by elimination (not listed on pokepricelab): ${open.map((idx, k) => `${missing[k]}→${items[idx].idProduct} (${items[idx].name.slice(0, 24)})`).join(', ')}`)
	}
	const out = new Map<number, number>()
	items.forEach((p, i) => out.set(p.idProduct, nums[i]!))
	return out
}

// deck products list the deck's basic energies as cardmarket products while limitless
// numbers only the real cards (they become letter-coded cards like MC G) — exclude them
// when that makes the counts meet; the sample verification backstops the decision
let numbered = expansion
const energies: Record<string, number> = {}
if (expansion.length !== llCount) {
	// cardmarket names them "Basic Grass Energy" (MC) or just "Grass Energy" (SM12a)
	const basicRe = /^(?:Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy$/
	const basics = expansion.filter((p) => basicRe.test(p.name))
	if (basics.length && expansion.length - basics.length >= llCount) {
		// a basic-energy product can still be a numbered card of the set (SM12a's secret
		// energies) — pokepricelab lists those with a number, so a probe tells them apart;
		// the rest are unnumbered letter cards when limitless lists them (/cards/jp/MC/G),
		// otherwise plain pack inserts outside the set
		const letterRows = new Set([...listHtml.matchAll(new RegExp(`<a href="/cards/jp/${set.id}/([A-Z])">`, 'g'))].map((m) => m[1]))
		const inserts = new Set<number>()
		for (const p of basics) {
			if ((await probeNumber(slug, p)) != null) continue
			inserts.add(p.idProduct)
			const type = p.name.match(basicRe)![1]
			const letter = Object.keys(ENERGY_CODES).find((l) => ENERGY_CODES[l].type === type)
			if (!letter) throw new Error(`unknown basic energy type "${type}" (${p.idProduct})`)
			if (letterRows.has(letter)) energies[letter] = p.idProduct
		}
		numbered = expansion.filter((p) => !inserts.has(p.idProduct))
		if (Object.keys(energies).length) {
			console.log(`note: ${Object.keys(energies).length} basic energies kept as letter cards (${Object.entries(energies).map(([l, id]) => `${l}=${id}`).join(', ')})`)
		}
		const dropped = inserts.size - Object.keys(energies).length
		if (dropped) console.log(`note: ${dropped} basic-energy products are pack inserts outside the set's numbering — dropped`)
	}
}

// cardmarket usually lists secret rares before limitless does — its expansion size is
// then the real total; any wrong assignment (or a wrong set match) trips on the samples
const cardmarketIds: Record<string, number> = {}
let totalCards = llCount
if (numbered.length >= llCount) {
	totalCards = numbered.length
	const ordered = samples.every((s) => numbered[s.num - 1]?.idProduct === s.cardmarket)
	if (ordered) {
		numbered.forEach((p, i) => { cardmarketIds[String(i + 1)] = p.idProduct })
	} else {
		// the plain id order disagrees with the samples — repair via probes
		const assigned = await assignNumbers(numbered, new Map(samples.map((s) => [s.cardmarket, s.num])), slug, parseLimitlessNames(listHtml, set.id))
		const sorted = [...assigned.values()].sort((a, b) => a - b)
		if (sorted[0] !== 1) throw new Error('repaired numbering does not start at 1')
		totalCards = Math.max(sorted[sorted.length - 1], llCount)
		const gaps = Array.from({ length: totalCards }, (_, i) => i + 1).filter((n) => !sorted.includes(n))
		if (gaps.length) console.log(`note: no cardmarket product for card(s) ${gaps.join(', ')} — their thirdParty stays empty`)
		for (const [id, n] of assigned) cardmarketIds[String(n)] = id
	}
	console.log(`cardmarket ids: ${numbered.length} (expansion ${sampleProduct.idExpansion}, verified against ${samples.length} pokepricelab samples${probeCount ? `, order repaired with ${probeCount} probes` : ''})`)
	if (totalCards > llCount) {
		console.log(`note: cards ${llCount + 1}–${totalCards} are not on limitless yet — add them to "secrets" in the config (see M5.config.json)`)
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

// ---------- rarities cardmarket knows but limitless does not list ----------

// cardmarket rarity label → data-asia rarity name; null = the card carries no rarity
const CM_RARITY: Record<string, string | null> = {
	'Fixed': null,
	'Common': 'Common',
	'Uncommon': 'Uncommon',
	'Rare': 'Rare',
	'Holo Rare': 'Rare Holo',
	'Double Rare': 'Double rare',
	'Ultra Rare': 'Ultra Rare',
	'Illustration Rare': 'Illustration rare',
	'Special Illustration Rare': 'Special illustration rare',
	// cardmarket's top tier is the era's gold cards — M era calls those Mega Hyper Rare
	'Secret Rare': serie === 'M' ? 'Mega Hyper Rare' : 'Secret Rare',
	'Rainbow Rare': 'Hyper rare',
}
const cmRarity = (label: string | null): string | null => {
	if (label == null) return null
	const l = label.trim()
	if (!(l in CM_RARITY)) throw new Error(`unknown cardmarket rarity "${l}" — extend CM_RARITY`)
	return CM_RARITY[l]
}

const rarityOverrides: Record<string, string> = {}
const rarityless = [...set.list.values()].every((r) => r === '')
if (!rarityless) {
	for (const [n, label] of [...set.list.entries()].sort((a, b) => a[0] - b[0])) {
		if (label !== '') continue
		const id = cardmarketIds[String(n)]
		const p = id != null ? numbered.find((x) => x.idProduct === id) : undefined
		if (!p) continue
		const r = cmRarity((await probeRow(slug, p))?.rarity ?? null)
		if (r) rarityOverrides[String(n)] = r
	}
	if (Object.keys(rarityOverrides).length) {
		console.log(`rarity overrides from cardmarket: ${Object.keys(rarityOverrides).length} cards limitless lists without a rarity`)
	}
}

// ---------- secret rares beyond the limitless list (auto-derived) ----------

// the secrets are reprints — the cardmarket product name matches the main-set card;
// secret basic energies (SM12a 202–210) stand on their own
const secrets: Record<string, { base?: number, energy?: string, from?: { set: string, number: number }, rarity: string }> = {}
if (totalCards > llCount) {
	const nameOf = new Map(numbered.map((p) => [p.idProduct, p.name]))
	const mainByName = new Map<string, number[]>()
	for (let n = 1; n <= officialCardCount; n++) {
		const nm = nameOf.get(cardmarketIds[String(n)])
		if (nm != null) mainByName.set(nm, [...(mainByName.get(nm) ?? []), n])
	}
	// era-wide alt arts have no print in the set at all (SM12a): the official database
	// carries their Japanese name, which finds the original print via the limitless search
	const officialNames = new Map<number, string>()
	const findImport = async (n: number): Promise<{ set: string, number: number } | null> => {
		if (!officialNames.size) {
			let page = 1
			let maxPage = 1
			const allIds: string[] = []
			do {
				const raw = await fetchCached(
					`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=&pg=${pg}&regulation_sidebar_form=all&sm_and_keyword=true&page=${page}`,
					`${CACHE}/official-api-${page}.json`
				)
				const d = JSON.parse(raw) as { maxPage: number, cardList: { cardID: string }[] }
				maxPage = d.maxPage
				allIds.push(...d.cardList.map((c) => c.cardID))
				page += 1
			} while (page <= maxPage)
			for (const cid of [...new Set(allIds)]) {
				const pageHtml = await fetchCached(
					`https://www.pokemon-card.com/card-search/details.php/card/${cid}/regu/all`,
					`${CACHE}/official-${cid}.html`
				)
				const col = pageHtml.match(/&nbsp;(\d{3})&nbsp;\/&nbsp;(\d{3})&nbsp;/)
				const nm = pageHtml.match(/<h1 class="Heading1[^"]*">([^<]+)<\/h1>/)
				if (col && nm) officialNames.set(parseInt(col[1], 10), clean(nm[1]))
			}
		}
		const nameJp = officialNames.get(n)
		if (!nameJp) return null
		const html = await fetchCached(
			`https://limitlesstcg.com/cards/jp?q=${encodeURIComponent(nameJp)}`,
			`${BOOT}/ll-search-${n}.html`
		)
		const prints = [...new Set([...html.matchAll(/\/cards\/jp\/([A-Za-z0-9-]+)\/(\d+)/g)]
			.map((m) => `${m[1]}/${m[2]}`))]
			.map((s) => ({ set: s.split('/')[0], number: parseInt(s.split('/')[1], 10) }))
			.filter((x) => x.set !== set.id)
			.sort((a, b) => a.set.localeCompare(b.set) || a.number - b.number)
		return prints[0] ?? null
	}

	const unresolved: number[] = []
	const byProductName = new Map<string, string>() // resolved secrets by name (HR/UR share the SR's origin)
	for (let n = llCount + 1; n <= totalCards; n++) {
		const id = cardmarketIds[String(n)]
		const p = id != null ? numbered.find((x) => x.idProduct === id) : undefined
		if (!p) { unresolved.push(n); continue }
		const rarity = cmRarity((await probeRow(slug, p))?.rarity ?? null)
		const basic = p.name.match(/^(?:Basic )?(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy$/)
		const bases = mainByName.get(p.name) ?? []
		if (rarity && basic) {
			secrets[String(n)] = { energy: Object.keys(ENERGY_CODES).find((l) => ENERGY_CODES[l].type === basic[1])!, rarity }
		} else if (rarity && bases.length === 1) {
			secrets[String(n)] = { base: bases[0], rarity }
			byProductName.set(p.name, String(n))
		} else if (rarity) {
			const twin = byProductName.get(p.name)
			const from = twin != null ? secrets[twin].from ?? null : await findImport(n)
			if (from) {
				secrets[String(n)] = { from, rarity }
				byProductName.set(p.name, String(n))
			} else {
				unresolved.push(n)
			}
		} else {
			unresolved.push(n)
		}
	}
	if (Object.keys(secrets).length) console.log(`secrets auto-derived: ${Object.keys(secrets).length} (${Object.values(secrets).filter((s) => s.from).length} imported from other sets)`)
	if (unresolved.length) {
		console.log(`WARNING: ${unresolved.length} secret cards need hand-curation in "secrets" (no unique reprint match): ${unresolved.join(', ')}`)
	}
}

// ---------- reverse variants („…-additionals" listings on pokepricelab) ----------

// mirror-pattern reprints of the regular cards live in a separate "<slug>-additionals"
// pokepricelab set backed by its own cardmarket expansion; each card has two adjacent
// products there — energy pattern first, ball pattern second (cf. the English prints,
// verified via M2a Togepi 861628/861629)
const reverses: Record<string, { name: string, ids: [number, number] }> = {}
const addSlug = `${slug}-additionals`
let addHtml: string | null = null
try {
	const addBoot = `${import.meta.dir}/out/.bootstrap/${addSlug}`
	mkdirSync(addBoot, { recursive: true })
	addHtml = await fetchCached(`https://pokepricelab.com/catalog?set=${addSlug}`, `${addBoot}/ppl-catalog.html`)
} catch {
	console.log('no additionals listing')
}
if (addHtml) {
	const addSamples = parsePplRows(addHtml)
	if (addSamples.length && addSamples.some((s) => s.languages.includes('JA')) && !addSamples.some((s) => s.languages.includes('EN'))) {
		const anchor = catalog.products.find((p) => p.idProduct === addSamples[0].cardmarket)
		if (!anchor) throw new Error(`cardmarket catalog has no product ${addSamples[0].cardmarket} — delete ${CM_CACHE} to refresh`)
		const addExp = catalog.products.filter((p) => p.idExpansion === anchor.idExpansion).sort((a, b) => a.idProduct - b.idProduct)
		if (addExp.length % 2) throw new Error(`additionals expansion ${anchor.idExpansion} has an odd product count (${addExp.length})`)
		const idToNum = new Map(Object.entries(cardmarketIds).map(([n, id]) => [id, parseInt(n, 10)]))
		const byName = new Map<string, number[]>()
		for (const p of numbered) {
			const n = idToNum.get(p.idProduct)
			if (n != null) byName.set(p.name, [...(byName.get(p.name) ?? []), n])
		}
		let prev = 0
		for (let i = 0; i < addExp.length; i += 2) {
			if (addExp[i].name !== addExp[i + 1].name) throw new Error(`additionals products ${addExp[i].idProduct}/${addExp[i + 1].idProduct} are not a name pair`)
			// the pair belongs to the main-set card of the same product name (regular range,
			// ascending along the pair sequence); ambiguity is settled by a probe
			const cand = (byName.get(addExp[i].name) ?? []).filter((n) => n <= officialCardCount! && n > prev)
			const n = cand.length === 1 ? cand[0] : await probeNumber(addSlug, addExp[i])
			if (n <= prev) throw new Error(`additionals pair ${addExp[i].idProduct}: number ${n} breaks the ascending order`)
			reverses[String(n)] = { name: addExp[i].name.replace(/\s*\[.*$/, '').trim(), ids: [addExp[i].idProduct, addExp[i + 1].idProduct] }
			prev = n
		}
		for (const s of addSamples) {
			const hit = Object.entries(reverses).find(([, r]) => r.ids.includes(s.cardmarket))
			if (!hit || parseInt(hit[0], 10) !== s.num) {
				throw new Error(`additionals sample ${s.num}→${s.cardmarket} contradicts the pair mapping`)
			}
		}
		console.log(`reverse variants: ${Object.keys(reverses).length} cards × 2 patterns (expansion ${anchor.idExpansion}, verified against ${addSamples.length} samples)`)
		console.log('note: set "enSet" in the config (e.g. "Mega Evolution/Ascended Heroes") so the ball foils come from the English prints')
	}
}

// ---------- write ----------

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
	...(Object.keys(rarityOverrides).length ? { rarityOverrides } : {}),
	...(Object.keys(secrets).length ? { secrets } : {}),
	cardmarketIds,
	...(Object.keys(energies).length ? { energies } : {}),
	...(Object.keys(reverses).length ? { reverses } : {}),
}
const path = `${import.meta.dir}/configs/${set.id}.config.json`
if (existsSync(path) && !force) {
	console.log(`\nconfig: configs/${set.id}.config.json (existing file kept — pass --force to overwrite)`)
} else {
	writeFileSync(path, JSON.stringify(config, null, '\t') + '\n')
	console.log(`\nconfig: configs/${set.id}.config.json`)
	console.log('note: manualDex is empty and staple secrets stay uncurated; generate.ts fails loudly if the set needs them')
}
