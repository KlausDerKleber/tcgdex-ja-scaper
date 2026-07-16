// Scrapes one Japanese Pokémon TCG set from its primary sources into out/<SET>/.
//
//   bun run scrape.ts M5
//
// Sources:
//   - www.pokemon-card.com  (official database: names, full Japanese card text,
//     flavor text, national dex numbers, illustrators, collection numbers)
//   - limitlesstcg.com      (stages, evolves-from, weakness/resistance/retreat,
//     rarities, regulation mark)
//   - serebii.net           (illustrators of secret rares, only when the set's
//     secrets are not yet listed by the two sources above)
//
// Every HTTP response is cached under out/<SET>/cache/ so the run is auditable.

import { mkdirSync, writeFileSync } from 'node:fs'
import { clean, fetchCached, loadConfig, stripTags, type RawCard, type SetConfig } from './lib'

const TYPE_LETTER: Record<string, string> = {
	G: 'Grass', R: 'Fire', W: 'Water', L: 'Lightning', P: 'Psychic',
	F: 'Fighting', D: 'Darkness', M: 'Metal', C: 'Colorless', Y: 'Fairy', N: 'Dragon',
}
const TYPE_WORDS = new Set(Object.values(TYPE_LETTER))

// limitlesstcg rarity label → rarity name used by data-asia/M (mapping derived from M3,
// which exists in both databases; cross-checked against Cardmarket's labels)
const RARITY_MAP: Record<string, string> = {
	'Common': 'Common',
	'Uncommon': 'Uncommon',
	'Rare': 'Rare',
	'Double Rare': 'Double rare',
	'Art Rare': 'Illustration rare',
	'Secret Rare': 'Ultra Rare',
	'Special Art Rare': 'Special illustration rare',
	'Ultra Rare': 'Mega Hyper Rare',
	'Character Rare': 'Character Rare',
	'Character Super Rare': 'Character Super Rare',
}

const setId = process.argv[2]
if (!setId) {
	console.error('usage: bun run scrape.ts <SET>')
	process.exit(1)
}
const config = loadConfig(setId)
const OUT = `${import.meta.dir}/out/${setId}`
const CACHE = `${OUT}/cache`
mkdirSync(OUT, { recursive: true })

// ---------- limitless: rarity per collection number (set list page) ----------

async function limitlessRarities(): Promise<Map<number, string>> {
	const html = await fetchCached(
		`https://limitlesstcg.com/cards/jp/${config.setId}?display=list`,
		`${CACHE}/limitless-list.html`
	)
	const out = new Map<number, string>()
	for (const row of html.matchAll(new RegExp(`<tr[^>]*data-hover="[^"]*/tpc/${config.setId}/[^"]*"[^>]*>([\\s\\S]*?)</tr>`, 'g'))) {
		const link = row[1].match(new RegExp(`<a href="/cards/jp/${config.setId}/(\\d+)">`))
		const tds = [...row[1].matchAll(/<td class="md-only">\s*<a[^>]*>\s*([^<]*?)\s*</g)].map((m) => m[1])
		if (link) out.set(parseInt(link[1], 10), tds[tds.length - 1] ?? '')
	}
	return out
}

// ---------- limitless: one card page ----------

