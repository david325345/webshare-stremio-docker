// Webshare — Stremio / Nuvio addon pro Webshare.cz
// Každý uživatel má vlastní odkaz s configem (base64url JSON) v cestě URL.
// Hledání, parser a řazení jsou v lib/engine.js (sdílené s pluginem pro Nuvio na Apple TV).

const express = require('express');
const needle = require('needle');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('./matcher');
const E = require('./lib/engine');
const { CACHE_DIR, config: { INDEXER_URL, INDEXER_FALLBACK_URL, CSFD_ON, CSFD_URL, CSFD_FALLBACK_URL, TMDB_API_KEY, HELLSPY_PROXY, HELLSPY_ON } } = require('./lib/platform');
const {
    log, TTLCache, H, linkCache, tmdbCache, resolveCache, hasWs, hsOn,
    who, userKey, WsError, wsLogin, withToken, wsFileLink, wsUserData, hsSearch,
    hsDetail, convHeight, hsMeta, csfdToInfo, needsCzName, withCsfdCzName, seasonBase, longCut,
    buildPlan, buildQueries, judgeFile, filterFiles, olderSameFromReasons, describe, rankFiles, durationMismatch,
    durationFilter, rescueOlderSeries, expandHellspy, handleStream, handleCatalog, handleCatalogHs, handleMeta, md5crypt,
    dbg, hsDown
} = E;

const VERSION = '8.11.0';
const PORT = process.env.PORT || 7000;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');

// archiv hledání a verze pro jádro; trvalá cache na disk každé 2 min a při ukončení
E.hooks.version = VERSION;
E.hooks.archiveOn = () => archiveOk;
E.hooks.archive = rec => archiveWrite(rec);
setInterval(E.saveCaches, 2 * 60 * 1000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { E.saveCaches(); process.exit(0); });

// ───────────────────────── Config v URL ─────────────────────────
// Platný config: účet Webshare, nebo jen Hellspy ({ hellspy: true } bez účtu)
function decodeConfig(b64) {
    try {
        const cfg = JSON.parse(Buffer.from(decodeURIComponent(b64), 'base64').toString('utf8'));
        if (!cfg || typeof cfg !== 'object') return null;
        const ws = typeof cfg.username === 'string' && typeof cfg.password === 'string' && cfg.username && cfg.password;
        if (!ws) {
            if (cfg.hellspy !== true) return null;
            delete cfg.username; delete cfg.password;
        }
        return cfg;
    } catch (e) {
        return null;
    }
}


// /eyJ.../stream/... → /[config:jméno]/stream/...   (Coolify maže <…>, proto hranaté závorky)
function maskConfigInUrl(url) {
    return String(url).replace(/(^\/|[?&]config=)(eyJ[A-Za-z0-9_+=%-]+)/g, (m, prefix, b64) => {
        const cfg = decodeConfig(b64);
        return `${prefix}[config:${cfg ? who(cfg) : '?'}]`;
    }).replace(/([?&]key=)[^&]+/g, '$1***');   // ADMIN_KEY nesmí do logu
}


function personalAddonId(username) {
    const hash = crypto.createHash('sha1').update(String(username || '').toLowerCase()).digest('hex').slice(0, 10);
    return `com.webshare.anime.${hash}`;
}

function baseUrl(req) {
    if (APP_URL) return APP_URL;
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
}


// ───────────────────────── Archiv hledání (anonymní) ─────────────────────────
// Každé hledání = 1 řádek JSON v ARCHIVE_DIR/RRRR-MM-DD.jsonl – bez uživatelských údajů.
// Slouží k ladění parseru: co Webshare vrátil, co prošlo/neprošlo a proč, co šlo do Stremia.
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, 'data', 'hledani');
const ARCHIVE_DAYS = parseInt(process.env.ARCHIVE_DAYS || '30', 10) || 30;
const ARCHIVE_ON = !/^(0|false|no)$/i.test(process.env.ARCHIVE || '');
let archiveOk = ARCHIVE_ON;
if (archiveOk) {
    try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); fs.accessSync(ARCHIVE_DIR, fs.constants.W_OK); }
    catch (e) { archiveOk = false; log(`⚠️ archiv hledání vypnutý – ${ARCHIVE_DIR} není zapisovatelný (${e.message})`); }
}

