// Webshare — Stremio / Nuvio addon pro Webshare.cz
// Každý uživatel má vlastní odkaz s configem (base64url JSON) v cestě URL.

const express = require('express');
const needle = require('needle');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('./matcher');

const VERSION = '8.1.0';
const PORT = process.env.PORT || 7000;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
// Indexer (resolve-ids) — interně přes Coolify síť, veřejná adresa jako záloha
const INDEXER_URL = (process.env.INDEXER_URL || 'http://indexer:3003').replace(/\/+$/, '');
const INDEXER_FALLBACK_URL = (process.env.INDEXER_FALLBACK_URL || 'https://indexer.ddnsfree.com').replace(/\/+$/, '');
// Serverový TMDB klíč — použije se, když uživatel žádný nezadal
const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '');

const HTTP = { open_timeout: 4000, response_timeout: 8000, read_timeout: 12000 };

const log = (...a) => console.log(...a);
const dbg = (...a) => { if (DEBUG) console.log(...a); };

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
const tmdbCache = new TTLCache(5000);     // TMDB názvy (24 h)
const resolveCache = new TTLCache(5000);  // resolve-ids z indexeru (24 h / 6 h negativní)
const resultCache = new TTLCache(3000);   // nalezené soubory pro dané ID (30 min, sdílené)
const inflight = new Map();               // souběžné stejné požadavky čekají na jeden výsledek

function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

// ───────────────────────── Config v URL ─────────────────────────
function decodeConfig(b64) {
    try {
        const cfg = JSON.parse(Buffer.from(decodeURIComponent(b64), 'base64').toString('utf8'));
        if (!cfg || typeof cfg.username !== 'string' || typeof cfg.password !== 'string') return null;
        if (!cfg.username || !cfg.password) return null;
        return cfg;
    } catch (e) {
        return null;
    }
}

// /eyJ.../stream/... → /[config:jméno]/stream/...   (Coolify maže <…>, proto hranaté závorky)
function maskConfigInUrl(url) {
    return String(url).replace(/(^\/|[?&]config=)(eyJ[A-Za-z0-9_+=%-]+)/g, (m, prefix, b64) => {
        const cfg = decodeConfig(b64);
        return `${prefix}[config:${cfg ? cfg.username : '?'}]`;
    });
}

function userKey(cfg) {
    return crypto.createHash('sha1').update(`${cfg.username}\n${cfg.password}`).digest('hex');
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

// ───────────────────────── Webshare API ─────────────────────────
// MD5-crypt (kompatibilní s PHP crypt $1$) — Webshare jím solí heslo
function md5crypt(password, salt) {
    salt = salt.replace(/^\$1\$/, '').split('$')[0];
    const magic = '$1$';
    let ctx1 = crypto.createHash('md5');
    ctx1.update(password); ctx1.update(salt); ctx1.update(password);
    let final = ctx1.digest();
    let ctx = crypto.createHash('md5');
    ctx.update(password); ctx.update(magic); ctx.update(salt);
    for (let pl = password.length; pl > 0; pl -= 16) ctx.update(final.slice(0, pl > 16 ? 16 : pl));
    for (let i = password.length; i > 0; i >>= 1) {
        if (i & 1) ctx.update(Buffer.from([0])); else ctx.update(password[0]);
    }
    final = ctx.digest();
    for (let i = 0; i < 1000; i++) {
        const c = crypto.createHash('md5');
        if (i & 1) c.update(password); else c.update(final);
        if (i % 3) c.update(salt);
        if (i % 7) c.update(password);
        if (i & 1) c.update(final); else c.update(password);
        final = c.digest();
    }
    const itoa64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const enc = (b0, b1, b2, n) => {
        let w = (b0 << 16) | (b1 << 8) | b2, out = '';
        for (let i = 0; i < n; i++) { out += itoa64[w & 0x3f]; w >>= 6; }
        return out;
    };
    return magic + salt + '$' +
        enc(final[0], final[6], final[12], 4) + enc(final[1], final[7], final[13], 4) +
        enc(final[2], final[8], final[14], 4) + enc(final[3], final[9], final[15], 4) +
        enc(final[4], final[10], final[5], 4) + enc(0, 0, final[11], 2);
}

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
    const hashed = crypto.createHash('sha1').update(md5crypt(password, s.get('salt'))).digest('hex');
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

function parseFiles(ch) {
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
    }).filter(f => f.ident && f.name);
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

