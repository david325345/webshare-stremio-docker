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
    for (const f of c.files) {
        total++;
        let j = S.judgeFile({ name: f.n }, plan);
        let ok = j.ok, reason = j.reason;
        if (ok && f.len && S.durationMismatch) { const why = S.durationMismatch(plan, { f: { name: f.n }, info: { len: f.len } }); if (why) { ok = false; reason = why; } }
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
