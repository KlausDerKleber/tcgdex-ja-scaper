# tcgdex-ja-set-scraper

Deterministic scraper that builds [tcgdex/cards-database](https://github.com/tcgdex/cards-database)
`data-asia` files for new Japanese Pokémon TCG sets from their primary sources.

Every value in the generated files is copied verbatim from a source page (all HTTP
responses are cached under `out/<SET>/cache/` for auditing) — nothing is written
by hand or guessed. A whole set is imported from nothing but its pokepricelab
catalog URL:

```
bun run import.ts "https://pokepricelab.com/catalog?q=&set=abyss-eye&language=all&condition=all&grade=all" --repo ../cards-database
bun run import.ts "abyss eye"               # a set name works too
```

which chains the four steps (each also runs standalone):

```
bun run config.ts <pokepricelab-url|name>   # writes configs/<SET>.config.json
bun run scrape.ts M5                        # writes out/M5/cards.json (+ cache)
bun run generate.ts M5 --repo ../cards-database
bun run images.ts M5                        # images/M5/001.png … + symbol.png
cd ../cards-database && git diff            # → empty = every byte reproducible
```

The CP1 (Double Crisis), M4 (Ninja Spinner) and M5 (Abyss Eye) pull requests were
produced exactly this way and are byte-identical to the output of this tool.

## Sources

| Data | Source |
|---|---|
| Japanese names, attack/ability/trainer text, flavor text, national dex numbers, illustrators, official card count | `www.pokemon-card.com` card database (official) |
| Stage, evolves-from, weakness/resistance/retreat, rarity, regulation mark | `limitlesstcg.com` |
| Illustrators of secret rares (only when limitless/official do not list them yet) | `serebii.net` |
| `thirdParty.cardmarket` product ids | Cardmarket's public product catalog (`downloads.s3.cardmarket.com`); within an expansion the products sorted by id follow the collection numbers, verified against the sample rows pokepricelab renders |
| Set identification (which limitless/official set a pokepricelab URL means) | `pokepricelab.com` catalog page (set name + ≤10 sample cards with cardmarket ids) |

Rarity names are mapped to the ones used by `data-asia/M` since M1; the mapping was
derived from M3 (present in both databases) and cross-checked against Cardmarket.

Secret rares that are reprints carry the identical Japanese text of their main-set
base card. Gold trainer reprints without a base card in the set use the official
Japanese text of their most recent print from `www.pokemon-card.com`.

## Adding a new set

1. `bun run import.ts <pokepricelab-catalog-url> --repo <path-to-cards-database>`.
   `config.ts` derives everything itself: set id + Japanese name + release date +
   card count from limitless, the official `pg` product id + card count + the era's
   resistance value from pokemon-card.com, the cardmarket ids from Cardmarket's
   public catalog, and the `data-asia` serie from the repo. Each step fails loudly
   when a source disagrees.
2. Only when needed (the tools tell you): add `manualDex` entries for Pokémon whose
   official pages print no dex number (EX/Mega cards), and — when limitless does not
   list the secret rares yet — the `secrets` mapping plus `serebiiSlug`
   (see `M5.config.json`). An existing config is kept on re-runs, so curated
   entries survive; `scrape.ts`/`generate.ts` fail loudly on any inconsistency.
3. Validate: `tsc --noEmit` over the generated files, then commit.

Requires [Bun](https://bun.sh); no dependencies.
