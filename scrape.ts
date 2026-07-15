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

async function limitlessCard(n: number, rarityLabel: string | undefined): Promise<RawCard> {
	const html = await fetchCached(
		`https://limitlesstcg.com/cards/jp/${config.setId}/${n}`,
		`${CACHE}/limitless-${String(n).padStart(3, '0')}.html`
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
	const card: OfficialCard = {
		num: parseInt(col[1], 10),
		total: parseInt(col[2], 10),
		name: name ? clean(name[1]) : null,
		dexId: dex ? parseInt(dex[1], 10) : null,
		flavor: flavor ? clean(stripTags(flavor[1])) : null,
	}
	const tool = raw.match(/<h2[^>]*>ポケモンのどうぐ<\/h2>([\s\S]*?)(?:<h2|<\/div)/)
	if (tool) {
		const ps = [...tool[1].matchAll(/<p>([\s\S]*?)<\/p>/g)]
			.map((m) => clean(stripTags(m[1])))
			.filter((p) => p && !RULE_REMINDERS.has(p))
		if (ps.length !== 1) throw new Error(`card ${card.num}: expected exactly one Tool text paragraph, got ${ps.length}`)
		card.toolClause = ps[0]
		const attack = raw.match(/<h2[^>]*>ワザ<\/h2>\s*<h4[^>]*>([\s\S]*?)<\/h4>\s*<p>([\s\S]*?)<\/p>/)
		if (attack) card.toolAttack = { name: clean(stripTags(attack[1])), effect: clean(stripTags(attack[2])) }
	}
	return card
}

// ---------- serebii (secret-rare illustrators) ----------

async function serebiiIllustrators(cfg: SetConfig): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	if (!cfg.secrets || !cfg.serebiiSlug) return out
	for (const numStr of Object.keys(cfg.secrets)) {
		const n = String(numStr).padStart(3, '0')
		const html = await fetchCached(
			`https://www.serebii.net/card/${cfg.serebiiSlug}/${n}.shtml`,
			`${CACHE}/serebii-${n}.html`
		)
		const m = html.match(/Illustration:\s*<a[^>]*><u>([^<]+)<\/u>/)
		if (!m) throw new Error(`serebii ${n}: no illustrator found`)
		out[numStr] = m[1].trim()
	}
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
		const hits = d.cardList.filter((c) => c.cardNameViewText === name)
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
	cards[String(n)] = await limitlessCard(n, rarities.get(n))
	if (n % 20 === 0) console.log(`limitless ${n}/${limitlessNums.length}`)
}

const ids = await officialCardIds()
console.log(`official database: ${ids.length} card ids`)
const problems: string[] = []
for (const id of ids) {
	const o = await officialCard(id)
	if (!o) continue
	const c = cards[String(o.num)]
	if (!c) continue
	if (o.name && o.name !== c.name) problems.push(`${o.num}: name mismatch limitless=${c.name} official=${o.name}`)
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

for (const c of Object.values(cards)) {
	if (c.category === 'Pokemon' && (!c.hp || !c.types.length || !c.stageRaw || c.retreat === null)) {
		problems.push(`${c.num}: incomplete pokemon data`)
	}
	if (c.category !== 'Pokemon' && !(c as RawCard & { effect?: string }).effect) problems.push(`${c.num}: missing trainer/energy text`)
	if (config.rarities !== false && !c.rarity) problems.push(`${c.num}: missing rarity`)
	if (config.regulationMarks !== false && !c.regulationMark) problems.push(`${c.num}: missing regulation mark`)
}

writeFileSync(`${OUT}/cards.json`, JSON.stringify(cards, null, 1))
writeFileSync(`${OUT}/serebii-illustrators.json`, JSON.stringify(await serebiiIllustrators(config), null, 1))
writeFileSync(`${OUT}/staple-texts.json`, JSON.stringify(await stapleTexts(config), null, 1))

console.log(`\n${Object.keys(cards).length} cards written to out/${setId}/cards.json`)
if (problems.length) {
	console.log('PROBLEMS:')
	for (const p of problems) console.log(' -', p)
	process.exit(1)
}
console.log('no problems')
