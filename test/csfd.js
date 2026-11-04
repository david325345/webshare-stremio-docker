// Test převodu metadat z csfd-ratings (tituly jen na ČSFD, ID csfd:…) na názvy pro hledání.
//   node test/csfd.js
process.env.ARCHIVE = '0';
process.env.CACHE_DIR = require('os').tmpdir() + '/webshare-test-cache';
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

console.log('csfd: ✓');
process.exit(0);
