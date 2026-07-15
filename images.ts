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

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { UA, fetchCached, loadConfig } from './lib'

const setId = process.argv[2]
if (!setId) {
	console.error('usage: bun run images.ts <SET>')
	process.exit(1)
}
const config = loadConfig(setId)
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
	`https://limitlesstcg.com/cards/jp/${setId}?display=list`,
	`${CACHE}/limitless-list.html`
)

// row thumbnails carry the full image URL with an _XS size suffix
const images = new Map<number, string>()
for (const row of listHtml.matchAll(new RegExp(`<tr[^>]*data-hover="([^"]*/tpc/${setId}/[^"]*)"[^>]*>([\\s\\S]*?)</tr>`, 'g'))) {
	const link = row[2].match(new RegExp(`<a href="/cards/jp/${setId}/(\\d+)">`))
	if (link) images.set(parseInt(link[1], 10), row[1].replace(/_XS\.png$/, '.png'))
}
if (!images.size) throw new Error(`no card rows on the limitless list page for ${setId}`)

let fresh = 0
for (const [num, url] of [...images.entries()].sort((a, b) => a[0] - b[0])) {
	if (await download(url, `${DIR}/${String(num).padStart(3, '0')}.png`)) fresh += 1
}

const symbol = listHtml.match(/<img class="set"[^>]*src="([^"]+)"/)
if (!symbol) throw new Error('no set symbol on the limitless list page')
if (await download(symbol[1], `${DIR}/symbol.png`)) fresh += 1

const missing = Array.from({ length: config.totalCards }, (_, i) => i + 1).filter((n) => !images.has(n))
console.log(`images/${setId}: ${images.size} cards + symbol (${fresh} new)${missing.length ? ` — limitless has no scans yet for: ${missing.join(', ')}` : ''}`)
