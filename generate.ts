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
import { loadConfig, type RawCard } from './lib'

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

// ---------- secret rares: reprint clones + gold staples ----------

for (const [ns, info] of Object.entries(config.secrets ?? {})) {
	const n = parseInt(ns, 10)
	const illustrator = serebii[ns] ?? ''
	if (info.base != null) {
		const base = cards[String(info.base)]
		if (!base) throw new Error(`secret ${n}: base card ${info.base} missing`)
		cards[ns] = { ...base, num: n, rarity: info.rarity, illustrator, flavor: null }
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

let repoDex: Map<string, number> | null = null
function resolveDex(c: RawCard): number {
	if (c.dexId != null) return c.dexId
	const base = c.name.replace(/ex$/, '').replace(/^メガ/, '').trim()
	if (config.manualDex[base] != null) return config.manualDex[base]
	repoDex ??= buildRepoDexIndex()
	const dex = repoDex.get(base)
	if (dex == null) throw new Error(`card ${c.num} (${c.name}): dexId unresolved — add it to manualDex`)
	return dex
}

// ---------- card file emission (format identical to the existing M-era files) ----------

const STAGE: Record<string, string> = { 'Basic': 'Basic', 'Stage 1': 'Stage1', 'Stage 2': 'Stage2' }

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

function langBlock(value: string, indent = '\t'): string {
	return `{\n${indent}\tja: "${esc(value)}",\n${indent}}`
}

/** cardmarket/tcgplayer ids now live on the variant objects (see data/Scarlet & Violet). */
function pushVariants(L: string[], c: RawCard, variant: string): void {
	const cm = config.cardmarketIds[String(c.num)]
	if (cm == null) {
		L.push(`\tvariants: [{ type: "${variant}" }],`)
		return
	}
	L.push('\tvariants: [')
	L.push('\t\t{')
	L.push(`\t\t\ttype: "${variant}",`)
	L.push('\t\t\tthirdParty: {')
	L.push(`\t\t\t\tcardmarket: ${cm},`)
	L.push('\t\t\t},')
	L.push('\t\t},')
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
		if (c.rarity != null) L.push(`\trarity: "${c.rarity}",`)
		L.push(`\tdexId: [${resolveDex(c)}],`)
		if (c.name.endsWith('ex') || c.name.endsWith('EX')) {
			L.push('')
			L.push('\tsuffix: "EX",')
		}
	} else {
		if (c.category === 'Energy') L.push('\tenergyType: "Special",')
		L.push('')
		L.push('\teffect: {')
		L.push(`\t\tja: "${esc(c.effect ?? '')}",`)
		L.push('\t},')
		L.push('')
		pushAttacks(L, c) // an attack granted by a Pokémon Tool (e.g. CP1 025/026)
		pushVariants(L, c, variant)
		L.push('')
		if (c.category === 'Trainer') L.push(`\ttrainerType: "${c.trainerType}",`)
		if (c.regulationMark) L.push(`\tregulationMark: "${c.regulationMark}",`)
		if (c.rarity != null) L.push(`\trarity: "${c.rarity}",`)
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
for (const n of nums) {
	writeFileSync(join(dir, `${String(n).padStart(3, '0')}.ts`), genCard(cards[String(n)]))
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

console.log(`${nums.length} card files + ${config.setId}.ts written to ${outBase}`)
if (!existsSync(join(repo, 'data-asia', 'M', 'M3'))) {
	console.log('note: --repo does not look like tcgdex/cards-database')
}
