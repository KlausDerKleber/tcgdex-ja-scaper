// Writes a ready-to-post pull-request description for an imported set to out/<SET>/pr.md
// (title on the first line, body below) and type-checks the generated files — the repo's
// own `npm run validate` does not cover data-asia.
//
//   bun run pr.ts M5 --repo ../cards-database

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENERGY_CODES, loadConfig, type RawCard } from './lib'

const setId = process.argv[2]
const args = process.argv.slice(3)
const repoIdx = args.indexOf('--repo')
const repo = repoIdx !== -1 ? args[repoIdx + 1] : '../cards-database'
if (!setId) {
	console.error('usage: bun run pr.ts <SET> --repo <cards-database>')
	process.exit(1)
}
const config = loadConfig(setId)
const serie = config.serie ?? 'M'
const dir = join(repo, 'data-asia', serie, setId)
const cards: Record<string, RawCard> = JSON.parse(readFileSync(`${import.meta.dir}/out/${setId}/cards.json`, 'utf-8'))

// ---------- type-check the generated files (honest claim in the PR text) ----------

const energyCount = Object.keys(config.energies ?? {}).length
const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()
if (files.length !== config.totalCards + energyCount) {
	throw new Error(`${dir} has ${files.length} files, expected ${config.totalCards + energyCount}`)
}
const tsc = Bun.spawnSync(['bunx', 'tsc', '--noEmit', '--ignoreConfig', '--target', 'esnext', '--module', 'esnext',
	'--moduleResolution', 'bundler', '--skipLibCheck', ...files.map((f) => join('data-asia', serie, setId, f))], { cwd: repo })
if (tsc.exitCode !== 0) {
	console.error(tsc.stdout.toString() + tsc.stderr.toString())
	throw new Error('generated files do not type-check')
}

// ---------- content ----------

const SECRET_SHORT: Record<string, string> = {
	'Illustration rare': 'AR', 'Ultra Rare': 'SR', 'Special illustration rare': 'SAR', 'Hyper rare': 'UR',
	'Character Rare': 'CHR', 'Character Super Rare': 'CSR',
}
const count = (xs: string[]) => {
	const m = new Map<string, number>()
	for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
	return m
}

const main = Object.values(cards).filter((c) => c.num <= config.officialCardCount)
const categories = count(main.map((c) => c.category))
const exCards = main.filter((c) => /(ex|EX)$/.test(c.name)).length
const catParts = [
	`${categories.get('Pokemon') ?? 0} Pokémon${exCards ? ` (${exCards} of them ex)` : ''}`,
	`${categories.get('Trainer') ?? 0} Trainers`,
	`${categories.get('Energy') ?? 0} Energy`,
].filter((p) => !p.startsWith('0 '))

// secret rares: the scraped ones (limitless lists them, e.g. SM11b's CHR) plus the
// config-mapped ones beyond the limitless list
const secretRarities = [
	...Object.values(cards).filter((c) => c.num > config.officialCardCount).map((c) => c.rarity ?? '?'),
	...Object.values(config.secrets ?? {}).filter((s) => !s.from).map((s) => s.rarity), // from-imports are already in cards.json
]
const secretParts = [...count(secretRarities)].map(([r, n]) => `${n} ${SECRET_SHORT[r] ?? r}`)
const secretText = !secretRarities.length
	? ` (${catParts.join(', ')})`
	: config.rarities === false
		? ` (${config.officialCardCount} printed + ${secretRarities.length} beyond the printed count)`
		: ` (${config.officialCardCount} regular + ${secretRarities.length} secret rares: ${secretParts.join(', ')})`

const cm = Object.values(config.cardmarketIds)
const cmRange = cm.length ? `${Math.min(...cm)}–${Math.max(...cm)}` : 'none yet'
const setFileGenerated = !existsSync(join(repo, '.git')) ? false
	: Bun.spawnSync(['git', 'diff', '--quiet', 'HEAD', '--', `data-asia/${serie}/${setId}.ts`], { cwd: repo }).exitCode !== 0
		|| Bun.spawnSync(['git', 'ls-files', '--error-unmatch', `data-asia/${serie}/${setId}.ts`], { cwd: repo }).exitCode !== 0

const toolAttacks = Object.values(cards).filter((c) => c.category === 'Trainer' && c.attacks.length)
const pad = (n: number) => String(n).padStart(3, '0')
const en = config.nameEn ? ` (${config.nameEn})` : ''

const notes: string[] = []
notes.push(`Follows the file format and conventions of the M-era sets (#1728)`)
if (config.regulationMarks === false) notes.push(`No \`regulationMark\` (the set predates regulation marks)${config.resistanceValue ? `; resistances are \`${config.resistanceValue}\` per the era` : ''}`)
if (config.rarities === false) notes.push(`The product's cards carry no rarity — they use \`rarity: "None"\` and plain variants, like data-asia/VS/VS1`)
if (toolAttacks.length) notes.push(`${toolAttacks.map((c) => pad(c.num)).join('/')} ${toolAttacks.length === 1 ? 'is a Pokémon Tool' : 'are Pokémon Tools'} that grant an attack — modeled as \`effect\` + \`attacks\`, like their English prints`)
const reverseCount = Object.keys(config.reverses ?? {}).length
if (reverseCount) notes.push(`${reverseCount} regular cards additionally exist as two mirror prints, modeled as \`reverse\` variants with their own cardmarket ids — \`foil: "energy"\` plus a ball foil per card${config.enSet ? ` (taken from the English print, \`data/${config.enSet}\`)` : ''}`)
notes.push(`All ${files.length} files type-check against \`interfaces.d.ts\` (\`tsc --noEmit\`)`)

const body = `## What

Adds the complete Japanese set **${setId} ${config.nameJa}${en}**, released ${config.releaseDate}:

${setFileGenerated ? `- \`data-asia/${serie}/${setId}.ts\` — set definition (${config.officialCardCount} official cards)\n` : ''}- \`data-asia/${serie}/${setId}/${pad(1)}.ts\` … \`${pad(config.totalCards)}.ts\` — all ${config.totalCards} cards${secretText}
${energyCount ? `- ${Object.keys(config.energies!).map((l) => `\`${ENERGY_CODES[l].code}.ts\``).join(', ')} — the deck's ${energyCount} basic energies (letter-coded, like data-asia/S/SI)\n` : ''}${setFileGenerated ? '' : `- the set definition \`data-asia/${serie}/${setId}.ts\` already existed and is untouched\n`}
## Data sources

- **pokemon-card.com** (official database): Japanese names, flavor texts, National Dex numbers, official card count
- **limitlesstcg.com**: full Japanese card text, stages, weaknesses/resistances/retreat, rarities, illustrators, attack costs
- **Cardmarket**: product IDs as \`thirdParty.cardmarket\` on the variant objects (${cmRange}; tcgplayer IDs not available to me)

## Notes

${notes.map((n) => `- ${n}`).join('\n')}
`

const title = `(data) Add Japanese ${serie} set ${setId}${config.nameEn ? ` ${config.nameEn}` : ''}`
writeFileSync(`${import.meta.dir}/out/${setId}/pr.md`, `${title}\n\n${body}`)
console.log(`out/${setId}/pr.md:\n`)
console.log(`${title}\n\n${body}`)
