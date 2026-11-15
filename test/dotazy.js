// Test sestavení dotazů (buildQueries) – bez sítě.
process.env.ARCHIVE = '0';
require('./stub-deps');
const assert = require('assert');
const S = require('../server.js');

const qs = w => w.map(x => x.q);
const plan = (names, extra = {}) => ({
    type: 'series', season: 1, episode: 2, year: 2018, isAnime: false, alEpisode: null,
    names: names.map(t => ({ text: t, kind: 'franchise' })), ...extra
});

// polský seriál s CZ, SK i EN názvem: originál je 4. v pořadí, a přesto v první vlně
const pl = plan(['Spálená zem', 'Spálená zem SK', 'The Ruins', 'Ślepnąc od świateł'], { origName: 'Ślepnąc od świateł' });
const [w1, w2] = S.buildQueries(pl);
assert.ok(qs(w1).includes('Slepnac od swiatel S01E02'), qs(w1).join(' | '));
assert.ok(!qs(w2).includes('Slepnac od swiatel S01E02'), 'dotaz se v druhé vlně nesmí opakovat');
// bez origName (CZ/EN seriál) se první vlna nemění
const [v1] = S.buildQueries(plan(['Spálená zem', 'Spálená zem SK', 'The Ruins', 'Ślepnąc od świateł']));
assert.ok(!qs(v1).includes('Slepnac od swiatel S01E02'), qs(v1).join(' | '));
// originál mezi prvními třemi názvy → žádný dvojitý dotaz
const [u1] = S.buildQueries(plan(['Papírový dům', 'La casa de papel'], { origName: 'La casa de papel' }));
assert.strictEqual(qs(u1).filter(q => q === 'La casa de papel S01E02').length, 1, qs(u1).join(' | '));

console.log('dotazy: ✓');
process.exit(0);
