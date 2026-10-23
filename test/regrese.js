// Regresní test parseru nad skutečnými názvy souborů z archivu hledání.
//   node test/regrese.js            → porovná s očekávanými výsledky (test/cases.json)
//   node test/regrese.js --update   → uloží aktuální výsledky jako nové očekávané
process.env.ARCHIVE = '0';
process.env.CACHE_DIR = require('os').tmpdir() + '/webshare-test-cache';
const fs = require('fs'), path = require('path');
const S = require('../server.js');
const FILE = path.join(__dirname, 'cases.json');
const cases = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const update = process.argv.includes('--update');
let diffs = 0, total = 0;
for (const c of cases) {
    const plan = { ...c.plan, allow: new Set(c.plan.allow) };
    // posouzení názvu po souborech, délková pravidla nad celou sadou (jako v addonu)
    const judged = c.files.map((f, i) => ({ f, i, j: S.judgeFile({ name: f.n }, plan) }));
    plan.olderSame = S.olderSameFromReasons ? S.olderSameFromReasons(judged.map(x => x.j.reason), plan) : 0;
    const okItems = judged.filter(x => x.j.ok).map(x => ({ f: { name: x.f.n, ident: x.i }, info: x.f.len ? { len: x.f.len } : null }));
    const bad = S.durationFilter ? S.durationFilter(plan, okItems, new Date(c.at || '2026-10-23T00:00:00Z'))   // pevné datum: pravidlo „nový film“ závisí na roce
        : new Map(okItems.map(it => [it.f.ident, it.info && S.durationMismatch(plan, it)]).filter(x => x[1]));
    for (const { f, i, j } of judged) {
        total++;
        let ok = j.ok, reason = j.reason;
        if (ok && bad.has(i)) { ok = false; reason = bad.get(i); }
        if (update) { f.ok = ok; continue; }
        if (ok !== f.ok) {
            diffs++;
            console.log(`${ok ? '+ NOVĚ PŘIJAT ' : '− NOVĚ VYŘAZEN'}  ${c.plan.id.padEnd(16)} ${(ok ? '' : reason).padEnd(30)} ${f.n}`);
        }
    }
}
if (update) { fs.writeFileSync(FILE, JSON.stringify(cases, null, 1)); console.log(`Uloženo ${total} očekávaných výsledků (${cases.length} titulů).`); }
else console.log(`\n${total} souborů, ${cases.length} titulů – ${diffs ? `${diffs} rozdílů` : 'beze změn ✓'}`);
process.exit(diffs ? 1 : 0);