async function limitlessCard(n: number, rarityLabel: string | undefined, fromSet?: string): Promise<RawCard> {
	const setId = fromSet ?? config.setId
	const html = await fetchCached(
		`https://limitlesstcg.com/cards/jp/${setId}/${n}`,
		fromSet ? `${CACHE}/limitless-${fromSet}-${n}.html` : `${CACHE}/limitless-${String(n).padStart(3, '0')}.html`
	)
	const card: RawCard = {
		num: n, name: '', category: 'Pokemon', types: [], hp: null, stageRaw: null,
		evolveFrom: null, trainerType: null, energyType: null, abilities: [], attacks: [],
		weakness: null, resistance: null, retreat: null, illustrator: '',
		regulationMark: null, rarity: RARITY_MAP[rarityLabel ?? ''] ?? null, flavor: null, dexId: null,
	}

	const title = html.match(/<span class="card-text-name"><a[^>]*>([^<]+)<\/a><\/span>([^<]*)/)
	if (!title) throw new Error(`card ${n}: no title on limitless page`)
	card.name = clean(title[1])
	const titleRest = clean(title[2]) // e.g. "- Grass - 50 HP"
	card.types = titleRest.split(/[\s\-]+/).filter((w) => TYPE_WORDS.has(w))
	const hp = titleRest.match(/(\d+)\s*HP/)
	card.hp = hp ? parseInt(hp[1], 10) : null

	const typeCell = html.match(/<p class="card-text-type">([\s\S]*?)<\/p>/)
	if (!typeCell) throw new Error(`card ${n}: no type line`)
	const typeLine = clean(typeCell[1].replace(/<[^>]+>/g, ' '))
	if (typeLine.startsWith('Pokémon')) {
		card.category = 'Pokemon'
		const st = typeLine.match(/Pokémon\s*-\s*([A-Za-z 12]+?)(?:\s*-|$)/)
		card.stageRaw = st ? st[1].trim() : null
		const ev = typeCell[1].match(/Evolves from\s*<a[^>]*>([^<]+)<\/a>/)
		card.evolveFrom = ev ? clean(ev[1]) : null
	} else if (typeLine.startsWith('Trainer')) {
		card.category = 'Trainer'
		card.trainerType = typeLine.split('-').pop()!.trim()
	} else if (typeLine.startsWith('Energy')) {
		card.category = 'Energy'
		card.energyType = typeLine.split('-').pop()!.trim()
	}

	for (const ab of html.matchAll(/<div class="card-text-ability">([\s\S]*?)<\/div>/g)) {
		const info = ab[1].match(/card-text-ability-info[^>]*>([\s\S]*?)<\/p>/)
		const eff = ab[1].match(/card-text-ability-effect[^>]*>([\s\S]*?)<\/p>/)
		if (!info) continue
		card.abilities.push({
			name: clean(stripTags(info[1])).replace(/^(Ability|特性)\s*[:：]\s*/, ''),
			effect: eff ? clean(stripTags(eff[1])) : '',
		})
	}

	// "card-text-attack trainer" marks an attack granted by a Tool (e.g. CP1 Aqua Diffuser)
	for (const at of html.matchAll(/<div class="card-text-attack[^"]*">([\s\S]*?)<\/div>/g)) {
		const info = at[1].match(/card-text-attack-info[^>]*>([\s\S]*?)<\/p>/)
		const eff = at[1].match(/card-text-attack-effect[^>]*>([\s\S]*?)<\/p>/)
		if (!info) continue
		const cost: string[] = []
		for (const sym of info[1].matchAll(/<span class="ptcg-symbol">([^<]*)<\/span>/g)) {
			for (const ch of sym[1].trim()) if (TYPE_LETTER[ch]) cost.push(TYPE_LETTER[ch])
		}
		let text = clean(stripTags(info[1].replace(/<span class="ptcg-symbol">[^<]*<\/span>/g, ' ')))
		let damage: string | null = null
		const dm = text.match(/^(.*?)\s+(\d+[+×x]?)$/)
		if (dm) {
			text = dm[1]
			damage = dm[2].replace('x', '×')
		}
		card.attacks.push({ name: text, cost, damage, effect: eff ? clean(stripTags(eff[1])) : '' })
	}

	if (card.category !== 'Pokemon') {
		// trainer/energy effect: the longest plain card-text-section (skip name and W/R/R rows;
		// embedded Tool attacks are their own data, and the bare Tool rule reminder is not card text —
		// Tool cards whose own text limitless omits get it from the official page instead)
		let best = ''
		for (const m of html.matchAll(/<div class="card-text-section">([\s\S]*?)<\/div>/g)) {
			if (m[1].includes('card-text-name') || m[1].includes('card-text-wrr')) continue
			const txt = clean(stripTags(m[1].replace(/<div class="card-text-attack[\s\S]*$/, '')))
			if (RULE_REMINDERS.has(txt)) continue
			if (txt.length > best.length) best = txt
		}
		;(card as RawCard & { effect?: string }).effect = best
	}

	const wrr = html.match(/card-text-wrr[^>]*>([\s\S]*?)<\/p>/)
	if (wrr) {
		const txt = wrr[1].replace(/<br\s*\/?>/g, '\n')
		const w = txt.match(/Weakness:\s*([A-Za-z]+)/)
		if (w && TYPE_WORDS.has(w[1])) card.weakness = w[1]
		const r = txt.match(/Resistance:\s*([A-Za-z]+)\s*(-\d+)?/)
		if (r && TYPE_WORDS.has(r[1])) card.resistance = { type: r[1], value: r[2] ?? config.resistanceValue ?? '-30' }
		const rt = txt.match(/Retreat:\s*(\d+)/)
		card.retreat = rt ? parseInt(rt[1], 10) : null
	}

	const art = html.match(/card-text-artist">[\s\S]*?<a[^>]*>\s*([^<]+?)\s*<\/a>/)
	card.illustrator = art ? clean(art[1]) : ''
	const reg = html.match(/([A-Z])\s*Regulation Mark/)
	card.regulationMark = reg ? reg[1] : null
	return card
}

// ---------- official database ----------

// rule reminders printed on every Pokémon Tool card page — not card-specific text
// (the Tool rule was reworded over the years; one entry per known era)
const RULE_REMINDERS = new Set([
	'ポケモンのどうぐは、自分のポケモンにつけて使う。ポケモン1匹につき1枚だけつけられ、つけたままにする。', // XY era
	'ポケモンのどうぐは、自分の番に何枚でも、自分のポケモンにつけられる。ポケモン1匹につき1枚だけつけられ、つけたままにする。', // M era
	'グッズは、自分の番に何枚でも使える。',
])

interface OfficialCard {
	num: number
	total: number
	name: string | null
	dexId: number | null
	flavor: string | null
	/** the pages link the illustrator (illust=…) — the source for secret-rare artists */
	illustrator: string | null
	/** Pokémon Tool text (only parsed from Tool card pages) */
	toolClause?: string
	/** attack granted by a Pokémon Tool (name + text; the cost only limitless lists) */
	toolAttack?: { name: string, effect: string }
}

async function officialCardIds(): Promise<string[]> {
	const ids: string[] = []
	let page = 1
	let maxPage = 1
	do {
		const raw = await fetchCached(
			`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=&pg=${config.officialProductId}&regulation_sidebar_form=all&sm_and_keyword=true&page=${page}`,
			`${CACHE}/official-api-${page}.json`
		)
		const d = JSON.parse(raw) as { maxPage: number, cardList: { cardID: string }[] }
		maxPage = d.maxPage
		ids.push(...d.cardList.map((c) => c.cardID))
		page += 1
	} while (page <= maxPage)
	return [...new Set(ids)]
}

async function officialCard(cardId: string): Promise<OfficialCard | null> {
	const raw = await fetchCached(
		`https://www.pokemon-card.com/card-search/details.php/card/${cardId}/regu/all`,
		`${CACHE}/official-${cardId}.html`
	)
	const col = raw.match(/&nbsp;(\d{3})&nbsp;\/&nbsp;(\d{3})&nbsp;/)
	if (!col) return null
	const name = raw.match(/<h1 class="Heading1[^"]*">([^<]+)<\/h1>/)
	const dex = raw.match(/<h4>No\.(\d+)/)
	const flavor = raw.match(/<hr\s*\/>\s*<p>([\s\S]*?)<\/p>/)
	const illust = raw.match(/[?&]illust=([^"&]+)"/)
	const card: OfficialCard = {
		num: parseInt(col[1], 10),
		total: parseInt(col[2], 10),
		name: name ? clean(name[1]) : null,
		dexId: dex ? parseInt(dex[1], 10) : null,
		flavor: flavor ? clean(stripTags(flavor[1])) : null,
		illustrator: illust ? clean(illust[1]) : null,
	}
	// Tool/Item text lives under a heading that varies by era (ポケモンのどうぐ, or グッズ
	// on SM-era pages); it fills in when limitless lacks the card's own text
	const tool = raw.match(/<h2[^>]*>(?:ポケモンのどうぐ|グッズ)<\/h2>([\s\S]*?)(?:<h2|<\/div)/)
	if (tool) {
		const ps = [...tool[1].matchAll(/<p>([\s\S]*?)<\/p>/g)]
			.map((m) => clean(stripTags(m[1])))
			.filter((p) => p && !RULE_REMINDERS.has(p))
		if (ps.length === 1) {
			card.toolClause = ps[0]
			const attack = raw.match(/<h2[^>]*>ワザ<\/h2>\s*<h4[^>]*>([\s\S]*?)<\/h4>\s*<p>([\s\S]*?)<\/p>/)
			if (attack) card.toolAttack = { name: clean(stripTags(attack[1])), effect: clean(stripTags(attack[2])) }
		}
	}
	return card
}

// ---------- dex ids the set's own pages do not print (ex/Mega/owned Pokémon) ----------

// another print of the same species carries the number — search the official database
// for progressively simplified species names (エリカのラフレシアex → エリカのラフレシア →
// ラフレシア; メガリザードンYex → メガリザードンY → リザードンY → リザードン; regional
// forms share their base form's number)
function speciesCandidates(name: string): string[] {
	const out: string[] = []
	const add = (s: string) => {
		s = s.trim()
		if (!s || out.includes(s)) return
		out.push(s)
		if (s.includes('の')) add(s.slice(s.indexOf('の') + 1))
		if (s.startsWith('メガ')) add(s.slice(2))
		const regional = s.match(/^(?:アローラ|ガラル|ヒスイ|パルデア)\s*(.+)$/)
		if (regional) add(regional[1])
	}
	add(name.replace(/(ex|EX|GX)$/, ''))
	for (const s of [...out]) if (/[XY]$/.test(s)) add(s.slice(0, -1)) // mega form letters
	return out
}

/** dex id of one species name via the candidate chain, or null */
async function searchDex(name: string): Promise<number | null> {
	for (const cand of speciesCandidates(name)) {
		const raw = await fetchCached(
			`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=${encodeURIComponent(cand)}&regulation_sidebar_form=all&sm_and_keyword=true`,
			`${CACHE}/dex-search-${cand}.json`
		)
		const d = JSON.parse(raw) as { cardList: { cardID: string, cardNameViewText: string }[] }
		// cardNameViewText comes back HTML-encoded (フェローチェ&amp;マッシブーンGX) — clean() decodes
		for (const hit of d.cardList.filter((h) => clean(h.cardNameViewText) === cand).slice(0, 5)) {
			const page = await fetchCached(
				`https://www.pokemon-card.com/card-search/details.php/card/${hit.cardID}/regu/all`,
				`${CACHE}/official-${hit.cardID}.html`
			)
			const no = page.match(/<h4>No\.(\d+)/)
			if (no) return parseInt(no[1], 10)
		}
	}
	return null
}

async function resolveDexViaOtherPrints(all: Record<string, RawCard>): Promise<void> {
	for (const c of Object.values(all)) {
		if (c.category !== 'Pokemon' || c.dexId != null) continue
		// TAG TEAM cards name several Pokémon (フェローチェ&マッシブーンGX) — one id each
		const parts = c.name.replace(/(ex|EX|GX)$/, '').split(/[&＆]/).map((s) => s.trim()).filter(Boolean)
		if (parts.length > 1) {
			const ids: number[] = []
			for (const part of parts) {
				const dex = await searchDex(part)
				if (dex == null) { ids.length = 0; break }
				ids.push(dex)
			}
			if (ids.length) c.dexId = ids
			continue
		}
		const dex = await searchDex(c.name)
		if (dex != null) c.dexId = dex
	}
}

// ---------- unnumbered basic energies of deck products (limitless letter cards) ----------

async function scrapeEnergies(cfg: SetConfig): Promise<Record<string, { name: string, regulationMark: string | null }>> {
	const out: Record<string, { name: string, regulationMark: string | null }> = {}
	for (const letter of Object.keys(cfg.energies ?? {})) {
		const html = await fetchCached(
			`https://limitlesstcg.com/cards/jp/${cfg.setId}/${letter}`,
			`${CACHE}/limitless-${letter}.html`
		)
		const title = html.match(/<span class="card-text-name"><a[^>]*>([^<]+)<\/a><\/span>/)
		if (!title) throw new Error(`energy ${letter}: no name on limitless page`)
		if (!/card-text-type">\s*Energy\s*-\s*Basic Energy/.test(html)) throw new Error(`energy ${letter}: not a basic energy`)
		const reg = html.match(/([A-Z])\s*Regulation Mark/)
		out[letter] = { name: clean(title[1]), regulationMark: reg ? reg[1] : null }
	}
	return out
}

// ---------- serebii (secret-rare illustrators) ----------

async function serebiiIllustrators(cfg: SetConfig): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	if (!cfg.secrets || !cfg.serebiiSlug) return out
	const missing: string[] = []
	for (const numStr of Object.keys(cfg.secrets)) {
		if (cfg.secrets[numStr].energy) continue // energy cards carry no illustrator
		const n = String(numStr).padStart(3, '0')
		const html = await fetchCached(
			`https://www.serebii.net/card/${cfg.serebiiSlug}/${n}.shtml`,
			`${CACHE}/serebii-${n}.html`
		)
		const m = html.match(/Illustration:\s*<a[^>]*><u>([^<]+)<\/u>/)
		if (m) out[numStr] = m[1].trim()
		else missing.push(numStr) // serebii has the page but no artist yet — other sources fill in
	}
	if (missing.length) console.log(`note: serebii lists no illustrator for: ${missing.join(', ')}`)
	return out
}

// ---------- gold staples: official Japanese text of their most recent print ----------

async function stapleTexts(cfg: SetConfig): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	if (!cfg.secrets) return out
	const names = [...new Set(Object.values(cfg.secrets).filter((s) => s.staple).map((s) => s.staple!.nameJa))]
	for (const name of names) {
		const raw = await fetchCached(
			`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=${encodeURIComponent(name)}&regulation_sidebar_form=all&sm_and_keyword=true`,
			`${CACHE}/staple-search-${name}.json`
		)
		const d = JSON.parse(raw) as { cardList: { cardID: string, cardNameViewText: string }[] }
		const hits = d.cardList.filter((c) => clean(c.cardNameViewText) === name)
		if (!hits.length) throw new Error(`staple ${name}: not found in official database`)
		const cardId = String(Math.max(...hits.map((c) => parseInt(c.cardID, 10))))
		const page = await fetchCached(
			`https://www.pokemon-card.com/card-search/details.php/card/${cardId}/regu/all`,
			`${CACHE}/staple-${cardId}.html`
		)
		const seg = page.slice(page.indexOf('RightBox'), page.indexOf('RightBox') + 6000)
		const ps = [...seg.matchAll(/<p>([\s\S]*?)<\/p>/g)]
			.map((m) => clean(stripTags(m[1])))
			.filter((p) => p.length > 20)
		if (!ps.length) throw new Error(`staple ${name}: no effect text on card ${cardId}`)
		out[name] = ps[0]
	}
	return out
}

// ---------- main ----------

const rarities = await limitlessRarities()
console.log(`limitless list: ${rarities.size} cards`)

// scrape every card limitless lists (for sets whose secrets limitless does not have
// yet, that is only the main set — the secrets then come from the config + serebii)
const limitlessNums = [...rarities.keys()].sort((a, b) => a - b)
const cards: Record<string, RawCard> = {}
for (const n of limitlessNums) {
	const card = await limitlessCard(n, rarities.get(n))
	// limitless lists some sets without rarities — cardmarket's label fills in (config.ts)
	if (!card.rarity && config.rarityOverrides?.[String(n)]) card.rarity = config.rarityOverrides[String(n)]
	cards[String(n)] = card
	if (n % 20 === 0) console.log(`limitless ${n}/${limitlessNums.length}`)
}

const ids = await officialCardIds()
console.log(`official database: ${ids.length} card ids`)
const problems: string[] = []
// illustrators per collection number — the source generate.ts uses for secret rares
const officialIllustrators: Record<string, string> = {}
for (const id of ids) {
	const o = await officialCard(id)
	if (!o) continue
	if (o.illustrator && officialIllustrators[String(o.num)] == null) officialIllustrators[String(o.num)] = o.illustrator
	const c = cards[String(o.num)]
	if (!c) continue
	// the sources disagree on spacing within names (アローラ ロコン vs アローラロコン)
	const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')
	if (o.name && squash(o.name) !== squash(c.name)) problems.push(`${o.num}: name mismatch limitless=${c.name} official=${o.name}`)
	c.dexId = o.dexId
	c.flavor = o.flavor
	if (o.total !== config.officialCardCount) problems.push(`${o.num}: official total ${o.total} ≠ config ${config.officialCardCount}`)
	if (o.toolClause) {
		const cc = c as RawCard & { effect?: string }
		if (!cc.effect) cc.effect = o.toolClause
		if (o.toolAttack) {
			const at = c.attacks[0]
			if (!at) problems.push(`${o.num}: official page grants a Tool attack, limitless page does not`)
			else {
				if (at.name !== o.toolAttack.name) problems.push(`${o.num}: tool attack name mismatch limitless=${at.name} official=${o.toolAttack.name}`)
				if (at.effect !== o.toolAttack.effect) problems.push(`${o.num}: tool attack text mismatch limitless=${at.effect} official=${o.toolAttack.effect}`)
			}
		}
	}
}

// secrets that reprint a card from another set (era-wide alt arts, e.g. SM12a):
// the full card data comes from the original print's limitless page
for (const [ns, info] of Object.entries(config.secrets ?? {})) {
	if (!info.from) continue
	const card = await limitlessCard(info.from.number, undefined, info.from.set)
	card.num = parseInt(ns, 10)
	card.rarity = info.rarity
	card.illustrator = officialIllustrators[ns] ?? ''
	card.flavor = null
	cards[ns] = card
}

await resolveDexViaOtherPrints(cards)

for (const c of Object.values(cards)) {
	if (c.category === 'Pokemon' && (!c.hp || !c.types.length || !c.stageRaw || c.retreat === null)) {
		problems.push(`${c.num}: incomplete pokemon data`)
	}
	if (c.category !== 'Pokemon' && !(c as RawCard & { effect?: string }).effect) problems.push(`${c.num}: missing trainer/energy text`)
	if (config.regulationMarks !== false && !c.regulationMark) problems.push(`${c.num}: missing regulation mark`)
}

writeFileSync(`${OUT}/cards.json`, JSON.stringify(cards, null, 1))
writeFileSync(`${OUT}/official-illustrators.json`, JSON.stringify(officialIllustrators, null, 1))
writeFileSync(`${OUT}/energies.json`, JSON.stringify(await scrapeEnergies(config), null, 1))
writeFileSync(`${OUT}/serebii-illustrators.json`, JSON.stringify(await serebiiIllustrators(config), null, 1))
writeFileSync(`${OUT}/staple-texts.json`, JSON.stringify(await stapleTexts(config), null, 1))

// cards without a rarity become rarity "None" — legitimate for fixed-distribution
// products (whole deck sets like MC, or the regular cards of subsets like M2a, which
// cardmarket lists as "Fixed"), but worth a look when unexpected
const noRarity = Object.values(cards).filter((c) => !c.rarity).map((c) => c.num)
if (noRarity.length && config.rarities !== false) {
	console.log(`note: ${noRarity.length} cards carry no rarity (become "None"): ${noRarity.sort((a, b) => a - b).join(', ')}`)
}

console.log(`\n${Object.keys(cards).length} cards written to out/${setId}/cards.json`)
if (problems.length) {
	console.log('PROBLEMS:')
	for (const p of problems) console.log(' -', p)
	process.exit(1)
}
console.log('no problems')
