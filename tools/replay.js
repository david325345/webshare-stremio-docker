// Přehraje archivy hledání starou a novou verzí parseru a vypíše rozdíly.
//   node tools/replay.js <adresář staré verze> <adresář nové verze> archiv1.jsonl[.gz] …
//   SN='{"tt40197357":[2001]}' – ruční seznam stejnojmenných seriálů pro starší záznamy bez pole sameName
process.env.ARCHIVE = '0'; process.env.CACHE_DIR = require('os').tmpdir() + '/webshare-replay-cache';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const OLD = require(path.resolve(process.argv[2], 'server.js')), NEW = require(path.resolve(process.argv[3], 'server.js'));
const M = require(path.resolve(process.argv[3], 'matcher.js'));
const read = f => (f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)) : fs.readFileSync(f)).toString('utf8');
const recs = process.argv.slice(4).flatMap(f => read(f).trim().split('\n').filter(Boolean).map(JSON.parse))
  .filter(r => r.kind === 'stream' && r.files && r.names && r.names.length);
// poslední záznam pro každé ID
const byId = new Map(); recs.forEach(r => byId.set(r.id, r));
// délky filmů z TMDB (archivy je zatím neobsahují) – jen pro ukázku kontroly délky
const RT = { tt1877830: 176, tt0468569: 152, tt1345836: 165, tt23572848: 96, tt2250912: 133, tt0111161: 142, tt36983905: null, tt31450459: null, tt1230385: 156 };
const SN = JSON.parse(process.env.SN || '{}');
let changed = 0, fixedOut = 0, newIn = 0;
for (const r of byId.values()) {
  const names = r.names.map(n => ({ ...n }));
  for (const n of names) if (n.short) {
    const nt = M.nameTokens(n.text);
    const full = names.find(x => !x.short && x.kind === n.kind && nt.every(t => M.nameTokens(x.text).includes(t)));
    n.full = full ? full.text : n.text;
  }
  if (r.anime && r.type === 'series' && NEW.seasonBase) {
    const have = new Set(names.map(n => M.nameTokens(n.text).join(' ')));
    for (const n of names.filter(x => x.kind === 'anime' && !x.short)) {
      const sb = NEW.seasonBase(n.text);
      if (!sb || sb.season !== (r.alSeason || r.season)) continue;
      const k = M.nameTokens(sb.base).join(' ');
      if (have.has(k)) continue; have.add(k);
      names.push({ text: sb.base, kind: 'anime', seasonOnly: sb.season });
    }
  }
  const allow = new Set(names.flatMap(n => M.nameTokens(n.full || n.text)));
  const plan = { type: r.type, id: r.id, isAnime: !!r.anime, names, allow, year: r.year, season: r.season, episode: r.episode,
                 alEpisode: r.alEpisode, alSeason: r.alSeason, runtime: r.runtime || RT[r.id.split(':')[0]] || null, epRuntime: r.epRuntime || null, sameName: r.sameName || SN[r.id.split(':')[0]] || null, coll: r.coll || null };
  const out = [];
  const at = new Date(r.t || Date.now());
  // posouzení názvu po souborech + délková pravidla nad celou sadou (starší verze jen po souborech)
  const judgeAll = (S, pl) => {
    const js = r.files.map(f => S.judgeFile ? S.judgeFile({ name: f.n }, pl) : { ok: f.ok, reason: f.r });
    const p2 = { ...pl, olderSame: S.olderSameFromReasons ? S.olderSameFromReasons(js.map(j => j.reason), pl) : 0 };
    const items = r.files.map((f, i) => ({ f: { name: f.n, ident: i }, info: f.len ? { len: f.len } : null })).filter((_, i) => js[i].ok);
    const bad = S.durationFilter ? S.durationFilter(p2, items, at)
      : new Map(items.filter(it => it.info && S.durationMismatch && S.durationMismatch(p2, it)).map(it => [it.f.ident, S.durationMismatch(p2, it)]));
    return js.map((j, i) => j.ok && bad.has(i) ? { ok: false, reason: bad.get(i) } : j);
  };
  const oldJ = judgeAll(OLD, plan), newJ = judgeAll(NEW, plan);
  for (const [i, f] of r.files.entries()) {
    const oldOk = oldJ[i].ok;
    const n = newJ[i];
    const reason = n.reason;
    if (oldOk !== n.ok) { out.push(`${n.ok ? '  + PŘIDÁNO ' : '  − ODEBRÁNO'} ${(n.ok ? '' : reason).padEnd(34)} ${f.n.slice(0, 110)}`); n.ok ? newIn++ : fixedOut++; }
  }
  if (out.length) { changed++; console.log(`\n${r.id}  ${r.names[0].text}${r.season ? ` S${r.season}E${r.episode}` : ''}`); out.forEach(l => console.log(l)); }
}
console.log(`\n=== ${byId.size} titulů, změněno ${changed}: odebráno ${fixedOut}, přidáno ${newIn}`);
process.exit(0);
