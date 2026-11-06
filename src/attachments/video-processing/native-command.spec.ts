import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Script} from 'node:vm';
import ts from 'typescript';
import {NativeDiagnosticFailure,diagnoseNativeFailure} from './native-diagnostic';
import {measuredNativeInvocation} from './native-memory';

// Extract only the actual command declaration. Importing video-worker would start
// its real main/heartbeat; this trusted-source test seam does neither. Every child,
// IPC/memory observation and OS interaction is replaced before the body executes.
const workerPath=join(__dirname,'video-worker.ts');
const source=ts.createSourceFile(workerPath,readFileSync(workerPath,'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
const declarations=source.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='command');
if(declarations.length!==1||!declarations[0].body)throw Error('Expected exactly one worker command declaration');
const compiled=ts.transpileModule(declarations[0].getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
if(compiled.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('Worker command could not be transpiled');
const actualCommand=new Script(compiled.outputText+'\ncommand;',{filename:'actual-video-worker-command.test.js'});

function invocation(){
 const child=Object.assign(new EventEmitter(),{pid:4242,stdout:new EventEmitter(),stderr:new EventEmitter(),kill:jest.fn(()=>true)});
 const spawn=jest.fn(()=>child),snapshot=jest.fn(),send=jest.fn();
 const environment={OMP_NUM_THREADS:'1',TMPDIR:'/owned-synthetic',TMP:'/owned-synthetic',TEMP:'/owned-synthetic'};
 const command=actualCommand.runInNewContext({
  Buffer,join,spawn,snapshot,environment,directory:'/owned-synthetic',commandSequence:0,
  stage:'SOURCE_PROBE',nativePid:undefined,launcherPid:undefined,timeExecutable:undefined,completedNativePeak:0,
  process:{platform:'win32',memoryUsage:()=>({rss:16*1024*1024}),send},
  observe:(_point:unknown,work:()=>unknown)=>work(),
  measuredNativeInvocation,NativeDiagnosticFailure,diagnoseNativeFailure,
 },{timeout:1000}) as (executable:string,args:string[])=>Promise<string>;
 const pending=command('/pinned/ffprobe',['-v','error','-show_streams','-of','json','source.mp4']);
 return {child,pending,spawn,snapshot,environment};
}

describe('actual video worker command stderr boundary',()=>{
 it('accepts quiet exit0 and returns exact bounded stdout using the normal no-shell invocation',async()=>{
  const {child,pending,spawn,snapshot,environment}=invocation();
  child.stdout.emit('data',Buffer.from('{"streams":['));child.stdout.emit('data',Buffer.from(']}'));
  child.emit('close',0);
  await expect(pending).resolves.toBe('{"streams":[]}');
  expect(spawn).toHaveBeenCalledWith('/pinned/ffprobe',['-v','error','-show_streams','-of','json','source.mp4'],{cwd:'/owned-synthetic',env:environment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  expect(child.kill).not.toHaveBeenCalled();expect(snapshot).toHaveBeenCalledTimes(2);
 });
 for(const [name,stderr] of [
  ['decoder error',Buffer.from('/owned-private/source.mp4: invalid AAC payload\n')],
  ['whitespace error-level output',Buffer.from('\n')],
  ['nontext byte',Buffer.from([0])],
  ['below stderr cap',Buffer.alloc(131071,65)],
  ['at stderr cap',Buffer.alloc(131072,65)],
 ] as const)it('rejects exit0 with nonempty stderr: '+name,async()=>{
  const {child,pending}=invocation();child.stdout.emit('data',Buffer.from('{"streams":[]}'));child.stderr.emit('data',stderr);child.emit('close',0);
  await expect(pending).rejects.toMatchObject({name:'NativeDiagnosticFailure',message:'PROCESSING_INVALID',diagnostic:{stage:'SOURCE_PROBE',point:'COMMAND_STDERR',reason:'FORMAT'}});
  const error=await pending.catch((value:unknown)=>value);
  expect(error).toBeInstanceOf(NativeDiagnosticFailure);
  expect((error as Error).message).not.toContain('/owned-private');
  expect(JSON.stringify(error)).not.toContain('invalid AAC payload');
 });
 it('retains nonzero exit attribution instead of replacing it with stderr content',async()=>{
  const {child,pending}=invocation();child.stderr.emit('data',Buffer.from('/owned-private/source.mp4: decoder rejected stream\n'));child.emit('close',1);
  await expect(pending).rejects.toMatchObject({name:'NativeDiagnosticFailure',message:'PROCESSING_INVALID',diagnostic:{stage:'SOURCE_PROBE',point:'COMMAND_EXIT',reason:'NONZERO'}});
  const error=await pending.catch((value:unknown)=>value);expect(JSON.stringify(error)).not.toContain('/owned-private');
 });
 it('preserves stdout output-limit precedence over error stderr and kills only the fake child',async()=>{
  const {child,pending}=invocation();child.stdout.emit('data',Buffer.alloc(131073,65));child.stderr.emit('data',Buffer.from('decoder error'));child.emit('close',0);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  await expect(pending).rejects.toMatchObject({diagnostic:{stage:'SOURCE_PROBE',point:'COMMAND_STDOUT',reason:'LIMIT'}});
 });
 it('preserves stderr output-limit attribution and fake-child termination',async()=>{
  const {child,pending}=invocation();child.stderr.emit('data',Buffer.alloc(131073,65));child.emit('close',0);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  await expect(pending).rejects.toMatchObject({diagnostic:{stage:'SOURCE_PROBE',point:'COMMAND_STDERR',reason:'LIMIT'}});
 });
 it('retains earlier spawn error attribution without exposing arbitrary error messages',async()=>{
  const {child,pending}=invocation();child.emit('error',Object.assign(Error('/owned-private/native-binary'),{code:'EIO'}));child.stderr.emit('data',Buffer.from('secondary error'));child.emit('close',1);
  await expect(pending).rejects.toMatchObject({message:'PROCESSING_INVALID',diagnostic:{stage:'SOURCE_PROBE',point:'COMMAND_SPAWN',reason:'EIO'}});
  const error=await pending.catch((value:unknown)=>value);expect(JSON.stringify(error)).not.toContain('/owned-private');
 });
});
