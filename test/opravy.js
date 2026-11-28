// Drobné opravy parseru z nočních reportů 2026-11-24 a 2026-11-26 – bez sítě.
process.env.ARCHIVE = '0';
require('./stub-deps');
const assert = require('assert');
const S = require('../server.js');
const E = require('../lib/engine.js');
const M = require('../matcher.js');

const plan = (type, texts, extra = {}) => {
    const names = texts.map(t => ({ text: t, kind: 'franchise' }));
    return { type, names, allow: new Set(names.flatMap(n => M.nameTokens(n.text))), ...extra };
};
const j = (p, name) => S.judgeFile({ name }, p);
const ok = (p, name) => assert.strictEqual(j(p, name).ok, true, `${name}: ${j(p, name).reason}`);
const no = (p, name, reason) => {
    const r = j(p, name);
    assert.strictEqual(r.ok, false, `${name} prošel (${r.reason})`);
    if (reason) assert.strictEqual(r.reason, reason, name);
};

// 1) zvukové kanály za kodekem ("DDP5 1", "AAC5.1") nejsou číslo dílu – film nesmí projít jako S01E01 seriálu
const indo = plan('series', ['Indomptables'], { year: 2026, season: 1, episode: 1 });
no(indo, 'Indomptables 2025 1080p AMZN WEB-DL DDP5 1 H 264-Kitsune.mkv', 'bez čísla dílu');
no(indo, 'Indomptables.2025.1080p.WEBRip.x264.AAC5.1-WORLD.mp4', 'bez čísla dílu');
ok(indo, 'Indomptables S01E01 1080p WEB-DL DDP5.1 H 264.mkv');

// 2) [Cap.101] = S01E01 (španělské značení v hranaté závorce)
assert.deepStrictEqual(M.parseEpisode('Agata Y Lola [HDTV 1080p][Cap.101].mkv', ['agata', 'lola']), { season: 1, episode: 1, explicit: true });
assert.deepStrictEqual(M.parseEpisode('Show [HDTV][Cap.1012].mkv', ['show']), { season: 10, episode: 12, explicit: true });
const agata = plan('series', ['Ágata y Lola'], { year: 2025, season: 1, episode: 1 });
ok(agata, 'Agata Y Lola [HDTV 1080p][Cap.101].mkv');
no(agata, 'Agata Y Lola [HDTV 1080p][Cap.102].mkv', 'jiný díl (S1E2)');

// 3) FullHD je technický údaj
const sinister = plan('movie', ['Sinister'], { year: 2012 });
ok(sinister, 'Sinister_1_FullHD_CZdabing');
ok(sinister, '+Sinister 1 FullHD CZdabing');

// 4) "UK" = "United Kingdom" (jen porovnání), Francie/Španělsko dál ne
const criminal = plan('series', ['Criminal: Velká Británie', 'Criminal: UK'], { year: 2019, season: 1, episode: 1 });
ok(criminal, 'criminal.united.kingdom.s01e01.1080p.web.x264-paleale.mkv');
ok(criminal, 'Criminal United Kingdom S01E01 CZtit V OBRAZE');
no(criminal, 'criminal.france.s01e01.1080p.web.x264.mkv');
assert.deepStrictEqual(E.nameVariants('Criminal: UK'), ['Criminal: United Kingdom']);
// varianta se do dotazů nedostane – plán zůstává beze změny
assert.strictEqual(criminal.names.length, 2);

// 5) úvodní značka uploadera v kulaté závorce (1–2 slova bez čísel)
assert.strictEqual(M.stripLeadingGroups('(Lena BL) Junjou romantica S01E01 CZ tit.mp4'), 'Junjou romantica S01E01 CZ tit.mp4');
assert.strictEqual(M.stripLeadingGroups('(B-A) Film 2020.mkv'), 'Film 2020.mkv');
assert.strictEqual(M.stripLeadingGroups('(500) Days of Summer 2009.mkv'), '(500) Days of Summer 2009.mkv');
assert.strictEqual(M.stripLeadingGroups('(Ne)zadaní 2020.mkv'), '(Ne)zadaní 2020.mkv');
assert.strictEqual(M.stripLeadingGroups('(plechova-kavalerie)-06-svah 79'), '(plechova-kavalerie)-06-svah 79');
assert.strictEqual(M.stripLeadingGroups('(Mike Perry — Inside The Lines) S01E01'), '(Mike Perry — Inside The Lines) S01E01');
const junjou = plan('series', ['Junjou Romantica'], { year: 2008, season: 1, episode: 1 });
ok(junjou, '(Lena BL) Junjou romantica S01E01 CZ tit.mp4');

