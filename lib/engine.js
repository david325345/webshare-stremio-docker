'use strict';
// Jádro hledání CzechShare (Webshare + Hellspy + Fastshare) – sdílené addonem (server.js) a pluginem pro Nuvio (nuvio-plugins/czechshare).
// Síť a ukládání dodává platforma (./platform): na serveru Node (needle, disk, proxy pro Hellspy),
// v pluginu fetch a localStorage. Logika hledání, parser a řazení jsou pro obě stejné.
const needle = require('needle');
const M = require('../matcher');
const P = require('./platform');

const { INDEXER_URL, INDEXER_FALLBACK_URL, CSFD_ON, CSFD_URL, CSFD_FALLBACK_URL, TMDB_API_KEY, HELLSPY_ON, HELLSPY_API, HTTP } = P.config;
const log = P.log, dbg = P.dbg;
const { PersistentCache, md5crypt } = P;

// Napojení na hostitele: verze do archivu, zápis archivu hledání (server: soubor, plugin: odeslání)
const hooks = { version: 'dev', archiveOn: () => false, archive: () => {} };
const archiveWrite = rec => { if (hooks.archiveOn()) hooks.archive(rec); };

// ───────────────────────── Cache s expirací ─────────────────────────
class TTLCache {
    constructor(max = 2000) { this.max = max; this.map = new Map(); }
    get(key) {
        const e = this.map.get(key);
        if (!e) return undefined;
        if (e.exp < Date.now()) { this.map.delete(key); return undefined; }
        return e.val;
    }
    set(key, val, ttlMs) {
        if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
        this.map.set(key, { val, exp: Date.now() + ttlMs });
    }
    delete(key) { this.map.delete(key); }
}

const H = 3600 * 1000;
const tokenCache = new TTLCache(500);     // přihlašovací tokeny Webshare (6 h)
const linkCache = new TTLCache(2000);     // odkazy na soubory (15 min)
const tmdbCache = new PersistentCache('tmdb');        // TMDB názvy (30 dní)
const resolveCache = new PersistentCache('resolve');  // resolve-ids (anime 30 dní, „není anime“ 2 dny)
const saveCaches = () => { tmdbCache.save(); resolveCache.save(); fileCache.save(); };
const resultCache = new TTLCache(3000);   // nalezené soubory pro dané ID (30 min, sdílené)
const lastFull = new TTLCache(1000);      // poslední úplný výsledek pro ID (24 h) – doplnění při výpadku zdroje
const inflight = new Map();               // souběžné stejné požadavky čekají na jeden výsledek

function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

const hasWs = cfg => !!(cfg && cfg.username && cfg.password);
// Hellspy je u starších instalací (bez volby) zapnutý, pokud ho server podporuje
const hsOn = cfg => HELLSPY_ON && !!cfg && cfg.hellspy !== false;
const hasFs = cfg => !!(cfg && cfg.fs_username && cfg.fs_password);
const who = cfg => (cfg && cfg.username) || (cfg && cfg.fs_username ? `fs:${cfg.fs_username}` : 'hellspy');
// Zdroj souboru: Webshare (bez příznaku), Hellspy (f.hs), Fastshare (f.fs). Délka je u Hellspy známá už z hledání,
// (u Fastshare taky), u Webshare až z file_info – pravidla délky a řazení se řídí tímhle, ne názvem zdroje.
const isWs = f => !f.hs && !f.fs;
const lenFromSearch = f => !!(f.hs || f.fs);
const srcLetter = f => (f.hs ? 'h' : f.fs ? 'f' : 'w');
// pořadí při stejné kvalitě: Webshare (originál, ověřený zvuk) → ostatní originály → Hellspy (převody)
const srcRank = f => (f.hs ? 2 : f.fs ? 1 : 0);

function userKey(cfg) {
    return P.sha1hex(`${cfg.username}\n${cfg.password}`);
}

// ───────────────────────── Webshare API ─────────────────────────
const WS_HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'text/xml; charset=UTF-8'
};

async function wsPost(endpoint, params) {
    const body = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const resp = await needle('post', `https://webshare.cz/api/${endpoint}/`, body, { headers: WS_HEADERS, ...HTTP });
    const ch = resp.body && resp.body.children;
    if (!Array.isArray(ch)) throw new Error(`Webshare ${endpoint}: neplatná odpověď (HTTP ${resp.statusCode})`);
    const get = name => { const el = ch.find(e => e.name === name); return el ? el.value : undefined; };
    return { ch, get, status: get('status') };
}

class WsError extends Error {}

async function wsLogin(username, password) {
    const s = await wsPost('salt', { username_or_email: username });
    if (s.status !== 'OK' || !s.get('salt')) throw new WsError('Neznámé uživatelské jméno');
    const hashed = P.sha1hex(md5crypt(password, s.get('salt')));
    const l = await wsPost('login', { username_or_email: username, password: hashed, keep_logged_in: 1 });
    if (l.status !== 'OK' || !l.get('token')) throw new WsError('Špatné jméno nebo heslo');
    return l.get('token');
}

// Token z cache (6 h); souběžné požadavky téhož uživatele se přihlásí jen jednou
async function getToken(cfg, fresh = false) {
    const key = userKey(cfg);
    if (!fresh) {
        const t = tokenCache.get(key);
        if (t) return { token: t, cached: true };
    }
    const token = await once(`login:${key}`, () => wsLogin(cfg.username, cfg.password));
    tokenCache.set(key, token, 6 * H);
    return { token, cached: false };
}

// Zavolá fn(token); když selže s tokenem z cache, přihlásí se znovu a zkusí to ještě jednou
async function withToken(cfg, fn) {
    const { token, cached } = await getToken(cfg);
    const r = await fn(token);
    if (r && r.authFailed && cached) {
        tokenCache.delete(userKey(cfg));
        const again = await getToken(cfg, true);
        return fn(again.token);
    }
    return r;
}

const lockedIdents = new Set();
function parseFiles(ch) {
    // soubory pod heslem nejdou přehrát → pryč hned z výsledků hledání
    lockedIdents.clear();
    ch.filter(el => el.name === 'file').forEach(el => {
        const pw = (el.children || []).find(k => k.name === 'password');
        if (pw && pw.value === '1') lockedIdents.add((el.children.find(k => k.name === 'ident') || {}).value);
    });
    return ch.filter(el => el.name === 'file').map(el => {
        const c = name => { const x = (el.children || []).find(k => k.name === name); return x ? x.value : undefined; };
        return {
            ident: c('ident'),
            name: c('name') || '',
            size: parseInt(c('size') || '0', 10) || 0,
            img: c('img') || null,
            pos: parseInt(c('positive_votes') || '0', 10) || 0,
            neg: parseInt(c('negative_votes') || '0', 10) || 0
        };
    }).filter(f => f.ident && f.name && !lockedIdents.has(f.ident));
}

async function wsSearch(token, query, limit = 50) {
    const r = await wsPost('search', { what: query, category: 'video', limit, offset: 0, wst: token });
    if (r.status !== 'OK') return { authFailed: r.status === 'FATAL', files: [] };
    return { files: parseFiles(r.ch) };
}

async function wsFileLink(token, ident) {
    const r = await wsPost('file_link', { ident, download_type: 'video_stream', force_https: 1, wst: token });
    if (r.status === 'OK' && r.get('link')) return { link: r.get('link') };
    return { authFailed: r.status === 'FATAL', link: null, message: r.get('message') || r.get('code') };
}

// file_info vrací (nezdokumentovaně) i délku, rozlišení a audio stopy s jazykem; titulky ne
const IMAGE_FORMATS = new Set(['MJPEG', 'PNG', 'JPEG', 'JPG', 'GIF', 'BMP', 'WEBP']);
function parseStreams(ch, tag) {
    const block = ch.find(e => e.name === tag);
    return ((block && block.children) || []).filter(e => e.name === 'stream').map(st => {
        const v = n => { const x = (st.children || []).find(k => k.name === n); return x && x.value != null ? String(x.value) : ''; };
        return { format: v('format').toUpperCase(), width: +v('width') || 0, height: +v('height') || 0,
                 channels: +v('channels') || 0, lang: v('language').toUpperCase() };
    });
}

async function wsFileInfo(token, ident) {
    const r = await wsPost('file_info', { ident, wst: token });
    if (r.status !== 'OK') {
        const code = r.get('code') || '';
        // FILE_INFO_FATAL_1 = soubor neexistuje → nedostupný (ne chyba přihlášení)
        if (/FILE_INFO_FATAL/.test(code)) return { info: null, missing: true };
        return { authFailed: r.status === 'FATAL', info: null };
    }
    const video = parseStreams(r.ch, 'video').filter(v => !IMAGE_FORMATS.has(v.format))[0] || null;
    const audio = parseStreams(r.ch, 'audio').map(a => ({ f: a.format, ch: a.channels, lang: a.lang }));
    return {
        info: {
            ident,
            name: r.get('name') || '',
            size: parseInt(r.get('size') || '0', 10) || 0,
            img: r.get('img') || null,
            description: r.get('description') || '',
            pos: parseInt(r.get('positive_votes') || '0', 10) || 0,
            neg: parseInt(r.get('negative_votes') || '0', 10) || 0,
            ok: r.get('available') !== '0' && r.get('removed') !== '1' && r.get('password') !== '1',
            len: parseInt(r.get('length') || '0', 10) || 0,
            w: video ? video.width : (parseInt(r.get('width') || '0', 10) || 0),
            h: video ? video.height : (parseInt(r.get('height') || '0', 10) || 0),
            vf: video ? video.format : String(r.get('format') || '').toUpperCase(),
            au: audio
        }
    };
}

async function wsUserData(token) {
    const r = await wsPost('user_data', { wst: token });
    if (r.status !== 'OK') return null;
    return { vip: r.get('vip') === '1', vipDays: parseInt(r.get('vip_days') || '0', 10) || 0 };
}

// ───────────────────────── Hellspy API ─────────────────────────
// hledání: id, title, fileHash, size, duration; detail: filename, conversions {720,1080…} (MP4), subtitles (VTT)
const HS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json', 'Origin': 'https://hellspy.to', 'Referer': 'https://hellspy.to/'
};
let hsDownUntil = 0, hsFailStreak = 0;   // vypnutí až po 3 chybách za sebou

// Odpověď Hellspy přes platformu (server: tunel přes proxy s CZ IP, plugin: napřímo z televize)
async function hsGet(pathq) {
    if (Date.now() < hsDownUntil) throw new Error('Hellspy dočasně vypnutý (předchozí chyba)');
    try {
        const resp = await P.hsRequest(HELLSPY_API + pathq, HS_HEADERS);
        let result;
        if (resp.status === 404) result = null;
        else if (resp.status !== 200) throw Object.assign(new Error(`Hellspy HTTP ${resp.status}`), { status: resp.status });
        else {
            try { result = JSON.parse(resp.text); } catch (e) { throw new Error('Hellspy: neplatná odpověď'); }
        }
        hsFailStreak = 0;
        return result;
    } catch (e) {
        // blokace / výpadek proxy → Hellspy krátce vynechat, Webshare jede dál
        // jedna výjimečná chyba (síť, pomalá proxy) nic nevypne; až 3 za sebou → 1 min pauza
        if (!e.status || e.status === 429 || e.status === 403 || e.status >= 500) {
            hsFailStreak++;
            if (hsFailStreak >= 3) {
                if (Date.now() >= hsDownUntil) log(`⚠️ Hellspy vynechán na 1 min (3 chyby za sebou): ${e.message}`);
                hsDownUntil = Date.now() + 60 * 1000;
                hsFailStreak = 0;
            }
        }
        throw e;
    }
}
const hsDown = () => Date.now() < hsDownUntil;

async function hsSearch(query, limit = 50) {
    const j = await hsGet(`/search?query=${encodeURIComponent(query)}&offset=0&limit=${Math.min(limit, 64)}`);
    return ((j && j.items) || []).filter(it => it && it.id && it.fileHash && it.title).map(it => ({
        hs: true, ident: `hs:${it.id}`, id: it.id, hash: String(it.fileHash),
        name: String(it.title), size: +it.size || 0, len: +it.duration || 0,
        img: Array.isArray(it.thumbs) && typeof it.thumbs[0] === 'string' ? it.thumbs[0].replace(/([^:])\/\/+/g, '$1/') : null
    }));
}

// Detail s odkazy (platí ~24 h) – v paměti 6 h; metadata (převody, jazyky titulků) trvale ve fileCache
const hsDetailCache = new TTLCache(3000);
async function hsDetail(id, hash) {
    const key = `${id}:${hash}`;
    const hit = hsDetailCache.get(key);
    if (hit !== undefined) return hit;
    return once(`hsd:${key}`, async () => {
        const j = await hsGet(`/video/${encodeURIComponent(id)}/${encodeURIComponent(hash)}`);
        const conv = j && j.conversions && typeof j.conversions === 'object' ? j.conversions : {};
        const d = j ? {
            title: String(j.title || j.filename || ''), size: +j.size || 0, duration: +j.duration || 0,
            thumb: Array.isArray(j.thumbs) && typeof j.thumbs[0] === 'string' ? j.thumbs[0].replace(/([^:])\/\/+/g, '$1/') : null,
            filename: j.filename || j.title || '',
            conv: Object.fromEntries(Object.entries(conv).filter(([, v]) => typeof v === 'string' && /^https?:/.test(v))),
            subs: (Array.isArray(j.subtitles) ? j.subtitles : []).filter(x => x && x.url)
                .map(x => ({ lang: String(x.language || x.title || '').toLowerCase().replace(/\d+$/, ''), url: x.url }))
        } : null;
        hsDetailCache.set(key, d, (d ? 6 : 1) * H);
        return d;
    });
}
// výška převodu: "0" = originál (výška neznámá)
const convHeight = k => (k === '0' ? 9999 : parseInt(k, 10) || 0);
function hsMeta(d) {
    if (!d) return { ok: false };
    const conv = Object.keys(d.conv).sort((a, b) => convHeight(b) - convHeight(a));
    return { ok: conv.length > 0, conv, subs: [...new Set(d.subs.map(s => s.lang).filter(Boolean))], fn: d.filename };
}

// ───────────────────────── Fastshare API ─────────────────────────
// Kodi API: přihlášení → hash (session), hledání s cookie FASTSHARE=<hash>. Délka a rozlišení jsou už
// v hledání, zvukové stopy ani titulky API nevrací (jazyk jen z názvu). Přehrání: download_url&stream=1&session=<hash>
// – odkaz se skládá až při přehrání, hash se do seznamu streamů nedává.
const FS_API = 'https://fastshare.cz/api/api_kodi.php';
const FS_HEADERS = { 'User-Agent': 'Kodi/20', Accept: 'application/json' };
const fsSessions = new TTLCache(500);     // session hash pro účet (55 min)
const fsFiles = new TTLCache(5000);       // soubory z hledání podle id (24 h) – katalog, meta, přehrání
class FsError extends Error {}            // špatné jméno nebo heslo – neopakovat
let fsDownUntil = 0, fsFailStreak = 0;    // jako Hellspy: po 3 chybách za sebou 1 min vynechat
const fsKey = cfg => P.sha1hex(`fastshare\n${cfg.fs_username}\n${cfg.fs_password}`);

async function fsGet(params, hash) {
    if (Date.now() < fsDownUntil) throw new Error('Fastshare dočasně vypnutý (předchozí chyba)');
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    try {
        const resp = await P.fsRequest(`${FS_API}?${qs}`, hash ? { ...FS_HEADERS, Cookie: `FASTSHARE=${hash}` } : FS_HEADERS);
        if (resp.status !== 200) throw Object.assign(new Error(`Fastshare HTTP ${resp.status}`), { status: resp.status });
        let j;
        try { j = JSON.parse(resp.text); } catch (e) { throw new Error('Fastshare: neplatná odpověď'); }
        fsFailStreak = 0;
        return j;
    } catch (e) {
        if (++fsFailStreak >= 3) {
            if (Date.now() >= fsDownUntil) log(`⚠️ Fastshare vynechán na 1 min (3 chyby za sebou): ${e.message}`);
            fsDownUntil = Date.now() + 60 * 1000;
            fsFailStreak = 0;
        }
        throw e;
    }
}

// Přihlášení → { hash, unlimited, creditMB } (hash se nikam neloguje)
async function fsLogin(name, password) {
    const j = await fsGet({ process: 'login', login: name, password });
    const u = j && j.user;
    if (!u || typeof u.hash !== 'string' || !/^[0-9a-f]{16,64}$/i.test(u.hash)) {
        const msg = j && (j.error || j.message || (u && u.error));
        throw new FsError(typeof msg === 'string' && msg.length < 200 ? `Fastshare: ${msg}` : 'Přihlášení k Fastshare se nepovedlo – zkontroluj jméno a heslo.');
    }
    const d = u.data || {};
    const mul = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 }[String(d.unit || 'MB').toUpperCase()] ?? 1;
    return { hash: u.hash, unlimited: u.unlimited === true || u.unlimited === 1 || u.unlimited === '1', creditMB: Math.round((parseFloat(d.value) || 0) * mul) };
}
// Session pro účet z configu; fresh = nové přihlášení (neplatný hash)
async function fsSession(cfg, fresh = false) {
    const key = fsKey(cfg);
    const hit = fsSessions.get(key);
    if (hit && hit.bad) throw new FsError(hit.bad);   // špatné údaje – další pokus až za 10 min
    if (hit && !fresh) return hit;
    return once(`fsl:${key}`, async () => {
        let r;
        try { r = await fsLogin(cfg.fs_username, cfg.fs_password); } catch (e) {
            if (e instanceof FsError) fsSessions.set(key, { bad: e.message }, 10 * 60 * 1000);
            throw e;
        }
        const s = { hash: r.hash, t: Date.now() };
        fsSessions.set(key, s, 55 * 60 * 1000);
        return s;
    });
}