async function wsFileInfo(token, ident) {
    const r = await wsPost('file_info', { ident, wst: token });
    if (r.status !== 'OK') return { authFailed: r.status === 'FATAL', info: null };
    return {
        info: {
            ident,
            name: r.get('name') || '',
            size: parseInt(r.get('size') || '0', 10) || 0,
            img: r.get('img') || null,
            description: r.get('description') || '',
            pos: parseInt(r.get('positive_votes') || '0', 10) || 0,
            neg: parseInt(r.get('negative_votes') || '0', 10) || 0
        }
    };
}

async function wsUserData(token) {
    const r = await wsPost('user_data', { wst: token });
    if (r.status !== 'OK') return null;
    return { vip: r.get('vip') === '1', vipDays: parseInt(r.get('vip_days') || '0', 10) || 0 };
}

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
                    resolveCache.set(key, b, 24 * H);
                    return b;
                }
                // indexer odpověděl, ale nejde o anime → negativní cache
                resolveCache.set(key, null, 6 * H);
                return null;
            } catch (e) {
                if (!indexerDownUntil.get(base)) log(`⚠️ indexer ${base} nedostupný (${e.message}) – 5 min použiju zálohu`);
                indexerDownUntil.set(base, Date.now() + 5 * 60 * 1000);
            }
        }
        return null; // indexer nedostupný – necachovat
    });
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
        year: parseInt(String(d.release_date || d.first_air_date || '').slice(0, 4), 10) || null,
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
    if (hit !== undefined) return hit;
    return once(key, async () => {
        const keys = [...new Set([String(userTmdbKey || '').trim(), TMDB_API_KEY].filter(Boolean))];
        for (const k of keys) {
            try {
                const info = await tmdbInfoWithKey(imdbId, type, k);
                if (info) { tmdbCache.set(key, info, 24 * H); return info; }
                break; // TMDB odpovědělo, jen titul nezná
            } catch (e) {
                dbg(`TMDB ${imdbId}: ${e.message}`);
                if (!e.auth) break;
            }
        }
        const cm = await cinemetaInfo(imdbId, type);
        if (cm) tmdbCache.set(key, cm, 12 * H);
        return cm;
    });
}

