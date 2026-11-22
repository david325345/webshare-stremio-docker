'use strict';
// Platforma jádra (lib/engine.js) pro server addonu: nastavení z proměnných prostředí, trvalá cache na disku,
// hashování hesla k Webshare a cesta k Hellspy (přes proxy s CZ IP). Plugin pro Nuvio má vlastní náhradu
// tohoto souboru (nuvio-plugins/webshare/src/platform.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

const env = process.env;
const config = {
    // Indexer (resolve-ids) — interně přes Coolify síť, veřejná adresa jako záloha
    INDEXER_URL: (env.INDEXER_URL || 'http://indexer:3003').replace(/\/+$/, ''),
    INDEXER_FALLBACK_URL: (env.INDEXER_FALLBACK_URL || 'https://indexer.ddnsfree.com').replace(/\/+$/, ''),
    // csfd-ratings – názvy a rok pro tituly, které jsou jen na ČSFD (ID csfd:12345 / csfd:12345:S:E); CSFD=0 vypne
    CSFD_ON: !/^(0|false|no|off)$/i.test(env.CSFD || ''),
    CSFD_URL: (env.CSFD_URL || 'http://csfd:7020').replace(/\/+$/, ''),
    CSFD_FALLBACK_URL: (env.CSFD_FALLBACK_URL || 'https://csfd-rating.duckdns.org').replace(/\/+$/, ''),
    // Serverový TMDB klíč — použije se, když uživatel žádný nezadal
    TMDB_API_KEY: (env.TMDB_API_KEY || '').trim(),
    DEBUG: /^(1|true|yes)$/i.test(env.DEBUG || ''),
    // Hellspy: API pouští jen české/slovenské IP → dotazy přes proxy s CZ IP (HTTP CONNECT).
    // Prázdné = Hellspy vypnutý, "direct" = bez proxy (server v CZ/SK)
    HELLSPY_PROXY: (env.HELLSPY_PROXY || '').trim(),
    HELLSPY_ON: !!(env.HELLSPY_PROXY || '').trim(),
    HELLSPY_API: (env.HELLSPY_API || 'https://api.hellspy.to/gw').replace(/\/+$/, ''),
    HTTP: { open_timeout: 4000, response_timeout: 8000, read_timeout: 12000 }
};

const log = (...a) => console.log(...a);
const dbg = (...a) => { if (config.DEBUG) console.log(...a); };

const H = 3600 * 1000;
// Trvalá cache na disku (přežije deploy): TMDB názvy a resolve-ids z indexeru.
// Prošlé záznamy se drží ještě STALE_DAYS a použijí se, když TMDB / indexer nejsou dostupné.
const CACHE_DIR = env.CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const STALE_MS = 60 * 24 * H;
class PersistentCache {
    constructor(name, max = 50000) {
        this.file = path.join(CACHE_DIR, `${name}.json`);
        this.max = max; this.map = new Map(); this.dirty = false; this.ok = true;
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const now = Date.now();
            for (const [k, e] of Object.entries(raw)) if (e && e.e + STALE_MS > now) this.map.set(k, e);
        } catch (e) { /* první start nebo poškozený soubor – začínáme prázdní */ }
    }
    get(key) { const e = this.map.get(key); return e && e.e > Date.now() ? e.v : undefined; }   // jen platné
    getStale(key) { const e = this.map.get(key); return e ? e.v : undefined; }                   // i prošlé
    set(key, val, ttlMs) {
        if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
        this.map.delete(key);
        this.map.set(key, { v: val, e: Date.now() + ttlMs });
        this.dirty = true;
    }
    save() {
        if (!this.dirty || !this.ok) return;
        try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
            fs.renameSync(tmp, this.file);
            this.dirty = false;
        } catch (e) {
            this.ok = false;
            console.log(`⚠️ cache ${this.file} nejde uložit (${e.message}) – poběží jen v paměti`);
        }
    }
}

const sha1hex = s => crypto.createHash('sha1').update(s).digest('hex');

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

// Tunel přes HTTP proxy (CONNECT) – tinyproxy pustí jen api.hellspy.to:443
function hsTunnel(host, port) {
    const p = new URL(config.HELLSPY_PROXY);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${host}:${port}`,
            headers: { Host: `${host}:${port}` }, timeout: 6000 });
        req.on('connect', (r, socket) => {
            if (r.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${r.statusCode}`)); }
            resolve(socket);
        });
        req.on('timeout', () => req.destroy(new Error('proxy neodpovídá')));
        req.on('error', reject);
        req.end();
    });
}

// GET na Hellspy API → { status, text }; síťová chyba = výjimka
async function hsRequest(url, headers) {
    const u = new URL(url);
    const port = +u.port || 443;
    // Connection: close + zavření tunelu po odpovědi – jinak spojení visí na proxy (keep-alive) a zaplní její limit
    const opts = { host: u.hostname, port, path: u.pathname + u.search, headers: { ...headers, Connection: 'close' }, timeout: 8000 };
    let tunnel = null, tlsSock = null;
    try {
        if (config.HELLSPY_PROXY && config.HELLSPY_PROXY !== 'direct') {
            tunnel = await hsTunnel(u.hostname, port);
            // bez agenta: Node pak použije createConnection (s agent:false by ho ignoroval a šel napřímo)
            opts.createConnection = () => (tlsSock = tls.connect({ socket: tunnel, servername: u.hostname }));
        }
        return await new Promise((resolve, reject) => {
            const req = https.get(opts, resp => {
                let data = '';
                resp.setEncoding('utf8');
                resp.on('data', c => { data += c; if (data.length > 4e6) req.destroy(new Error('Hellspy: příliš velká odpověď')); });
                resp.on('end', () => resolve({ status: resp.statusCode, text: data }));
                resp.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Hellspy neodpovídá')));
            req.on('error', reject);
        });
    } finally {
        if (tlsSock) tlsSock.destroy();
        if (tunnel) tunnel.destroy();
    }
}

module.exports = { config, log, dbg, PersistentCache, md5crypt, sha1hex, hsRequest, CACHE_DIR };
