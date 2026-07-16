// Turns out/<SET>/cards.json (from scrape.ts) into tcgdex data-asia card files.
//
//   bun run generate.ts M5 --repo ../cards-database [--out <dir>]
//
// --repo is used for two things: the existing card files are scanned to resolve
// national dex ids of ex/Mega cards (the official pages do not print those), and
// it is the default output location (<repo>/data-asia/M).
//
// The output is intended to be byte-identical to the files in the corresponding
// pull request — run it and `git diff` to verify.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENERGY_CODES, loadConfig, type RawCard } from './lib'

const args = process.argv.slice(2)
const setId = args[0]
const repoIdx = args.indexOf('--repo')
const outIdx = args.indexOf('--out')
if (!setId || repoIdx === -1) {
	console.error('usage: bun run generate.ts <SET> --repo <cards-database> [--out <dir>]')
	process.exit(1)
}
const repo = args[repoIdx + 1]

const config = loadConfig(setId)
const serie = config.serie ?? 'M'
const outBase = outIdx !== -1 ? args[outIdx + 1] : join(repo, 'data-asia', serie)
const OUT = `${import.meta.dir}/out/${setId}`
const cards: Record<string, RawCard> = JSON.parse(readFileSync(`${OUT}/cards.json`, 'utf-8'))
const serebii: Record<string, string> = JSON.parse(readFileSync(`${OUT}/serebii-illustrators.json`, 'utf-8'))
const stapleTexts: Record<string, string> = JSON.parse(readFileSync(`${OUT}/staple-texts.json`, 'utf-8'))
const officialIll: Record<string, string> = existsSync(`${OUT}/official-illustrators.json`)
	? JSON.parse(readFileSync(`${OUT}/official-illustrators.json`, 'utf-8'))
	: {}

// ---------- secret rares: reprint clones, secret energies, gold staples ----------

const secretsWithoutArtist: number[] = []
for (const [ns, info] of Object.entries(config.secrets ?? {})) {
	const n = parseInt(ns, 10)
	const illustrator = serebii[ns] ?? officialIll[ns] ?? ''
	if (!illustrator && info.energy == null && info.from == null) secretsWithoutArtist.push(n)
	if (info.base != null) {
		const base = cards[String(info.base)]
		if (!base) throw new Error(`secret ${n}: base card ${info.base} missing`)
		cards[ns] = { ...base, num: n, rarity: info.rarity, illustrator, flavor: null }
	} else if (info.energy) {
		const e = ENERGY_CODES[info.energy]
		if (!e) throw new Error(`secret ${n}: unknown energy letter ${info.energy}`)
		cards[ns] = {
			num: n, name: `基本${e.jp}エネルギー`, category: 'Energy', types: [], hp: null,
			stageRaw: null, evolveFrom: null, trainerType: null, energyType: 'Basic Energy',
			abilities: [], attacks: [], weakness: null, resistance: null, retreat: null,
			illustrator, regulationMark: null, rarity: info.rarity, flavor: null, dexId: null,
		}
	} else if (info.from) {
		// scraped in full from the original print's page (scrape.ts)
		if (!cards[ns]) throw new Error(`secret ${n}: import from ${info.from.set}/${info.from.number} missing — re-run scrape.ts`)
		if (!cards[ns].illustrator) cards[ns].illustrator = illustrator
		if (!cards[ns].illustrator) secretsWithoutArtist.push(n)
	} else if (info.staple) {
		const effect = stapleTexts[info.staple.nameJa]
		if (!effect) throw new Error(`secret ${n}: no official text for ${info.staple.nameJa}`)
		cards[ns] = {
			num: n, name: info.staple.nameJa, category: 'Trainer', types: [], hp: null,
			stageRaw: null, evolveFrom: null, trainerType: info.staple.trainerType, energyType: null,
			abilities: [], attacks: [], weakness: null, resistance: null, retreat: null,
			illustrator, regulationMark: 'J', rarity: info.rarity, flavor: null, dexId: null, effect,
		}
	} else {
		throw new Error(`secret ${n}: needs either base or staple`)
	}
}

// ---------- dex ids for ex/Mega cards (not printed on the official pages) ----------

function buildRepoDexIndex(): Map<string, number> {
	const index = new Map<string, number>()
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
			e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [])
	for (const file of walk(join(repo, 'data-asia'))) {
		const src = readFileSync(file, 'utf-8')
		const nm = src.match(/name:\s*\{\s*ja:\s*"([^"]+)"/)
		const dx = src.match(/dexId:\s*\[([0-9, ]+)\]/)
		if (!nm || !dx) continue
		const ids = dx[1].split(',').map((x) => parseInt(x, 10))
		if (ids.length !== 1) continue
		const base = nm[1].replace(/(ex|EX|GX|V|VMAX|VSTAR)$/, '').replace(/^メガ/, '').trim()
		if (!index.has(base)) index.set(base, ids[0])
	}
	return index
}

