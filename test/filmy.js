// Test pravidel pro filmy z kolekcí a podpisy uploaderů (judgeFile + durationFilter) – bez sítě.
process.env.ARCHIVE = '0';
require('./stub-deps');
const assert = require('assert');
const S = require('../server.js');
const M = require('../matcher.js');

const plan = (type, texts, extra = {}) => {
    const names = texts.map(t => typeof t === 'string' ? { text: t, kind: 'franchise' } : { kind: 'franchise', ...t });
    return { type, names, allow: new Set(names.flatMap(n => M.nameTokens(n.full || n.text))), ...extra };
};
const ok = (p, name) => S.judgeFile({ name }, p);

// Ulice strachu – 1. část (kolekce 1/3): číslo za "Part", "N. část" není díl seriálu, cizí letopočet za zkráceným názvem
const fs1 = plan('movie', ['Ulice strachu – 1. část: 1994', 'Fear Street: 1994',
    { text: 'Ulice strachu', short: true, full: 'Ulice strachu – 1. část: 1994' },
    { text: 'Fear Street', short: true, full: 'Fear Street: 1994' }], { year: 2021, runtime: 108, coll: { i: 1, n: 3, w: ['fear', 'street', '1978', '1666', 'part'] } });
assert.strictEqual(ok(fs1, 'Fear.Street.Part.2.1978.2021.1080p.WEBRip.x264-RARBG.mp4').reason, 'jiný díl série (2)');
assert.strictEqual(ok(fs1, 'Fear Street 1666 2021 1080p Netflix WEB-DL AVC DDP 5 1 Atmos-DBTV.mp4').reason, 'jiný díl série (1666)');
assert.strictEqual(ok(fs1, 'Fear.Street.Part.1.1994.2021.1080p.WEBRip.x264-RARBG.mp4').ok, true);
assert.strictEqual(ok(fs1, 'Ulice.strachu.1.cast.1994.2021.WEBRip.720p.x264.CZ.mkv').ok, true);
assert.strictEqual(ok(fs1, 'Ulice strachu – 2. část: 1978 (2021) CZ Titulky').reason, 'jiný díl série (2)');
assert.strictEqual(ok(fs1, 'Ripper.Street.S01E01.HDTV.XviD-AFG.avi').reason, 'vypadá jako díl seriálu');
// bez kolekce zůstává "3. část" značkou dílu
assert.strictEqual(ok(plan('movie', ['Ulice strachu'], { year: 2021 }), 'Ulice strachu 3. část 2021').reason, 'vypadá jako díl seriálu');

// "více" před rokem
const shaw = plan('movie', ['Vykoupení z věznice Shawshank', 'The Shawshank Redemption'], { year: 1994 });
assert.strictEqual(ok(shaw, 'Vykoupení z věznice Shawshank - The Shawshank Redemption více (1994) [2].mp4').ok, true);
assert.strictEqual(ok(shaw, 'Vykoupení z věznice Shawshank - více zla (1994).mp4').ok, false);

// podpis uploadera: předběžně přijat, durationFilter ho nechá jen s délkou ±3 % / PAL
const dp = plan('movie', ['Deadpool 2', { text: 'Deadpool', short: true, full: 'Deadpool 2' }],
    { year: 2018, runtime: 119, coll: { i: 2, n: 3, w: ['deadpool', 'wolverine'] } });
const j = ok(dp, 'Deadpool 2   SiC.mkv');
assert.strictEqual(j.ok, true); assert.strictEqual(j.reason, 'podpis uploadera za názvem');
const items = [
    { f: { name: 'Deadpool 2   SiC.mkv', ident: 'a' }, info: { len: 7160 } },          // 119 min ✓
    { f: { name: 'Deadpool 2 OGGY.mkv', ident: 'b' }, info: { len: 7160 * 1.043 } },  // PAL ✓
    { f: { name: 'Deadpool 2 jentam.mkv', ident: 'c' }, info: { len: 5400 } },        // 90 min ✗
    { f: { name: 'Deadpool 2 semtam.mkv', ident: 'd' }, info: null }                  // bez délky ✗
];
const bad = S.durationFilter(dp, items);
assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(i => bad.has(i)), [false, false, true, true]);
// slovo z názvu jiného dílu kolekce není podpis ("Deadpool Wolverine")
assert.strictEqual(ok({ ...dp, names: [{ text: 'Deadpool', kind: 'franchise' }] }, 'Deadpool Wolverine.mkv').ok, false);
const hw = plan('movie', ['Halloween'], { year: 2018, runtime: 106, coll: { i: 11, n: 13, w: ['halloween', 'kills', 'ends', 'zabiji', 'konci'] } });
assert.strictEqual(ok(hw, 'Halloween Kills.mkv').ok, false);
assert.strictEqual(ok(hw, 'Halloween zabíjí CZ.mkv').ok, false);
// kolekce bez názvů dílů (starší cache / výpadek) → pravidlo se nepoužije
assert.strictEqual(ok({ ...dp, coll: { i: 2, n: 3 } }, 'Deadpool 2   SiC.mkv').ok, false);
assert.strictEqual(ok({ ...dp, coll: null, hasColl: true }, 'Deadpool 2   SiC.mkv').ok, false);
// cizí slovo uprostřed (ne poslední) neprojde
assert.strictEqual(ok(dp, 'Deadpool 2 Povstani CZ dabing SiC.mkv').ok, false);

// anime: přepis bez dlouhých samohlásek
const fx = M.repairName('Mikata ga Yowasugite Hojo Maho ni Tesshite ita Kyutei Mahoshi 2025 S01E01-[1080p][BDRIP].mkv',
    ['Mikata ga Yowasugite Hojo Mahou ni Tesshiteita Kyuutei Mahoushi'], 1, 1, { anime: true });
assert.ok(fx && fx.how === 'přepis', JSON.stringify(fx));
assert.strictEqual(M.repairName('Mikata ga Yowasugite Hojo Maho ni Tesshite ita Kyutei Mahoshi 2025 S01E01.mkv',
    ['Mikata ga Yowasugite Hojo Mahou ni Tesshiteita Kyuutei Mahoushi'], 1, 1, { anime: false }), null);

// slovo před zkráceným názvem: cizí titul ("Celebrity Crime Scene") × slovo / slepená slova z plného názvu
assert.strictEqual(M.shortNameIsNoise('Celebrity.Crime.Scene.S01E01.1080p.WEB.h264-EDITH.mkv', 'Crime Scene', 'Crime Scene: The Texas Killing Fields'), true);
assert.strictEqual(M.shortNameIsNoise('Otrava - Příběh lásky 2024 CZ dab 1080p.mkv', 'Příběh lásky', 'Pamela: Příběh lásky'), true);
assert.strictEqual(M.shortNameIsNoise('Sum1 Alien Invasion (2017)', 'Alien Invasion', 'S.U.M.1: Alien Invasion'), false);
assert.strictEqual(M.shortNameIsNoise('Terminátor Den zúčtování 1991.mkv', 'Den zúčtování', 'Terminátor 2: Den zúčtování'), false);
assert.strictEqual(M.shortNameIsNoise('S01E01 Crime Scene.mkv', 'Crime Scene', 'Crime Scene: X'), false);
assert.strictEqual(M.shortNameIsNoise('Krimi Crime Scene 2022.mkv', 'Crime Scene', 'Crime Scene: X'), false);

console.log('filmy: ✓');
process.exit(0);
