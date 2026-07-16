// Downloads the set's card scans and set symbol into images/<SET>/.
//
//   bun run images.ts M5
//
// Layout (for uploading alongside a pull request):
//   images/<SET>/001.png … <NNN>.png   full-size card scans (limitless CDN, the
//                                      URLs are taken verbatim from the set list page)
//   images/<SET>/symbol.png            set symbol
//
// Cards limitless does not list yet (fresh secret rares) are reported, not fatal.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { ENERGY_CODES, UA, fetchCached, loadConfig } from './lib'

const setId = process.argv[2]
if (!setId) {
	console.error('usage: bun run images.ts <SET>')
	process.exit(1)
}
const config = loadConfig(setId)
const LL = config.limitlessId ?? config.setId
const CACHE = `${import.meta.dir}/out/${setId}/cache`
const DIR = `${import.meta.dir}/images/${setId}`
mkdirSync(DIR, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function download(url: string, file: string): Promise<boolean> {
	if (existsSync(file) && statSync(file).size > 0) return false
	const res = await fetch(url, { headers: { 'User-Agent': UA } })
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
	writeFileSync(file, Buffer.from(await res.arrayBuffer()))
	await sleep(300)
	return true
}

const listHtml = await fetchCached(
	`https://limitlesstcg.com/cards/jp/${LL}?display=list`,
	`${CACHE}/limitless-list.html`
)

// row thumbnails carry the full image URL with an _XS size suffix; letter rows are the
// deck's basic energies and are saved under their tcgdex code (G → GRA.png)
const images = new Map<number, string>()
const energyImages = new Map<string, string>()
for (const row of listHtml.matchAll(new RegExp(`<tr[^>]*data-hover="([^"]*/tpc/${LL}/[^"]*)"[^>]*>([\\s\\S]*?)</tr>`, 'g'))) {
	const url = row[1].replace(/_XS\.png$/, '.png')
	const link = row[2].match(new RegExp(`<a href="/cards/jp/${LL}/(\\d+)">`))
	if (link) {
		images.set(parseInt(link[1], 10), url)
		continue
	}
	const letter = row[2].match(new RegExp(`<a href="/cards/jp/${LL}/([A-Z])">`))
	if (letter && ENERGY_CODES[letter[1]]) energyImages.set(ENERGY_CODES[letter[1]].code, url)
}
if (!images.size) throw new Error(`no card rows on the limitless list page for ${LL}`)

let fresh = 0
for (const [num, url] of [...images.entries()].sort((a, b) => a[0] - b[0])) {
	if (await download(url, `${DIR}/${String(num).padStart(3, '0')}.png`)) fresh += 1
}
for (const [code, url] of [...energyImages.entries()].sort()) {
	if (await download(url, `${DIR}/${code}.png`)) fresh += 1
}

const symbol = listHtml.match(/<img class="set"[^>]*src="([^"]+)"/)
if (!symbol) throw new Error('no set symbol on the limitless list page')
if (await download(symbol[1], `${DIR}/symbol.png`)) fresh += 1

// ---------- fallbacks for cards limitless has no scan of (fresh secret rares) ----------
// 1) the official database's large scans (748×1044), 2) pokepricelab's CDN thumbnails
// (255×361, last resort); non-png sources are converted via sips where available

const pad = (n: number) => String(n).padStart(3, '0')

function toPng(src: string, dest: string): boolean {
	const r = Bun.spawnSync(['sips', '-s', 'format', 'png', src, '--out', dest], { stdout: 'ignore', stderr: 'ignore' })
	if (r.exitCode !== 0) return false
	unlinkSync(src)
	return true
}

async function fetchFallback(url: string, n: number, ext: string): Promise<boolean> {
	const png = `${DIR}/${pad(n)}.png`
	const raw = `${DIR}/${pad(n)}.${ext}`
	if ([png, raw].some((f) => existsSync(f) && statSync(f).size > 0)) return true
	try {
		if (await download(url, raw)) fresh += 1
	} catch {
		return false
	}
	if (!toPng(raw, png)) console.log(`note: ${pad(n)}.${ext} kept unconverted (sips unavailable/failed)`)
	return true
}

// promo numbering is gapped — only numbers that exist anywhere count as missing
const missing = Array.from({ length: config.totalCards }, (_, i) => i + 1)
	.filter((n) => !images.has(n) && (config.promo !== true || config.cardmarketIds[String(n)] != null))
const CACHE_DIR = `${import.meta.dir}/out/${setId}/cache`
let official = 0
let ppl = 0
if (missing.length && existsSync(CACHE_DIR)) {
	// official large scans, mapped via the cached search listing + card pages
	const thumbs = new Map<number, string>()
	for (const f of readdirSync(CACHE_DIR).filter((x) => /^official-api-.+\.json$/.test(x))) {
		const d = JSON.parse(readFileSync(`${CACHE_DIR}/${f}`, 'utf-8')) as { cardList?: { cardID: string, cardThumbFile?: string }[] }
		for (const c of d.cardList ?? []) {
			const page = `${CACHE_DIR}/official-${c.cardID}.html`
			if (!c.cardThumbFile || !existsSync(page)) continue
			const col = readFileSync(page, 'utf-8').match(/&nbsp;(\d{3})&nbsp;\/&nbsp;/)
			if (col && !thumbs.has(parseInt(col[1], 10))) thumbs.set(parseInt(col[1], 10), `https://www.pokemon-card.com${c.cardThumbFile}`)
		}
	}
	for (let i = missing.length - 1; i >= 0; i--) {
		const url = thumbs.get(missing[i])
		if (url && await fetchFallback(url, missing[i], 'jpg')) {
			missing.splice(i, 1)
			official += 1
		}
	}
	// pokepricelab thumbnails from the probe caches
	const boot = `${import.meta.dir}/out/.bootstrap/${config.pplSlug ?? ''}`
	for (let i = missing.length - 1; i >= 0; i--) {
		const id = config.cardmarketIds[String(missing[i])]
		const probe = `${boot}/probe-${id}.html`
		if (id == null || !config.pplSlug || !existsSync(probe)) continue
		const h = readFileSync(probe, 'utf-8')
		const at = h.indexOf(`\\"cardmarket_id\\":${id}`)
		if (at === -1) continue
		const img = [...h.slice(Math.max(0, at - 2000), at).matchAll(/\\"image_url\\":\\"([^\\"]+)\\"/g)].pop()
		if (img && await fetchFallback(img[1], missing[i], 'webp')) {
			missing.splice(i, 1)
			ppl += 1
		}
	}
}

const sources = [official && `${official} from the official database`, ppl && `${ppl} from pokepricelab`].filter(Boolean).join(', ')
console.log(`images/${setId}: ${images.size + official + ppl} cards${energyImages.size ? ` + ${energyImages.size} energies` : ''} + symbol (${fresh} new${sources ? `; ${sources}` : ''})${missing.length ? ` — no scan anywhere for: ${missing.join(', ')}` : ''}`)
