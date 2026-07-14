# tcgdex-ja-set-scraper

Deterministic scraper that builds [tcgdex/cards-database](https://github.com/tcgdex/cards-database)
`data-asia` files for new Japanese Pokémon TCG sets from their primary sources.

Every value in the generated files is copied verbatim from a source page (all HTTP
responses are cached under `out/<SET>/cache/` for auditing) — nothing is written
by hand or guessed. Anyone can re-run the tool and `git diff` the result against
a pull request to verify the data:

```
bun run scrape.ts M5
bun run generate.ts M5 --repo ../cards-database
cd ../cards-database && git diff        # → empty = every byte reproducible
```

The M4 (Ninja Spinner) and M5 (Abyss Eye) pull requests were produced exactly
this way and are byte-identical to the output of this tool.

## Sources

| Data | Source |
|---|---|
| Japanese names, attack/ability/trainer text, flavor text, national dex numbers, illustrators, official card count | `www.pokemon-card.com` card database (official) |
| Stage, evolves-from, weakness/resistance/retreat, rarity, regulation mark | `limitlesstcg.com` |
| Illustrators of secret rares (only when limitless/official do not list them yet) | `serebii.net` |
| `thirdParty.cardmarket` product ids | cardmarket.com set listing (static, in the set config) |

Rarity names are mapped to the ones used by `data-asia/M` since M1; the mapping was
derived from M3 (present in both databases) and cross-checked against Cardmarket.

Secret rares that are reprints carry the identical Japanese text of their main-set
base card. Gold trainer reprints without a base card in the set use the official
Japanese text of their most recent print from `www.pokemon-card.com`.

## Adding a new set

1. Create `configs/<SET>.config.json` (see `M5.config.json`): set id, Japanese name,
   release date, the `pg` product id from the official card search, card counts,
   cardmarket product ids, and — if the machine-readable sources do not list the
   secret rares yet — the secret→base mapping.
2. `bun run scrape.ts <SET>` — fails loudly on any inconsistency between the sources
   (name mismatches, missing rarities, wrong card counts).
3. `bun run generate.ts <SET> --repo <path-to-cards-database>`
4. Validate: `tsc --noEmit` over the generated files, then commit.

Requires [Bun](https://bun.sh); no dependencies.
