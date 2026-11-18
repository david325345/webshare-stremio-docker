// Test pravidla stejnojmenného seriálu s názvy ostatních seriálů (judgeFile + durationFilter) – bez sítě.
process.env.ARCHIVE = '0';
require('./stub-deps');
const assert = require('assert');
const S = require('../server.js');
const M = require('../matcher.js');

const plan = (texts, extra = {}) => {
    const names = texts.map(t => ({ text: t, kind: 'franchise' }));
    return { type: 'series', season: 1, episode: 1, names, allow: new Set(names.flatMap(n => M.nameTokens(n.text))), ...extra };
};
const j = (p, name) => S.judgeFile({ name }, p);

// Gajokgyehoek (KR 2024) × Family Matters (US 1989): korejský název druhý seriál nemá
const fam = plan(['Gajokgyehoek', 'Family Matters'], { year: 2024, epRuntime: 52,
    sameName: [{ y: 1989, v: 381, c: 'us', n: ['family matters'] }, { ours: true, v: 39, c: 'kr' }] });
const own = j(fam, 'Gajokgyehoek - S1E1 KO');
assert.strictEqual(own.ok, true, JSON.stringify(own));
assert.strictEqual(own.reason, 'náš název, jiný seriál ho nemá');
assert.strictEqual(j(fam, 'Gajokgyehoek - S1E2 KO').reason, 'jiný díl (S1E2)');
assert.strictEqual(j(fam, 'Family.Matters.S01E01.1080p.AMZN.WEB-DL.DDP2.0.H.264-MrHulk.mkv').reason, 'bez roku (starší seriál 1989)');
assert.strictEqual(j(fam, 'Family Matters 2024 S01E01 1080p.mkv').ok, true);   // náš rok → běžné přijetí
assert.strictEqual(j(fam, 'Family Matters 2024 S01E01 1080p.mkv').reason === 'náš název, jiný seriál ho nemá', false);
// pojistka délkou: ±15 % na díl z TMDB, bez délky ne
const items = [
    { f: { name: 'Gajokgyehoek - S1E1 KO', ident: 'a' }, info: { len: 3070 } },
    { f: { name: 'Gajokgyehoek S01E01 CZ', ident: 'b' }, info: { len: 1272 } },
    { f: { name: 'Gajokgyehoek S01E01 EN', ident: 'c' }, info: null }
];
const bad = S.durationFilter(fam, items);
assert.deepStrictEqual(['a', 'b', 'c'].map(i => bad.has(i)), [false, true, true]);

// Lov 2026 × The Hunt 2015: CZ název "Lov" má i starší seriál → pravidlo platí dál
const lov = plan(['Lov', 'The Hunt'], { year: 2026, epRuntime: 50,
    sameName: [{ y: 2015, v: 94, c: 'uk', n: ['the hunt', 'lov'] }, { ours: true, v: 14, c: 'us' }] });
assert.strictEqual(j(lov, 'Lov S01E01 CZ Titulky.mkv').reason, 'bez roku (starší seriál 2015)');
// starší formát bez názvů (cache sn2, staré archivy) → beze změny
const old = { ...fam, sameName: [{ y: 1989, v: 381, c: 'us' }, { ours: true, v: 39, c: 'kr' }] };
assert.strictEqual(j(old, 'Gajokgyehoek - S1E1 KO').reason, 'bez roku (starší seriál 1989)');
// značka země druhého seriálu pořád rozhodne
const office = plan(['Kancl', 'The Office'], { year: 2005, epRuntime: 22,
    sameName: [{ y: 2001, v: 2000, c: 'uk', n: ['the office'] }, { ours: true, v: 4000, c: 'us' }] });
assert.strictEqual(j(office, 'The Office UK S01E01.mkv').ok, false);

console.log('seriály: ✓');
process.exit(0);