// ───────────────────────── Plán hledání ─────────────────────────
function uniqNames(list, max) {
    const seen = new Set(), out = [];
    for (const n of list) {
        if (!n || !n.text) continue;
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

// Sestaví názvy a cílovou epizodu pro dané Stremio ID
async function buildPlan(type, id, cfg) {
    const parts = id.split(':');
    let imdb = null, season = null, episode = null, rs = null, info = null;

    if (parts[0].startsWith('tt')) {
        imdb = parts[0];
        if (type === 'series') { season = parseInt(parts[1], 10) || null; episode = parseInt(parts[2], 10) || null; }
        const rsParams = type === 'series' && season && episode ? { imdb, season, episode } : { imdb };
        [info, rs] = await Promise.all([titleInfo(imdb, type, cfg.tmdb_api_key), resolveIds(rsParams)]);
    } else if (parts[0] === 'kitsu') {
        const kitsu = parts[1];
        episode = parseInt(parts[2], 10) || null;
        rs = await resolveIds(episode ? { kitsu, episode } : { kitsu });
        if (rs && rs.imdb_id) info = await titleInfo(rs.imdb_id, type, cfg.tmdb_api_key);
        season = (rs && rs.season) || 1;
        if (rs && rs.episode && !episode) episode = rs.episode;
    } else {
        return null;
    }

    // Anime záznam z indexeru je platný jen pokud sedí typ (film × seriál)
    if (rs && type === 'movie' && rs.type && !/movie/i.test(rs.type) && imdb) {
        // seriálové AL pro filmové ID ignorujeme (např. film navazující na seriál)
        rs = null;
    }

    const isAnime = !!rs;
    const latin = s => s && M.isLatin(s) ? s : null;

    // Názvy "franšízy" (CZ/SK/EN z TMDB) – párují se s IMDb sezónou/epizodou
    // short = zkrácený název před dvojtečkou; full = celý název, ze kterého vznikl
    const full = text => text ? { text } : null;
    const short = text => { const s = M.shortTitle(text); return s ? { text: s, short: true, full: text } : null; };
    const sub = text => { const s = M.subTitle(text); return s ? { text: s, short: true, full: text } : null; };
    const fr = [];
    if (info) {
        fr.push(full(info.cz), full(info.sk), full(info.en), full(latin(info.original)));
        fr.push(short(info.cz), sub(info.cz), short(info.en), sub(info.en));
        (info.alt || []).slice(0, 3).forEach(a => fr.push(full(a)));
    }
    // Názvy z indexeru (romaji / EN pro konkrétní sezónu) – párují se s epizodou v rámci sezóny
    const an = [];
    if (rs) {
        an.push(full(rs.title), full(rs.title_en), short(rs.title), short(rs.title_en));
        (rs.titles || []).filter(t => M.isLatin(t) && t.length <= 60).slice(0, 6).forEach(t => an.push(full(t)));
    }

    const names = uniqNames([
        ...fr.filter(Boolean).map(n => ({ ...n, kind: 'franchise' })),
        ...an.filter(Boolean).map(n => ({ ...n, kind: 'anime' }))
    ], 9);
    if (!names.length) return null;

    return {
        type, id, isAnime, names,
        year: (info && info.year) || null,
        season, episode,
        alEpisode: rs ? (rs.episode || episode) : null,
        alSeason: rs ? (rs.season || season) : null,
        source: info ? info.source : 'indexer',
        anilistId: rs ? rs.anilist_id : null
    };
}

const pad = n => String(n).padStart(2, '0');

// "Druhá světová válka" → "2 svetova valka" (soubory často píšou číslicí)
const ORD_Q = { prvni: '1', druha: '2', druhy: '2', druhe: '2', treti: '3', ctvrta: '4', ctvrty: '4' };
function digitVariant(q) {
    const v = q.split(' ').map(w => ORD_Q[w.toLowerCase()] || w).join(' ');
    return v !== q ? v : null;
}

function buildQueries(plan) {
    const fr = plan.names.filter(n => n.kind === 'franchise').map(n => M.queryText(n.text));
    const an = plan.names.filter(n => n.kind === 'anime').map(n => M.queryText(n.text));
    const variants = fr.map(digitVariant).filter(Boolean);
    const w1 = [], w2 = [];
    if (plan.type === 'movie') {
        const all = [...fr, ...an];
        all.slice(0, 3).forEach(q => w1.push(q));
        if (plan.year) all.slice(0, 2).forEach(q => w1.push(`${q} ${plan.year}`));
        all.slice(3).forEach(q => w2.push(q));
        variants.forEach(q => w2.push(q));
    } else if (plan.season && plan.episode) {
        const se = `S${pad(plan.season)}E${pad(plan.episode)}`;
        fr.slice(0, 3).forEach(q => w1.push(`${q} ${se}`));
        if (plan.isAnime && plan.alEpisode) an.slice(0, 2).forEach(q => w1.push(`${q} ${pad(plan.alEpisode)}`));
        fr.slice(0, 3).forEach(q => w2.push(`${q} ${plan.season}x${pad(plan.episode)}`));
        if (plan.season === 1) fr.slice(0, 2).forEach(q => w2.push(`${q} ${pad(plan.episode)}`));
        fr.slice(3).forEach(q => w2.push(`${q} ${se}`));
        variants.forEach(q => w2.push(`${q} ${se}`));
        if (plan.isAnime && plan.alEpisode) {
            an.slice(0, 2).forEach(q => w2.push(`${q} E${pad(plan.alEpisode)}`));
            an.slice(2).forEach(q => w2.push(`${q} ${pad(plan.alEpisode)}`));
        }
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

// Hledání s omezenou souběžností (max 4 dotazy naráz)
async function runQueries(cfg, queries) {
    const out = new Map();
    let i = 0;
    const worker = async () => {
        while (i < queries.length) {
            const { q, limit } = queries[i++];
            try {
                const r = await withToken(cfg, t => wsSearch(t, q, limit));
                for (const f of r.files) if (!out.has(f.ident)) out.set(f.ident, f);
                dbg(`  🔎 "${q}" → ${r.files.length}`);
            } catch (e) {
                log(`  ⚠️ hledání "${q}" selhalo: ${e.message}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, queries.length) }, worker));
    return out;
}

// Vybere soubory, které sedí na název (a rok / epizodu)
// Sedí název souboru na daný název? Zkrácený název nesmí být následován jiným podtitulem.
function nameOk(fileName, n) {
    if (!M.titleMatches(fileName, n.text)) return false;
    return !n.short || !M.shortNameIsNoise(fileName, n.text, n.full);
}

// Posoudí jeden soubor: { ok, exact, reason, s, e } – důvod se ukládá do archivu hledání
function judgeFile(f, plan) {
    if (M.isNonVideo(f.name)) return { ok: false, reason: 'nepřehratelný soubor' };
    const anyTitle = plan.names.some(n => M.titleMatches(f.name, n.text));
    if (plan.type === 'movie') {
        if (M.looksLikeEpisode(f.name)) return { ok: false, reason: 'vypadá jako díl seriálu' };
        const byFull = plan.names.some(n => !n.short && nameOk(f.name, n));
        const byShort = !byFull && plan.names.some(n => n.short && nameOk(f.name, n));
        if (!byFull && !byShort) return { ok: false, reason: anyTitle ? 'jiný podtitul' : 'název nesedí' };
        const years = M.fileYears(f.name);
        const yearOk = plan.year && years.some(y => Math.abs(y - plan.year) <= 1);
        if (plan.year && years.length && !yearOk) return { ok: false, reason: `rok nesedí (${years.join(',')})` };
        // jen zkrácený název ("Pán prstenů 1") → rok v souboru musí sedět
        if (byShort && !yearOk) return { ok: false, reason: 'zkrácený název bez roku' };
        return { ok: true, exact: years.length > 0, reason: byShort ? 'zkrácený název + rok' : 'název' };
    }
    if (!plan.season || !plan.episode) {
        return plan.names.some(n => nameOk(f.name, n))
            ? { ok: true, exact: false, reason: 'název' }
            : { ok: false, reason: anyTitle ? 'jiný podtitul' : 'název nesedí' };
    }
    let reason = anyTitle ? 'jiný podtitul' : 'název nesedí', seen = null;
    for (const n of plan.names) {
        if (!nameOk(f.name, n)) continue;
        // slova za názvem: značka pokračování ("Capu2", "II", "S2") a číslo dílu
        const hit = M.afterName(f.name, n.text);
        const seq = hit ? M.sequelSeason(hit.rest) : null;
        const rest = hit ? (seq ? hit.rest.slice(1) : hit.rest) : undefined;
        const pe = M.parseEpisode(f.name, M.nameTokens(n.text), rest);
        if (pe.episode === null) { reason = 'bez čísla dílu'; continue; }
        if (pe.season === null && seq) pe.season = seq;
        seen = pe;
        if (n.kind === 'franchise') {
            if (pe.episode === plan.episode &&
                (pe.season === plan.season || (pe.season === null && plan.season === 1))) {
                return { ok: true, exact: pe.explicit, reason: `název (${n.kind})`, s: pe.season, e: pe.episode };
            }
            // anime s absolutním číslováním pod názvem franšízy (One Piece - 1094 pro S22E10)
            if (plan.isAnime && pe.season === null && plan.alEpisode &&
                plan.alEpisode !== plan.episode && pe.episode === plan.alEpisode) {
                return { ok: true, exact: false, reason: 'absolutní číslo dílu', s: null, e: pe.episode };
            }
        } else if (plan.alEpisode && pe.episode === plan.alEpisode &&
                   (pe.season === null || pe.season === plan.alSeason || pe.season === 1)) {
            return { ok: true, exact: pe.explicit, reason: `název (${n.kind})`, s: pe.season, e: pe.episode };
        }
        reason = (pe.season !== null && pe.season !== plan.season && pe.episode === plan.episode)
            ? `jiná sezóna (S${pe.season})` : `jiný díl (${pe.season !== null ? 'S' + pe.season : ''}E${pe.episode})`;
    }
    return { ok: false, reason, s: seen ? seen.season : undefined, e: seen ? seen.episode : undefined };
}

function filterFiles(files, plan) {
    const out = [];
    for (const f of files) {
        const j = judgeFile(f, plan);
        if (j.ok) out.push({ f, exact: !!j.exact });
    }
    return out;
}

function rankFiles(items) {
    return items.map(it => {
        const lang = M.detectLang(it.f.name);
        const q = M.detectQuality(it.f.name);
        return { ...it, lang, q, ls: M.langScore(lang) };
    }).sort((a, b) =>
        ((a.q.cam ? 1 : 0) - (b.q.cam ? 1 : 0)) ||
        (b.ls - a.ls) ||
        (b.q.score - a.q.score) ||
        ((b.exact ? 1 : 0) - (a.exact ? 1 : 0)) ||
        (b.f.size - a.f.size)
    );
}

// Najde a seřadí soubory pro dané ID (výsledek je sdílený pro všechny uživatele, 30 min)
async function findFiles(type, id, cfg) {
    const key = `res:${type}:${id}`;
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
        const files = await runQueries(cfg, w1);
        let items = filterFiles([...files.values()], plan);
        let queries = w1.length;
        if (items.length < 5 && w2.length) {
            const more = await runQueries(cfg, w2);
            for (const [k, v] of more) if (!files.has(k)) files.set(k, v);
            items = filterFiles([...files.values()], plan);
            queries += w2.length;
        }
        const ranked = rankFiles(items);
        const res = { plan, items: ranked, queries, total: files.size, ms: Date.now() - t0 };
        if (ranked.length) resultCache.set(key, res, 30 * 60 * 1000);
        archiveSearch(plan, [...w1, ...(queries > w1.length ? w2 : [])], files, ranked, res.ms);
        return res;
    });
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

function archiveSearch(plan, queries, files, ranked, ms) {
    if (!archiveOk) return;
    const sent = new Map(ranked.slice(0, plan.type === 'movie' ? 30 : 25).map((it, i) => [it.f.ident, i + 1]));
    archiveWrite({
        t: new Date().toISOString(), kind: 'stream', type: plan.type, id: plan.id,
        anime: plan.anilistId || null, source: plan.source, year: plan.year,
        season: plan.season, episode: plan.episode, alEpisode: plan.alEpisode, alSeason: plan.alSeason,
        names: plan.names.map(n => ({ text: n.text, kind: n.kind, short: !!n.short })),
        queries: queries.map(q => q.q), ms,
        files: [...files.values()].map(f => {
            const j = judgeFile(f, plan);
            const rec = { n: f.name, s: f.size, ok: j.ok, r: j.reason };
            if (j.e !== undefined && j.e !== null) rec.se = [j.s ?? null, j.e];
            if (sent.has(f.ident)) rec.sent = sent.get(f.ident);
            return rec;
        })
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

function toStream(item, base, cfgB64) {
    const { f, lang, q } = item;
    const lbl = langLabel(lang);
    const tech = [q.source, q.codec, q.audio, q.hdr ? 'HDR' : null].filter(Boolean).join(' · ');
    const star = f.pos >= 3 && f.pos > f.neg * 3 ? ' ⭐' : '';
    const lines = [f.name, [lbl, `💾 ${formatSize(f.size)}`, tech].filter(Boolean).join('  ·  ') + star];
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
        const ident = id.slice(9);
        const r = await withToken(cfg, t => wsFileInfo(t, ident));
        if (!r.info) return [];
        const item = rankFiles([{ f: r.info, exact: true }])[0];
        return [toStream(item, base, cfgB64)];
    }
    const res = await findFiles(type, id, cfg);
    const max = type === 'movie' ? 30 : 25;
    const streams = res.items.slice(0, max).map(it => toStream(it, base, cfgB64));
    const p = res.plan;
    log(`🎬 ${type} ${id} [${cfg.username}] ${p ? (p.isAnime ? `anime AL${p.anilistId}` : p.source) : 'bez názvů'}` +
        `${p ? ` | názvy: ${p.names.map(n => n.text).join(' / ')}` : ''}` +
        ` | dotazů ${res.queries || 0}, souborů ${res.total || 0}, streamů ${streams.length}` +
        `${res.cached ? ' (cache)' : ` | ${res.ms} ms`}` +
        `${res.items.length ? ` | 1.: ${res.items[0].f.name}` : ''}`);
    return streams;
}

// ───────────────────────── Katalog „Webshare Hledat“ a meta ─────────────────────────
async function handleCatalog(type, extra, cfg, base) {
    if (cfg.enable_direct_search === false) return [];
    const query = (extra.search || '').trim();
    if (!query) return [];
    const r = await withToken(cfg, t => wsSearch(t, query, 100));
    r.files = r.files.filter(f => !M.isNonVideo(f.name));
    const backdrop = `${base}/webshare-backdrop.jpg`;
    log(`🔍 hledat "${query}" [${cfg.username}] → ${r.files.length}`);
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

async function handleMeta(type, id, cfg, base) {
    if (!id.startsWith('webshare-')) return null;
    const ident = id.slice(9);
    const r = await withToken(cfg, t => wsFileInfo(t, ident));
    if (!r.info) return null;
    const f = r.info;
    const q = M.detectQuality(f.name);
    const lbl = langLabel(M.detectLang(f.name));
    const backdrop = `${base}/webshare-backdrop.jpg`;
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

// ───────────────────────── Manifest ─────────────────────────
const SEARCH_CATALOG = { type: 'movie', id: 'webshare_search', name: 'Webshare Hledat', extra: [{ name: 'search', isRequired: true }] };

function buildManifest(base, cfg) {
    const withCatalog = cfg && cfg.enable_direct_search !== false;
    return {
        id: cfg ? personalAddonId(cfg.username) : 'com.webshare.anime',
        version: VERSION,
        name: 'Webshare',
        description: 'Filmy, seriály a anime z Webshare.cz – české a slovenské názvy, CZ/SK dabing a titulky na prvním místě.',
        logo: `${base}/logo.png`,
        background: `${base}/webshare-backdrop.jpg`,
        // meta jen pro soubory z katalogu (webshare-…); metadata filmů a seriálů dodává Cinemeta
        resources: [
            { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'kitsu', 'webshare'] },
            { name: 'meta', types: ['movie', 'series'], idPrefixes: ['webshare'] },
            ...(withCatalog ? ['catalog'] : [])
        ],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'kitsu', 'webshare'],
        catalogs: withCatalog ? [SEARCH_CATALOG] : [],
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
        .replace('/*__SERVER_TMDB__*/false', TMDB_API_KEY ? 'true' : 'false');
}

// ───────────────────────── Express ─────────────────────────
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

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

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));

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
        username: cfg.username, password: cfg.password,
        tmdb_api_key: cfg.tmdb_api_key || '', enable_direct_search: cfg.enable_direct_search !== false
    } : null)(req, res);
});

app.get('/:cfg/manifest.json', withCfg(async (req, res, cfg) => {
    log(`📦 manifest [${cfg.username}]`);
    res.json(buildManifest(baseUrl(req), cfg));
}));

app.get('/:cfg/stream/:type/:id.json', withCfg(async (req, res, cfg) => {
    let streams = [];
    try {
        streams = await handleStream(req.params.type, req.params.id, cfg, baseUrl(req), req.params.cfg);
    } catch (e) {
        log(`❌ stream ${req.params.id} [${cfg.username}]: ${e.message}`);
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
    if (req.params.id === 'webshare_search') {
        try {
            metas = await handleCatalog(req.params.type, parseExtra(req.params.extra), cfg, baseUrl(req));
        } catch (e) {
            log(`❌ katalog [${cfg.username}]: ${e.message}`);
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
    const ident = req.params.ident;
    const key = `${userKey(cfg)}:${ident}`;
    let link = linkCache.get(key);
    if (!link) {
        const r = await withToken(cfg, t => wsFileLink(t, ident));
        if (!r.link) {
            log(`⛔ play ${ident} [${cfg.username}] – odkaz nedostupný (${r.message || 'neznámá chyba'})`);
            return res.status(404).type('text/plain').send('Soubor není dostupný (smazaný, nebo účet bez VIP).');
        }
        link = r.link;
        linkCache.set(key, link, 15 * 60 * 1000);
        log(`▶️ play ${ident} [${cfg.username}]`);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, link);
}));

app.use((req, res) => res.status(404).json({ error: 'Nenalezeno' }));

if (require.main === module) {
    app.listen(PORT, () => {
        log(`🚀 Webshare ${VERSION} běží na portu ${PORT}`);
        log(`   indexer: ${INDEXER_URL} (záloha ${INDEXER_FALLBACK_URL}) | serverový TMDB klíč: ${TMDB_API_KEY ? 'ano' : 'ne'}`);
        log(`   archiv hledání: ${archiveOk ? `${ARCHIVE_DIR} (${ARCHIVE_DAYS} dní)` : 'vypnutý'} | stažení: ${ADMIN_KEY ? '/admin/hledani.jsonl.gz?key=…' : 'vypnuté (chybí ADMIN_KEY)'}`);
    });
}

module.exports = { app, buildPlan, buildQueries, filterFiles, rankFiles, decodeConfig, maskConfigInUrl, md5crypt };
