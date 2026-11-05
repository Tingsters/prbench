// Packages curated copies only. Raw importing and privacy review remain separate.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { caseDirs, loadCase } from '../src/schema/case.ts';
import { preflightCase } from '../src/run/preflight.ts';
import type { DatasetManifest, DatasetRelease } from '../src/datasets.ts';

const arg=(name:string,fallback?:string)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const root=resolve(arg('--cases','cases-local')!);
const out=resolve(arg('--out','results/dataset-release')!);
const id=arg('--id','real-cases')!,version=arg('--version')!;
const approval=arg('--publication');
if(!approval||!version||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))throw new Error('Need --version x.y.z and --publication <privacy/consent record>.');
const record=JSON.parse(readFileSync(resolve(approval),'utf8'));
if(record.schema!=='prbench.publication/v1'||record.id!==id||record.version!==version||record.publicRedistribution!==true||!record.reviewedAt||!record.reviewedBy)throw new Error('A publication privacy review and owner consent are required.');
const files:Record<string,Uint8Array>={};
const add=(name:string)=>{
 if(!name||name.includes('\\')||name.includes(':')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe dataset member.');
 const p=join(root,name);if(!existsSync(p)||!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink())throw new Error('Missing/non-regular dataset member: '+name);
 files[name]=readFileSync(p);
};
const selected=caseDirs(root).map(loadCase).filter(c=>!c.case.excluded);
const cases={dev:[] as string[],test:[] as string[]},checked=[];
for(const loaded of selected){
 const c=loaded.case;if(!record.cases?.includes(c.id))throw new Error('Publication consent does not cover '+c.id);
 const result=preflightCase(loaded,{cache:join(out,'preflight-cache'),requireProvenance:true});
 checked.push({case:c.id,checkedFacts:result.checkedFacts,sessionRecords:result.sessionRecords});
 cases[c.split].push(c.id);
 const names=['case.json',c.repo.bundle!,c.facts!,'facts-provenance.json',...(c.sessions??[]).map(s=>s.file),...(c.original?[c.original.body]:[])];
 const prov=JSON.parse(readFileSync(join(loaded.dir,'facts-provenance.json'),'utf8'));
 for(const entry of Object.values(prov.entries) as any[])for(const source of entry.sources)if(source.kind==='historical-digest')names.push(source.path);
 for(const name of new Set(names))add(c.id+'/'+name);
 const expected=record.caseInputs?.[c.id];
 if(!expected)throw new Error('Privacy review has no input fingerprints: '+c.id);
 for(const name of names){const bytes=files[c.id+'/'+name]!;if(expected[name]!==createHash('sha256').update(bytes).digest('hex'))throw new Error('Publication input changed after review: '+c.id+'/'+name);}
}
cases.dev.sort();cases.test.sort();
if(JSON.stringify([...record.cases].sort())!==JSON.stringify([...cases.dev,...cases.test].sort()))throw new Error('Publication inventory mismatch.');
for(const name of ['preparation.json','MANIFEST.md','DATASET_CARD.md','LICENSE','NOTICE.md'])add(name);
const preparation=JSON.parse(Buffer.from(files['preparation.json']!).toString());
for(const c of Object.values(preparation.cases) as any[])for(const fixture of c.fixtures??[])add(fixture.bundle);
for(const [name,bytes]of Object.entries(files)){
 if(!cases.dev.some(id=>name.startsWith(id+'/'))&&!cases.test.some(id=>name.startsWith(id+'/'))&&record.globalInputs?.[name]!==createHash('sha256').update(bytes).digest('hex'))throw new Error('Publication asset changed after review: '+name);
 if(name.endsWith('.jsonl'))for(const line of Buffer.from(bytes).toString().split('\n'))if(line.trim())JSON.parse(line);
}
const manifest:DatasetManifest={schema:'prbench.dataset/v1',id,version,cases,preparation:'preparation.json',files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([n,b])=>[n,{sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length}]))};
files['dataset.json']=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
mkdirSync(out,{recursive:true});
const filename=`prbench-${id}-${version}.tar.gz`,target=join(out,filename);
if(existsSync(target))throw new Error('Release artifact already exists; choose a new output directory.');
await Bun.Archive.write(target,files,{compress:'gzip',level:9});
const archive=readFileSync(target);
const release:DatasetRelease={id,version,description:'Seven consented, redacted historical PR-writing replay cases',url:`https://github.com/Tingsters/prbench/releases/download/cases-v${version}/${filename}`,sha256:createHash('sha256').update(archive).digest('hex'),manifestSha256:createHash('sha256').update(files['dataset.json']!).digest('hex'),bytes:archive.length,cases};
writeFileSync(join(out,'dataset-release.json'),JSON.stringify(release,null,2)+'\n');
writeFileSync(join(out,'SHA256SUMS.txt'),release.sha256+'  '+filename+'\n');
writeFileSync(join(out,'preflight-summary.json'),JSON.stringify({passed:true,cases:checked,modelCalls:0},null,2)+'\n');
console.log(JSON.stringify({archive:filename,sha256:release.sha256,bytes:release.bytes,cases,preflightPassed:true,modelCalls:0}));
