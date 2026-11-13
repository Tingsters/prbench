import {afterAll,expect,test}from'bun:test';
import{join}from'node:path';
import{readFileSync,readdirSync,rmSync,unlinkSync,mkdirSync,writeFileSync}from'node:fs';
import{judgePair,judgmentPath}from'../src/judge/pairwise.ts';
import{RUBRIC_KEYS}from'../src/judge/rubric.ts';
import{loadCase,loadFacts}from'../src/schema/case.ts';
import type{PRArtifact}from'../src/schema/artifact.ts';
import{readEvents,retryDelay}from'../src/run/ledger.ts';
import{runCase}from'../src/run/runner.ts';
import{original}from'../src/systems/original.ts';
import{EXAMPLE,tempDir,cleanupTemps}from'./helpers.ts';
afterAll(cleanupTemps);
const loaded=loadCase(EXAMPLE),facts=loadFacts(loaded)!;
const artifact=(system:string):PRArtifact=>({schema:'prbench.artifact/v1',case:loaded.case.id,system,title:'Default greeting',body:'Greets world.',base:loaded.case.repo.base,commits:[],diff:'same change',meta:{tool:system,startedAt:'2026-01-01T00:00:00Z',durationMs:1}});
const side={factualErrors:[],unsupportedClaims:[],claimAssessments:[],claimsCovered:['C1'],contextCovered:[],uncertaintiesRespected:[],trapsHit:[],rubric:Object.fromEntries(RUBRIC_KEYS.map(key=>[key,2])),notes:'Synthetic recovery fixture.'};
const valid=JSON.stringify({A:side,B:side,preferred:'tie',preferenceDependsOnMissingEvidence:false,reason:'Equal.'});
test('transport and one format repair share a persisted budget; accepted orders recover without calls',async()=>{
 let calls=0;const prompts:string[]=[],out=tempDir(),ledger=tempDir();
 const judge={id:'fixture:recovery',family:'fixture',ask:async(prompt:string)=>{prompts.push(prompt);calls++;if(calls===1)throw new Error('503 capacity');return{text:calls===2?'not JSON':valid};}};
 const opts={loaded,facts,x:artifact('a'),y:artifact('b'),judge,outDir:out,controls:{ledgerRoot:ledger,retryDelays:[0,0]}};
 const pair=await judgePair(opts);expect(calls).toBe(4);expect(prompts[2]).toContain('FORMAT CORRECTION ONLY');
 expect(readEvents(ledger).filter(e=>e.kind==='failed')).toHaveLength(2);
 const file=judgmentPath(out,loaded.case.id,judge.id,'a','b','ab'),bytes=readFileSync(file,'utf8');unlinkSync(file);
 await judgePair(opts);expect(calls).toBe(4);expect(readFileSync(file,'utf8')).toBe(bytes);
 expect(pair.orderDigests?.ab).toHaveLength(64);
});
test('exhausted format repair cannot be reset by resume',async()=>{
 let calls=0;const judge={id:'fixture:bad',family:'fixture',ask:async()=>{calls++;return{text:'not JSON'};}};
 const opts={loaded,facts,x:artifact('a'),y:artifact('b'),judge,outDir:tempDir()};
 await expect(judgePair(opts)).rejects.toThrow('no usable judgment');expect(calls).toBe(2);
 await expect(judgePair(opts)).rejects.toThrow('persisted recovery limit');expect(calls).toBe(2);
 expect(retryDelay(new Error('Retry-After: 12'),100)).toBe(12000);
});
test('a judge timeout persisted by a stopped run is retried on resume, within the 3-attempt budget',async()=>{
 const out=tempDir(),ledger=tempDir();let calls=0,stop=true;
 const judge={id:'fixture:slow',family:'fixture',ask:async()=>{calls++;if(stop)throw new Error('claude judge timed out after 900000 ms');return{text:valid};}};
 const opts={loaded,facts,x:artifact('a'),y:artifact('b'),judge,outDir:out,controls:{ledgerRoot:ledger,retryDelays:[0,0]}};
 // Every attempt times out: three attempts, then the run stops.
 await expect(judgePair(opts)).rejects.toThrow('timed out');expect(calls).toBe(3);
 // Resume with all three used still refuses without another call.
 await expect(judgePair(opts)).rejects.toThrow('no usable judgment');expect(calls).toBe(3);
 // A run stopped after one timed-out attempt (as before the retry) resumes at attempt 2.
 const out2=tempDir();calls=0;
 const opts2={...opts,outDir:out2,controls:{ledgerRoot:ledger,retryDelays:[0,0]}};
 const once={...judge,ask:async()=>{calls++;throw new Error('claude judge timed out after 900000 ms');}};
 const dir=judgmentPath(out2,loaded.case.id,judge.id,'a','b','ab')+'.attempts';
 await expect(judgePair({...opts2,judge:once})).rejects.toThrow('timed out');
 expect(calls).toBe(3);
 const key=readdirSync(dir)[0]!;for(const n of ['002','003'])for(const f of ['request','result'])rmSync(join(dir,key,`${n}.${f}.json`));
 stop=false;calls=0;
 // One call finishes the resumed order, one the order that never started.
 const pair=await judgePair(opts2);expect(calls).toBe(2);expect(pair.verdict).toBe('tie');
 expect(readdirSync(join(dir,key)).filter(f=>f.endsWith('.accepted.json'))).toEqual(['002.accepted.json']);
});
test('fresh redacted traces survive sandbox cleanup without credential files',async()=>{
 const out=tempDir();
 const system={...original,id:'trace-fixture',run:async(context:Parameters<typeof original.run>[0])=>{
   const dir=join(context.sandbox.codexHome,'sessions');mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'fresh.jsonl'),JSON.stringify({type:'diagnostic',text:'Bearer secret-value-123456789'})+'\n');
   return artifact('trace-fixture');
 }};
 const result=await runCase(loaded,system,{outDir:out});
 const status=JSON.parse(readFileSync(result.path!.replace('.json','.status.json'),'utf8'));
 expect(status.cleanup.state).toBe('removed');expect(status.traces.entries).toHaveLength(1);
 const text=readFileSync(join(out,loaded.case.id,'trace-fixture.traces',status.traces.entries[0].file),'utf8');
 expect(text).toContain('[redacted]');expect(text).not.toContain('secret-value-123456789');
},30000);
