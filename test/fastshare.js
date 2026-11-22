// Fastshare: převod odpovědí API, přihlášení (session, znovupřihlášení), hledání, karta streamu,
// odkaz pro přehrání, config a manifest. API je nahrazené (bez sítě, bez skutečného účtu).
//   node test/fastshare.js
process.env.ARCHIVE = '0';
process.env.CACHE_DIR = require('os').tmpdir() + `/webshare-fs-test-${process.pid}`;
process.env.TMDB_API_KEY = '';
require('./stub-deps');
const assert = require('assert');
const P = require('../lib/platform');
const E = require('../lib/engine');
const S = require('../server.js');

// ── náhrada Fastshare API ──
const HASH = 'a'.repeat(32), HASH2 = 'b'.repeat(32);
const ITEM = {
    id: '26226029', position: '0', filename: 'Matrix (1999) CZ dabing.mkv',
    data: { unit: 'B', value: '2526766767' },
    download_url: 'https://data.fastshare.cloud/download.php?id=26226029',
    resolution: '1920x800', uploaded_date: '2023-11-30 00:00:00', duration_f: '02:16:18',
    duration: { unit: 's', value: '8178' }, thumbnail: 'https://img.fastshare.cloud/upload/tn/x.jpg'
};
const calls = [];
let api = {};
P.fsRequest = async (url, headers) => {
    const q = Object.fromEntries(new URL(url).searchParams);
    calls.push({ q, cookie: headers.Cookie || null, ua: headers['User-Agent'] });
    const r = api[q.process](q, headers);
    return { status: r.status || 200, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
};
const login = (hash, extra = {}) => q => q.password === 'spatne'
    ? { body: { error: 'Nesprávné jméno nebo heslo' } }
    : { body: { user: { id: '1', email: 'x', unlimited: false, data: { unit: 'GB', value: '2.5' }, hash, ...extra } } };

(async () => {
    // rozlišení podle šířky / výšky jako u Webshare
    const R = E.fsResolution;
    assert.strictEqual(R('1080p'), '1080p');
    assert.strictEqual(R('2160p'), '4K');
    assert.strictEqual(R('720p'), '720p');
    assert.strictEqual(R('480p'), 'SD');
    assert.strictEqual(R('1920x800'), '1080p');
    assert.strictEqual(R('3840x1600'), '4K');
    assert.strictEqual(R('1280x536'), '720p');
    assert.strictEqual(R('720x576'), 'SD');
    assert.strictEqual(R(''), null);
    assert.strictEqual(R(undefined), null);

    // položka hledání → soubor
    const f = E.fsFile(ITEM);
    assert.deepStrictEqual({ fs: f.fs, ident: f.ident, id: f.id, name: f.name, size: f.size, len: f.len, res: f.res, resRaw: f.resRaw },
        { fs: true, ident: 'fs:26226029', id: '26226029', name: ITEM.filename, size: 2526766767, len: 8178, res: '1080p', resRaw: '1920x800' });
    assert.strictEqual(f.dl, ITEM.download_url);
    assert.strictEqual(E.fsFile({ ...ITEM, download_url: 'https://evil.example/x' }).dl, null);   // jen domény Fastshare
    assert.strictEqual(E.fsFile({ ...ITEM, id: '../1' }), null);
    assert.strictEqual(E.fsFile({ ...ITEM, duration: { unit: 'min', value: '90' } }).len, 5400);
    assert.strictEqual(E.fsFile({ ...ITEM, data: { unit: 'MB', value: '700' } }).size, 734003200);

    // přihlášení: hash, kredit; špatné heslo → FsError, 10 min se nezkouší znovu
    api = { login: login(HASH) };
    const lr = await E.fsLogin('david', 'heslo');
    assert.deepStrictEqual(lr, { hash: HASH, unlimited: false, creditMB: 2560 });
    assert.strictEqual(calls[0].ua, 'Kodi/20');
    api = { login: login(HASH, { unlimited: true }) };
    assert.strictEqual((await E.fsLogin('david', 'heslo')).unlimited, true);
    const bad = { fs_username: 'david', fs_password: 'spatne' };
    await assert.rejects(E.fsSession(bad), e => e instanceof E.FsError && /Nesprávné jméno/.test(e.message));
    calls.length = 0;
    await assert.rejects(E.fsSession(bad), E.FsError);
    assert.strictEqual(calls.length, 0, 'špatné údaje: žádný další pokus o přihlášení');

    // hledání: cookie se session, pagination 200, adult 0; session se drží
    const cfg = { fs_username: 'david', fs_password: 'heslo' };
    api = {
        login: login(HASH),
        search: (q, h) => ({ body: h.Cookie === `FASTSHARE=${HASH}` || h.Cookie === `FASTSHARE=${HASH2}` ? { search: { file: q.term === 'nic' ? [] : [ITEM] } } : {} })
    };
    calls.length = 0;
    let files = await E.fsSearch(cfg, 'Matrix 1999');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].ident, 'fs:26226029');
    const sq = calls.find(c => c.q.process === 'search');
    assert.deepStrictEqual([sq.q.term, sq.q.pagination, sq.q.adult, sq.cookie], ['Matrix 1999', '200', '0', `FASTSHARE=${HASH}`]);
    calls.length = 0;
    await E.fsSearch(cfg, 'Matrix');
    assert.strictEqual(calls.filter(c => c.q.process === 'login').length, 0, 'session z mezipaměti');

    // prázdný výsledek s čerstvou session → bez nového přihlášení; se starou (> 2 min) → jednou znovu
    calls.length = 0;
    assert.strictEqual((await E.fsSearch(cfg, 'nic')).length, 0);
    assert.strictEqual(calls.filter(c => c.q.process === 'login').length, 0);
    const key = P.sha1hex(`fastshare\n${cfg.fs_username}\n${cfg.fs_password}`);
    E.fsSessions.set(key, { hash: 'c'.repeat(32), t: Date.now() - 10 * 60 * 1000 }, 60 * 1000);   // neplatný hash
    api.login = login(HASH2);
    calls.length = 0;
    files = await E.fsSearch(cfg, 'Matrix 1999');
    assert.strictEqual(files.length, 1, 'po novém přihlášení výsledky jsou');
    assert.strictEqual(calls.filter(c => c.q.process === 'login').length, 1);
    assert.strictEqual(calls[calls.length - 1].cookie, `FASTSHARE=${HASH2}`);

    // runQueries jen s Fastshare
    const rq = await E.runQueries(cfg, [{ q: 'Matrix 1999', limit: 50 }, { q: 'Matrix', limit: 50 }], { budgetMs: 2000 });
    assert.strictEqual(rq.files.size, 1);
    assert.deepStrictEqual(rq.dead, { ws: true, hs: true, fs: false });
    assert.strictEqual(rq.fsFailed, false);
    assert.deepStrictEqual(rq.deg, {});

    // řazení a karta streamu: rozlišení z API (1920x800 → 1080p), CZ dabing z názvu, odkaz bez session
    const it = E.rankFiles([{ f: files[0], exact: true, info: { len: files[0].len } }])[0];
    assert.strictEqual(it.q.resolution, '1080p');
    const st = E.toStream(it, 'https://addon.example', 'CFG');
    assert.strictEqual(st.name, 'Fastshare\n1080p');
    assert.strictEqual(st.url, 'https://addon.example/CFG/fs/play/26226029/Matrix%20(1999)%20CZ%20dabing.mkv');
    assert.ok(!st.url.includes(HASH2) && !JSON.stringify(st).includes(HASH2), 'session nesmí do seznamu streamů');
    assert.ok(/🇨🇿 CZ dabing/.test(st.title) && /⏱ 2 h 16 min/.test(st.title), st.title);
    assert.strictEqual(st.behaviorHints.bingeGroup, 'fastshare-1080p-cz-dub');
    assert.strictEqual(st.behaviorHints.filename, ITEM.filename);

    // při stejné kvalitě a jazyce: Webshare → Fastshare → Hellspy
    const ws = { f: { ident: 'w1', name: 'Matrix (1999) CZ dabing 1080p.mkv', size: 1 }, info: { len: 8178 } };
    const hs = { f: { hs: true, ident: 'hs:1', name: 'Matrix (1999) CZ dabing 1080p.mkv', size: 3, len: 8178 }, info: { len: 8178 }, conv: '1080' };
    const order = E.rankFiles([hs, { f: files[0], info: { len: 8178 } }, ws]).map(x => x.f.ident);
    assert.deepStrictEqual(order, ['w1', 'fs:26226029', 'hs:1']);

    // odkaz pro přehrání: download_url z hledání + stream=1 + session + filename
    const link = await E.fsPlayLink(cfg, '26226029', 'Matrix (1999) CZ dabing.mkv');
    assert.strictEqual(link, `https://data.fastshare.cloud/download.php?id=26226029&stream=1&session=${HASH2}&filename=Matrix%20(1999)%20CZ%20dabing.mkv`);
    assert.ok((await E.fsPlayLink(cfg, '999', 'x.mkv')).startsWith('https://data.fastshare.cloud/download.php?id=999&stream=1&'));

    // katalog a meta
    const metas = await E.handleCatalogFs('movie', { search: 'Matrix 1999' }, cfg, 'https://addon.example');
    assert.strictEqual(metas.length, 1);
    assert.strictEqual(metas[0].id, 'fastshare-26226029');
    assert.ok(/1080p/.test(metas[0].description));
    assert.deepStrictEqual(await E.handleCatalogFs('movie', { search: 'Matrix' }, { ...cfg, fastshare_search: false }, 'x'), []);
    const meta = await E.handleMeta('movie', 'fastshare-26226029', cfg, 'https://addon.example');
    assert.strictEqual(meta.name, ITEM.filename);
    const cs = await E.handleStream('movie', 'fastshare-26226029', cfg, 'https://addon.example', 'CFG');
    assert.strictEqual(cs.length, 1);
    assert.strictEqual(cs[0].url, st.url);
    assert.deepStrictEqual(await E.handleStream('movie', 'fastshare-26226029', { hellspy: true }, 'x', 'CFG'), []);

    // config: jen Fastshare je platný; Fastshare bez hesla se zahodí
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
    const c1 = S.decodeConfig(b64({ fs_username: 'david', fs_password: 'heslo', hellspy: false }));
    assert.ok(c1 && E.hasFs(c1) && !E.hasWs(c1));
    assert.strictEqual(E.who(c1), 'fs:david');
    assert.strictEqual(S.decodeConfig(b64({ fs_username: 'david', hellspy: false })), null);
    const c2 = S.decodeConfig(b64({ username: 'u', password: 'p', fs_username: 'david' }));
    assert.ok(c2 && !E.hasFs(c2) && c2.fs_username === undefined);

    // manifest: katalog „Fastshare Hledat“ ve výchozím stavu zapnutý, vypínatelný; prefix fastshare
    const m1 = S.buildManifest('https://addon.example', c1);
    assert.ok(m1.catalogs.some(c => c.id === 'fastshare_search'));
    assert.ok(m1.idPrefixes.includes('fastshare'));
    assert.ok(m1.resources.find(r => r.name === 'meta').idPrefixes.includes('fastshare'));
    assert.ok(/Fastshare/.test(m1.description) && !/Webshare\.cz/.test(m1.description), m1.description);
    const m2 = S.buildManifest('https://addon.example', { ...c1, fastshare_search: false });
    assert.ok(!m2.catalogs.some(c => c.id === 'fastshare_search'));
    const m3 = S.buildManifest('https://addon.example', { username: 'u', password: 'p', hellspy: false });
    assert.ok(!m3.catalogs.some(c => c.id === 'fastshare_search'));
    assert.strictEqual(m3.description.startsWith('Filmy, seriály a anime z Webshare.cz –'), true, m3.description);

    console.log('fastshare: ✓');
})().catch(e => { console.error(e); process.exit(1); });
