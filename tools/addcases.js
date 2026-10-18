// Přidá/obnoví tituly v test/cases.json ze záznamů archivu:
//   node tools/addcases.js <adresář addonu> tt123:1:2,tt456 archiv.jsonl[.gz] …   (pak: node test/regrese.js --update)
const fs=require('fs'),path=require('path'),zlib=require('zlib');const M=require(path.resolve(process.argv[2],'matcher.js'));
const cf=path.resolve(process.argv[2],'test/cases.json');const cases=JSON.parse(fs.readFileSync(cf,'utf8'));
const recs=process.argv.slice(4).flatMap(f=>(f.endsWith('.gz')?zlib.gunzipSync(fs.readFileSync(f)):fs.readFileSync(f)).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse)).filter(r=>r.kind==='stream'&&r.files&&r.names);
for(const id of process.argv[3].split(',')){
  const r=recs.filter(x=>x.id===id).pop(); if(!r){console.log('chybí',id);continue;}
  const names=r.names.map(n=>({...n}));
  for(const n of names) if(n.short){const nt=M.nameTokens(n.text);const full=names.find(x=>!x.short&&x.kind===n.kind&&nt.every(t=>M.nameTokens(x.text).includes(t)));n.full=full?full.text:n.text;}
  const allow=[...new Set(names.flatMap(n=>M.nameTokens(n.full||n.text)))];
  const plan={sameName:r.sameName||null,type:r.type,id:r.id,isAnime:!!r.anime,names,allow,year:r.year,season:r.season,episode:r.episode,alEpisode:r.alEpisode,alSeason:r.alSeason,runtime:r.runtime||null,epRuntime:r.epRuntime||null};
  const seen=new Set();const files=r.files.filter(f=>!seen.has(f.n)&&seen.add(f.n)).map(f=>({n:f.n,...(f.len?{len:f.len}:{}),ok:false}));
  const i=cases.findIndex(c=>c.plan.id===id); if(i>=0) cases[i]={plan,files}; else cases.push({plan,files});
  console.log('přidáno',id,files.length);
}
fs.writeFileSync(cf,JSON.stringify(cases,null,1));