// 7) anilist:ID:ID:díl (Nuvio) – díl je poslední část; velké prostřední číslo je ID záznamu, malé sezóna
assert.deepStrictEqual(E.animeIdParts('anilist:12189:12189:13'.split(':')), { animeId: '12189', episode: 13 });
assert.deepStrictEqual(E.animeIdParts('anilist:101922:142329:5'.split(':')), { animeId: '142329', episode: 5 });
assert.deepStrictEqual(E.animeIdParts('anilist:101922:2:5'.split(':')), { animeId: '101922', episode: 5 });
assert.deepStrictEqual(E.animeIdParts('anilist:12189:13'.split(':')), { animeId: '12189', episode: 13 });
assert.deepStrictEqual(E.animeIdParts('kitsu:12'.split(':')), { animeId: '12', episode: null });

// 8) značka NxNN před víceslovným názvem → zbytek je název dílu
const sousede = plan('series', ['Sousedské noční můry'], { year: 2014, season: 1, episode: 1 });
ok(sousede, '1x01 Sousedské noční můry - Můj soused psychopat.avi');
no(sousede, '1x02 Sousedské noční můry - Podpal bližního svého.avi');

// 9) apostrof jako mezera ("L'Aile" × "L Aile")
const aile = plan('movie', ["L'Aile ou la Cuisse", 'Křidýlko nebo stehýnko'], { year: 1976 });
ok(aile, 'L Aile ou la cuisse 1976 (Kridylko nebo Stehynko) CZE sub.no 0.ch ToMyX.mov');
ok(aile, "L'Aile ou la cuisse 1976 1080p.mkv");

// ── report 2026-11-28 ──
// 1) náš název až za značkou dílu, před kterou stojí jiný název = díl jiného seriálu
const dog = plan('series', ['Dog Days'], { year: 2011, season: 1, episode: 2, isAnime: true });
no(dog, 'All Creatures Great & Small - s01e02 - Dog Days.avi');
no(dog, 'Všechny velké a malé bytosti cz - s01e02 - Dog-Days.mkv');
ok(dog, '[AKT] Dog Days 02 CZ.mp4');
const cena = plan('series', ['Druhá světová válka, Cena říše'], { year: 2009, season: 1, episode: 10 });
ok(cena, 'S01E10 Operace Overlord - Druhá světová válka, Cena říše.avi');   // značka na začátku nevadí
const cizinka = plan('movie', ['Cizinka: Krev mé krve', 'Outlander: Blood of My Blood'], { year: 2025 });
no(cizinka, 'Hra o trůny - 06x06 - Krev mé krve.mkv');

// 2) bonusy z BD a ukázky – kromě slov z našeho názvu
no(dog, 'Dog Days 2 - End Card 01 (BD 720p) [1E7081A2].mkv', 'bonus / ukázka');
no(dog, 'Dog Days 2 - Menu 01a (BD 720p) [54A8248E].mkv', 'bonus / ukázka');
const dangers = plan('series', ['Boku no Kokoro no Yabai Yatsu'], { year: 2023, season: 0, episode: 1, isAnime: true });
no(dangers, 'Boku no Kokoro no Yabai Yatsu 2024 NCOP2-[1080p][BDRIP][AV1.OPUS].mkv', 'bonus / ukázka');
no(plan('movie', ['SpongeBob: Search for SquarePants'], { year: 2025 }), 'THE SPONGEBOB MOVIE - SEARCH FOR SQUAREPANTS (2025) - Trailer [4K Ultra HD].mkv', 'bonus / ukázka');
ok(plan('movie', ['The Menu', 'Menu'], { year: 2022 }), 'The Menu 2022 1080p CZ dabing.mkv');
ok(plan('series', ['Trailer Park Boys'], { year: 2001, season: 1, episode: 1 }), 'Trailer Park Boys S01E01 1080p.mkv');

// 3) HTML entity v názvech (indexer, ČSFD)
assert.strictEqual(E.decodeEntities('Girls &amp; Panzer'), 'Girls & Panzer');
assert.strictEqual(E.decodeEntities('Law &amp; Order Toronto: Criminal Intent'), 'Law & Order Toronto: Criminal Intent');
assert.strictEqual(E.decodeEntities('Tom &quot;Kid&quot; &#39;x&#39; &#x2013; y'), 'Tom "Kid" \'x\' – y');
assert.strictEqual(E.decodeEntities('R&D &unknown; Fast&Furious'), 'R&D &unknown; Fast&Furious');

console.log('opravy: ✓');
