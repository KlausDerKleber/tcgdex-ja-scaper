// Shared helpers and types for the Japanese-set scraper.
// Zero dependencies — runs with plain Bun (native fetch).

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const UA = 'Mozilla/5.0 (compatible; ja-set-scraper/1.0)'

/** limitless letter code → energy type + tcgdex file code (cf. data-asia/S/SI: GRA.ts …)
 * + the Japanese type word (基本<jp>エネルギー is the basic energy's card name) */
export const ENERGY_CODES: Record<string, { type: string, code: string, jp: string }> = {
	G: { type: 'Grass', code: 'GRA', jp: '草' }, R: { type: 'Fire', code: 'FIR', jp: '炎' }, W: { type: 'Water', code: 'WAT', jp: '水' },
	L: { type: 'Lightning', code: 'LIG', jp: '雷' }, P: { type: 'Psychic', code: 'PSY', jp: '超' }, F: { type: 'Fighting', code: 'FIG', jp: '闘' },
	D: { type: 'Darkness', code: 'DAR', jp: '悪' }, M: { type: 'Metal', code: 'MET', jp: '鋼' }, Y: { type: 'Fairy', code: 'FAI', jp: 'フェアリー' },
}

export interface Ability {
	name: string
	effect: string
}

export interface Attack {
	name: string
	cost: string[]
	damage: string | null
	effect: string
}

/** One card as extracted from the sources (language: Japanese). */
export interface RawCard {
	num: number
	name: string
	category: 'Pokemon' | 'Trainer' | 'Energy'
	types: string[]
	hp: number | null
	stageRaw: string | null
	evolveFrom: string | null
	trainerType: string | null
	energyType: string | null
	abilities: Ability[]
	attacks: Attack[]
	weakness: string | null
	resistance: { type: string, value: string } | null
	retreat: number | null
	illustrator: string
	regulationMark: string | null
	rarity: string | null
	flavor: string | null
	/** an array for TAG TEAM cards (one entry per named Pokémon, print order) */
	dexId: number | number[] | null
	/** trainer/energy rules text */
	effect?: string
}

export interface SecretEntry {
	/** collection number of the main-set card this secret is a reprint of */
	base?: number
	/** gold staple without a base card in this set (text taken from its most recent official print) */
	staple?: { nameJa: string, trainerType: 'Item' | 'Tool' }
	/** secret basic energy (letter code, cf. ENERGY_CODES) */
	energy?: string
	/** reprint of a card from another set (era-wide alt arts, e.g. SM12a) — scraped from there */
	from?: { set: string, number: number }
	rarity: string
}

export interface SetConfig {
	setId: string
	nameJa: string
	/** English set name as limitless lists it (used for the PR text) */
	nameEn?: string
	/** pokepricelab set slug (probe caches under out/.bootstrap/<slug>/ hold e.g. image urls) */
	pplSlug?: string
	releaseDate: string
	/** data-asia serie directory the set belongs to (default: "M") */
	serie?: string
	/** false for sets printed before regulation marks existed (pre-2018) */
	regulationMarks?: boolean
	/** false for products whose cards carry no rarity at all (deck sets, cf. data-asia/S/SI) */
	rarities?: boolean
	/** rarities cardmarket knows but limitless does not list (number → data-asia rarity name) */
	rarityOverrides?: Record<string, string>
	/** resistance value of the set's era when the source omits it (default: "-30"; XY era: "-20") */
	resistanceValue?: string
	officialProductId: number | string
	officialCardCount: number
	totalCards: number
	/** ongoing promo series (M-P …): gapped, growing numbering; no secrets */
	promo?: boolean
	/** limitless set code when it differs from the tcgdex id (M-P is MP there) */
	limitlessId?: string
	/** serebii.net set slug, needed only when `secrets` is present (illustrators of secret rares) */
	serebiiSlug?: string
	/** dexIds the official pages do not print (ex/Mega cards); base species name → national dex id */
	manualDex: Record<string, number>
	/** collection number → cardmarket product id (from cardmarket.com set listing) */
	cardmarketIds: Record<string, number>
	/** unnumbered basic energies of deck products: limitless letter → cardmarket product id */
	energies?: Record<string, number>
	/** mirror-pattern reverse prints: number → cardmarket ids [energy pattern, ball pattern]
	 * plus the bracket-less cardmarket name (matches the English card for the ball foil) */
	reverses?: Record<string, { name: string, ids: [number, number] }>
	/** English print of the set under data/ (e.g. "Mega Evolution/Ascended Heroes") —
	 * source of the per-card ball foil of the reverse prints */
	enSet?: string
	/** foils of the two mirror prints in id order, when they differ from the default
	 * [energy, per-card ball] — e.g. ["pokeball", "masterball"] for SV2a */
	reverseFoils?: [string | null, string | null]
	/** secret rares not listed by the machine-readable sources; number → origin */
	secrets?: Record<string, SecretEntry>
}

export function loadConfig(setId: string): SetConfig {
	const path = `${import.meta.dir}/configs/${setId}.config.json`
	if (!existsSync(path)) throw new Error(`missing config: ${path}`)
	return JSON.parse(readFileSync(path, 'utf-8')) as SetConfig
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polite cached GET: every response is stored on disk so re-runs are reproducible and cheap. */
export async function fetchCached(url: string, cacheFile: string): Promise<string> {
	if (existsSync(cacheFile) && statSync(cacheFile).size > 300) {
		return readFileSync(cacheFile, 'utf-8')
	}
	const res = await fetch(url, { headers: { 'User-Agent': UA } })
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
	const text = await res.text()
	mkdirSync(dirname(cacheFile), { recursive: true })
	writeFileSync(cacheFile, text)
	await sleep(300)
	return text
}

/** Minimal HTML entity decoding (the sources only emit these in card data). */
export function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&nbsp;/g, ' ')
}

/** Decode entities and collapse whitespace — mirrors what the card text looks like on the page. */
export function clean(s: string): string {
	return decodeEntities(s).replace(/\s+/g, ' ').trim()
}

export function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, '')
}
