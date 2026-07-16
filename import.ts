// One-shot import: pokepricelab catalog URLs (or set names) in, tcgdex data-asia card
// files + card images + PR texts out. Several sets run back to back (the sources are
// fetched politely, so the batch is sequential); one failing set does not stop the rest.
//
//   bun run import.ts "https://pokepricelab.com/catalog?q=&set=<slug>&language=all&condition=all&grade=all"
//   bun run import.ts "abyss eye" remix-bout dream-league [--repo ../cards-database] [--force]
//
// Per set: config.ts → scrape.ts → generate.ts → images.ts → pr.ts. An existing config
// is kept (hand-curated manualDex/secrets survive re-runs); --force regenerates it.
// --set <limitless-id> pins the set and only works with a single input.

const argv = process.argv.slice(2)
const inputs: string[] = []
const flags: string[] = []
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--repo' || argv[i] === '--set') {
		flags.push(argv[i], argv[i + 1])
		i += 1
	} else if (argv[i].startsWith('--')) {
		flags.push(argv[i])
	} else {
		inputs.push(argv[i])
	}
}
if (!inputs.length) {
	console.error('usage: bun run import.ts <pokepricelab-url | set name> [more sets …] [--set <limitless-id>] [--repo <cards-database>] [--force]')
	process.exit(1)
}
if (inputs.length > 1 && flags.includes('--set')) {
	console.error('--set pins one specific set — it cannot be combined with several inputs')
	process.exit(1)
}
const repoIdx = flags.indexOf('--repo')
const repo = repoIdx !== -1 ? flags[repoIdx + 1] : '../cards-database'

function run(args: string[], pipe = false): { code: number, out: string } {
	const r = Bun.spawnSync(['bun', 'run', ...args], {
		cwd: import.meta.dir,
		stdout: pipe ? 'pipe' : 'inherit',
		stderr: 'inherit',
	})
	return { code: r.exitCode ?? 1, out: pipe ? r.stdout.toString() : '' }
}

const results: { input: string, setId?: string, failed?: string }[] = []
for (const input of inputs) {
	if (inputs.length > 1) console.log(`\n========== ${input}`)
	const cfg = run(['config.ts', input, ...flags], true)
	process.stdout.write(cfg.out)
	const m = cfg.out.match(/^config: configs\/(.+)\.config\.json/m)
	if (cfg.code !== 0 || !m) {
		results.push({ input, failed: 'config.ts' })
		continue
	}
	const setId = m[1]
	let failed: string | undefined
	for (const step of [
		['scrape.ts', setId],
		['generate.ts', setId, '--repo', repo],
		['images.ts', setId],
		['pr.ts', setId, '--repo', repo],
	]) {
		console.log(`\n=== ${step.join(' ')}`)
		if (run(step).code !== 0) {
			failed = step[0]
			break
		}
	}
	results.push({ input, setId, failed })
}

if (inputs.length > 1) {
	console.log('\n========== summary')
	for (const r of results) {
		console.log(`  ${r.failed ? '✗' : '✓'} ${r.setId ?? r.input}${r.failed ? ` — failed at ${r.failed}` : ''}`)
	}
}
console.log(`\nreview with: git -C ${repo} status`)
if (results.some((r) => r.failed)) process.exit(1)