function archiveWrite(rec) {
    if (!archiveOk) return;
    const file = path.join(ARCHIVE_DIR, `${rec.t.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify(rec) + '\n', err => {
        if (err && archiveOk) { archiveOk = false; log(`⚠️ archiv hledání vypnutý – zápis selhal (${err.message})`); }
    });
}

// Smaže soubory archivu starší než ARCHIVE_DAYS (při startu a pak jednou denně)
function archiveCleanup() {
    if (!archiveOk) return;
    const limit = new Date(Date.now() - ARCHIVE_DAYS * 24 * H).toISOString().slice(0, 10);
    fs.readdir(ARCHIVE_DIR, (err, names) => {
        if (err) return;
        names.filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) < limit)
            .forEach(n => fs.unlink(path.join(ARCHIVE_DIR, n), () => {}));
    });
}
archiveCleanup();
setInterval(archiveCleanup, 24 * H).unref();

// ───────────────────────── Manifest ─────────────────────────
const SEARCH_CATALOG = { type: 'movie', id: 'webshare_search', name: 'Webshare Hledat', extra: [{ name: 'search', isRequired: true }] };
const SEARCH_CATALOG_HS = { type: 'movie', id: 'hellspy_search', name: 'Hellspy Hledat', extra: [{ name: 'search', isRequired: true }] };

function buildManifest(base, cfg) {
    const withCatalog = hasWs(cfg) && cfg.enable_direct_search !== false;
    const withHsCatalog = hsOn(cfg) && cfg.hellspy_search !== false;
    const catalogs = [...(withCatalog ? [SEARCH_CATALOG] : []), ...(withHsCatalog ? [SEARCH_CATALOG_HS] : [])];
    const prefixes = ['tt', 'kitsu', ...(CSFD_ON ? ['csfd:'] : []), 'webshare', ...(HELLSPY_ON ? ['hellspy'] : [])];
    return {
        id: cfg ? personalAddonId(who(cfg)) : 'com.webshare.anime',
        version: VERSION,
        name: 'Webshare',
        description: cfg && !hasWs(cfg)
            ? 'Filmy, seriály a anime z Hellspy – české a slovenské názvy, CZ/SK dabing a titulky na prvním místě.'
            : `Filmy, seriály a anime z Webshare.cz${hsOn(cfg) ? ' a Hellspy' : ''} – české a slovenské názvy, CZ/SK dabing a titulky na prvním místě.`,
        logo: `${base}/logo.png`,
        background: `${base}/webshare-backdrop.jpg`,
        // meta jen pro soubory z katalogu (webshare-…); metadata filmů a seriálů dodává Cinemeta
        resources: [
            { name: 'stream', types: ['movie', 'series'], idPrefixes: prefixes },
            { name: 'meta', types: ['movie', 'series'], idPrefixes: ['webshare', ...(HELLSPY_ON ? ['hellspy'] : [])] },
            ...(catalogs.length ? ['catalog'] : [])
        ],
        types: ['movie', 'series'],
        idPrefixes: prefixes,
        catalogs,
        behaviorHints: { configurable: true, configurationRequired: !cfg, adult: false, p2p: false }
    };
}

// ───────────────────────── Konfigurační stránka ─────────────────────────
const PAGE_PATH = path.join(__dirname, 'views', 'configure.html');
function renderPage(prefill) {
    const html = fs.readFileSync(PAGE_PATH, 'utf8');
    const json = JSON.stringify(prefill || null).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
    return html
        .replace('/*__PREFILL__*/null', json)
        .replace(/__VERSION__/g, VERSION)
        .replace('/*__SERVER_TMDB__*/false', TMDB_API_KEY ? 'true' : 'false')
        .replace('/*__HELLSPY__*/false', HELLSPY_ON ? 'true' : 'false');
}

// ───────────────────────── Express ─────────────────────────
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
// JSON těla do 10 kB; archiv hledání z pluginu (/api/archive) má vlastní větší limit
const json10kb = express.json({ limit: '10kb' });
app.use((req, res, next) => (req.path === '/api/archive' ? next() : json10kb(req, res, next)));

app.use((req, res, next) => {
    if (!/\.(png|jpg|ico|svg|css)$/i.test(req.path)) log(`📥 ${req.method} ${maskConfigInUrl(req.originalUrl)}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

const sendPage = prefill => (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderPage(prefill));
};
app.get('/', sendPage(null));
app.get('/configure', sendPage(null));

app.get('/manifest.json', (req, res) => res.json(buildManifest(baseUrl(req), null)));

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, hellspy: HELLSPY_ON ? (hsDown() ? 'dočasně vypnutý' : 'zapnutý') : 'vypnutý' }));