// "1080p" / "2160p" / "1920x800" → rozlišení jako u Webshare (podle šířky / výšky)
const FS_RES_SCORE = { '4K': 4, '1080p': 3, '720p': 2, SD: 1 };
function fsResolution(r) {
    const s = String(r || '').toLowerCase().trim();
    let w = 0, h = 0, m;
    if ((m = s.match(/^(\d{3,4})\s*[x×]\s*(\d{3,4})$/))) { w = +m[1]; h = +m[2]; }
    else if ((m = s.match(/^(\d{3,4})[pi]$/))) h = +m[1];
    else if (/^(4k|uhd)$/.test(s)) h = 2160;
    else return null;
    return (w >= 3200 || h >= 2000) ? '4K' : (w >= 1800 || h >= 1000) ? '1080p' : (w >= 1200 || h >= 700) ? '720p' : 'SD';
}
function fsUnits(v, table) {
    if (!v || typeof v !== 'object') return +v || 0;
    return Math.round((parseFloat(v.value) || 0) * (table[String(v.unit || '').toUpperCase()] ?? 1));
}
const FS_SIZE = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
const FS_TIME = { S: 1, MIN: 60, M: 60, H: 3600 };
function fsFile(it) {
    if (!it || !it.id || !it.filename) return null;
    const id = String(it.id);
    if (!/^\d+$/.test(id)) return null;
    const f = {
        fs: true, ident: `fs:${id}`, id, name: String(it.filename),
        size: fsUnits(it.data, FS_SIZE), len: fsUnits(it.duration, FS_TIME),
        res: fsResolution(it.resolution), resRaw: it.resolution ? String(it.resolution) : undefined,
        img: typeof it.thumbnail === 'string' && /^https?:/.test(it.thumbnail) ? it.thumbnail : null,
        dl: typeof it.download_url === 'string' && /^https:\/\/[\w.-]+\.fastshare\.(cloud|cz)\//.test(it.download_url) ? it.download_url : null
    };
    fsFiles.set(id, f, 24 * H);
    return f;
}
async function fsSearch(cfg, query, limit = 200) {
    const run = async hash => {
        const j = await fsGet({ process: 'search', pagination: Math.min(limit, 200), term: query, adult: 0 }, hash);
        const list = j && j.search && j.search.file;
        return Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : [];
    };
    let s = await fsSession(cfg);
    let list = null, err = null;
    try { list = await run(s.hash); } catch (e) { err = e; }
    // neplatný hash (neznámo, jak ho API hlásí) → jednou znovu přihlásit, nejvýš jednou za 2 min na účet
    if ((err ? (err.status === 401 || err.status === 403) : !list.length) && Date.now() - s.t > 2 * 60 * 1000) {
        s = await fsSession(cfg, true);
        list = await run(s.hash);
    } else if (err) throw err;
    return list.map(fsFile).filter(Boolean);
}
// Odkaz pro přehrání (platí se session; skládá se až při přehrání)
async function fsPlayLink(cfg, id, filename) {
    const f = fsFiles.get(String(id));
    const dl = (f && f.dl) || `https://data.fastshare.cloud/download.php?id=${encodeURIComponent(id)}`;
    const s = await fsSession(cfg);
    return `${dl}${dl.includes('?') ? '&' : '?'}stream=1&session=${s.hash}&filename=${encodeURIComponent(filename || (f && f.name) || 'video')}`;
}
const fsDown = () => Date.now() < fsDownUntil;

// ───────────────────────── Indexer: resolve-ids ─────────────────────────
// Vrací anime záznam (anilist_id, title, title_en, titles, season, episode…) nebo null (není anime)
const indexerDownUntil = new Map();
async function resolveIds(params) {
    const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const key = `rs:${qs}`;
    const hit = resolveCache.get(key);
    if (hit !== undefined) return hit;
    return once(key, async () => {
        // nedostupná interní adresa se na 5 minut přeskakuje (ať každý dotaz nečeká na timeout)
        const bases = [...new Set([INDEXER_URL, INDEXER_FALLBACK_URL].filter(Boolean))]
            .filter(b => !(indexerDownUntil.get(b) > Date.now()));
        for (const base of bases) {
            try {
                const resp = await needle('get', `${base}/api/resolve-ids?${qs}`, {
                    open_timeout: 2000, response_timeout: 3000, read_timeout: 4000, parse: true
                });
                const b = resp.body;
                if (resp.statusCode === 200 && b && b.anilist_id) {
                    resolveCache.set(key, b, 30 * 24 * H);
                    return b;
                }
                if (resp.statusCode >= 500) throw new Error(`HTTP ${resp.statusCode}`);
                // indexer odpověděl, ale nejde o anime → negativní cache (krátká – mapování se může doplnit)
                resolveCache.set(key, null, 2 * 24 * H);
                return null;
            } catch (e) {
                if (!indexerDownUntil.get(base)) log(`⚠️ indexer ${base} nedostupný (${e.message}) – 5 min použiju zálohu`);
                indexerDownUntil.set(base, Date.now() + 5 * 60 * 1000);
            }
        }
        // indexer nedostupný – použij i prošlý záznam, jinak nic (necachovat)
        const stale = resolveCache.getStale(key);
        return stale !== undefined ? stale : null;
    });
}

// ───────────────────────── ČSFD (csfd-ratings) ─────────────────────────
// Metadata titulu jen z ČSFD → stejný tvar jako z TMDB (cz/sk/en/alt/year/runtime), source 'csfd'.
// GET {CSFD_URL}/meta/{movie|series}/csfd:ID.json → { meta: { name, releaseInfo, runtime, titlesOther: [{ country, title }] } }
// Cache 7 dní (metadata se skoro nemění), neexistující titul 1 den, výpadek služby se necachuje (prošlý záznam má přednost).
const csfdDownUntil = new Map();
const EN_COUNTRY = /^(USA|Velká Británie|Spojené království|Kanada|Austrálie|Irsko|Nový Zéland|angl)/i;
function csfdToInfo(m, type, csfdId) {
    const others = (m.titlesOther || []).map(t => typeof t === 'string' ? { country: null, title: t } : t).filter(t => t && t.title);
    const pick = re => { const t = others.find(o => o.country && re.test(o.country)); return t ? t.title.trim() : null; };
    const sk = pick(/^Slovensk/i), en = pick(EN_COUNTRY);
    const alt = others.map(o => o.title.trim()).filter(t => t && t !== sk && t !== en && t !== m.name && M.isLatin(t)).slice(0, 3);
    const year = parseInt(String(m.releaseInfo || m.year || '').slice(0, 4), 10) || null;
    const runtime = type === 'movie' ? (parseInt(String(m.runtime || ''), 10) || null) : null;
    return {
        cz: m.name || null, sk, en, original: null, originalLanguage: null, alt, altEn: [],
        year, runtime, media: type === 'movie' ? 'movie' : 'tv', csfdId, source: 'csfd'
    };
}
async function csfdInfo(type, csfdId) {
    const key = `csfd:${type}:${csfdId}`;
    const hit = tmdbCache.get(key);
    if (hit !== undefined) return hit;
    return once(key, async () => {
        const bases = [...new Set([CSFD_URL, CSFD_FALLBACK_URL].filter(Boolean))]
            .filter(b => !(csfdDownUntil.get(b) > Date.now()));
        for (const base of bases) {
            try {
                const resp = await needle('get', `${base}/meta/${type}/csfd:${csfdId}.json`, {
                    open_timeout: 2000, response_timeout: 4000, read_timeout: 6000, parse: true
                });
                const m = resp.body && resp.body.meta;
                if (resp.statusCode === 200 && m && m.name) {
                    const info = csfdToInfo(m, type, csfdId);
                    tmdbCache.set(key, info, 7 * 24 * H);
                    return info;
                }
                if (resp.statusCode === 404) { tmdbCache.set(key, null, 24 * H); return null; }
                throw new Error(`HTTP ${resp.statusCode}`);
            } catch (e) {
                if (!csfdDownUntil.get(base)) log(`⚠️ csfd-ratings ${base} nedostupný (${e.message}) – 5 min použiju zálohu`);
                csfdDownUntil.set(base, Date.now() + 5 * 60 * 1000);
            }
        }
        const stale = tmdbCache.getStale(key);
        return stale !== undefined ? stale : null;
    });
}

// Český název z ČSFD, když ho TMDB nemá (Melania Rea): csfd-ratings /csfd-id/{type}/tt….json vrátí ČSFD ID
// i u titulu bez hodnocení (od csfd-ratings 1.7.0), starší služba (404) → /ratings/{type}/tt….json, kde je odkaz
// …/film/{csfdId}/ jen u titulu s hodnocením. Pak /meta/{type}/csfd:ID.json. Cache 30 dní, nenalezeno 6 h.
async function csfdIdForImdb(type, imdbId) {
    const key = `csfdid:${type}:${imdbId}`;
    const hit = tmdbCache.get(key);
    if (hit !== undefined) return hit;
    const get = (base, p) => needle('get', `${base}${p}`, {
        open_timeout: 2000, response_timeout: 6000, read_timeout: 8000, parse: true
    });
    return once(key, async () => {
        const bases = [...new Set([CSFD_URL, CSFD_FALLBACK_URL].filter(Boolean))]
            .filter(b => !(csfdDownUntil.get(b) > Date.now()));
        for (const base of bases) {
            try {
                let id;
                const resp = await get(base, `/csfd-id/${type}/${imdbId}.json`);
                if (resp.statusCode === 200) {
                    id = resp.body && Number.isFinite(resp.body.csfdId) ? resp.body.csfdId : null;
                } else if (resp.statusCode === 404) {
                    const old = await get(base, `/ratings/${type}/${imdbId}.json`);
                    if (old.statusCode !== 200) throw new Error(`HTTP ${old.statusCode}`);
                    const r = ((old.body && old.body.ratings) || []).find(x => x && /csfd\.cz\/film\/\d+/.test(x.url || ''));
                    id = r ? parseInt(r.url.match(/\/film\/(\d+)/)[1], 10) : null;
                } else {
                    throw new Error(`HTTP ${resp.statusCode}`);
                }
                tmdbCache.set(key, id, id ? 30 * 24 * H : 6 * H);
                return id;
            } catch (e) {
                // první dohledání titulu na ČSFD může trvat déle – pomalá odpověď službu nevypíná (příště už bývá v cache)
                if (!/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH/.test(String(e.code || e.message))) continue;
                if (!csfdDownUntil.get(base)) log(`⚠️ csfd-ratings ${base} nedostupný (${e.message}) – 5 min použiju zálohu`);
                csfdDownUntil.set(base, Date.now() + 5 * 60 * 1000);
            }
        }
        return null;
    });
}
// TMDB nemá český název (chybí, nebo je stejný jako originál)
function needsCzName(info) {
    if (!info || info.source === 'csfd' || info.originalLanguage === 'cs') return false;
    if (!info.cz) return true;
    const t = x => M.tokens(x || '').join(' ');
    return t(info.cz) === t(info.original) || (!info.original && t(info.cz) === t(info.en));
}
// Doplní CZ (a chybějící SK) název z ČSFD; čeká nejvýš budgetMs, jinak dotaz doběhne do cache na příště
async function withCsfdCzName(info, type, imdbId, budgetMs = 1200) {
    if (!CSFD_ON || !imdbId || !needsCzName(info)) return info;
    const p = csfdIdForImdb(type, imdbId).then(id => id ? csfdInfo(type, id) : null).catch(() => null);
    const cs = await Promise.race([p, new Promise(r => setTimeout(() => r(null), budgetMs).unref())]);
    if (!cs || !cs.cz) return info;
    if (info.year && cs.year && Math.abs(info.year - cs.year) > 1) return info;   // jiný titul na ČSFD
    const t = x => M.tokens(x || '').join(' ');
    if ([info.cz, info.en, info.original].some(x => x && t(x) === t(cs.cz))) return info;
    dbg(`  ČSFD název k ${imdbId}: ${cs.cz}`);
    return { ...info, cz: cs.cz, sk: info.sk || cs.sk || null, czFrom: 'csfd' };
}

// ───────────────────────── TMDB / Cinemeta ─────────────────────────
async function tmdbGet(pathq, key) {
    const bearer = key.length > 40; // v4 token
    const url = `https://api.themoviedb.org/3${pathq}${bearer ? '' : (pathq.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key)}`;
    const resp = await needle('get', url, { ...HTTP, headers: bearer ? { Authorization: `Bearer ${key}` } : {} });
    if (resp.statusCode === 401) throw Object.assign(new Error('TMDB klíč je neplatný'), { auth: true });
    if (resp.statusCode !== 200) throw new Error(`TMDB HTTP ${resp.statusCode}`);
    return resp.body;
}

async function tmdbInfoWithKey(imdbId, type, key) {
    const found = await tmdbGet(`/find/${imdbId}?external_source=imdb_id&language=cs-CZ`, key);
    const movie = (found.movie_results || [])[0];
    const tv = (found.tv_results || [])[0];
    const pick = type === 'series' ? (tv ? ['tv', tv] : movie ? ['movie', movie] : null)
                                   : (movie ? ['movie', movie] : tv ? ['tv', tv] : null);
    if (!pick) return null;
    const [media, item] = pick;
    const d = await tmdbGet(`/${media}/${item.id}?language=cs-CZ&append_to_response=translations,alternative_titles`, key);
    const trs = (d.translations && d.translations.translations) || [];
    const tr = (lang, country) => {
        const t = trs.find(x => x.iso_639_1 === lang && (!country || x.iso_3166_1 === country));
        const v = t && t.data && (t.data.title || t.data.name);
        return v && v.trim() ? v.trim() : null;
    };
    const original = d.original_title || d.original_name || null;
    const origLang = d.original_language || null;
    const altList = (d.alternative_titles && (d.alternative_titles.titles || d.alternative_titles.results)) || [];
    return {
        cz: tr('cs') || (origLang === 'cs' ? original : null),
        sk: tr('sk') || (origLang === 'sk' ? original : null),
        en: tr('en', 'US') || tr('en') || (origLang === 'en' ? original : null),
        original,
        originalLanguage: origLang,
        alt: altList.filter(a => a.iso_3166_1 === 'CZ' || a.iso_3166_1 === 'SK').map(a => a.title).filter(Boolean),
        altEn: altList.filter(a => a.iso_3166_1 === 'US' || a.iso_3166_1 === 'GB').map(a => a.title).filter(Boolean).slice(0, 10),
        year: parseInt(String(d.release_date || d.first_air_date || '').slice(0, 4), 10) || null,
        runtime: d.runtime || null,           // délka filmu v minutách (u seriálů null)
        tmdbId: item.id, media,               // pro délku dílů (/tv/{id}/season/{n})
        collection: media === 'movie' ? ((d.belongs_to_collection && d.belongs_to_collection.id) || null) : undefined,
        source: 'tmdb'
    };
}

