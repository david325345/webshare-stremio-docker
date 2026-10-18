# Nástroje pro kontrolu archivu hledání

Addon jednou za 48 h nahraje anonymní archiv hledání do
`david325345/nimetodex-media/hledani/RRRR-MM-DD.jsonl.gz` (env `GH_ARCHIVE_*`).
Noční kontrola ho projde těmito nástroji a report uloží do `nimetodex-media/reports/`.

| Nástroj | Použití |
|---|---|
| `analyze.py` | `python3 -I tools/analyze.py archiv.jsonl.gz [… ] [--od ISO]` → Markdown souhrn: rychlost, hledání bez výsledku / s málo výsledky, kandidáti na chybné vyřazení (❓), zkomolené názvy, pravidla roku/délky/rebootu |
| `replay.js` | `node tools/replay.js <stará verze> <nová verze> archiv…` → co by nová verze parseru přidala/odebrala |
| `addcases.js` | `node tools/addcases.js . tt123:1:2,tt456 archiv…` a pak `node test/regrese.js --update` → přidá tituly do regresního testu |
| `../test/regrese.js` | `node test/regrese.js` → regresní test parseru (musí projít beze změn) |

Pravidla práce (David): komunikace česky; **žádný kód bez předchozího souhlasu** (nejdřív návrh, pak souhlas);
nasazení dělá David ručně v Coolify. Noční kontrola proto jen analyzuje a navrhuje, kód nemění.