// Ověření přihlášení z konfigurační stránky (jednoduchý limit 10 pokusů / min / IP)
const verifyHits = new TTLCache(5000);
app.post('/api/verify', async (req, res) => {
    const ip = req.ip || 'x';
    const n = (verifyHits.get(ip) || 0) + 1;
    verifyHits.set(ip, n, 60 * 1000);
    if (n > 10) return res.status(429).json({ ok: false, error: 'Příliš mnoho pokusů, zkus to za minutu.' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.json({ ok: false, error: 'Vyplň jméno i heslo.' });
    try {
        const token = await wsLogin(String(username).trim(), String(password));
        const ud = await wsUserData(token).catch(() => null);
        res.json({ ok: true, vip: ud ? ud.vip : null, vipDays: ud ? ud.vipDays : null });
    } catch (e) {
        res.json({ ok: false, error: e instanceof WsError ? e.message : 'Webshare teď neodpovídá, zkus to znovu.' });
    }
});

// Archiv hledání z pluginu pro Nuvio na Apple TV (volba „Pomoct vylepšit hledání“, výchozí vypnutá).
// Anonymní záznam stejného tvaru jako ze serveru: uloží se jen známá pole, čas serveru a via: 'nuvio'.
// Nic o uživateli (ani IP) se neukládá; limit 300 záznamů za hodinu na IP.
const archiveHits = new TTLCache(5000);
const REC_KEYS = new Set(['kind', 'v', 'src', 'type', 'id', 'anime', 'source', 'year', 'runtime', 'epRuntime', 'sameName', 'coll',
    'olderSame', 'deg', 'season', 'episode', 'alEpisode', 'alSeason', 'names', 'queries', 'ms', 'files', 'q', 'count', 'note']);
const FILE_KEYS = ['n', 's', 'ok', 'r', 'src', 'dup', 'len', 'av', 'conv', 'subs', 'au', 'res', 'se', 'sent'];
app.post('/api/archive', express.json({ limit: '512kb' }), (req, res) => {
    if (!archiveOk) return res.status(503).json({ ok: false });
    const ip = req.ip || 'x';
    const n = (archiveHits.get(ip) || 0) + 1;
    archiveHits.set(ip, n, 60 * 60 * 1000);
    if (n > 300) return res.status(429).json({ ok: false });
    const rec = req.body && req.body.record;
    if (!rec || typeof rec !== 'object' || !['stream', 'catalog'].includes(rec.kind) ||
        !Array.isArray(rec.files) || rec.files.length > 500) return res.status(400).json({ ok: false });
    const clean = { t: new Date().toISOString(), via: 'nuvio' };
    for (const [k, v] of Object.entries(rec)) if (REC_KEYS.has(k)) clean[k] = v;
    clean.files = rec.files.filter(f => f && typeof f === 'object' && typeof f.n === 'string')
        .map(f => Object.fromEntries(FILE_KEYS.filter(k => f[k] !== undefined).map(k => [k, f[k]])));
    archiveWrite(clean);
    res.json({ ok: true });
});

// Stažení archivu hledání: /admin/hledani.jsonl.gz?key=ADMIN_KEY[&dni=7]  (bez ADMIN_KEY vypnuto)
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
function adminOk(req) {
    const k = String(req.query.key || '');
    return ADMIN_KEY && k.length === ADMIN_KEY.length &&
        crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
}
function archiveFiles(days) {
    try {
        const names = fs.readdirSync(ARCHIVE_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
        return days ? names.slice(-days) : names;
    } catch (e) { return []; }
}
app.get('/admin/hledani', (req, res) => {
    if (!adminOk(req)) return res.status(404).json({ error: 'Nenalezeno' });
    const files = archiveFiles().map(n => {
        const st = fs.statSync(path.join(ARCHIVE_DIR, n));
        return { den: n.slice(0, 10), velikost: st.size };
    });
    res.json({ zapnuto: archiveOk, adresar: ARCHIVE_DIR, uchovavani_dni: ARCHIVE_DAYS, soubory: files });
});
app.get('/admin/hledani.jsonl.gz', (req, res) => {
    if (!adminOk(req)) return res.status(404).json({ error: 'Nenalezeno' });
    const days = parseInt(req.query.dni, 10) || 0;
    const names = archiveFiles(days);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="hledani-${new Date().toISOString().slice(0, 10)}.jsonl.gz"`);
    const gz = zlib.createGzip();
    gz.pipe(res);
    (function next(i) {
        if (i >= names.length) return gz.end();
        const rs = fs.createReadStream(path.join(ARCHIVE_DIR, names[i]));
        rs.on('error', () => next(i + 1));
        rs.on('end', () => next(i + 1));
        rs.pipe(gz, { end: false });
    })(0);
});

// ───────────────────────── Nahrávání archivu na GitHub ─────────────────────────
// Jednou za GH_ARCHIVE_HOURS (výchozí 48 h) v GH_ARCHIVE_HOUR (výchozí 3:00 Europe/Prague) nahraje záznamy
// od posledního nahrání jako GH_ARCHIVE_PATH/RRRR-MM-DD.jsonl.gz do GH_ARCHIVE_REPO (GitHub Contents API).
// Bez GH_ARCHIVE_TOKEN vypnuto. Stav (čas posledního záznamu) v ARCHIVE_DIR/.github-upload.json.
const GH_REPO = (process.env.GH_ARCHIVE_REPO || '').trim();
const GH_TOKEN = (process.env.GH_ARCHIVE_TOKEN || '').trim();
const GH_PATH = (process.env.GH_ARCHIVE_PATH || 'hledani').trim().replace(/^\/+|\/+$/g, '');
const GH_HOURS = parseFloat(process.env.GH_ARCHIVE_HOURS || '48') || 48;
const GH_HOUR = parseInt(process.env.GH_ARCHIVE_HOUR || '3', 10);
const GH_ON = !!(GH_REPO && GH_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(GH_REPO));
const GH_STATE = path.join(ARCHIVE_DIR, '.github-upload.json');
let ghBusy = false, ghLastFail = 0;

function ghState() {
    try { return JSON.parse(fs.readFileSync(GH_STATE, 'utf8')); } catch (e) { return {}; }
}
function pragueHour(d = new Date()) {
    return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false }).format(d), 10) % 24;
}
function pragueDate(d = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(d);   // RRRR-MM-DD
}
// Záznamy novější než `since` (ISO) ze souborů archivu
function archiveSince(since) {
    const fromDay = since ? since.slice(0, 10) : '';
    const out = [];
    let lastT = since || '';
    for (const n of archiveFiles()) {
        if (n.slice(0, 10) < fromDay) continue;
        let text;
        try { text = fs.readFileSync(path.join(ARCHIVE_DIR, n), 'utf8'); } catch (e) { continue; }
        for (const line of text.split('\n')) {
            if (!line) continue;
            const m = line.match(/^\{"t":"([^"]+)"/);
            const t = m ? m[1] : '';
            if (since && t && t <= since) continue;
            out.push(line);
            if (t > lastT) lastT = t;
        }
    }
    return { lines: out, lastT };
}
async function ghPut(name, buf, message) {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH ? GH_PATH + '/' : ''}${name}`;
    const resp = await needle('put', url, { message, content: buf.toString('base64') }, {
        json: true, open_timeout: 15000, response_timeout: 60000, read_timeout: 60000,
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'webshare-stremio-addon', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    return resp.statusCode;
}
async function ghUpload(reason) {
    if (!GH_ON) return { ok: false, error: 'vypnuto (chybí GH_ARCHIVE_REPO / GH_ARCHIVE_TOKEN)' };
    if (ghBusy) return { ok: false, error: 'nahrávání už běží' };
    ghBusy = true;
    try {
        const st = ghState();
        const { lines, lastT } = archiveSince(st.lastT);
        if (!lines.length) {
            fs.writeFileSync(GH_STATE, JSON.stringify({ ...st, last: new Date().toISOString() }));
            log(`☁️ GitHub archiv: nic nového k nahrání (${reason})`);
            return { ok: true, zaznamu: 0 };
        }
        const buf = zlib.gzipSync(Buffer.from(lines.join('\n') + '\n'), { level: 9 });
        const day = pragueDate();
        const msg = `Historie hledání ${day} (${lines.length} záznamů, v${VERSION})`;
        let name = `${day}.jsonl.gz`;
        let code = await ghPut(name, buf, msg);
        if (code === 422) {   // soubor toho dne už existuje (ruční nahrání) → s časem
            const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(':', '');
            name = `${day}-${hm}.jsonl.gz`;
            code = await ghPut(name, buf, msg);
        }
        if (code !== 201 && code !== 200) {
            ghLastFail = Date.now();
            const why = code === 401 ? 'neplatný token' : code === 403 ? 'token nemá právo zápisu' : code === 404 ? 'repo nenalezeno' : `HTTP ${code}`;
            log(`⚠️ GitHub archiv: nahrání selhalo – ${why}; další pokus za hodinu`);
            return { ok: false, error: why };
        }
        fs.writeFileSync(GH_STATE, JSON.stringify({ last: new Date().toISOString(), lastT, file: name, count: lines.length }));
        log(`☁️ GitHub archiv: nahráno ${GH_PATH}/${name} (${lines.length} záznamů, ${Math.round(buf.length / 1024)} kB, ${reason})`);
        return { ok: true, soubor: `${GH_PATH}/${name}`, zaznamu: lines.length, kB: Math.round(buf.length / 1024) };
    } catch (e) {
        ghLastFail = Date.now();
        log(`⚠️ GitHub archiv: nahrání selhalo – ${e.message}; další pokus za hodinu`);
        return { ok: false, error: e.message };
    } finally {
        ghBusy = false;
    }
}
// kontrola každých 10 min: uplynulo GH_HOURS (s rezervou 1 h) a je GH_HOUR, nebo už o 24 h déle (výpadek přes noc)
function ghTick() {
    if (!GH_ON || !archiveOk || ghBusy || Date.now() - ghLastFail < H) return;
    const st = ghState();
    const since = st.last ? Date.now() - Date.parse(st.last) : Infinity;
    if ((since >= (GH_HOURS - 1) * H && pragueHour() === GH_HOUR) || since >= (GH_HOURS + 24) * H) ghUpload('plán');
}
if (GH_ON) {
    // první spuštění: počítat od teď (nahraje se v nejbližší plánovaný čas po GH_HOURS), ne hned po startu
    if (!fs.existsSync(GH_STATE) && archiveOk) {
        try { fs.writeFileSync(GH_STATE, JSON.stringify({ last: new Date(Date.now() - (GH_HOURS - 24) * H).toISOString() })); } catch (e) {}
    }
    setInterval(ghTick, 10 * 60 * 1000).unref();
}
// ruční nahrání: /admin/github-upload?key=ADMIN_KEY
app.get('/admin/github-upload', async (req, res) => {
    if (!adminOk(req)) return res.status(404).json({ error: 'Nenalezeno' });
    res.json(await ghUpload('ručně'));
});

// Osobní routy – config je první segment cesty
function withCfg(handler) {
    return async (req, res) => {
        const cfg = decodeConfig(req.params.cfg);
        if (!cfg) return res.status(400).json({ error: 'Neplatný odkaz addonu' });
        try {
            await handler(req, res, cfg);
        } catch (e) {
            log(`❌ ${req.method} ${maskConfigInUrl(req.path)}: ${e.message}`);
            if (!res.headersSent) res.status(500).json({ error: 'Chyba serveru' });
        }
    };
}

app.get('/:cfg/configure', (req, res) => {
    const cfg = decodeConfig(req.params.cfg);
    sendPage(cfg ? {
        username: cfg.username || '', password: cfg.password || '',
        tmdb_api_key: cfg.tmdb_api_key || '', enable_direct_search: cfg.enable_direct_search !== false,
        hellspy: cfg.hellspy !== false, hellspy_search: cfg.hellspy_search !== false
    } : null)(req, res);
});

app.get('/:cfg/manifest.json', withCfg(async (req, res, cfg) => {
    log(`📦 manifest [${who(cfg)}]`);
    res.json(buildManifest(baseUrl(req), cfg));
}));

app.get('/:cfg/stream/:type/:id.json', withCfg(async (req, res, cfg) => {
    let streams = [];
    try {
        streams = await handleStream(req.params.type, req.params.id, cfg, baseUrl(req), req.params.cfg);
    } catch (e) {
        log(`❌ stream ${req.params.id} [${who(cfg)}]: ${e.message}`);
    }
    // krátká cache v klientovi – výsledky drží server sám 30 min, opravy se tak projeví do minuty
    res.setHeader('Cache-Control', streams.length ? 'max-age=60' : 'no-store');
    res.json({ streams });
}));

function parseExtra(str) {
    const extra = {};
    String(str || '').replace(/\.json$/, '').split('&').forEach(pair => {
        const i = pair.indexOf('=');
        if (i > 0) extra[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return extra;
}

app.get(['/:cfg/catalog/:type/:id/:extra.json', '/:cfg/catalog/:type/:id.json'], withCfg(async (req, res, cfg) => {
    let metas = [];
    if (req.params.id === 'webshare_search' || req.params.id === 'hellspy_search') {
        try {
            const fn = req.params.id === 'hellspy_search' ? handleCatalogHs : handleCatalog;
            metas = await fn(req.params.type, parseExtra(req.params.extra), cfg, baseUrl(req));
        } catch (e) {
            log(`❌ katalog ${req.params.id} [${who(cfg)}]: ${e.message}`);
        }
    }
    res.json({ metas });
}));

app.get('/:cfg/meta/:type/:id.json', withCfg(async (req, res, cfg) => {
    const meta = await handleMeta(req.params.type, req.params.id, cfg, baseUrl(req));
    if (!meta) return res.status(404).json({ err: 'not found' });
    res.json({ meta });
}));

// Odkaz na soubor se vytváří až při přehrání (rychlejší seznam streamů, odkaz nevyprší)
app.get('/:cfg/play/:ident/:name?', withCfg(async (req, res, cfg) => {
    if (!hasWs(cfg)) return res.status(404).type('text/plain').send('Addon je nastavený bez účtu Webshare.');
    const ident = req.params.ident;
    const key = `${userKey(cfg)}:${ident}`;
    let link = linkCache.get(key);
    if (!link) {
        const r = await withToken(cfg, t => wsFileLink(t, ident));
        if (!r.link) {
            log(`⛔ play ${ident} [${who(cfg)}] – odkaz nedostupný (${r.message || 'neznámá chyba'})`);
            return res.status(404).type('text/plain').send('Soubor není dostupný (smazaný, nebo účet bez VIP).');
        }
        link = r.link;
        linkCache.set(key, link, 15 * 60 * 1000);
        log(`▶️ play ${ident} [${who(cfg)}]`);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, link);
}));

// Hellspy: detail přes proxy (v paměti max 6 h, odkazy platí ~24 h) → přesměrování na převod
app.get('/:cfg/hs/play/:id/:hash/:q/:name?', withCfg(async (req, res, cfg) => {
    if (!HELLSPY_ON) return res.status(404).type('text/plain').send('Hellspy není na serveru zapnutý.');
    const { id, hash, q } = req.params;
    let d = null;
    try { d = await hsDetail(id, hash); } catch (e) { log(`⛔ hellspy play ${id} [${who(cfg)}] – ${e.message}`); }
    const keys = d ? Object.keys(d.conv).sort((a, b) => convHeight(b) - convHeight(a)) : [];
    const link = d && (d.conv[q] || (keys.length ? d.conv[keys[0]] : null));
    if (!link) return res.status(404).type('text/plain').send('Soubor na Hellspy není dostupný.');
    log(`▶️ hellspy play ${id} ${q} [${who(cfg)}]`);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, link);
}));
app.get('/:cfg/hs/sub/:id/:hash/:idx.vtt', withCfg(async (req, res, cfg) => {
    if (!HELLSPY_ON) return res.status(404).end();
    const { id, hash } = req.params;
    let d = null;
    try { d = await hsDetail(id, hash); } catch (e) { dbg(`hellspy sub ${id}: ${e.message}`); }
    const sub = d && d.subs[parseInt(req.params.idx, 10)];
    if (!sub) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, sub.url);
}));

app.use((req, res) => res.status(404).json({ error: 'Nenalezeno' }));

if (require.main === module) {
    app.listen(PORT, () => {
        log(`🚀 Webshare ${VERSION} běží na portu ${PORT}`);
        log(`   indexer: ${INDEXER_URL} (záloha ${INDEXER_FALLBACK_URL}) | serverový TMDB klíč: ${TMDB_API_KEY ? 'ano' : 'ne'}`);
        log(`   ČSFD (csfd: ID): ${CSFD_ON ? `${CSFD_URL} (záloha ${CSFD_FALLBACK_URL})` : 'vypnuté'}`);
        log(`   cache: ${CACHE_DIR} (TMDB ${tmdbCache.map.size}, indexer ${resolveCache.map.size} záznamů)`);
        log(`   Hellspy: ${HELLSPY_ON ? (HELLSPY_PROXY === 'direct' ? 'zapnutý (bez proxy)' : `zapnutý přes proxy ${HELLSPY_PROXY.replace(/\/\/[^@/]*@/, '//***@')}`) : 'vypnutý (chybí HELLSPY_PROXY)'}`);
        log(`   archiv hledání: ${archiveOk ? `${ARCHIVE_DIR} (${ARCHIVE_DAYS} dní)` : 'vypnutý'} | stažení: ${ADMIN_KEY ? '/admin/hledani.jsonl.gz?key=…' : 'vypnuté (chybí ADMIN_KEY)'}`);
        log(`   GitHub archiv: ${GH_ON ? `${GH_REPO}/${GH_PATH} každých ${GH_HOURS} h v ${GH_HOUR}:00` : 'vypnutý (chybí GH_ARCHIVE_REPO / GH_ARCHIVE_TOKEN)'}`);
    });
}

module.exports = {
    csfdToInfo,
    seasonBase, longCut, durationFilter, needsCzName, withCsfdCzName, olderSameFromReasons, rescueOlderSeries, app, hsSearch, hsDetail, hsMeta, describe, expandHellspy, buildPlan, buildQueries, filterFiles, judgeFile, rankFiles, durationMismatch, decodeConfig, maskConfigInUrl, md5crypt };