async function cinemetaInfo(imdbId, type) {
    try {
        const resp = await needle('get', `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, HTTP);
        const m = resp.body && resp.body.meta;
        if (!m || !m.name) return null;
        const year = parseInt(String(m.year || m.releaseInfo || m.released || '').slice(0, 4), 10) || null;
        return { cz: null, sk: null, en: m.name, original: null, originalLanguage: null, alt: [], year, source: 'cinemeta' };
    } catch (e) {
        return null;
    }
}

// Názvy k IMDb ID: TMDB (uživatelův klíč → serverový klíč) → Cinemeta
async function titleInfo(imdbId, type, userTmdbKey) {
    const key = `tm:${imdbId}:${type}`;
    const hit = tmdbCache.get(key);
    // starší záznamy (před v8.4) nemají délku filmu → u filmů z TMDB načíst znovu
    // starší záznamy bez TMDB ID (před v8.6.4) → u seriálů načíst znovu (kvůli délce dílů)
    // starší záznamy bez série filmů (před v8.7.0) → u filmů načíst znovu (kvůli pořadí v sérii)
    const old = hit && hit.source === 'tmdb' && ((type === 'movie' && (hit.runtime === undefined || hit.collection === undefined)) || (type === 'series' && hit.tmdbId === undefined));
    if (hit !== undefined && !old) return hit;
    return once(key, async () => {
        const keys = [...new Set([String(userTmdbKey || '').trim(), TMDB_API_KEY].filter(Boolean))];
        let failed = false;
        for (const k of keys) {
            try {
                const info = await tmdbInfoWithKey(imdbId, type, k);
                if (info) { tmdbCache.set(key, info, 30 * 24 * H); return info; }
                failed = false;
                break; // TMDB odpovědělo, jen titul nezná
            } catch (e) {
                dbg(`TMDB ${imdbId}: ${e.message}`);
                failed = true;
                if (!e.auth) break;
            }
        }
        // TMDB nedostupné → radši prošlý záznam (s CZ názvy) než Cinemeta
        const stale = tmdbCache.getStale(key);
        if (failed && stale) return stale;
        const cm = await cinemetaInfo(imdbId, type);
        // když TMDB jen selhalo, Cinemetu držet krátce (ať se CZ názvy brzy doplní)
        if (cm) tmdbCache.set(key, cm, failed ? H : 7 * 24 * H);
        return cm || stale || null;
    });
}

// Délka dílů sezóny z TMDB → { [díl]: minut }. Uzavřená sezóna (všechny díly mají délku) se drží 1 rok,
// probíhající 1 den; chybí-li hledaný díl (nový), sezóna se načte znovu – nejvýš jednou denně.
async function seasonRuntimes(tvId, season, userTmdbKey, episode) {
    const key = `ep:${tvId}:${season}`;
    const hit = tmdbCache.get(key);
    if (hit !== undefined) {
        if (hit === null) return null;                                   // neúspěch (1 den)
        const map = hit.map || hit;                                      // starší formát = jen mapa
        if (!episode || map[episode] || (hit.t && Date.now() - hit.t < 24 * H)) return map;
    }
    return once(key, async () => {
        const keys = [...new Set([String(userTmdbKey || '').trim(), TMDB_API_KEY].filter(Boolean))];
        for (const k of keys) {
            try {
                const d = await tmdbGet(`/tv/${tvId}/season/${season}?language=cs-CZ`, k);
                const eps = (d && d.episodes) || [];
                const map = {};
                for (const e of eps) if (e.episode_number && e.runtime) map[e.episode_number] = e.runtime;
                const complete = eps.length > 0 && Object.keys(map).length === eps.length;
                tmdbCache.set(key, { map, t: Date.now() }, (complete ? 365 : 1) * 24 * H);
                return map;
            } catch (e) {
                dbg(`TMDB sezóna ${tvId}/${season}: ${e.message}`);
                if (!e.auth) break;
            }
        }
        tmdbCache.set(key, null, 24 * H);
        return null;
    });
}

// Jiné seriály se stejným názvem (reboot / revival / původní seriál / jiná země) →
// [{ y: rok začátku, v: počet hodnocení, c: země }] + náš seriál jako { ours: true, v, c }.
// Jen známější tituly (aspoň 10 hodnocení), aby nějaký zapadlý stejnojmenný pořad nezpůsobil vyřazení.
// Výsledek 30 dní v cache, chyba 1 den.
const countryCode = c => { c = String(c || '').toLowerCase(); return c === 'gb' ? 'uk' : c; };
async function sameNameShows(info, userTmdbKey) {
    if (!info || info.media !== 'tv' || !info.tmdbId || !info.year) return null;
    const key = `sn3:${info.tmdbId}`;
    const hit = tmdbCache.get(key);
    if (hit !== undefined) return hit;
    const ours = new Set([info.en, info.original, info.cz].filter(Boolean).map(t => M.tokens(t).join(' ')).filter(Boolean));
    const query = info.en || (M.isLatin(info.original) ? info.original : null);
    if (!query || !ours.size) return null;
    return once(key, async () => {
        const keys = [...new Set([String(userTmdbKey || '').trim(), TMDB_API_KEY].filter(Boolean))];
        for (const k of keys) {
            try {
                const d = await tmdbGet(`/search/tv?query=${encodeURIComponent(query)}&language=en-US`, k);
                // české názvy ostatních seriálů – pravidlo stejnojmenného platí jen pro sdílené názvy ("Lov" × "Lov");
                // bez nich (chyba) se názvy neukládají a pravidlo platí pro všechny jako dřív
                let dcs = null;
                try { dcs = await tmdbGet(`/search/tv?query=${encodeURIComponent(query)}&language=cs-CZ`, k); } catch (e) { /* bez CZ */ }
                const csName = dcs ? new Map(((dcs && dcs.results) || []).map(r => [r.id, r.name])) : null;
                const out = [];
                let me = null;
                for (const r of (d && d.results) || []) {
                    const c = countryCode((r.origin_country || [])[0]);
                    if (r.id === info.tmdbId) { me = { ours: true, v: r.vote_count || 0, c }; continue; }
                    if ((r.vote_count || 0) < 10) continue;
                    const y = parseInt(String(r.first_air_date || '').slice(0, 4), 10);
                    if (!y || Math.abs(y - info.year) <= 1) continue;
                    const same = [r.name, r.original_name].filter(Boolean).some(t => ours.has(M.tokens(t).join(' ')));
                    if (!same) continue;
                    const n = csName ? [r.name, r.original_name, csName.get(r.id)].filter(Boolean).map(t => M.tokens(t).join(' ')).filter(Boolean) : null;
                    const prev = out.find(o => o.y === y);
                    if (prev) { if (prev.n && n) prev.n = [...new Set([...prev.n, ...n])]; continue; }
                    out.push(n ? { y, v: r.vote_count || 0, c, n: [...new Set(n)] } : { y, v: r.vote_count || 0, c });
                }
                out.sort((a, b) => a.y - b.y);
                const res = out.length ? [...out, me || { ours: true, v: null, c: '' }] : [];
                tmdbCache.set(key, res, 30 * 24 * H);
                return res;
            } catch (e) {
                dbg(`TMDB stejný název ${info.tmdbId}: ${e.message}`);
                if (!e.auth) break;
            }
        }
        tmdbCache.set(key, null, 24 * H);
        return null;
    });
}

// Díly filmové série (TMDB kolekce) seřazené podle data vydání → [{ id, y }]. 30 dní v cache, chyba 1 den.
// Díly kolekce TMDB v pořadí vydání: [{ id, y, w }], w = slova z názvů dílu (EN, originál, CZ) – pro pojistku
// u podpisu uploadera ("Halloween Kills" není podpis za "Halloween")
async function collectionParts(collId, userTmdbKey) {
    if (!collId) return null;
    const key = `col2:${collId}`;
    const hit = tmdbCache.get(key);
    if (hit !== undefined) return hit;
    return once(key, async () => {
        const keys = [...new Set([String(userTmdbKey || '').trim(), TMDB_API_KEY].filter(Boolean))];
        for (const k of keys) {
            try {
                const d = await tmdbGet(`/collection/${collId}?language=en-US`, k);
                let cs = null;
                try { cs = await tmdbGet(`/collection/${collId}?language=cs-CZ`, k); } catch (e) { /* jen anglické názvy */ }
                const csTitle = new Map(((cs && cs.parts) || []).map(p => [p.id, p.title]));
                const words = p => [...new Set(M.nameTokens([p.title, p.original_title, csTitle.get(p.id)].filter(Boolean).join(' ')))];
                const parts = ((d && d.parts) || [])
                    .filter(p => p.release_date)
                    .map(p => ({ id: p.id, d: p.release_date, y: parseInt(p.release_date.slice(0, 4), 10) || null, w: words(p) }))
                    .sort((a, b) => a.d.localeCompare(b.d))
                    .map(p => ({ id: p.id, y: p.y, w: p.w }));
                tmdbCache.set(key, parts, 30 * 24 * H);
                return parts;
            } catch (e) {
                dbg(`TMDB série ${collId}: ${e.message}`);
                if (!e.auth) break;
            }
        }
        tmdbCache.set(key, null, 24 * H);
        return null;
    });
}

// Anime název se sezónou ("… II", "… Season 2", "… 2nd Season", "… S2") → základní název + číslo sezóny
function seasonBase(text) {
    const m = String(text || '').match(/^(.*?)[\s:\-–]+(?:(II|III|IV|V|VI)|(\d{1,2})(?:st|nd|rd|th)\s+season|season\s*(\d{1,2})|s(\d{1,2}))\s*$/i);
    if (!m) return null;
    const roman = { II: 2, III: 3, IV: 4, V: 5, VI: 6 };
    const n = m[2] ? roman[m[2].toUpperCase()] : +(m[3] || m[4] || m[5]);
    const base = m[1].trim();
    if (!(n >= 2) || M.nameTokens(base).join('').length < 5) return null;
    return { base, season: n };
}

// ───────────────────────── Plán hledání ─────────────────────────
// Dlouhý název light novel (nad 10 slov) → část do první tečky / čárky / "!" / "?", má-li aspoň 4 významná slova
// ("Tsuihou sareta … Ouka suru. Ore wa Buki dake ja Naku, …" → "Tsuihou sareta … Ouka suru")
function longCut(text) {
    if (!text || M.tokens(text).length <= 10) return null;
    const m = String(text).match(/^(.*?\S)\s*[.,!?]+(?:\s|$)/);
    if (!m) return null;
    return M.nameTokens(m[1]).length >= 4 ? m[1].trim() : null;
}

// HTML entity v názvech z indexeru / ČSFD ("Girls &amp; Panzer", "Law &amp; Order") → znaky
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(s) {
    if (typeof s !== 'string' || !s.includes('&')) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : all;
        }
        return ENTITIES[e.toLowerCase()] ?? all;
    });
}

function uniqNames(list, max) {
    const seen = new Set(), out = [];
    for (let n of list) {
        if (!n || !n.text) continue;
        if (n.text.includes('&') || (n.full && n.full.includes('&'))) {
            n = { ...n, text: decodeEntities(n.text), ...(n.full ? { full: decodeEntities(n.full) } : {}) };
        }
        const nt = M.nameTokens(n.text);
        const k = nt.join(' ');
        // aspoň jedno slovo o 3+ znacích ("R+V", "OP" se nepoužijí)
        if (!k || !nt.some(t => t.length >= 3) || seen.has(k)) continue;
        seen.add(k);
        out.push(n);
        if (out.length >= max) break;
    }
    return out;
}

// kitsu:ID:díl / anilist:ID:díl → { animeId, episode }. Nuvio posílá i anilist:ID:ID:díl – díl je vždy poslední
// část; prostřední velké číslo je ID záznamu, ke kterému díl patří (AniList čísluje po záznamech),
// malé číslo je sezóna titulu a stačí ID titulu
function animeIdParts(parts) {
    if (parts.length >= 4) {
        const animeId = /^\d+$/.test(parts[2]) && +parts[2] > 30 ? parts[2] : parts[1];
        return { animeId, episode: parseInt(parts[parts.length - 1], 10) || null };
    }
    return { animeId: parts[1], episode: parseInt(parts[2], 10) || null };
}

// Sestaví názvy a cílovou epizodu pro dané Stremio ID
async function buildPlan(type, id, cfg) {
    const parts = id.split(':');
    let imdb = null, season = null, episode = null, rs = null, info = null;

    if (parts[0].startsWith('tt')) {
        imdb = parts[0];
        if (type === 'series') { season = parseInt(parts[1], 10) || null; episode = parseInt(parts[2], 10) || null; }
        const rsParams = type === 'series' && season && episode ? { imdb, season, episode } : { imdb };
        [info, rs] = await Promise.all([titleInfo(imdb, type, cfg.tmdb_api_key), resolveIds(rsParams)]);
    } else if (parts[0] === 'kitsu' || parts[0] === 'anilist') {
        // anime z Kitsu (anime addony) nebo z AniListu (Nuvio na Apple TV): kitsu:ID:díl / anilist:ID:díl
        const key = parts[0];
        const ap = animeIdParts(parts);
        const animeId = ap.animeId;
        episode = ap.episode;
        rs = await resolveIds(episode ? { [key]: animeId, episode } : { [key]: animeId });
        if (rs && rs.imdb_id) info = await titleInfo(rs.imdb_id, type, cfg.tmdb_api_key);
        season = (rs && rs.season) || 1;
        if (rs && rs.episode && !episode) episode = rs.episode;
    } else if (parts[0] === 'csfd' && CSFD_ON) {
        // titul jen na ČSFD: názvy a rok z csfd-ratings, díly podle číslování ČSFD (seriál bez sérií = S1)
        const csfdId = parseInt(parts[1], 10);
        if (!csfdId) return null;
        if (type === 'series') { season = parseInt(parts[2], 10) || 1; episode = parseInt(parts[3], 10) || null; }
        info = await csfdInfo(type, csfdId);
    } else {
        return null;
    }
    // TMDB bez českého názvu → zkusit ČSFD (podle IMDb ID přes csfd-ratings)
    if (info && info.source !== 'csfd') info = await withCsfdCzName(info, type, imdb || (rs && rs.imdb_id));

    // Anime záznam z indexeru je platný jen pokud sedí typ (film × seriál)
    if (rs && type === 'movie' && rs.type && !/movie/i.test(rs.type) && imdb) {
        // seriálové AL pro filmové ID ignorujeme (např. film navazující na seriál)
        rs = null;
    }

    const isAnime = !!rs;
    // délka cílového dílu (minuty) – jen u seriálů z TMDB; běží souběžně s hledáním (čeká se na ni až
    // při filtrování podle délky), chyba/neznámá = bez kontroly
    let epRuntimeP = null;
    if (type === 'series' && season && episode && info && info.media === 'tv' && info.tmdbId) {
        epRuntimeP = seasonRuntimes(info.tmdbId, season, cfg.tmdb_api_key, episode)
            .then(m => (m && m[episode]) || null).catch(() => null);
    }
    // jiné stejnojmenné seriály (reboot) – běží souběžně s hledáním, čeká se před posouzením souborů
    // film ze série → pořadí v sérii (běží souběžně s hledáním)
    const collP = type === 'movie' && info && info.media === 'movie' && info.collection
        ? collectionParts(info.collection, cfg.tmdb_api_key).then(parts => {
            const i = (parts || []).findIndex(p => p.id === info.tmdbId);
            if (i < 0 || parts.length < 2) return null;
            // slova z názvů ostatních dílů (pojistka u podpisu uploadera)
            const w = [...new Set(parts.filter((p, j) => j !== i).flatMap(p => p.w || []))].slice(0, 80);
            return { i: i + 1, n: parts.length, w };
        }).catch(() => null) : null;
    const sameNameP = type === 'series' && info && info.media === 'tv'
        ? sameNameShows(info, cfg.tmdb_api_key).catch(() => null) : null;
    const latin = s => s && M.isLatin(s) ? s : null;

    // Názvy "franšízy" (CZ/SK/EN z TMDB) – párují se s IMDb sezónou/epizodou
    // short = zkrácený název před dvojtečkou; full = celý název, ze kterého vznikl
    const full = text => text ? { text } : null;
    const short = text => { const s = M.shortTitle(text); return s ? { text: s, short: true, full: text } : null; };
    // podtitul ("Okresní přebor – Poslední zápas Pepika Hnátka" → "Poslední zápas Pepika Hnátka"):
    // od 3 významných slov je dost jednoznačný i bez roku
    const sub = text => { const s = M.subTitle(text); return s ? { text: s, short: M.nameTokens(s).length < 3, full: text } : null; };
    const fr = [];
    if (info) {
        // delší anglický název, který začíná nebo končí naším EN/originálním ("Evil Genius: The True Story of …",
        // "Anne Rice's Mayfair Witches")
        const baseEn = [info.en, latin(info.original)].filter(Boolean).map(t => M.nameTokens(t).join(' '));
        const longEn = [...(info.altEn || []), latin(info.original)].filter(Boolean).find(a => {
            const k = M.nameTokens(a).join(' ');
            return baseEn.some(b => b && k !== b && (k.startsWith(b + ' ') || k.endsWith(' ' + b)));
        });
        if (info.source === 'csfd') {
            // ČSFD: jen plné názvy – tituly jen na ČSFD bývají spin-offy/speciály ("Frieren: ●● no mahó"),
            // zkrácený název před dvojtečkou by pouštěl mateřský seriál; zástupné znaky (●●, ??) pryč
            const clean = t => t ? t.replace(/[●○■□◆◇★☆♦♥?？]+/g, ' ').replace(/\s+([:,.])/g, '$1').replace(/\s+/g, ' ').trim() : t;
            fr.push(full(clean(info.cz)), full(clean(info.sk)), full(clean(info.en)));
            (info.alt || []).slice(0, 3).forEach(a => fr.push(full(clean(a))));
        } else {
            fr.push(full(info.cz), full(info.sk), full(info.en), full(latin(info.original)), full(longEn));
            fr.push(short(info.cz), sub(info.cz), short(info.en), sub(info.en));
            (info.alt || []).slice(0, 3).forEach(a => fr.push(full(a)));
        }

    }
    // Názvy z indexeru (romaji / EN pro konkrétní sezónu) – párují se s epizodou v rámci sezóny
    const an = [];
    if (rs) {
        an.push(full(rs.title), full(rs.title_en), full(longCut(rs.title)), full(longCut(rs.title_en)), short(rs.title), short(rs.title_en));
        // alternativní názvy z indexeru: jen varianty romaji/EN názvu (sdílí s ním slovo, "Ladies Vs Butlers!")
        // nebo jednoslovné romaji zkratky od 5 znaků ("Oregairu"); cizí lokalizace ("Doamne vs. Majordom")
        // a krátké zkratky ("PES", "OP") se nepoužijí – české názvy jsou z TMDB
        const core = new Set([...M.nameTokens(rs.title || ''), ...M.nameTokens(rs.title_en || '')]
            .filter(t => t.length >= 3 && !/^\d+$/.test(t) && t !== 'vs' && t !== 'versus'));
        // jednoslovný název, který je jen slovem z jiného našeho názvu ("Hello" z "Hello, I Am a Witch"), se nepoužije –
        // pouštěl by cizí seriály ("Hello, Me!"); zkratky, které v názvech nejsou ("Oregairu"), zůstanou
        const ownWords = new Set([...core, ...fr.filter(Boolean).flatMap(n => M.nameTokens(n.text))]);
        (rs.titles || []).filter(t => M.isLatin(t) && t.length <= 60)
            .filter(t => {
                const nt = M.nameTokens(t);
                if (nt.length === 1) return nt[0].length >= 5 && !ownWords.has(nt[0]);
                return nt.some(x => core.has(x));
            })
            .slice(0, 6).forEach(t => an.push(full(t)));
    }

    const names = uniqNames([
        ...fr.filter(Boolean).map(n => ({ ...n, kind: 'franchise' })),
        ...an.filter(Boolean).map(n => ({ ...n, kind: 'anime' }))
    ], 9);
    if (!names.length) return null;
    // anime: základní název bez značky sezóny ("Sasaki to Pii-chan S2 - 01" pro "Sasaki to Pii-chan Season 2");
    // platí jen se značkou téže sezóny v souboru (díly 1. řady "… - 02" neprojdou)
    if (rs && type === 'series') {
        const have = new Set(names.map(n => M.nameTokens(n.text).join(' ')));
        let added = 0;
        for (const n of names.filter(x => x.kind === 'anime' && !x.short)) {
            if (added >= 2) break;
            const sb = seasonBase(n.text);
            if (!sb || sb.season !== (rs.season || season)) continue;
            const k = M.nameTokens(sb.base).join(' ');
            if (have.has(k)) continue;
            have.add(k);
            names.push({ text: sb.base, kind: 'anime', seasonOnly: sb.season });
            added++;
        }
    }

    // slova, která smí stát za názvem (z kteréhokoli našeho názvu) – pro kontrolu jiného podtitulu
    const allow = new Set(names.flatMap(n => M.nameTokens(n.full || n.text)));
    return {
        type, id, isAnime, names, allow,
        runtime: (info && info.runtime) || null,
        epRuntime: null, epRuntimeP,
        sameName: null, sameNameP,
        coll: null, collP, hasColl: !!collP,
        year: (info && info.year) || null,
        season, episode,
        alEpisode: rs ? (rs.episode || episode) : null,
        alSeason: rs ? (rs.season || season) : null,
        source: info ? info.source : 'indexer',
        anilistId: rs ? rs.anilist_id : null,
        // originální název u titulu v jiném jazyce než CZ/SK/EN (polský, španělský …) – dotaz hned v první vlně
        origName: info && info.source === 'tmdb' && info.originalLanguage && !['cs', 'sk', 'en'].includes(info.originalLanguage)
            && names.some(n => n.text === latin(info.original)) ? info.original : null
    };
}

const pad = n => String(n).padStart(2, '0');

// "Druhá světová válka" → "2 svetova valka" (soubory často píšou číslicí)
const ORD_Q = { prvni: '1', druha: '2', druhy: '2', druhe: '2', treti: '3', ctvrta: '4', ctvrty: '4' };
function digitVariant(q) {
    const v = q.split(' ').map(w => ORD_Q[w.toLowerCase()] || w).join(' ');
    return v !== q ? v : null;
}
// "Hawaii 5-0" / "Havaj 5.0" → "Hawaii 5-O" (soubory často píšou písmeno O)
function fiveOVariant(q) {
    const v = q.replace(/\b(5|five)[-. ]?0\b/i, '5-O');
    return v !== q ? v : null;
}

function buildQueries(plan) {
    const fr = plan.names.filter(n => n.kind === 'franchise').map(n => M.queryText(n.text));
    const an = plan.names.filter(n => n.kind === 'anime' && !n.seasonOnly).map(n => M.queryText(n.text));
    const variants = [...fr.map(digitVariant), ...fr.map(fiveOVariant)].filter(Boolean);
    const w1 = [], w2 = [];
    if (plan.type === 'movie') {
        const all = [...fr, ...an];
        all.slice(0, 3).forEach(q => w1.push(q));
        if (plan.year) all.slice(0, 2).forEach(q => w1.push(`${q} ${plan.year}`));
        all.slice(3).forEach(q => w2.push(q));
        variants.forEach(q => w2.push(q));
    } else if (plan.season && plan.episode) {
        const se = `S${pad(plan.season)}E${pad(plan.episode)}`;
        // krátký jednoslovný název (Most, Dark, You) → dotaz i s rokem, jinak Webshare vrací "Most Wanted" apod.
        const shortName = fr.length && plan.year && M.nameTokens(fr[0]).length === 1 && M.nameTokens(fr[0])[0].length < 6;
        if (shortName) w1.push(`${fr[0]} ${plan.year} ${se}`);
        fr.slice(0, 3).forEach(q => w1.push(`${q} ${se}`));
        // seriál v jiném jazyce: originál hned v první vlně, i když je v pořadí až za CZ/SK/EN ("Rojst", "La casa de papel")
        if (plan.origName) w1.push(`${M.queryText(plan.origName)} ${se}`);
        if (plan.isAnime && plan.alEpisode) an.slice(0, 2).forEach(q => w1.push(`${q} ${pad(plan.alEpisode)}`));
        fr.slice(0, 3).forEach(q => w2.push(`${q} ${plan.season}x${pad(plan.episode)}`));
        if (plan.season === 1) fr.slice(0, 2).forEach(q => w2.push(`${q} ${pad(plan.episode)}`));
        fr.slice(3).forEach(q => w2.push(`${q} ${se}`));
        variants.forEach(q => w2.push(`${q} ${se}`));
        if (plan.isAnime && plan.alEpisode) {
            if (plan.alEpisode < 10) an.slice(0, 1).forEach(q => w2.push(`${q} ${plan.alEpisode}`));   // "… 1" bez nuly
            an.slice(0, 2).forEach(q => w2.push(`${q} E${pad(plan.alEpisode)}`));
            an.slice(2).forEach(q => w2.push(`${q} ${pad(plan.alEpisode)}`));
        }
        if (shortName) w2.push({ q: `${fr[0]} ${plan.year}`, limit: 100 });
        // samotný název (100 výsledků) – soubory jako "Cena Říše 05 - Barbarossa" nebo "(13) Tisíc slunců"
        [fr[0], ...variants.slice(0, 1), ...plan.names.filter(n => n.short && n.kind === 'franchise' && M.subTitle(n.full) === n.text).map(n => M.queryText(n.text)).slice(0, 1)]
            .filter(Boolean).forEach(q => w2.push({ q, limit: 100 }));
    } else {
        [...fr, ...an].slice(0, 3).forEach(q => w1.push(q));
    }
    const dedupe = (arr, skip = new Set()) => {
        const out = [];
        for (const item of arr) {
            const it = typeof item === 'string' ? { q: item, limit: 50 } : item;
            const k = it.q.toLowerCase().trim();
            if (!k || skip.has(k)) continue;
            skip.add(k);
            out.push(it);
        }
        return out;
    };
    const seen = new Set();
    return [dedupe(w1, seen).slice(0, 8), dedupe(w2, seen).slice(0, 10)];
}

// Hledání s omezenou souběžností – Webshare max 4 dotazy naráz, Hellspy a Fastshare max 3 (souběžně vedle sebe).
// Časový strop: po budgetMs se vrátí, co je hotové (pomalé dotazy doběhnou na pozadí a zahodí se).
// Vrací { files, degraded, dead, deg } – degraded = některý zdroj selhal nebo nestihl strop (kratší cache);
// deg = { ws|hs|fs: { err, ok, timeout, msg } } jen u zdroje, který selhal (do archivu hledání)
async function runQueries(cfg, queries, { ws = true, hs = true, fs = true, budgetMs = 4000 } = {}) {
    const out = new Map();
    const deadline = Date.now() + budgetMs;
    let degraded = false, done = false;
    const finished = { WS: false, HS: false, FS: false }, okCount = { WS: 0, HS: 0, FS: 0 },
        errCount = { WS: 0, HS: 0, FS: 0 }, lastErr = { WS: '', HS: '', FS: '' };
    const authFail = { WS: false, FS: false };   // přihlášení selhalo – opakovat nemá smysl
    const muted = { WS: () => false, HS: () => Date.now() < hsDownUntil, FS: () => Date.now() < fsDownUntil };
    const pool = async (n, search, label) => {
        let i = 0;
        const worker = async () => {
            while (i < queries.length && Date.now() < deadline && !done) {
                const { q, limit } = queries[i++];
                try {
                    const files = await search(q, limit);
                    if (done) return;
                    okCount[label]++;
                    for (const f of files) if (!out.has(f.ident)) out.set(f.ident, f);
                    dbg(`  🔎 ${label} "${q}" → ${files.length}`);
                } catch (e) {
                    degraded = true;
                    errCount[label]++; lastErr[label] = String(e.message || e).slice(0, 80);
                    if (e instanceof WsError || e instanceof FsError) authFail[label] = true;   // špatné jméno / heslo
                    const quiet = authFail[label] && errCount[label] > 1;   // špatné jméno / heslo – stačí jednou
                    if (!quiet && !muted[label]()) log(`  ⚠️ ${label} hledání "${q}" selhalo: ${e.message}`);
                }
            }
            if (i < queries.length) degraded = true;
        };
        await Promise.all(Array.from({ length: Math.min(n, queries.length) }, worker));
        finished[label] = true;
    };
    const all = Promise.all([
        ws && hasWs(cfg) ? pool(4, async (q, limit) => (await withToken(cfg, t => wsSearch(t, q, limit))).files, 'WS') : null,
        hs && hsOn(cfg) ? pool(3, (q, limit) => hsSearch(q, limit), 'HS') : null,
        fs && hasFs(cfg) ? pool(3, q => fsSearch(cfg, q, 200), 'FS') : null
    ]);
    const timedOut = await Promise.race([all.then(() => false), new Promise(r => setTimeout(() => r(true), budgetMs).unref())]);
    if (timedOut) { done = true; degraded = true; log(`  ⏱ hledání přerušeno po ${budgetMs} ms – vracím, co je hotové`); }
    // zdroj, který nestihl strop nebo mu neprošel ani jeden dotaz = "nefunguje" → druhá vlna se mu neposílá
    const dead = { ws: !finished.WS || !okCount.WS, hs: !finished.HS || !okCount.HS, fs: !finished.FS || !okCount.FS };
    const deg = {};
    for (const [label, on] of [['WS', ws && hasWs(cfg)], ['HS', hs && hsOn(cfg)], ['FS', fs && hasFs(cfg)]]) {
        if (!on || (finished[label] && !errCount[label])) continue;
        deg[label.toLowerCase()] = { err: errCount[label], ok: okCount[label], ...(finished[label] ? {} : { timeout: true }), ...(lastErr[label] ? { msg: lastErr[label] } : {}) };
    }
    return {
        files: new Map(out), degraded, dead, deg,
        wsFailed: !!(ws && hasWs(cfg) && errCount.WS && !okCount.WS && !authFail.WS),
        // vypršel čas a neprošel ani jeden dotaz (poskytovatel "visí" – typicky v celou hodinu)
        wsTimedOut: !!(ws && hasWs(cfg) && !finished.WS && !okCount.WS),
        hsTimedOut: !!(hs && hsOn(cfg) && !finished.HS && !okCount.HS && Date.now() >= hsDownUntil),
        fsFailed: !!(fs && hasFs(cfg) && errCount.FS && !okCount.FS && Date.now() >= fsDownUntil && !authFail.FS),
        fsTimedOut: !!(fs && hasFs(cfg) && !finished.FS && !okCount.FS && Date.now() >= fsDownUntil)
    };
}

// Vybere soubory, které sedí na název (a rok / epizodu)
// Sedí název souboru na daný název? Zkrácený název nesmí být následován jiným podtitulem.
function nameOk(fileName, n, plan) {
    if (!M.titleMatches(fileName, n.text, plan && plan.names.map(x => x.text), plan && plan.year)) return false;
    if (n.short && M.shortNameIsNoise(fileName, n.text, n.full)) return false;
    // jiný podtitul za názvem ("House" ≠ "House of the Dragon", "Námořní vyšetřovací služba - Los Angeles");
    // u seriálů kontrola končí na značce dílu, takže název dílu za ní nevadí
    if (plan && M.subtitleNoise(fileName, n.text, plan.allow, plan.type === 'movie' ? 'movie' : 'series') &&
        !originalTitleWord(fileName, n, plan)) return false;
    // zkratka spin-offu za názvem ("NCIS LA")
    if (plan && M.spinoffAbbrev(fileName, n.text, plan.allow)) return false;
    return true;
}

// Jedno slovo mezi dlouhým názvem (3+ slova) a značkou dílu u seriálu = originální název, když soubor nese přesně
// náš rok ("Kdyby přání zabíjela - Girigo S01E01 (2026)"); bez roku ne ("NCIS - Hawai S01E01", "Higurashi … Kira - S1E1")
function originalTitleWord(fileName, n, plan) {
    if (plan.type === 'movie' || !plan.year || M.nameTokens(n.text).length < 3) return false;
    const hit = M.afterName(M.stripLeadingGroups(fileName), n.text);
    if (!hit || !/^[a-z]{3,}$/.test(hit.rest[0] || '') || !/^(s\d{1,2}e\d{1,4}|\d{1,2}x\d{1,4})$/.test(hit.rest[1] || '')) return false;
    return M.fileYears(fileName).includes(plan.year);
}

// Sezóna u anime názvu: bez sezóny OK; S01 jen když název sám určuje sezónu ("Mushoku Tensei II");
// jinak musí sedět s IMDb sezónou (Farming Life S01E01 ≠ S2E1)
function animeSeasonOk(pe, n, plan) {
    if (pe.season === null) return true;
    if (pe.season === plan.season || pe.season === plan.alSeason) return true;
    return pe.season === 1 && seasonInName(n);
}
function seasonInName(n) {
    return M.nameTokens(n.text).some(t => /^[2-9]$/.test(t) || t === 'season' || t === 'part' || /^\d(st|nd|rd|th)$/.test(t));
}

// Název s rozlišením části ("… 2nd Stage", "Part 2", "2nd Season") – holé číslo dílu pod ním je číslo v části.
// "Part 7" u JoJo je díl mangy, ne část sezóny → part/cour jen 2–4.
function hasPartMarker(n) {
    const t = M.nameTokens(n.text);
    return t.some((w, i) => /^[2-9](nd|rd|th)$/.test(w) ||
        ((w === 'part' || w === 'cour') && /^([2-4]|ii|iii|iv)$/.test(t[i + 1] || '')));
}

// Stejnojmenné seriály z plánu (i starší formát archivu = jen roky)
function sameNameOf(plan) {
    const list = (plan.sameName || []).map(o => typeof o === 'number' ? { y: o, v: null, c: '' } : o);
    return { others: list.filter(o => !o.ours), me: list.find(o => o.ours) || null };
}
const COUNTRY_MARK = new Set(['us', 'usa', 'uk', 'au', 'aus', 'nz', 'ca', 'ie']);
const markCountry = t => t === 'usa' ? 'us' : t === 'aus' ? 'au' : t;

// Podpis uploadera jako poslední slovo za názvem filmu ("Deadpool 2   SiC", "V hlavě 1 semtam", "… OGGY"):
// vrátí název bez posledního slova, když je to jedno písmenné slovo. U filmu z kolekce nesmí být v názvu jiného
// dílu ("Halloween Kills" u Halloweenu 2018); bez názvů dílů kolekce (starší cache, výpadek TMDB) se nepoužije.
const SIGNED = 'podpis uploadera za názvem';
const SEP = '[\\s._\\-–—\\[\\]()]';
const SIGNED_RE = new RegExp(`^(.*[^\\s._\\-–—\\[\\]()])${SEP}+([^\\s._\\-–—\\[\\]()]+)${SEP}*$`);
function signedName(fileName, plan) {
    const ext = (String(fileName).match(/\.[a-z0-9]{2,4}$/i) || [''])[0];
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    const m = base.match(SIGNED_RE);
    if (!m) return null;
    const word = M.normalize(m[2]);
    if (!/^[a-z]{2,}$/.test(word)) return null;
    if (plan.coll || plan.hasColl) {
        if (!plan.coll || !Array.isArray(plan.coll.w) || plan.coll.w.includes(word)) return null;
    }
    return { name: m[1] + ext, word };
}

// Posoudí jeden soubor: { ok, exact, reason, s, e } – důvod se ukládá do archivu hledání
// Porovnávací varianty názvů – jen pro posouzení souborů, nehledá se podle nich:
// apostrof jako mezera ("L'Aile ou la cuisse" → "L Aile ou la cuisse", "Winter's Bone" → "Winter s Bone")
// a "UK" jako "United Kingdom" ("Criminal: UK" → "criminal.united.kingdom.s01e01")
function nameVariants(text) {
    const out = [];
    if (/['’`]/.test(text)) out.push(text.replace(/\s*['’`]\s*/g, ' '));
    if (/\bUK\b/.test(text)) out.push(text.replace(/\bUK\b/g, 'United Kingdom'));
    return out;
}
// varianty podle pole názvů (plán se během hledání doplňuje – sameName, coll –, proto se kopíruje při každém volání)
const variantNames = new WeakMap();
function withNameVariants(plan) {
    if (!plan || !Array.isArray(plan.names)) return plan;
    let v = variantNames.get(plan.names);
    if (v === undefined) {
        const have = new Set(plan.names.map(n => M.nameTokens(n.text).join(' ')));
        const extra = [];
        for (const n of plan.names) {
            if (n.short) continue;   // krátké názvy ("UK" z "Criminal: UK") ne
            for (const t of nameVariants(n.text)) {
                const k = M.nameTokens(t).join(' ');
                if (!k || have.has(k)) continue;
                have.add(k);
                extra.push({ ...n, text: t, full: undefined, variant: true });
            }
        }
        v = extra.length ? { names: [...plan.names, ...extra], extraAllow: extra.flatMap(n => M.nameTokens(n.text)) } : null;
        variantNames.set(plan.names, v);
        if (v) variantNames.set(v.names, null);
    }
    if (!v) return plan;
    return { ...plan, names: v.names, allow: new Set([...(plan.allow || []), ...v.extraAllow]) };
}

// Bonusy z BD a ukázky ("Dog Days 2 - End Card 01", "Mayo Chiki - BD Menu 02", "NCOP2", "… - Trailer") –
// ne, když slovo patří do našeho názvu ("The Menu", "Trailer Park Boys")
const BONUS_RE = /(?:^|\s)(menu|end ?card|nc ?op\d*|nc ?ed\d*|creditless|textless|trailer|teaser)(?=\s|$)/;
function bonusWord(name, plan) {
    const m = M.normalize(name).match(BONUS_RE);
    if (!m) return null;
    const words = m[1].replace(/\d+$/, '').split(' ').filter(Boolean);
    const ours = new Set((plan.names || []).flatMap(n => M.tokens(n.full || n.text)));
    return words.every(w => ours.has(w)) ? null : m[1];
}

function judgeFile(f, plan) {
    if (M.isNonVideo(f.name)) return { ok: false, reason: 'nepřehratelný soubor' };
    if (bonusWord(f.name, plan)) return { ok: false, reason: 'bonus / ukázka' };
    plan = withNameVariants(plan);
    const texts = plan.names.map(n => n.text);
    const anyTitle = plan.names.some(n => M.titleMatches(f.name, n.text, texts, plan.year));
    if (plan.type === 'movie') {
        // film z kolekce: "3. část" / "díl 2" není díl seriálu – pořadí rozhodne kontrola série níž
        const inColl = !!(plan.coll && plan.coll.i);
        if (M.looksLikeEpisode(f.name, inColl) && !plan.names.some(n => /\b\d{1,2}x\d{1,3}\b/.test(M.normalize(n.text)))) {
            return { ok: false, reason: 'vypadá jako díl seriálu' };
        }
        const byFull = plan.names.some(n => !n.short && nameOk(f.name, n, plan));
        const byShort = !byFull && plan.names.some(n => n.short && nameOk(f.name, n, plan));
        if (!byFull && !byShort) {
            const sig = anyTitle && !f._sig && signedName(f.name, plan);
            if (sig) {
                const j = judgeFile({ ...f, name: sig.name, _sig: true }, plan);
                // přijetí je předběžné – durationFilter ho nechá jen s délkou ±3 % na TMDB nebo s poměrem PAL
                if (j.ok) return { ...j, exact: false, reason: SIGNED, sig: sig.word };
            }
            return { ok: false, reason: anyTitle ? 'jiný podtitul' : 'název nesedí' };
        }
        // film ze série ("Rambo" 2008 = 4. díl, "Policejní akademie" = 1. díl): číslo dílu u názvu musí být naše pořadí
        // nebo číslo z našich názvů ("Police Academy 1: …", "Star Wars: Epizoda IV" → 1 i 4);
        // číslo PŘED názvem s přesně naším rokem nevadí ("4.Policejní akademie (1984)" – pořadové číslo v seznamu)
        if (inColl) {
            const allowed = new Set([plan.coll.i, ...plan.names.flatMap(n => M.nameNumbers(n.text))]);
            const exactYear = plan.year && M.fileYears(f.name).includes(plan.year);
            const infos = plan.names.filter(n => nameOk(f.name, n, plan)).map(n => M.partNumberInfo(f.name, n.text))
                .filter(x => x && !(x.before && exactYear));
            const nums = infos.map(x => x.n);
            if (nums.length && !nums.some(n => allowed.has(n))) return { ok: false, reason: `jiný díl série (${nums[0]})` };
            // jen zkrácený název a za ním cizí letopočet = podtitul jiného dílu ("Fear Street 1978 2021" u "Fear Street: 1994")
            if (byShort) {
                const own = new Set(plan.names.flatMap(n => M.nameTokens(n.text)));
                const four = plan.names.filter(n => n.short && nameOk(f.name, n, plan))
                    .map(n => { const h = M.afterName(f.name, n.text); return h && h.rest[0]; })
                    .find(t => /^(1\d{3}|20\d\d)$/.test(t || ''));   // i "1666"
                if (four && !own.has(four) && !(plan.year && Math.abs(+four - plan.year) <= 1)) {
                    return { ok: false, reason: `jiný díl série (${four})` };
                }
            }
        }
        const years = M.fileYears(f.name);
        const yearOk = plan.year && years.some(y => Math.abs(y - plan.year) <= 1);
        if (plan.year && years.length && !yearOk) return { ok: false, reason: `rok nesedí (${years.join(',')})` };
        // jen zkrácený název ("Pán prstenů 1") → rok v souboru musí sedět
        if (byShort && !yearOk) return { ok: false, reason: 'zkrácený název bez roku' };
        return { ok: true, exact: years.length > 0, reason: byShort ? 'zkrácený název + rok' : 'název' };
    }
    if (!plan.season || !plan.episode) {
        return plan.names.some(n => nameOk(f.name, n, plan))
            ? { ok: true, exact: false, reason: 'název' }
            : { ok: false, reason: anyTitle ? 'jiný podtitul' : 'název nesedí' };
    }
    // rok v názvu: když jsou všechny roky dřív, než seriál začal → jiný (starší) titul stejného jména
    // (rozsahy "1858 - 1961" se nepočítají; "1973 … Barbarossa 1941" projde díky 1973)
    if (plan.year && anyTitle) {
        // rok v názvu dílu ("S10E1 Archer 1999: …") se nepočítá
        const ys = M.fileYears(f.name, { noRanges: true });
        const titleYs = M.episodeTitleYears(f.name, new Set(plan.names.flatMap(n => M.nameTokens(n.text))));
        for (const y of titleYs) { const i = ys.indexOf(y); if (i !== -1) ys.splice(i, 1); }
        if (ys.length && ys.every(y => y < plan.year - 1)) return { ok: false, reason: `rok nesedí (${ys.join(',')})` };
        // stejnojmenný seriál (reboot/revival ↔ původní, jiná země) – ne u anime (remaky bývají bez roku)
        const sn = plan.isAnime || f._own ? { others: [] } : sameNameOf(plan);
        const snv = sn.others.length ? sameNameVerdict(f, plan, sn, ys) : null;
        if (snv) {
            // soubor sedí přes náš plný název, který druhý seriál nemá ("Gajokgyehoek - S1E1" × Family Matters 1989):
            // pravidlo se přeskočí, přijetí je předběžné – durationFilter ho nechá jen s délkou dílu ±15 % na TMDB
            if (!ownNameMatch(f, plan, sn)) return snv;
            const j = judgeFile({ ...f, _own: true }, plan);
            return j.ok ? { ...j, exact: false, reason: OWN_NAME } : j;
        }
    }
    return judgeNames(f, plan, anyTitle);
}

// Pravidla stejnojmenných seriálů (značka země, starší známější, novější) → vyřazení nebo null
function sameNameVerdict(f, plan, sn, ys) {
    {
        {
            // značka země za názvem ("The Office US S01E01") rozhodne před rokem
            const hit = plan.names.map(n => M.afterName(f.name, n.text)).find(Boolean);
            const mark = hit && hit.rest.slice(0, 3).map(markCountry).find(t => COUNTRY_MARK.has(t));
            const myC = sn.me && sn.me.c;
            if (mark && myC && mark === myC) { /* náš seriál – pravidla roku stejnojmenných se přeskočí */ }
            else if (mark && myC && sn.others.some(o => o.c === mark)) {
                return { ok: false, reason: `jiný seriál (${mark.toUpperCase()})` };
            } else {
                // starší existuje a je známější než náš → soubor bez našeho roku patří jemu (Scrubs 2026 × 2001);
                // když je náš známější (The Office US × UK), soubor bez roku je náš
                const myV = sn.me && sn.me.v;
                const older = sn.others.filter(o => o.y < plan.year - 1 && (myV === null || myV === undefined || o.v === null || o.v === undefined || o.v > myV));
                const newer = sn.others.filter(o => o.y > plan.year + 1).map(o => o.y);
                if (older.length && !ys.some(y => y >= plan.year - 1)) {
                    return { ok: false, reason: `bez roku (starší seriál ${older[older.length - 1].y})` };
                }
                if (newer.length) {
                    const ours = ys.some(y => y >= plan.year - 1 && y < newer[0] - 1);
                    if (!ours && ys.some(y => y >= newer[0] - 1)) return { ok: false, reason: `rok nesedí (novější seriál ${newer[0]})` };
                }
            }
        }
    }
    return null;
}

// Soubor sedí přes náš plný název, který žádný stejnojmenný seriál nemá (názvy ostatních z TMDB EN + CZ, pole n);
// bez uložených názvů (starší cache, chyba CZ hledání) → false a pravidlo platí jako dřív
const OWN_NAME = 'náš název, jiný seriál ho nemá';
function ownNameMatch(f, plan, sn) {
    if (!sn.others.every(o => Array.isArray(o.n) && o.n.length)) return false;
    const shared = new Set(sn.others.flatMap(o => o.n));
    return plan.names.some(n => !n.short && !shared.has(M.tokens(n.text).join(' ')) && nameOk(f.name, n, plan));
}

// Zbytek posouzení seriálu: název, sezóna a díl
function judgeNames(f, plan, anyTitle) {
    let reason = anyTitle ? 'jiný podtitul' : 'název nesedí', seen = null;
    // rozdělená sezóna (JoJo S06E02 = Steel Ball Run 2nd Stage 01): číslo dílu v části je menší než TMDB díl
    const split = plan.alEpisode && plan.alEpisode < plan.episode;
    for (const n of plan.names) {
        if (!nameOk(f.name, n, plan)) continue;
        // slova za názvem: značka pokračování ("Capu2", "II", "S2") a číslo dílu
        const hit = M.afterName(f.name, n.text);
        const seq = hit ? M.sequelSeason(hit.rest) : null;
        const rest = hit ? (seq ? hit.rest.slice(1) : hit.rest) : undefined;
        const pe = M.parseEpisode(f.name, M.nameTokens(n.text), rest);
        // číslo dílu na začátku souboru, když za názvem žádné není ("01. Now and Then, Here and There …")
        if (pe.episode === null && pe.season === null && hit && hit.start > 0 && (plan.season === 1 || plan.isAnime)) {
            const lead = M.stripLeadingGroups(f.name).match(/^\s*0*(\d{1,3})\s*[.)\-_]/);
            if (lead && +lead[1] > 0) { pe.episode = +lead[1]; pe.explicit = false; }
        }
        if (pe.episode === null) { reason = 'bez čísla dílu'; continue; }
        // rok hned za názvem mimo dobu vysílání ("Hawaii Five-0 2010" × seriál z roku 1968)
        const y0 = hit && hit.rest[0] && /^(19|20)\d{2}$/.test(hit.rest[0]) ? +hit.rest[0] : null;
        if (y0 && plan.year && (y0 < plan.year - 1 || y0 > plan.year + (plan.season || 1) + 2)) {
            reason = `rok nesedí (${y0})`; continue;
        }
        if (pe.season === null && seq) pe.season = seq;
        // základní název anime platí jen se značkou téže sezóny
        if (n.seasonOnly && pe.season !== n.seasonOnly) {
            if (!seen) reason = pe.season === null ? 'bez značky sezóny' : `jiná sezóna (S${pe.season})`;
            continue;
        }
        seen = pe;
        if (n.kind === 'franchise') {
            if (pe.episode === plan.episode &&
                (pe.season === plan.season || (pe.season === null && plan.season === 1))) {
                return { ok: true, exact: pe.explicit, reason: `název (${n.kind})`, s: pe.season, e: pe.episode };
            }
            // anime s absolutním číslováním pod názvem franšízy (One Piece - 1094 pro S22E10);
            // u rozdělené sezóny jen pod názvem s rozlišením části
            if (plan.isAnime && pe.season === null && plan.alEpisode &&
                plan.alEpisode !== plan.episode && pe.episode === plan.alEpisode && (!split || hasPartMarker(n))) {
                return { ok: true, exact: false, reason: 'absolutní číslo dílu', s: null, e: pe.episode };
            }
        } else if (plan.alEpisode) {
            let epOk;
            if (split && pe.explicit && pe.season === plan.season && !(pe.season === 1 && seasonInName(n))) {
                // značka S{TMDB sezóna}Exx se počítá podle TMDB ("Steel Ball Run - S06E02" = S06E02, ne 2nd Stage 02)
                epOk = pe.episode === plan.episode;
            } else if (split && pe.season === null) {
                // holé číslo jen pod názvem části ("Steel Ball Run 2nd Stage - 01"); pod společným názvem
                // bývá průběžné číslování ("Steel Ball Run [07]" = S06E07)
                epOk = pe.episode === plan.alEpisode && hasPartMarker(n);
            } else {
                epOk = pe.episode === plan.alEpisode && animeSeasonOk(pe, n, plan);
            }
            if (epOk) return { ok: true, exact: pe.explicit, reason: `název (${n.kind})`, s: pe.season, e: pe.episode };
        }
        reason = (pe.season !== null && pe.season !== plan.season && pe.episode === plan.episode)
            ? `jiná sezóna (S${pe.season})` : `jiný díl (${pe.season !== null ? 'S' + pe.season : ''}E${pe.episode})`;
    }
    // zkomolený název ("The Simps.ons S35E03", "Simpsnovi S35E03") → posoudí se opravený název
    // (rok, podtitul, číslo dílu dál platí); jen když žádný název nesedí ani částečně
    if (reason === 'název nesedí' && !f._fixed) {
        const fx = M.repairName(f.name, plan.names.map(n => n.text), plan.season, plan.episode,
            { anime: plan.isAnime, alEpisode: plan.alEpisode });
        if (fx) {
            const j = judgeFile({ ...f, name: fx.text, _fixed: true }, plan);
            if (j.ok) return { ...j, exact: false, reason: `zkomolený název (${fx.how})` };
            return { ...j, reason: `${j.reason} [zkomolený]` };
        }
    }
    return { ok: false, reason, s: seen ? seen.season : undefined, e: seen ? seen.episode : undefined };
}

function filterFiles(files, plan) {
    const out = [];
    const older = new Map();
    // vyřazené kvůli roku – pro rescueOlderSeries (vrácení souborů bez roku podle délky)
    out.rejected = [];
    for (const f of files) {
        const j = judgeFile(f, plan);
        if (j.ok) out.push({ f, exact: !!j.exact, why: j.reason });
        else {
            countOlderNamesake(older, j.reason, plan);
            if (/^(bez roku \(starší seriál|rok nesedí)/.test(j.reason)) out.rejected.push({ f, why: j.reason });
        }
    }
    plan.olderSame = olderSameOf(older);
    return out;
}
// Film: soubory stejného názvu vyřazené kvůli staršímu roku ("rok nesedí (2011)") → je nahraný i starší stejnojmenný
// film; vrací počet souborů nejčastějšího takového roku
function countOlderNamesake(map, reason, plan) {
    if (plan.type !== 'movie' || !plan.year) return;
    const m = /^rok nesedí \((\d{4})/.exec(reason || '');
    if (m && +m[1] < plan.year - 1) map.set(+m[1], (map.get(+m[1]) || 0) + 1);
}
function olderSameOf(map) {
    return map.size ? Math.max(...map.values()) : 0;
}
function olderSameFromReasons(reasons, plan) {
    const m = new Map();
    for (const r of reasons) countOlderNamesake(m, r, plan);
    return olderSameOf(m);
}

// Jazyk a kvalita: skutečné stopy z file_info mají přednost před názvem souboru
const CZ_CODES = new Set(['CZE', 'CES', 'CZ', 'CS']);
const SK_CODES = new Set(['SLO', 'SLK', 'SK']);
const CONV_SCORE = { 2160: 4, 1440: 3.5, 1080: 3, 720: 2, 576: 1.5, 480: 1, 360: 0.5 };
function describe(f, info, conv) {
    const lang = M.detectLang(f.name);
    const q = M.detectQuality(f.name);
    if (f.hs) {
        // Hellspy: převod MP4 v dané výšce; zvuk jen podle názvu, titulky z detailu
        const subs = (info && info.subs) || [];
        if (subs.includes('cze') && !lang.cz) { lang.cz = true; if (!lang.dub) lang.sub = true; }
        else if (subs.includes('slo') && !lang.cz && !lang.sk) { lang.sk = true; if (!lang.dub) lang.sub = true; }
        if (conv && conv !== '0' && !q.cam) {
            const h = parseInt(conv, 10);
            q.resolution = h >= 2000 ? '4K' : `${h}p`;
            q.score = CONV_SCORE[h] ?? (h >= 1000 ? 3 : h >= 700 ? 2 : 1);
        }
        q.codec = null; q.audio = null; q.hdr = false;
        // stejný soubor na Webshare (shodná velikost) → ověřené zvukové stopy
        const langs = info && info.au ? [...new Set(info.au.map(a => a.lang).filter(l => l && l !== 'UND'))] : [];
        let ls = M.langScore(lang);
        if (langs.length) {
            const aCz = langs.some(l => CZ_CODES.has(l)), aSk = langs.some(l => SK_CODES.has(l));
            ls = aCz ? 50 : aSk ? 35 : lang.cz ? 30 : lang.sk ? 20 : lang.multi ? 5 : 0;
        }
        return { lang, q, ls, audioLangs: langs, subLangs: subs };
    }
    const langs = info && info.au ? [...new Set(info.au.map(a => a.lang).filter(l => l && l !== 'UND'))] : [];
    let ls;
    if (langs.length) {
        const aCz = langs.some(l => CZ_CODES.has(l)), aSk = langs.some(l => SK_CODES.has(l));
        // dabing podle stop; "CZ" v názvu bez české stopy = titulky
        ls = aCz ? 50 : aSk ? 35 : lang.cz ? 30 : lang.sk ? 20 : lang.multi ? 5 : 0;
    } else {
        ls = M.langScore(lang);
    }
    if (f.fs && f.res && !q.cam) { q.resolution = f.res; q.score = FS_RES_SCORE[f.res]; }   // rozlišení z Fastshare
    if (info && info.w) {
        const w = info.w, h = info.h;
        const res = (w >= 3200 || h >= 2000) ? ['4K', 4] : (w >= 1800 || h >= 1000) ? ['1080p', 3]
                  : (w >= 1200 || h >= 700) ? ['720p', 2] : ['SD', 1];
        if (!q.cam) { q.resolution = res[0]; q.score = res[1]; }
    }
    if (info && info.vf) {
        const vf = info.vf;
        q.codec = /HEVC|H265|X265/.test(vf) ? 'HEVC' : /H264|AVC|X264/.test(vf) ? 'H.264' : /AV1/.test(vf) ? 'AV1' : q.codec;
    }
    if (info && info.au && info.au.length) {
        const a = info.au[0];
        const fmt = /TRUEHD/.test(a.f) ? 'TrueHD' : /DTS/.test(a.f) ? 'DTS' : /EAC3|E-AC-3/.test(a.f) ? 'DD+'
                  : /AC3|AC-3/.test(a.f) ? 'AC3' : /AAC/.test(a.f) ? 'AAC' : /OPUS/.test(a.f) ? 'Opus' : /MP3|MPEG/.test(a.f) ? 'MP3' : null;
        if (fmt) q.audio = fmt + (a.ch >= 6 ? ` ${a.ch === 8 ? '7.1' : '5.1'}` : a.ch === 2 ? ' 2.0' : '');
    }
    return { lang, q, ls, audioLangs: langs };
}

function rankFiles(items) {
    return items.map(it => ({ ...it, ...describe(it.f, it.info, it.conv) })).sort((a, b) =>
        ((a.q.cam ? 1 : 0) - (b.q.cam ? 1 : 0)) ||
        (b.ls - a.ls) ||
        (b.q.score - a.q.score) ||
        (srcRank(a.f) - srcRank(b.f)) ||   // při stejné kvalitě Webshare (originál, ověřený zvuk)
        ((b.exact ? 1 : 0) - (a.exact ? 1 : 0)) ||
        (b.f.size - a.f.size)
    );
}

// Délka filmu ze stop vs. TMDB: mimo toleranci = jiný film, trailer, ukázka
// (prodloužené verze mají větší rezervu nahoru)
function durationMismatch(plan, it) {
    // seriál: délka dílu z TMDB – 60–120 % (zkrácené TV verze projdou, jiný seriál stejného jména
    // s delšími díly ne), nebo 180–220 % (dvojdíl "S06E01E02" obsahuje i hledaný díl)
    if (plan.type === 'series') {
        if (!plan.epRuntime || !it.info || !it.info.len) return null;
        const min = it.info.len / 60, rt = plan.epRuntime;
        if ((min >= rt * 0.6 && min <= rt * 1.2) || (min >= rt * 1.8 && min <= rt * 2.2)) return null;
        return `délka nesedí (${Math.round(min)} min, díl ${rt} min)`;
    }
    if (plan.type !== 'movie' || !plan.runtime || !it.info || !it.info.len) return null;
    const min = it.info.len / 60, rt = plan.runtime;
    const extended = /extended|director|uncut|unrated|prodlou|rozsir|special.?edition/i.test(M.normalize(it.f.name));
    // dolní hranice 80 %: verze bez titulků / PAL zrychlení bývají kratší; jiný film nebo trailer je mimo
    const lo = rt * 0.80, hi = rt * (extended ? 1.45 : 1.15);
    if (min >= lo && min <= hi) return null;
    return `délka nesedí (${Math.round(min)} min, film ${rt} min)`;
}

// Pravidla nad celou sadou přijatých souborů (délka už známá) → Map ident → důvod vyřazení.
// 1) jednotlivé soubory podle durationMismatch;
// 2) seriál: chybná délka dílu z TMDB (Vymítač Boner S01E01: TMDB 12 min, všechny kopie 18 min) – když pravidlo
//    vyřadilo všechny soubory se známou délkou, aspoň 3 mají shodnou délku (±3 %) a odchylka od TMDB je nejvýš 2×,
//    pravidlo se pro tento díl vynechá;
// 3) nový film (letos / loni) a nahraný starší stejnojmenný film (plan.olderSame ≥ 3): soubor bez roku projde jen
//    s délkou ±2 % proti mediánu souborů s naším rokem (nebo proti TMDB), případně ±1 % na některý z nich,
//    bez délky se neodešle (Resident Evil 2026 × 2002);
//    soubor s rokem ±1 projde s ±3 % nebo s poměrem PAL (Mistrovský plán 2026 × The Masterplan 2025);
// 4) film: aspoň 3 různá čísla hned za názvem ("Death-Note-01", "-02", "-04") = díly seriálu;
// 5) film bez kolekce TMDB a nahraný starší stejnojmenný film: soubor bez roku s číslem 1–9 hned za názvem je
//    jiný díl série ("Resident Evil 1 CZ" u Resident Evil 2026);
// 6) seriál: "zkomolený název (překlep)" jen s délkou ±15 % proti přesně přijatým souborům (jinak proti TMDB);
// 7) seriál se stejnojmenným seriálem: soubor s rokem ±1 (ne naším) musí sedět ±3 % na soubor s naším rokem,
//    když jsou aspoň 2 (The Hunt 2025 HHWEB × Lov 2026);
// 8) seriál se stejnojmenným seriálem, aspoň 5 souborů se známou délkou: soubor bez našeho roku s délkou mimo ±15 %
//    od mediánu dílu je jiný seriál (Drákula 2013 × Dracula 2020 s 90min díly, Na doživotí × BBC Life +16–19 %).
//    Medián ze souborů s naším rokem (aspoň 2), jinak ze všech – pak jen když je odlehlých nejvýš třetina
//    (při převaze cizího seriálu by medián patřil jemu). Soubor s rozsahem dílů ("1x01-02") se nevyřadí;
// 9) film: soubor přijatý jen díky podpisu uploadera za názvem ("Deadpool 2   SiC") zůstane jen s délkou ±3 % na TMDB
//    nebo s poměrem PAL; bez délky nebo bez délky filmu z TMDB se neodešle;
// 10) seriál: soubor přijatý přes náš název, který stejnojmenný seriál nemá (OWN_NAME), zůstane jen s délkou
//    ±15 % na díl z TMDB (rozsah dílů = násobek); bez délky se neodešle (pojistka pro CZ název, který TMDB nezná)
const NAMESAKE_MIN = 3;
const PAL = [25 / 23.976, 23.976 / 25];
const median = a => { const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const near = (a, b, tol) => Math.abs(a - b) <= b * tol;
// číslo (1–3 číslice) hned za některým naším názvem
function numberAfterName(name, plan) {
    for (const n of plan.names) {
        const hit = M.afterName(name, n.text);
        if (hit && /^\d{1,3}$/.test(hit.rest[0] || '')) return +hit.rest[0];
    }
    return null;
}
function durationFilter(plan, items, now = new Date()) {
    const bad = new Map();
    const lenOf = it => (it.info && it.info.len) || null;
    const why = it => it.why !== undefined ? it.why : judgeFile(it.f, plan).reason;
    const live = () => items.filter(it => !bad.has(it.f.ident));
    for (const it of items) {
        const r = durationMismatch(plan, it);
        if (r) bad.set(it.f.ident, r);
    }
    if (plan.type === 'series' && plan.epRuntime && bad.size) {
        const withLen = items.filter(lenOf);
        if (withLen.length && withLen.every(it => bad.has(it.f.ident))) {
            const lens = withLen.map(it => lenOf(it) / 60);
            const med = median(lens);
            const close = lens.filter(l => Math.abs(l - med) <= med * 0.03).length;
            if (close >= 3 && med <= plan.epRuntime * 2 && med >= plan.epRuntime / 2) bad.clear();
        }
    }
    if (plan.type === 'movie') {
        if (plan.year && plan.year >= now.getUTCFullYear() - 1 && (plan.olderSame || 0) >= NAMESAKE_MIN) {
            const ours = live().filter(it => lenOf(it) && M.fileYears(it.f.name).includes(plan.year)).map(lenOf);
            const ref = ours.length >= 2 ? median(ours) : plan.runtime ? plan.runtime * 60 : null;
            for (const it of live()) {
                const ys = M.fileYears(it.f.name), len = lenOf(it);
                if (!ys.length) {
                    // bez roku: jen ±2 % na medián, bez výjimky PAL (Tower Heist × Mistrovský plán má náhodou poměr PAL);
                    // nebo ±1 % na některou z aspoň 2 kopií s naším rokem – medián umí posunout CZ PAL kopie
                    // (Spodina 2026: 5× 5160 s PAL + 5404 s, soubor bez roku 5403 s)
                    const sameAsOurs = len && ours.length >= 2 && ours.some(l => near(len, l, 0.01));
                    if (!sameAsOurs && (!ref || !len || !near(len, ref, 0.02))) {
                        bad.set(it.f.ident, `bez roku (starší film stejného jména${len ? `, ${Math.round(len / 60)} min` : ''})`);
                    }
                } else if (!ys.includes(plan.year) && ref && len) {
                    // rok ±1: ±3 % nebo PAL zrychlení / zpomalení (±1 %)
                    if (!near(len, ref, 0.03) && !PAL.some(q => near(len / ref, q, 0.01))) {
                        bad.set(it.f.ident, `rok ±1, jiná délka (starší film stejného jména, ${Math.round(len / 60)} min)`);
                    }
                }
            }
        }
        const ref = plan.runtime ? plan.runtime * 60 : null;
        for (const it of live()) {
            if (why(it) !== SIGNED) continue;
            const len = lenOf(it);
            if (!ref || !len || !(near(len, ref, 0.03) || PAL.some(q => near(len / ref, q, 0.01)))) {
                bad.set(it.f.ident, `podpis uploadera, délka nesedí${len ? ` (${Math.round(len / 60)} min)` : ' (bez délky)'}`);
            }
        }
        const nums = new Map(live().map(it => [it.f.ident, numberAfterName(it.f.name, plan)]).filter(x => x[1] !== null));
        if (new Set(nums.values()).size >= 3) for (const id of nums.keys()) bad.set(id, 'vypadá jako díl seriálu');
        if ((plan.olderSame || 0) > 0 && !plan.coll && !plan.hasColl) {
            const allowed = new Set(plan.names.flatMap(n => M.nameNumbers(n.text)));
            for (const it of live()) {
                if (M.fileYears(it.f.name).length) continue;
                const x = plan.names.map(n => M.partNumberInfo(it.f.name, n.text)).find(v => v && !v.before);
                if (x && x.n >= 1 && x.n <= 9 && !allowed.has(x.n)) bad.set(it.f.ident, `bez roku s číslem za názvem (${x.n})`);
            }
        }
    }
    if (plan.type === 'series') {
        for (const it of live()) {
            if (why(it) !== OWN_NAME) continue;
            const len = lenOf(it), r = M.episodeRange(it.f.name);
            const ref = plan.epRuntime ? plan.epRuntime * 60 * (r ? r.to - r.from + 1 : 1) : null;
            if (!ref || !len || !near(len, ref, 0.15)) {
                bad.set(it.f.ident, `náš název, délka nesedí${len ? ` (${Math.round(len / 60)} min, díl ${plan.epRuntime || '?'} min)` : ' (bez délky)'}`);
            }
        }
        const typo = live().filter(it => lenOf(it) && why(it) === 'zkomolený název (překlep)');
        if (typo.length) {
            const exact = live().filter(it => lenOf(it) && !/^zkomolen/.test(why(it))).map(lenOf);
            const ref = exact.length ? median(exact) : plan.epRuntime ? plan.epRuntime * 60 : null;
            for (const it of typo) {
                if (ref && !near(lenOf(it), ref, 0.15)) bad.set(it.f.ident, `zkomolený název, délka nesedí (${Math.round(lenOf(it) / 60)} min)`);
            }
        }
        if (plan.year && !plan.isAnime && sameNameOf(plan).others.length) {
            const ours = live().filter(it => lenOf(it) && M.fileYears(it.f.name).includes(plan.year)).map(lenOf);
            if (ours.length >= 2) {
                for (const it of live()) {
                    const ys = M.fileYears(it.f.name), len = lenOf(it);
                    if (!len || ys.includes(plan.year) || !ys.some(y => Math.abs(y - plan.year) === 1)) continue;
                    if (!ours.some(l => near(len, l, 0.03))) bad.set(it.f.ident, `rok ±1, jiná délka (jiný seriál stejného jména, ${Math.round(len / 60)} min)`);
                }
            }
            const withLen = live().filter(lenOf);
            if (withLen.length >= 5) {
                const isOurs = it => M.fileYears(it.f.name).includes(plan.year);
                const oursLen = withLen.filter(isOurs).map(lenOf);
                const anchored = oursLen.length >= 2;
                const ref = median(anchored ? oursLen : withLen.map(lenOf));
                const odd = withLen.filter(it => !isOurs(it) && !near(lenOf(it), ref, 0.15) && !M.episodeRange(it.f.name));
                if (anchored || odd.length <= withLen.length / 3) {
                    for (const it of odd) {
                        bad.set(it.f.ident, `délka nesedí na náš seriál (${Math.round(lenOf(it) / 60)} min, díl ${Math.round(ref / 60)} min)`);
                    }
                }
            }
        }
    }
    return bad;
}

// Seriál se starším (známějším) stejnojmenným seriálem: soubor vyřazený jako "bez roku (starší seriál)" se vrátí,
// když po vynechání tohoto pravidla projde a jeho délka sedí ±2 % na přijatý soubor s naším rokem, ale na žádný
// soubor téhož dílu s rokem staršího seriálu (Lov 2026 CZ dabing 2975 s × The Hunt 2015 3464 s). Bez souboru
// se starším rokem a délkou: srovnávací jsou pak čisté kopie téhož dílu bez roku (projdou názvem i bez pravidla),
// které se od našich liší o víc než 10 % – starší seriál má prokazatelně jinou délku dílu (Gone 2018 "Gone S01E01
// CZdab" 2583 s × Gone 2026 2950 s); vrátí se pak jen soubor ±1 %. Bez takové kopie se nic nemění (Scrubs 2001
// i 2026 mají díl 1347 s).
// rejected = [{ f, info, why }] – vyřazené soubory se známou délkou; vrací vrácené položky
function rescueOlderSeries(plan, items, rejected) {
    if (plan.type !== 'series' || !plan.year || !plan.season || !plan.episode || plan.isAnime) return [];
    const lenOf = it => (it.info && it.info.len) || null;
    const older = new Set(sameNameOf(plan).others.filter(o => o.y < plan.year - 1).map(o => o.y));
    if (!older.size) return [];
    const ep = new RegExp(`\\bs0*${plan.season} ?e0*${plan.episode}\\b|\\b0*${plan.season}x0*${plan.episode}\\b`);
    const sameEp = it => ep.test(M.normalize(it.f.name));
    // naše kopie: s naším rokem, nebo přijaté přes náš název, který druhý seriál nemá ("Gajokgyehoek - S1E1 KO"),
    // pokud sedí délkou na díl z TMDB (±15 % jako pravidlo 10 v durationFilter – to proběhne až po vracení)
    const ownOk = it => it.why === OWN_NAME && plan.epRuntime && near(lenOf(it), plan.epRuntime * 60, 0.15);
    const ours = items.filter(it => lenOf(it) && (M.fileYears(it.f.name).includes(plan.year) || ownOk(it))).map(lenOf);
    if (!ours.length) return [];
    const plain = { ...plan, sameName: null };
    const cand = rejected.filter(it => /^bez roku \(starší seriál/.test(it.why || '') && lenOf(it));
    const clean = new Map(cand.map(it => [it, judgeFile(it.f, plain).ok]));
    let refs = [...items, ...rejected].filter(it => lenOf(it) && M.fileYears(it.f.name).some(y => older.has(y)) && sameEp(it)).map(lenOf);
    let tol = 0.02;
    if (!refs.length) {
        refs = cand.filter(it => clean.get(it) && sameEp(it) && ours.every(l => !near(lenOf(it), l, 0.10))).map(lenOf);
        tol = 0.01;
    }
    if (!refs.length) return [];
    return cand.filter(it => clean.get(it) && ours.some(l => near(lenOf(it), l, tol)) && !refs.some(l => near(lenOf(it), l, 0.02)))
        .map(it => ({ ...it, exact: false, why: RESCUED }));
}
const RESCUED = 'bez roku, délka sedí na náš seriál';

// Doplní file_info pro dané soubory (max 6 souběžně, časový limit 2,5 s – zbytek doběhne na pozadí do cache)
const fileCache = new PersistentCache('files', 200000);
setInterval(() => fileCache.save(), 2 * 60 * 1000).unref();
async function fetchFileInfo(cfg, ident) {
    const r = await withToken(cfg, t => wsFileInfo(t, ident));
    if (r.info) {
        const i = r.info;
        const rec = { ok: i.ok, len: i.len, w: i.w, h: i.h, vf: i.vf, au: i.au };
        fileCache.set(ident, rec, (i.ok ? 7 : 30) * 24 * H);
        return rec;
    }
    if (r.missing) { const rec = { ok: false }; fileCache.set(ident, rec, 30 * 24 * H); return rec; }
    return null;
}
async function enrichFiles(cfg, items, deadlineMs = 1500) {
    if (!hasWs(cfg)) return true;
    const todo = items.filter(it => isWs(it.f)).map(it => it.f.ident).filter(id => fileCache.get(id) === undefined);
    if (!todo.length) return true;
    let i = 0;
    const worker = async () => {
        while (i < todo.length) {
            const id = todo[i++];
            try { await once(`fi:${id}`, () => fetchFileInfo(cfg, id)); } catch (e) { dbg(`file_info ${id}: ${e.message}`); }
        }
    };
    const all = Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
    const timedOut = await Promise.race([all.then(() => false), new Promise(r => setTimeout(() => r(true), deadlineMs).unref())]);
    return !timedOut;
}

// Hellspy detail (převody + titulky) pro nejlepší kandidáty; metadata trvale ve fileCache
async function fetchHsMeta(f) {
    const d = await hsDetail(f.id, f.hash);
    const rec = hsMeta(d);
    fileCache.set(f.ident, rec, (rec.ok ? 3 : 7) * 24 * H);
    return rec;
}
async function enrichHellspy(items, deadlineMs = 1500) {
    const todo = items.filter(it => it.f.hs && fileCache.get(it.f.ident) === undefined).map(it => it.f);
    if (!todo.length) return true;
    let i = 0;
    const worker = async () => {
        while (i < todo.length) {
            const f = todo[i++];
            try { await fetchHsMeta(f); } catch (e) { dbg(`hellspy detail ${f.id}: ${e.message}`); }
        }
    };
    const all = Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    const timedOut = await Promise.race([all.then(() => false), new Promise(r => setTimeout(() => r(true), deadlineMs).unref())]);
    return !timedOut;
}
// Hellspy soubor → jeden stream na každý dostupný převod (bez detailu jeden „nejlepší“)
function expandHellspy(items) {
    const out = [];
    for (const it of items) {
        if (!it.f.hs) { out.push(it); continue; }
        const conv = it.info && it.info.conv;
        if (conv && conv.length) conv.forEach(c => out.push({ ...it, conv: c }));
        else out.push({ ...it, conv: null });
    }
    return out;
}

// Stejný soubor nahraný víckrát (shodná velikost na bajt, v rámci jednoho zdroje) → jen jednou;
// první = nejlépe seřazený. Webshare × Hellspy se neslučuje (originál × převod MP4).
const sizeKey = f => (f.size ? `${srcLetter(f)}:${f.size}` : null);
// dropped: Map vyřazená kopie → ident ponechaného souboru (archiv u kopie zapíše verdikt ponechaného)
// onlySearchLen: jen zdroje s délkou z hledání (Hellspy) – Webshare se slučuje až po file_info
function dedupeBySize(items, onlySearchLen, dropped) {
    const seen = new Map();
    return items.filter(it => {
        if (onlySearchLen && !lenFromSearch(it.f)) return true;
        const k = sizeKey(it.f);
        if (!k) return true;
        if (seen.has(k)) { if (dropped) dropped.set(it.f.ident, seen.get(k)); return false; }
        seen.set(k, it.f.ident);
        return true;
    });
}
// Soubory k ověření (file_info / detail): nejlepších N různých velikostí, od každé max. 2 kopie (záloha, kdyby první byla smazaná)
function enrichTargets(ranked, n) {
    const per = new Map(), out = [];
    let uniq = 0;
    for (const it of ranked) {
        const k = sizeKey(it.f) || it.f.ident;
        const c = per.get(k) || 0;
        if (c >= 2) continue;
        if (c === 0) { if (uniq >= n) continue; uniq++; }
        per.set(k, c + 1);
        out.push(it);
    }
    return out;
}
// Hellspy: tentýž film nahraný znovu pod jiným názvem/velikostí ("… T.O.P", "… BeDev2026") →
// stejná délka na sekundu + stejný jazykový profil z názvu = jedna kopie (první = nejlépe seřazená)
function langProfile(name) {
    const l = M.detectLang(name);
    return `${l.cz ? 'cz' : ''}${l.sk ? 'sk' : ''}${l.dub ? 'D' : l.sub ? 'T' : ''}`;
}
function dedupeHellspyCopies(items, dropped) {
    const seen = new Map();
    return items.filter(it => {
        if (!it.f.hs || !it.f.len) return true;   // jen Hellspy (převody) – u Fastshare jsou různé velikosti různé kvality
        const k = `${it.f.len}|${langProfile(it.f.name)}`;
        if (seen.has(k)) { if (dropped) dropped.set(it.f.ident, seen.get(k)); return false; }
        seen.set(k, it.f.ident);
        return true;
    });
}
// Strop Hellspy souborů (každý = 1–2 streamy), ať zbyde místo pro originály z Webshare
const HS_MAX_FILES = 6;
function capHellspy(items, max) {
    let n = 0;
    return items.filter(it => !it.f.hs || ++n <= max);
}

// Zvukové stopy ze stejného souboru na Webshare (shodná velikost na bajt)
function wsAudioBySize(items) {
    const m = new Map();
    for (const it of items) {
        if (!isWs(it.f) || !it.f.size) continue;
        const fi = fileCache.get(it.f.ident);
        if (fi && fi.au && fi.au.length && !m.has(it.f.size)) m.set(it.f.size, fi.au);
    }
    return m;
}

// Najde a seřadí soubory pro dané ID (výsledek je sdílený pro všechny uživatele se stejnými zdroji, 30 min)
async function findFiles(type, id, cfg) {
    const src = `${hasWs(cfg) ? 'w' : ''}${hsOn(cfg) ? 'h' : ''}${hasFs(cfg) ? 'f' : ''}`;
    if (!src) return { plan: null, items: [], queries: 0, ms: 0 };
    const key = `res:${type}:${id}:${src}`;
    const hit = resultCache.get(key);
    if (hit) return { ...hit, cached: true };
    return once(key, async () => {
        const t0 = Date.now();
        const plan = await buildPlan(type, id, cfg);
        if (!plan) {
            archiveWrite({ t: new Date().toISOString(), kind: 'stream', type, id, names: [], note: 'bez názvů' });
            return { plan: null, items: [], queries: 0, ms: Date.now() - t0 };
        }
        const [w1, w2] = buildQueries(plan);
        const r1 = await runQueries(cfg, w1, { budgetMs: 4000 });
        const deg = { ...r1.deg };
        // první vlna: Webshare/Fastshare jen chyby, nebo zdroj nestihl ani jeden dotaz → jednou zopakovat,
        // ať krátký výpadek (často v celou hodinu) nedá 0 streamů
        const wsAgain = r1.wsFailed || r1.wsTimedOut, hsAgain = r1.hsTimedOut, fsAgain = r1.fsFailed || r1.fsTimedOut;
        if (wsAgain || hsAgain || fsAgain) {
            const failed = r1.wsFailed || r1.fsFailed, slow = r1.wsTimedOut || r1.hsTimedOut || r1.fsTimedOut;
            log(`  🔁 ${[wsAgain && 'Webshare', hsAgain && 'Hellspy', fsAgain && 'Fastshare'].filter(Boolean).join(' + ')}: první vlna ${failed ? 'selhala' : 'nestihla'} – opakuji`);
            await new Promise(r => setTimeout(r, failed && !slow ? 300 : 1000).unref());
            const rr = await runQueries(cfg, w1, { ws: wsAgain, hs: hsAgain, fs: fsAgain, budgetMs: 2500 });
            for (const [k, v] of rr.files) if (!r1.files.has(k)) r1.files.set(k, v);
            if (wsAgain) { deg.wsRetry = rr.wsFailed || rr.wsTimedOut ? 'selhalo' : 'ok'; if (!rr.dead.ws) r1.dead.ws = false; }
            if (hsAgain) { deg.hsRetry = rr.hsTimedOut || rr.dead.hs ? 'selhalo' : 'ok'; if (!rr.dead.hs) r1.dead.hs = false; }
            if (fsAgain) { deg.fsRetry = rr.fsFailed || rr.fsTimedOut || rr.dead.fs ? 'selhalo' : 'ok'; if (!rr.dead.fs) r1.dead.fs = false; }
        }
        if (plan.sameNameP) {
            plan.sameName = await Promise.race([plan.sameNameP, new Promise(r => setTimeout(() => r(null), 1500).unref())]);
            plan.sameNameP = null;
        }
        if (plan.collP) {
            plan.coll = await Promise.race([plan.collP, new Promise(r => setTimeout(() => r(null), 1500).unref())]);
            plan.collP = null;
        }
        const files = r1.files;
        let degraded = r1.degraded;
        let items = filterFiles([...files.values()], plan);
        let queries = w1.length;
        // druhá vlna zvlášť pro každý zdroj – Hellspy nesmí zastavit dohledání na Webshare (a naopak)
        const wsFew = hasWs(cfg) && !r1.dead.ws && items.filter(it => isWs(it.f)).length < 5;
        const hsFew = hsOn(cfg) && !r1.dead.hs && items.filter(it => it.f.hs).length < 5;
        const fsFew = hasFs(cfg) && !r1.dead.fs && items.filter(it => it.f.fs).length < 5;
        if ((wsFew || hsFew || fsFew) && w2.length) {
            const r2 = await runQueries(cfg, w2, { ws: wsFew, hs: hsFew, fs: fsFew, budgetMs: 3000 });
            for (const [k, v] of r2.files) if (!files.has(k)) files.set(k, v);
            for (const [k, v] of Object.entries(r2.deg)) deg[`${k}2`] = v;
            degraded = degraded || r2.degraded;
            items = filterFiles([...files.values()], plan);
            queries += w2.length;
        }
        // Hellspy: délka už z hledání
        const dupes = new Map();
        let ranked = dedupeHellspyCopies(dedupeBySize(rankFiles(items.map(it => lenFromSearch(it.f) ? { ...it, info: { len: it.f.len } } : it)), true, dupes), dupes);
        // file_info (Webshare) a detail (Hellspy) pro nejlepší soubory – souběžně, s časovým limitem
        const max = plan.type === 'movie' ? 30 : 25;
        const top = enrichTargets(ranked.filter(it => !it.f.fs), max + 10);   // Fastshare nemá co ověřovat
        const [completeWs, completeHs] = await Promise.all([
            enrichFiles(cfg, top),
            hsOn(cfg) ? enrichHellspy(top.filter(it => it.f.hs).slice(0, 15)) : true
        ]);
        const complete = completeWs && completeHs;
        // délka dílu z TMDB – mezitím už doběhla; když ne, max. 300 ms, jinak bez kontroly délky
        if (plan.epRuntimeP) {
            plan.epRuntime = await Promise.race([plan.epRuntimeP, new Promise(r => setTimeout(() => r(null), 300).unref())]);
            plan.epRuntimeP = null;
        }
        const wsAu = wsAudioBySize(ranked);
        const playable = ranked
            .map(it => {
                const fi = fileCache.get(it.f.ident);
                if (lenFromSearch(it.f)) return { ...it, info: { ...(fi || {}), len: it.f.len, au: wsAu.get(it.f.size) || undefined } };
                return { ...it, info: fi || it.info };
            })
            .filter(it => !it.info || it.info.ok !== false);
        // soubory bez roku vyřazené kvůli staršímu stejnojmennému seriálu – zpět, když délkou sedí na náš rok
        const rejected = (items.rejected || []).map(it => {
            const fi = lenFromSearch(it.f) ? null : fileCache.get(it.f.ident);
            return { ...it, info: lenFromSearch(it.f) ? { len: it.f.len } : fi || null };
        }).filter(it => it.info && it.info.len && it.info.ok !== false);
        const rescued = rescueOlderSeries(plan, playable, rejected);
        if (rescued.length) playable.push(...rescued);
        const durationBad = durationFilter(plan, playable);
        ranked = rankFiles(expandHellspy(capHellspy(dedupeBySize(rankFiles(playable
            .filter(it => !durationBad.has(it.f.ident))), false, dupes), HS_MAX_FILES)));
        // výpadek zdroje (deg) a výrazně méně streamů než minule → doplnit z posledního úplného výsledku (24 h);
        // odkaz se řeší až při přehrání podle identu, smazaný soubor selže až tam
        const sendMax = plan.type === 'movie' ? 30 : 25;
        if (!degraded && ranked.length) lastFull.set(key, ranked.slice(0, sendMax + 10), 24 * H);
        else if (degraded) {
            const prev = lastFull.get(key);
            if (prev && Math.min(ranked.length, sendMax) < Math.min(prev.length, sendMax) / 3) {
                const k = it => `${sizeKey(it.f) || it.f.ident}|${it.conv || ''}`;
                const have = new Set(ranked.map(k));
                const add = prev.filter(it => !have.has(k(it)));
                if (add.length) {
                    ranked = rankFiles([...ranked, ...add]);
                    deg.fill = add.length;
                    log(`  ♻️ výpadek zdroje – doplněno ${add.length} položek z posledního úplného výsledku`);
                }
            }
        }
        const res = { plan, items: ranked, queries, total: files.size, ms: Date.now() - t0 };
        // neúplné obohacení (časový limit) → kratší cache, ať se stopy brzy doplní; výpadek zdroje → 1 min
        if (ranked.length) resultCache.set(key, res, (degraded ? 1 : complete ? 30 : 3) * 60 * 1000);
        archiveSearch(plan, [...w1, ...(queries > w1.length ? w2 : [])], files, ranked, res.ms, durationBad, src, dupes, deg,
            new Set(rescued.map(it => it.f.ident)));
        return res;
    });
}

// ───────────────────────── Archiv hledání (anonymní) – záznam ─────────────────────────
function archiveSearch(plan, queries, files, ranked, ms, durationBad, src, dupes, deg, rescued) {
    if (!hooks.archiveOn()) return;
    const sent = new Map();
    ranked.slice(0, plan.type === 'movie' ? 30 : 25).forEach((it, i) => { if (!sent.has(it.f.ident)) sent.set(it.f.ident, i + 1); });
    archiveWrite({
        t: new Date().toISOString(), kind: 'stream', v: hooks.version, src, type: plan.type, id: plan.id,
        anime: plan.anilistId || null, source: plan.source, year: plan.year, runtime: plan.runtime, epRuntime: plan.epRuntime || undefined,
        sameName: plan.sameName && plan.sameName.length ? plan.sameName : undefined,
        coll: plan.coll || undefined,
        olderSame: plan.olderSame || undefined,
        deg: deg && Object.keys(deg).length ? deg : undefined,
        season: plan.season, episode: plan.episode, alEpisode: plan.alEpisode, alSeason: plan.alSeason,
        names: plan.names.map(n => ({ text: n.text, kind: n.kind, short: !!n.short, ...(n.seasonOnly ? { seasonOnly: n.seasonOnly } : {}) })),
        queries: queries.map(q => q.q), ms,
        files: [...files.values()].map(f => {
            let j = judgeFile(f, plan);
            if (!j.ok && rescued && rescued.has(f.ident)) j = { ok: true, reason: RESCUED };
            const rec = { n: f.name, s: f.size, ok: j.ok, r: j.reason };
            if (!isWs(f)) rec.src = f.hs ? 'hs' : 'fs';
            if (dupes && dupes.has(f.ident)) rec.dup = 1;   // stejná velikost jako jiný (odeslaný) soubor
            if (j.ok && durationBad) {
                // kopie převezme vyřazení ponechaného souboru (Hodnej × "Good Boy (2025)" – kopie byla v archivu ok)
                let id = f.ident;
                for (let i = 0; i < 4 && !durationBad.has(id) && dupes && dupes.has(id); i++) id = dupes.get(id);
                if (durationBad.has(id)) { rec.ok = false; rec.r = durationBad.get(id); }
            }
            const fi = fileCache.get(f.ident);
            if (lenFromSearch(f)) {   // Hellspy / Fastshare: délka z hledání, převody a titulky z detailu (Hellspy)
                if (f.len) rec.len = f.len;
                if (f.fs && f.resRaw) rec.res = f.resRaw;
                if (fi) { rec.av = fi.ok; if (fi.conv) rec.conv = fi.conv; if (fi.subs && fi.subs.length) rec.subs = fi.subs; }
            } else if (fi) {   // skutečné stopy z file_info (jen u souborů, pro které se zjišťovaly)
                rec.av = fi.ok;
                if (fi.au && fi.au.length) rec.au = fi.au.map(x => x.lang || '?');
                if (fi.len) rec.len = fi.len;
                if (fi.w) rec.res = `${fi.w}x${fi.h}`;
            }
            if (j.e !== undefined && j.e !== null) rec.se = [j.s ?? null, j.e];
            if (sent.has(f.ident)) rec.sent = sent.get(f.ident);
            return rec;
        })
    });
}


// ───────────────────────── Streamy ─────────────────────────
function formatSize(bytes) {
    if (!bytes) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 0)} ${u[i]}`;
}

function langLabel(l) {
    const parts = [];
    if (l.cz) parts.push('🇨🇿 CZ');
    if (l.sk) parts.push('🇸🇰 SK');
    if (l.en) parts.push('🇬🇧 EN');
    if (!parts.length && l.multi) parts.push('🌍 MULTI');
    let s = parts.join(' + ');
    if (s && l.dub) s += ' dabing';
    else if (s && l.sub) s += ' titulky';
    else if (!s && l.sub) s = '💬 titulky';
    return s;
}

function playUrl(base, cfgB64, f) {
    const safe = f.name.replace(/[\/\\?#%]+/g, ' ').trim() || 'video';
    return `${base}/${cfgB64}/play/${encodeURIComponent(f.ident)}/${encodeURIComponent(safe)}`;
}

const FLAGS = { CZE: '🇨🇿 CZ', CES: '🇨🇿 CZ', CZ: '🇨🇿 CZ', CS: '🇨🇿 CZ', SLO: '🇸🇰 SK', SLK: '🇸🇰 SK', SK: '🇸🇰 SK',
    ENG: '🇬🇧 EN', EN: '🇬🇧 EN', GER: '🇩🇪 DE', DEU: '🇩🇪 DE', FRE: '🇫🇷 FR', FRA: '🇫🇷 FR', ITA: '🇮🇹 IT',
    SPA: '🇪🇸 ES', POL: '🇵🇱 PL', HUN: '🇭🇺 HU', RUS: '🇷🇺 RU', UKR: '🇺🇦 UA', JPN: '🇯🇵 JP', JAP: '🇯🇵 JP',
    KOR: '🇰🇷 KO', CHI: '🇨🇳 ZH', ZHO: '🇨🇳 ZH', POR: '🇵🇹 PT' };
// Zvuk ze skutečných stop ("🔊 🇨🇿 CZ · 🇬🇧 EN"), titulky jen z názvu ("💬 CZ")
function audioSubsLabel(item) {
    const { lang, audioLangs } = item;
    const parts = [];
    if (audioLangs && audioLangs.length) {
        parts.push('🔊 ' + [...new Set(audioLangs.map(l => FLAGS[l] || l))].slice(0, 4).join(' · '));
        if (lang.sub) {
            const subs = [lang.cz && !audioLangs.some(l => CZ_CODES.has(l)) ? 'CZ' : null,
                          lang.sk && !audioLangs.some(l => SK_CODES.has(l)) ? 'SK' : null].filter(Boolean);
            parts.push('💬 ' + (subs.length ? subs.join(' · ') : 'titulky'));
        } else if (lang.cz && !audioLangs.some(l => CZ_CODES.has(l))) {
            parts.push('💬 CZ');   // "CZ" v názvu, ale česká stopa chybí → nejspíš titulky
        } else if (lang.sk && !audioLangs.some(l => SK_CODES.has(l))) {
            parts.push('💬 SK');
        }
        return parts.join('  ');
    }
    return langLabel(lang);
}

function formatLength(sec) {
    if (!sec) return null;
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const safeName = n => String(n || '').replace(/[\/\\?#%]+/g, ' ').trim() || 'video';
function hsToStream(item, base, cfgB64) {
    const { f, lang, q, info, conv } = item;
    const subs = (info && info.subs) || [];
    const langs = item.audioLangs && item.audioLangs.length
        ? '🔊 ' + [...new Set(item.audioLangs.map(l => FLAGS[l] || l))].slice(0, 4).join(' · ')
        : langLabel(M.detectLang(f.name));
    const subLbl = subs.length ? `💬 ${subs.map(l => ({ cze: 'CZ', ces: 'CZ', slo: 'SK', slk: 'SK', eng: 'EN' }[l] || l.toUpperCase())).join(' · ')}` : null;
    const meta = [info && info.len ? `⏱ ${formatLength(info.len)}` : null, conv && conv !== '0' ? 'MP4 převod' : null,
                  f.size ? `originál ${formatSize(f.size)}` : null].filter(Boolean).join('  ·  ');
    const res = q.cam ? 'CAM' : (conv ? (q.resolution || 'SD') : 'auto');
    const fname = (info && info.fn) || `${safeName(f.name)}.mp4`;
    const stream = {
        name: `Hellspy\n${res}`,
        title: [f.name, [langs, subLbl].filter(Boolean).join('  '), meta].filter(Boolean).join('\n'),
        url: `${base}/${cfgB64}/hs/play/${encodeURIComponent(f.id)}/${encodeURIComponent(f.hash)}/${conv || 'best'}/${encodeURIComponent(safeName(f.name))}.mp4`,
        behaviorHints: { bingeGroup: `hellspy-${res}`, filename: fname }
    };
    // titulky přes server (odkazy Hellspy po ~24 h vyprší)
    if (subs.length) {
        stream.subtitles = subs.map((l, i) => ({
            id: `hs-${f.id}-${i}`, lang: l || 'und',
            url: `${base}/${cfgB64}/hs/sub/${encodeURIComponent(f.id)}/${encodeURIComponent(f.hash)}/${i}.vtt`
        }));
    }
    return stream;
}

// Fastshare: originál, jazyk z názvu (zvuk ze stejného souboru na Webshare, když ho máme); odkaz až při přehrání
function fsPlayUrl(base, cfgB64, f) {
    return `${base}/${cfgB64}/fs/play/${encodeURIComponent(f.id)}/${encodeURIComponent(safeName(f.name))}`;
}
function fsToStream(item, base, cfgB64) {
    const { f, lang, q, info } = item;
    const tech = [q.source, q.codec, q.audio, q.hdr ? 'HDR' : null].filter(Boolean).join(' · ');
    const meta = [f.size ? `💾 ${formatSize(f.size)}` : null, info && info.len ? `⏱ ${formatLength(info.len)}` : null, tech].filter(Boolean).join('  ·  ');
    return {
        name: `Fastshare\n${q.cam ? 'CAM' : (q.resolution || 'SD')}`,
        title: [f.name, audioSubsLabel(item), meta].filter(Boolean).join('\n'),
        url: fsPlayUrl(base, cfgB64, f),
        behaviorHints: {
            bingeGroup: `fastshare-${q.resolution || 'sd'}-${lang.cz ? 'cz' : lang.sk ? 'sk' : 'x'}${lang.dub ? '-dub' : ''}`,
            filename: f.name,
            videoSize: f.size || undefined
        }
    };
}

function toStream(item, base, cfgB64) {
    if (item.f.hs) return hsToStream(item, base, cfgB64);
    if (item.f.fs) return fsToStream(item, base, cfgB64);
    const { f, lang, q, info } = item;
    const lbl = audioSubsLabel(item);
    const tech = [q.source, q.codec, q.audio, q.hdr ? 'HDR' : null].filter(Boolean).join(' · ');
    const star = f.pos >= 3 && f.pos > f.neg * 3 ? ' ⭐' : '';
    const meta = [`💾 ${formatSize(f.size)}`, info && info.len ? `⏱ ${formatLength(info.len)}` : null, tech].filter(Boolean).join('  ·  ');
    const lines = [f.name, lbl, meta + star].filter(Boolean);
    return {
        name: `Webshare\n${q.cam ? 'CAM' : (q.resolution || 'SD')}`,
        // jen "title" – stremio-core bere title jako alias description; obě pole naráz = odpověď zahozena
        title: lines.join('\n'),
        url: playUrl(base, cfgB64, f),
        behaviorHints: {
            bingeGroup: `webshare-${q.resolution || 'sd'}-${lang.cz ? 'cz' : lang.sk ? 'sk' : 'x'}${lang.dub ? '-dub' : ''}`,
            filename: f.name,
            videoSize: f.size || undefined
        }
    };
}

async function handleStream(type, id, cfg, base, cfgB64) {
    // Soubor z katalogu "Webshare Hledat"
    if (id.startsWith('webshare-')) {
        if (!hasWs(cfg)) return [];
        const ident = id.slice(9);
        const r = await withToken(cfg, t => wsFileInfo(t, ident));
        if (!r.info) return [];
        if (r.info.ok === false) return [];
        const item = rankFiles([{ f: r.info, exact: true, info: r.info }])[0];
        return [toStream(item, base, cfgB64)];
    }
    // Soubor z katalogu "Hellspy Hledat"
    if (id.startsWith('hellspy-')) {
        if (!hsOn(cfg)) return [];
        const hf = await hsFileFromId(id);
        if (!hf) return [];
        return rankFiles(expandHellspy([{ f: hf.f, exact: true, info: hf.info }])).map(it => toStream(it, base, cfgB64));
    }
    // Soubor z katalogu "Fastshare Hledat"
    if (id.startsWith('fastshare-')) {
        if (!hasFs(cfg)) return [];
        const f = fsFileFromId(id);
        if (!f) return [];
        return [toStream(rankFiles([{ f, exact: true, info: { len: f.len } }])[0], base, cfgB64)];
    }
    const res = await findFiles(type, id, cfg);
    const max = type === 'movie' ? 30 : 25;
    const streams = res.items.slice(0, max).map(it => toStream(it, base, cfgB64));
    const p = res.plan;
    const nHs = res.items.slice(0, max).filter(it => it.f.hs).length, nFs = res.items.slice(0, max).filter(it => it.f.fs).length;
    log(`🎬 ${type} ${id} [${who(cfg)}] ${p ? (p.isAnime ? `anime AL${p.anilistId}` : p.source) : 'bez názvů'}` +
        `${p ? ` | názvy: ${p.names.map(n => n.text).join(' / ')}` : ''}` +
        ` | dotazů ${res.queries || 0}, souborů ${res.total || 0}, streamů ${streams.length}${nHs || nFs ? ` (${[nHs && `Hellspy ${nHs}`, nFs && `Fastshare ${nFs}`].filter(Boolean).join(', ')})` : ''}` +
        `${res.cached ? ' (cache)' : ` | ${res.ms} ms`}` +
        `${res.items.length ? ` | 1.: ${res.items[0].f.name}` : ''}`);
    return streams;
}

// ───────────────────────── Katalog „Webshare Hledat“ a meta ─────────────────────────
async function handleCatalog(type, extra, cfg, base) {
    if (cfg.enable_direct_search === false || !hasWs(cfg)) return [];
    const query = (extra.search || '').trim();
    if (!query) return [];
    const r = await withToken(cfg, t => wsSearch(t, query, 100));
    r.files = r.files.filter(f => !M.isNonVideo(f.name));
    const backdrop = `${base}/backdrop.jpg`;
    log(`🔍 hledat "${query}" [${who(cfg)}] → ${r.files.length}`);
    archiveWrite({ t: new Date().toISOString(), kind: 'catalog', q: query, count: r.files.length,
        files: r.files.slice(0, 100).map(f => ({ n: f.name, s: f.size })) });
    return r.files.slice(0, 100).map(f => {
        const q = M.detectQuality(f.name);
        const lbl = langLabel(M.detectLang(f.name));
        return {
            id: `webshare-${f.ident}`,
            type,
            name: f.name,
            poster: f.img || backdrop,
            posterShape: 'landscape',
            background: backdrop,
            description: [lbl, q.resolution, formatSize(f.size)].filter(Boolean).join(' · '),
            releaseInfo: [q.resolution, formatSize(f.size)].filter(Boolean).join(' · ')
        };
    });
}

// hellspy-<id>-<hash> → detail přes proxy
async function hsFileFromId(id) {
    const m = String(id).match(/^hellspy-(\d+)-([A-Za-z0-9]+)$/);
    if (!m) return null;
    const d = await hsDetail(m[1], m[2]);
    if (!d) return null;
    const meta = hsMeta(d);
    fileCache.set(`hs:${m[1]}`, meta, (meta.ok ? 3 : 7) * 24 * H);
    if (!meta.ok) return null;
    const f = { hs: true, ident: `hs:${m[1]}`, id: m[1], hash: m[2], name: d.title, size: d.size, len: d.duration, img: d.thumb };
    return { f, d, info: { ...meta, len: d.duration } };
}

async function handleCatalogHs(type, extra, cfg, base) {
    if (!hsOn(cfg) || cfg.hellspy_search === false) return [];
    const query = (extra.search || '').trim();
    if (!query) return [];
    let files = (await hsSearch(query, 64)).filter(f => !M.isNonVideo(f.name));
    const seen = new Set();
    files = files.filter(f => { if (!f.size) return true; if (seen.has(f.size)) return false; seen.add(f.size); return true; });
    const backdrop = `${base}/backdrop.jpg`;
    log(`🔍 hellspy hledat "${query}" [${who(cfg)}] → ${files.length}`);
    archiveWrite({ t: new Date().toISOString(), kind: 'catalog', src: 'hs', q: query, count: files.length,
        files: files.map(f => ({ n: f.name, s: f.size, len: f.len })) });
    return files.map(f => {
        const q = M.detectQuality(f.name);
        const lbl = langLabel(M.detectLang(f.name));
        return {
            id: `hellspy-${f.id}-${f.hash}`,
            type,
            name: f.name,
            poster: f.img || backdrop,
            posterShape: 'landscape',
            background: f.img || backdrop,
            description: [lbl, q.resolution, f.len ? formatLength(f.len) : null, formatSize(f.size)].filter(Boolean).join(' · '),
            releaseInfo: [f.len ? formatLength(f.len) : null, formatSize(f.size)].filter(Boolean).join(' · ')
        };
    });
}

async function handleMetaHs(type, id, cfg, base) {
    if (!hsOn(cfg)) return null;
    const hf = await hsFileFromId(id);
    if (!hf) return null;
    const { f, d, info } = hf;
    const q = M.detectQuality(f.name);
    const lbl = langLabel(M.detectLang(f.name));
    const subNames = { cze: 'CZ', ces: 'CZ', slo: 'SK', slk: 'SK', eng: 'EN' };
    const backdrop = `${base}/backdrop.jpg`;
    const desc = [
        `📄 ${d.filename || f.name}`, '',
        lbl ? `🗣️ ${lbl}` : null,
        info.conv.length ? `📺 převody MP4: ${info.conv.map(c => c === '0' ? 'originál' : `${c}p`).join(', ')}` : null,
        q.resolution ? `🎞️ originál: ${q.resolution}` : null,
        info.subs.length ? `💬 titulky: ${[...new Set(info.subs.map(l => subNames[l] || l.toUpperCase()))].join(', ')}` : null,
        f.len ? `⏱ ${formatLength(f.len)}` : null,
        `💾 ${formatSize(f.size)}`
    ].filter(x => x !== null).join('\n');
    return {
        id, type, name: f.name,
        poster: f.img || backdrop,
        posterShape: 'landscape',
        background: f.img || backdrop,
        description: desc
    };
}

// ───────────────────────── Katalog „Fastshare Hledat“ a meta ─────────────────────────
// fastshare-<id> → soubor z hledání (24 h v paměti); po restartu serveru jen id (název z odkazu)
function fsFileFromId(id) {
    const m = String(id).match(/^fastshare-(\d+)$/);
    if (!m) return null;
    return fsFiles.get(m[1]) || { fs: true, ident: `fs:${m[1]}`, id: m[1], name: `Fastshare ${m[1]}`, size: 0, len: 0, res: null, img: null, dl: null };
}

async function handleCatalogFs(type, extra, cfg, base) {
    if (!hasFs(cfg) || cfg.fastshare_search === false) return [];
    const query = (extra.search || '').trim();
    if (!query) return [];
    let files = (await fsSearch(cfg, query, 200)).filter(f => !M.isNonVideo(f.name));
    const seen = new Set();
    files = files.filter(f => { if (!f.size) return true; if (seen.has(f.size)) return false; seen.add(f.size); return true; }).slice(0, 100);
    const backdrop = `${base}/backdrop.jpg`;
    log(`🔍 fastshare hledat "${query}" [${who(cfg)}] → ${files.length}`);
    archiveWrite({ t: new Date().toISOString(), kind: 'catalog', src: 'fs', q: query, count: files.length,
        files: files.map(f => ({ n: f.name, s: f.size, len: f.len, res: f.resRaw })) });
    return files.map(f => {
        const q = M.detectQuality(f.name);
        const res = f.res || q.resolution;
        const lbl = langLabel(M.detectLang(f.name));
        return {
            id: `fastshare-${f.id}`,
            type,
            name: f.name,
            poster: f.img || backdrop,
            posterShape: 'landscape',
            background: f.img || backdrop,
            description: [lbl, res, f.len ? formatLength(f.len) : null, formatSize(f.size)].filter(Boolean).join(' · '),
            releaseInfo: [res, f.len ? formatLength(f.len) : null, formatSize(f.size)].filter(Boolean).join(' · ')
        };
    });
}

function handleMetaFs(type, id, cfg, base) {
    if (!hasFs(cfg)) return null;
    const f = fsFileFromId(id);
    if (!f) return null;
    const q = M.detectQuality(f.name);
    const lbl = langLabel(M.detectLang(f.name));
    const backdrop = `${base}/backdrop.jpg`;
    const desc = [
        `📄 ${f.name}`, '',
        lbl ? `🗣️ ${lbl}` : null,
        f.res || q.resolution ? `📺 ${f.res || q.resolution}` : null,
        [q.source, q.codec, q.audio].filter(Boolean).length ? `🎬 ${[q.source, q.codec, q.audio].filter(Boolean).join(' · ')}` : null,
        f.len ? `⏱ ${formatLength(f.len)}` : null,
        f.size ? `💾 ${formatSize(f.size)}` : null
    ].filter(x => x !== null).join('\n');
    return { id, type, name: f.name, poster: f.img || backdrop, posterShape: 'landscape', background: f.img || backdrop, description: desc };
}

async function handleMeta(type, id, cfg, base) {
    if (id.startsWith('hellspy-')) return handleMetaHs(type, id, cfg, base);
    if (id.startsWith('fastshare-')) return handleMetaFs(type, id, cfg, base);
    if (!id.startsWith('webshare-') || !hasWs(cfg)) return null;
    const ident = id.slice(9);
    const r = await withToken(cfg, t => wsFileInfo(t, ident));
    if (!r.info) return null;
    const f = r.info;
    const q = M.detectQuality(f.name);
    const lbl = langLabel(M.detectLang(f.name));
    const backdrop = `${base}/backdrop.jpg`;
    const desc = [
        `📄 ${f.name}`, '',
        lbl ? `🗣️ ${lbl}` : null,
        q.resolution ? `📺 ${q.resolution}` : null,
        [q.source, q.codec, q.audio].filter(Boolean).length ? `🎬 ${[q.source, q.codec, q.audio].filter(Boolean).join(' · ')}` : null,
        `💾 ${formatSize(f.size)}`,
        `👍 ${f.pos}  👎 ${f.neg}`,
        f.description ? `\n📝 ${f.description}` : null
    ].filter(x => x !== null).join('\n');
    return {
        id, type, name: f.name,
        poster: f.img || backdrop,
        posterShape: 'landscape',
        background: f.img || backdrop,
        description: desc,
        website: `https://webshare.cz/#/file/${ident}`
    };
}

module.exports = {
    dbg,
    log, hooks, archiveWrite, TTLCache, H, tokenCache, linkCache, tmdbCache,
    resolveCache, saveCaches, resultCache, lastFull, inflight, once, hasWs, hsOn, hasFs, isWs, lenFromSearch, srcLetter, srcRank,
    FS_API, FS_HEADERS, fsSessions, fsFiles, FsError, fsGet, fsLogin, fsSession, fsResolution, fsFile, fsSearch, fsPlayLink, fsDown,
    fsPlayUrl, fsToStream, fsFileFromId, handleCatalogFs, handleMetaFs,
    who, userKey, WS_HEADERS, wsPost, WsError, wsLogin, getToken, withToken,
    lockedIdents, parseFiles, wsSearch, wsFileLink, IMAGE_FORMATS, parseStreams, wsFileInfo, wsUserData,
    HS_HEADERS, hsGet, hsDown, hsSearch, hsDetailCache, hsDetail, convHeight, hsMeta,
    indexerDownUntil, resolveIds, csfdDownUntil, EN_COUNTRY, csfdToInfo, csfdInfo, csfdIdForImdb, needsCzName,
    withCsfdCzName, tmdbGet, tmdbInfoWithKey, cinemetaInfo, titleInfo, seasonRuntimes, countryCode, sameNameShows,
    collectionParts, seasonBase, longCut, uniqNames, buildPlan, pad, ORD_Q, digitVariant,
    fiveOVariant, buildQueries, runQueries, nameOk, originalTitleWord, animeSeasonOk, seasonInName, hasPartMarker,
    sameNameOf, COUNTRY_MARK, markCountry, SIGNED, SEP, SIGNED_RE, signedName, judgeFile, withNameVariants, nameVariants, animeIdParts,
    decodeEntities, bonusWord,
    sameNameVerdict, OWN_NAME, ownNameMatch, judgeNames, filterFiles, countOlderNamesake, olderSameOf, olderSameFromReasons,
    CZ_CODES, SK_CODES, CONV_SCORE, describe, rankFiles, durationMismatch, NAMESAKE_MIN, PAL,
    median, near, numberAfterName, durationFilter, rescueOlderSeries, RESCUED, fileCache, fetchFileInfo,
    enrichFiles, fetchHsMeta, enrichHellspy, expandHellspy, sizeKey, dedupeBySize, enrichTargets, langProfile,
    dedupeHellspyCopies, HS_MAX_FILES, capHellspy, wsAudioBySize, findFiles, archiveSearch, formatSize, langLabel,
    playUrl, FLAGS, audioSubsLabel, formatLength, safeName, hsToStream, toStream, handleStream,
    handleCatalog, hsFileFromId, handleCatalogHs, handleMetaHs, handleMeta, md5crypt, PersistentCache, M
};
