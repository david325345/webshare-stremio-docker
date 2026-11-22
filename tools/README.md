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

## Plugin pro Nuvio (Apple TV)

Plugin Webshare (`david325345/nuvio-plugins`, složka `webshare/`) nemá vlastní parser: `webshare/build.mjs`
do `webshare/webshare.js` přibalí `lib/engine.js` a `matcher.js` z tohoto repozitáře. **Každá oprava parseru
proto znamená i nové sestavení pluginu:**

1. oprava v `lib/engine.js` / `matcher.js`, `npm test`, replay, verze addonu, push;
2. v `nuvio-plugins`: `node webshare/build.mjs ../webshare-stremio-docker`, zvýšit verzi pluginu
   (`webshare/src/plugin.js` a `webshare/manifest.json`), `npm test` – `test/webshare-sync.test.js` selže,
   dokud plugin není sestavený z aktuálního parseru –, push do `main` **i do větve `webshare`**
   (`git push origin main main:webshare`) – Nuvio má plugin nainstalovaný z odkazu
   `raw.githubusercontent.com/david325345/nuvio-plugins/webshare/webshare/manifest.json`.

Hledání z pluginu (volba „Pomoct vylepšit hledání“) chodí přes `POST /api/archive` do stejného archivu
s verzí `8.x.y+nuvio-1.z.w`; `analyze.py` upozorní, když plugin běží na starším jádře než addon.

Pravidla práce (David): komunikace česky; **žádný kód bez předchozího souhlasu** (nejdřív návrh, pak souhlas);
nasazení dělá David ručně v Coolify. Noční kontrola proto jen analyzuje a navrhuje, kód nemění.