/** lookup keys for a card name, most specific first: the raw name, the name without its
 * ex/EX suffix, progressively without メガ prefixes (メガメガニウム → メガニウム → ニウム —
 * the repo index strips メガ the same way, which also keeps メガヤンマ/Yanmega consistent),
 * and — for owned Pokémon like エリカのラフレシアex — the species after the の */
function dexKeys(name: string): string[] {
	const keys = [name]
	const megaStripped = (s: string) => {
		for (keys.push(s); s.startsWith('メガ'); s = s.slice(2)) keys.push(s.slice(2))
	}
	const base = name.replace(/(ex|EX|GX)$/, '').trim()
	megaStripped(base)
	if (base.includes('の')) megaStripped(base.slice(base.indexOf('の') + 1))
	return [...new Set(keys)]
}

let repoDex: Map<string, number> | null = null
function resolveOneDex(name: string, c: RawCard): number {
	const keys = dexKeys(name)
	for (const k of keys) if (config.manualDex[k] != null) return config.manualDex[k]
	repoDex ??= buildRepoDexIndex()
	for (const k of keys) {
		const dex = repoDex.get(k)
		if (dex != null) return dex
	}
	throw new Error(`card ${c.num} (${c.name}): dexId unresolved — add it to manualDex`)
}

/** all dex ids of a card, print order (TAG TEAM cards name several Pokémon) */
function resolveDex(c: RawCard): number[] {
	if (c.dexId != null) return Array.isArray(c.dexId) ? c.dexId : [c.dexId]
	const parts = c.name.replace(/(ex|EX|GX)$/, '').split(/[&＆]/).map((s) => s.trim()).filter(Boolean)
	return parts.length > 1 ? parts.map((p) => resolveOneDex(p, c)) : [resolveOneDex(c.name, c)]
}

// ---------- card file emission (format identical to the existing M-era files) ----------

const STAGE: Record<string, string> = { 'Basic': 'Basic', 'Stage 1': 'Stage1', 'Stage 2': 'Stage2' }

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

function langBlock(value: string, indent = '\t'): string {
	return `{\n${indent}\tja: "${esc(value)}",\n${indent}}`
}

// ---------- ball foils of the reverse prints, from the English set (config.enSet) ----------

let enBalls: Map<string, string> | null | undefined
const missingFoils: string[] = []

/** English card name / #dexId → the card's ball foil (its non-energy reverse foil) */
function buildEnBallIndex(): Map<string, string> | null {
	if (!config.enSet) return null
	const dir = join(repo, 'data', config.enSet)
	if (!existsSync(dir)) throw new Error(`enSet "${config.enSet}" not found under ${join(repo, 'data')}`)
	const index = new Map<string, string>()
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
		const src = readFileSync(join(dir, file), 'utf-8')
		const ball = [...src.matchAll(/foil: "([a-z-]+)"/g)].map((m) => m[1]).find((f) => f !== 'energy')
		if (!ball) continue
		const nm = src.match(/name:\s*\{\s*en:\s*"([^"]+)"/)
		const dx = src.match(/dexId:\s*\[\s*(\d+)/)
		if (nm && !index.has(nm[1].toLowerCase())) index.set(nm[1].toLowerCase(), ball)
		if (dx && !index.has(`#${dx[1]}`)) index.set(`#${dx[1]}`, ball)
	}
	return index
}

function ballFoil(c: RawCard, cardmarketName: string): string | null {
	if (enBalls === undefined) enBalls = buildEnBallIndex()
	const ball = enBalls?.get(cardmarketName.toLowerCase())
		?? (c.dexId != null ? enBalls?.get(`#${c.dexId}`) : undefined)
	if (!ball) missingFoils.push(`${String(c.num).padStart(3, '0')} ${c.name} (${cardmarketName})`)
	return ball ?? null
}

