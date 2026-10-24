import {parseLinuxHighWater,parseCompletedNativePeak,measuredNativeInvocation,waitForLinuxGroupExit} from './native-memory';
describe('native lifetime memory evidence',()=>{
 it('does not mistake an exited zombie without an mm for malformed live memory',()=>{expect(parseLinuxHighWater('Name:\tffprobe\nState:\tZ (zombie)\nPid:\t123\n',true)).toBeNull();});
 it('requires real highwater for live workers and rejects malformed live native status',()=>{expect(parseLinuxHighWater('State:\tS (sleeping)\nVmHWM:\t1234 kB\n')).toBe(1234*1024);expect(()=>parseLinuxHighWater('State:\tS (sleeping)\n',true)).toThrow();expect(()=>parseLinuxHighWater('State:\tZ (zombie)\n')).toThrow();});
 it('accepts completed-command lifetime peak even when no live poll observed the short command',()=>{expect(parseCompletedNativePeak(Buffer.from('PHASE30_RSS_KIB=8192\n'))).toBe(8*1024*1024);});
 it.each(['','PHASE30_RSS_KIB=0\n','PHASE30_RSS_KIB=-1\n','PHASE30_RSS_KIB=1.5\n','PHASE30_RSS_KIB=9007199254740991\n','private-path\nPHASE30_RSS_KIB=8192\n','PHASE30_RSS_KIB=8192\nextra', 'x'.repeat(129)])('rejects missing or unsafe completion evidence: %s',text=>{expect(()=>parseCompletedNativePeak(Buffer.from(text))).toThrow();});
 it('wraps all Linux commands including version/probe with explicit private-file peak output',()=>{for(const args of [['-version'],['-show_streams','input.mp4']])expect(measuredNativeInvocation('/approved/bin/ffprobe',args,'/owned/rss-1','linux')).toEqual({executable:'/usr/bin/time',args:['-q','-f','PHASE30_RSS_KIB=%M','-o','/owned/rss-1','--','/approved/bin/ffprobe',...args]});});
 it('preserves the explicit Windows native invocation without claiming Linux peak evidence',()=>{expect(measuredNativeInvocation('C:\\approved\\ffprobe.exe',['-version'],'unused','win32')).toEqual({executable:'C:\\approved\\ffprobe.exe',args:['-version']});});
});

describe('bounded owned Linux process group quiescence',()=>{
 it('accepts only independent ESRCH absence, after actual termination',async()=>{let probes=0;expect(await waitForLinuxGroupExit(123,pid=>{expect(pid).toBe(-123);if(++probes===3)throw Object.assign(Error(),{code:'ESRCH'});},async()=>{})).toBe(true);expect(probes).toBe(3);});
 it('retains uncertainty for living groups, zombies and permission failures',async()=>{let probes=0;expect(await waitForLinuxGroupExit(123,()=>{probes++;},async()=>{})).toBe(false);expect(probes).toBe(41);expect(await waitForLinuxGroupExit(123,()=>{throw Object.assign(Error(),{code:'EPERM'});},async()=>{})).toBe(false);});
});
