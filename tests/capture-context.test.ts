import {expect,test}from'bun:test';
import{ValidationCapture}from'../src/agents/validation.ts';
import{staticExecutionContexts}from'../src/agents/orchestration.ts';
const root=process.cwd(),tree={head:'a'.repeat(40),fingerprint:'b'.repeat(64),at:'2026-01-01T00:00:00Z'};
function captured(thread:string){
 const capture=new ValidationCapture({cwd:root,observe:()=>tree,redact:text=>text.replaceAll(root,'<repo>')});
 capture.line(JSON.stringify({type:'thread.started',thread_id:'root'}));
 capture.line(JSON.stringify({type:'item.started',item:{id:'actual',type:'command_execution',command:"pwsh.exe -Command 'bun test'"}}));
 capture.line(JSON.stringify({type:'item.completed',item:{id:'actual',type:'command_execution',exit_code:0,aggregated_output:'1 pass'}}));
 capture.line(JSON.stringify({type:'session_meta',payload:{id:thread}}),'root-file',false);
 capture.line(JSON.stringify({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'actual',arguments:JSON.stringify({cmd:'bun test',workdir:root})}}),'root-file',false);
 return capture.finish(tree);
}
test('matching root invocation arguments enrich a live cwd without inventing observations',()=>{
 const command=captured('root').commands[0]!;
 expect(command.cwd).toBe('<repo>');expect(command.cwdSource).toBe('recorded-tool-arguments');expect(command.before?.fingerprint).toBe(tree.fingerprint);
 expect(captured('sibling').commands[0]!.cwd).toStartWith('unknown');
});
test('pure JSON output does not obscure static execution context and JSON cannot be shadowed',()=>{
 const call=`const result=await tools.exec_command({cmd:'bun test',workdir:${JSON.stringify(root)}});text(JSON.stringify(result));`;
 expect(staticExecutionContexts(call)).toHaveLength(1);
 expect(staticExecutionContexts(`const JSON='shadow';${call}`)).toEqual([]);
});