/** cardmarket/tcgplayer ids now live on the variant objects (see data/Scarlet & Violet). */
function pushVariants(L: string[], c: RawCard, variant: string): void {
	const cm = config.cardmarketIds[String(c.num)]
	const rev = config.reverses?.[String(c.num)]
	if (cm == null && !rev) {
		L.push(`\tvariants: [{ type: "${variant}" }],`)
		return
	}
	const entry = (type: string, foil: string | null, id: number) => {
		L.push('\t\t{')
		L.push(`\t\t\ttype: "${type}",`)
		if (foil) L.push(`\t\t\tfoil: "${foil}",`)
		L.push('\t\t\tthirdParty: {')
		L.push(`\t\t\t\tcardmarket: ${id},`)
		L.push('\t\t\t},')
		L.push('\t\t},')
	}
	L.push('\tvariants: [')
	if (cm != null) entry(variant, null, cm)
	if (rev) {
		// two mirror prints per card: energy pattern first, ball pattern second
		entry('reverse', 'energy', rev.ids[0])
		entry('reverse', ballFoil(c, rev.name), rev.ids[1])
	}
	L.push('\t],')
}

function pushAttacks(L: string[], c: RawCard): void {
	if (!c.attacks.length) return
	L.push('\tattacks: [')
	for (const at of c.attacks) {
		L.push('\t\t{')
		L.push(`\t\t\tname: { ja: "${esc(at.name)}" },`)
		if (at.damage !== null) {
			L.push(/^\d+$/.test(at.damage) ? `\t\t\tdamage: ${at.damage},` : `\t\t\tdamage: "${at.damage}",`)
		}
		L.push(`\t\t\tcost: [${at.cost.map((t) => `"${t}"`).join(', ')}],`)
		if (at.effect) {
			L.push('\t\t\teffect: {')
			L.push(`\t\t\t\tja: "${esc(at.effect)}",`)
			L.push('\t\t\t},')
		}
		L.push('\t\t},')
	}
	L.push('\t],')
	L.push('')
}

function genCard(c: RawCard): string {
	const L: string[] = []
	L.push('import { Card } from "../../../interfaces";')
	L.push(`import Set from "../${config.setId}";`)
	L.push('')
	L.push('const card: Card = {')
	L.push('\tset: Set,')
	L.push(`\tname: ${langBlock(c.name)},`)
	L.push('')
	L.push(`\tillustrator: "${esc(c.illustrator || '')}",`)
	L.push(`\tcategory: "${c.category}",`)

	// rarity-less deck cards (cf. data-asia/S/SI) are plain prints
	const variant = c.rarity === 'Common' || c.rarity === 'Uncommon' || c.rarity == null ? 'normal' : 'holo'

	if (c.category === 'Pokemon') {
		L.push(`\thp: ${c.hp},`)
		L.push(`\ttypes: [${c.types.map((t) => `"${t}"`).join(', ')}],`)
		L.push('')
		if (c.flavor) {
			L.push(`\tdescription: ${langBlock(c.flavor)},`)
			L.push('')
		}
		L.push(`\tstage: "${STAGE[c.stageRaw!]}",`)
		L.push('')
		if (c.abilities.length > 1) throw new Error(`card ${c.num} has multiple abilities — extend the generator`)
		for (const ab of c.abilities) {
			L.push('\tabilities: [')
			L.push('\t\t{')
			L.push('\t\t\ttype: "Ability",')
			L.push(`\t\t\tname: { ja: "${esc(ab.name)}" },`)
			L.push('\t\t\teffect: {')
			L.push(`\t\t\t\tja: "${esc(ab.effect)}",`)
			L.push('\t\t\t},')
			L.push('\t\t},')
			L.push('\t],')
			L.push('')
		}
		pushAttacks(L, c)
		L.push(c.weakness ? `\tweaknesses: [{ type: "${c.weakness}", value: "x2" }],` : '\tweaknesses: [],')
		L.push(c.resistance ? `\tresistances: [{ type: "${c.resistance.type}", value: "${c.resistance.value}" }],` : '\tresistances: [],')
		L.push('')
		pushVariants(L, c, variant)
		L.push('')
		if (c.evolveFrom) {
			L.push(`\tevolveFrom: ${langBlock(c.evolveFrom)},`)
			L.push('')
		}
		L.push(`\tretreat: ${c.retreat},`)
		if (c.regulationMark) L.push(`\tregulationMark: "${c.regulationMark}",`)
		L.push(`\trarity: "${c.rarity ?? 'None'}",`) // rarity-less products use "None" (cf. data-asia/VS/VS1)
		L.push(`\tdexId: [${resolveDex(c).join(', ')}],`)
		if (c.name.endsWith('ex') || c.name.endsWith('EX')) {
			L.push('')
			L.push('\tsuffix: "EX",')
		} else if (c.name.endsWith('GX')) {
			L.push('')
			L.push(`\tsuffix: "${/[&＆]/.test(c.name) ? 'TAG TEAM-GX' : 'GX'}",`)
		}
	} else {
		if (c.category === 'Energy') L.push(`\tenergyType: "${c.energyType === 'Basic Energy' ? 'Normal' : 'Special'}",`)
		L.push('')
		if (c.effect || c.energyType !== 'Basic Energy') { // basic energies carry no text
			L.push('\teffect: {')
			L.push(`\t\tja: "${esc(c.effect ?? '')}",`)
			L.push('\t},')
			L.push('')
		}
		pushAttacks(L, c) // an attack granted by a Pokémon Tool (e.g. CP1 025/026)
		pushVariants(L, c, variant)
		L.push('')
		if (c.category === 'Trainer') L.push(`\ttrainerType: "${c.trainerType}",`)
		if (c.regulationMark) L.push(`\tregulationMark: "${c.regulationMark}",`)
		L.push(`\trarity: "${c.rarity ?? 'None'}",`)
	}

	L.push('};')
	L.push('')
	L.push('export default card;')
	return L.join('\n') + '\n'
}

