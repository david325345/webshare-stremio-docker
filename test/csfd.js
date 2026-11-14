// Test převodu metadat z csfd-ratings (tituly jen na ČSFD, ID csfd:…) na názvy pro hledání.
//   node test/csfd.js
process.env.ARCHIVE = '0';
process.env.CACHE_DIR = require('os').tmpdir() + `/webshare-csfd-test-${process.pid}`;   // čistá cache při každém běhu
// náhrada csfd-ratings na localhostu (bez sítě)
const PORT = 47000 + (process.pid % 2000);
process.env.CSFD_URL = process.env.CSFD_FALLBACK_URL = `http://127.0.0.1:${PORT}`;
process.env.TMDB_API_KEY = '';
require('./stub-deps');
const assert = require('assert');
const S = require('../server.js');

const film = S.csfdToInfo({
    name: 'Pelíšky', releaseInfo: '1999', runtime: '115 min',
    titlesOther: [{ country: 'Slovensko', title: 'Pelíšky SK' }, { country: 'USA', title: 'Cozy Dens' },
        { country: 'Japonsko', title: 'ペリーシュキ' }, { country: 'Německo', title: 'Kuschelnester' }, 'Starý řetězec']
}, 'movie', 5911);
assert.strictEqual(film.cz, 'Pelíšky');
assert.strictEqual(film.sk, 'Pelíšky SK');
assert.strictEqual(film.en, 'Cozy Dens');
assert.deepStrictEqual(film.alt, ['Kuschelnester', 'Starý řetězec']);   // bez japonštiny, bez SK/EN
assert.strictEqual(film.year, 1999);
assert.strictEqual(film.runtime, 115);
assert.strictEqual(film.media, 'movie');
assert.strictEqual(film.source, 'csfd');

const serial = S.csfdToInfo({ name: 'MOST!', releaseInfo: '2019', runtime: '45 min', titlesOther: [] }, 'series', 637497);
assert.strictEqual(serial.media, 'tv');
assert.strictEqual(serial.runtime, null);      // u seriálu není délka dílu
assert.strictEqual(serial.tmdbId, undefined);  // bez TMDB → bez délky dílů, stejnojmenných seriálů a série filmů
assert.strictEqual(serial.sk, null);

const uk = S.csfdToInfo({ name: 'Něco', releaseInfo: '2020–2022', titlesOther: [{ country: 'Velká Británie', title: 'Something' }] }, 'series', 1);
assert.strictEqual(uk.en, 'Something');
assert.strictEqual(uk.year, 2020);

// buildPlan + csfd-ratings (náhrada na localhostu) – jen se skutečným needle (noční kontrola bez npm to přeskočí)
const realNeedle = !require.resolve('needle').startsWith('/__stub__/');
const META = {
    // Frieren mini anime: zástupné znaky ●● a název "Seriál: podtitul" (zkrácené názvy se u ČSFD nepoužijí)
    '/meta/series/csfd:1437967.json': { meta: { name: 'Sósó no Frieren: ●● no mahó', releaseInfo: '2023',
        titlesOther: [{ country: 'USA', title: "Frieren: Beyond Journey's End Mini Anime" }] } },
    // csfd-ratings 1.7.0: ČSFD ID i bez hodnocení
    '/csfd-id/series/tt45114341.json': { csfdId: 1660000, title: 'Melania Rea: Případ, který otřásl Itálií', year: 2026 },
    '/meta/series/csfd:1660000.json': { meta: { name: 'Melania Rea: Případ, který otřásl Itálií', releaseInfo: '2026',
        titlesOther: [{ country: 'Itálie', title: 'Melania Rea' }] } },
    '/csfd-id/series/tt0000001.json': { csfdId: null },
    // starší služba bez /csfd-id (404) → ID z odkazu v /ratings
    '/ratings/series/tt0000002.json': { ratings: [{ source: 'csfd', value: 71, url: 'https://www.csfd.cz/film/1660000/' }] }
};
async function online() {
    const http = require('http');
    const srv = http.createServer((req, res) => {
        const body = META[req.url];
        res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body || {}));
    });
    await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
    try {
        const plan = await S.buildPlan('series', 'csfd:1437967:1:1', {});
        const texts = plan.names.map(n => n.text);
        assert.ok(texts.includes('Sósó no Frieren: no mahó'), texts.join(' | '));
        assert.ok(!texts.some(t => /●/.test(t)), 'zástupné znaky v názvu');
        assert.ok(!texts.includes('Frieren') && !texts.includes('Sósó no Frieren'), 'zkrácený název u ČSFD: ' + texts.join(' | '));
        assert.ok(plan.names.every(n => !n.short));
        const frieren = S.judgeFile({ name: 'Sósó no Frieren S01E01 1080p.mkv' }, plan);
        assert.strictEqual(frieren.ok, false, 'díl hlavního seriálu Frieren nesmí projít');

        // TMDB bez českého názvu (CZ = originál) → název z ČSFD
        const tm = { cz: 'Melania Rea', sk: null, en: 'Melania Rea', original: 'Melania Rea', originalLanguage: 'it', year: 2026, source: 'tmdb' };
        assert.strictEqual(S.needsCzName(tm), true);
        const got = await S.withCsfdCzName(tm, 'series', 'tt45114341');
        assert.strictEqual(got.cz, 'Melania Rea: Případ, který otřásl Itálií');
        assert.strictEqual(tm.cz, 'Melania Rea');   // záznam z cache se nemění
        // jiný rok na ČSFD → jiný titul, nic se nepřidá
        assert.strictEqual((await S.withCsfdCzName({ ...tm, year: 2010 }, 'series', 'tt45114341')).cz, 'Melania Rea');
        // na ČSFD nenalezeno → beze změny
        assert.strictEqual(await S.withCsfdCzName({ ...tm }, 'series', 'tt0000001').then(x => x.cz), 'Melania Rea');
        // starší csfd-ratings bez /csfd-id → záloha přes /ratings
        assert.strictEqual(await S.withCsfdCzName({ ...tm }, 'series', 'tt0000002').then(x => x.cz), 'Melania Rea: Případ, který otřásl Itálií');
        // TMDB český název má → ČSFD se neptá
        assert.strictEqual(S.needsCzName({ ...tm, cz: 'Případ Melania' }), false);
        assert.strictEqual(S.needsCzName({ ...tm, originalLanguage: 'cs' }), false);
    } finally {
        srv.close();
    }
}
(realNeedle ? online() : Promise.resolve(console.log('(csfd: buildPlan přeskočen – needle není nainstalovaný)')))
    .then(() => 0, e => { console.error(e); return 1; })
    .then(code => {
        try { require('fs').rmSync(process.env.CACHE_DIR, { recursive: true, force: true }); } catch (e) { /* nic */ }
        if (!code) console.log('csfd: ✓');
        process.exit(code);
    });
