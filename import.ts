// One-shot import: pokepricelab catalog URL in, tcgdex data-asia card files out.
//
//   bun run import.ts "https://pokepricelab.com/catalog?q=&set=<slug>&language=all&condition=all&grade=all" [--repo ../cards-database] [--force]
//
// Runs config.ts → scrape.ts → generate.ts. An existing config for the set is kept
// (so hand-curated manualDex/secrets survive re-runs); --force regenerates it.

const url = process.argv[2]
const rest = process.argv.slice(3)
if (!url || !url.includes('pokepricelab.com')) {
	console.error('usage: bun run import.ts <pokepricelab-catalog-url> [--repo <cards-database>] [--force]')
	process.exit(1)
}
const repoIdx = rest.indexOf('--repo')
const repo = repoIdx !== -1 ? rest[repoIdx + 1] : '../cards-database'

function run(args: string[], pipe = false): string {
	const r = Bun.spawnSync(['bun', 'run', ...args], {
		cwd: import.meta.dir,
		stdout: pipe ? 'pipe' : 'inherit',
		stderr: 'inherit',
	})
	if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
	return pipe ? r.stdout.toString() : ''
}

const out = run(['config.ts', url, ...rest], true)
process.stdout.write(out)
const m = out.match(/^config: configs\/(.+)\.config\.json/m)
if (!m) {
	console.error('config.ts did not report a config file')
	process.exit(1)
}
const setId = m[1]

console.log(`\n=== scrape.ts ${setId}`)
run(['scrape.ts', setId])
console.log(`\n=== generate.ts ${setId} --repo ${repo}`)
run(['generate.ts', setId, '--repo', repo])
console.log(`\ndone — review with: git -C ${repo} status`)