// ---------- write ----------

const dir = join(outBase, config.setId)
mkdirSync(dir, { recursive: true })

const nums = Object.keys(cards).map((n) => parseInt(n, 10)).sort((a, b) => a - b)
if (nums.length !== config.totalCards) {
	throw new Error(`expected ${config.totalCards} cards, got ${nums.length}`)
}
// collect per-card failures and report them all at once (766-card deck sets would
// otherwise die one manualDex entry at a time)
const failures: string[] = []
for (const n of nums) {
	try {
		writeFileSync(join(dir, `${String(n).padStart(3, '0')}.ts`), genCard(cards[String(n)]))
	} catch (e) {
		failures.push((e as Error).message)
	}
}
if (failures.length) {
	console.error(`${failures.length} cards failed:`)
	for (const f of failures) console.error(' -', f)
	process.exit(1)
}
if (secretsWithoutArtist.length) {
	console.log(`note: ${secretsWithoutArtist.length} secret rares have no illustrator from any source (official DB, serebii): ${secretsWithoutArtist.join(', ')}`)
}
if (missingFoils.length) {
	console.log(`${missingFoils.length} reverse prints without a ball foil (${config.enSet ? 'no match in enSet' : 'set "enSet" in the config'}):`)
	for (const m of missingFoils) console.log(' -', m)
}

// unnumbered basic energies of deck products — letter-coded files (cf. data-asia/S/SI)
const energyCount = Object.keys(config.energies ?? {}).length
if (config.energies) {
	const energies: Record<string, { name: string, regulationMark: string | null }> =
		JSON.parse(readFileSync(`${OUT}/energies.json`, 'utf-8'))
	for (const [letter, cm] of Object.entries(config.energies)) {
		const e = energies[letter]
		if (!e) throw new Error(`energy ${letter} missing from energies.json — re-run scrape.ts`)
		const L: string[] = []
		L.push('import { Card } from "../../../interfaces";')
		L.push(`import Set from "../${config.setId}";`)
		L.push('')
		L.push('const card: Card = {')
		L.push('\tset: Set,')
		L.push(`\tname: ${langBlock(e.name)},`)
		L.push('')
		L.push('\tcategory: "Energy",')
		L.push('\tenergyType: "Normal",')
		L.push('')
		L.push('\tvariants: [')
		L.push('\t\t{')
		L.push('\t\t\ttype: "normal",')
		L.push('\t\t\tthirdParty: {')
		L.push(`\t\t\t\tcardmarket: ${cm},`)
		L.push('\t\t\t},')
		L.push('\t\t},')
		L.push('\t],')
		L.push('')
		if (e.regulationMark) L.push(`\tregulationMark: "${e.regulationMark}",`)
		L.push('\trarity: "None",')
		L.push('};')
		L.push('')
		L.push('export default card;')
		writeFileSync(join(dir, `${ENERGY_CODES[letter].code}.ts`), L.join('\n') + '\n')
	}
}

// the set file is only generated when the repo does not have one yet — existing
// set files (e.g. data-asia/XY/CP1.ts) may carry extra languages such as Korean
const setFile = join(outBase, `${config.setId}.ts`)
if (!existsSync(setFile)) writeFileSync(setFile, `import { Set } from "../../interfaces";
import serie from "../${serie}";

const set: Set = {
	id: "${config.setId}",
	name: {
		ja: "${config.nameJa}",
	},

	serie: serie,

	cardCount: {
		official: ${config.officialCardCount},
	},
	releaseDate: {
		ja: "${config.releaseDate}",
	},
};

export default set;
`)

console.log(`${nums.length} card files${energyCount ? ` + ${energyCount} energies` : ''} + ${config.setId}.ts written to ${outBase}`)
if (!existsSync(join(repo, 'data-asia', 'M', 'M3'))) {
	console.log('note: --repo does not look like tcgdex/cards-database')
}
