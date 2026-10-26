/** Linux /proc emits task_mem only while task has an mm:
 * https://raw.githubusercontent.com/torvalds/linux/master/fs/proc/array.c
 * GNU time %M is lifetime maximum resident set in KiB, surviving short commands:
 * https://www.gnu.org/software/time/manual/html_node/Memory-Resources.html
 * These are observed/post-exit peaks, not an OS-enforced memory sandbox. */
export class NativeMemoryObservationError extends Error{
 constructor(readonly reason:'HWM_MISSING'|'HWM_INVALID',readonly state:'R'|'S'|'D'|'T'|'t'|'X'|'Z'|'P'|'I'|'W'|'UNKNOWN'){super('PROCESSING_UNAVAILABLE');this.name='NativeMemoryObservationError';}
}
export function parseLinuxHighWater(status:string,allowExited=false):number|null {
 const stateMatch=/^State:\s+([RSDTtXZPIW])\b/m.exec(status),state=(stateMatch?.[1]??'UNKNOWN') as NativeMemoryObservationError['state'];
 const match=/^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
 if(!match&&/^VmHWM:/m.test(status))throw new NativeMemoryObservationError('HWM_INVALID',state);
 if(!match){if(allowExited&&/^State:\s+[ZX]\b/m.test(status))return null;throw new NativeMemoryObservationError('HWM_MISSING',state);}
 const bytes=Number(match[1])*1024;if(!Number.isSafeInteger(bytes)||bytes<1)throw new NativeMemoryObservationError('HWM_INVALID',state);return bytes;
}
/** do_exit sets PF_EXITING before exit_mm clears mm and before exit_notify:
 * https://raw.githubusercontent.com/torvalds/linux/master/kernel/exit.c
 * PF_EXITING=0x4: include/linux/sched.h; /proc stat field9: fs/proc/array.c.
 * An exiting task can still report State:R while VmHWM is no longer available.
 * This skips only that unavailable live sample; it proves neither lifetime RSS
 * nor producer quiescence. GNU time completion and group-absence remain required. */
function kernelExitFlag(stat:string,pid:number):boolean{
 const invalid=():never=>{throw new NativeMemoryObservationError('HWM_INVALID','UNKNOWN');};
 if(typeof stat!=='string'||Buffer.byteLength(stat,'utf8')>4096||!stat.endsWith('\n'))return invalid();
 const record=stat.slice(0,-1),header=/^([1-9]\d*) \(/.exec(record),end=record.lastIndexOf(') ');
 if(!header||Number(header[1])!==pid||end<header[0].length||/[\r\n\0]/.test(record))return invalid();
 // comm can contain spaces and parentheses; only its LAST delimiter precedes
 // the fixed numeric record. Current Linux stat has52 fields through exit_code.
 const fields=record.slice(end+2).split(' ');
 if(fields.length<50||fields.length>62||!/^([RSDTtXZPIW])$/.test(fields[0])||fields.slice(1).some(v=>!/^\-?\d+$/.test(v))||!/^(0|[1-9]\d*)$/.test(fields[6]))return invalid();
 const flags=Number(fields[6]);if(!Number.isSafeInteger(flags)||flags<0||flags>0xffffffff)return invalid();
 return (flags&0x4)!==0;
}
function needsExitProof(error:unknown,allowExited:boolean):error is NativeMemoryObservationError{return allowExited&&error instanceof NativeMemoryObservationError&&error.reason==='HWM_MISSING';}
function validSamplePid(pid:number):void{if(!Number.isSafeInteger(pid)||pid<1||pid>0x7fffffff)throw new NativeMemoryObservationError('HWM_INVALID','UNKNOWN');}
// proc_single_show returns -ESRCH when an already-open status/stat task vanishes:
// https://raw.githubusercontent.com/torvalds/linux/master/fs/proc/base.c
// A missing sampled task supplies no RSS value, lifetime peak or closure proof.
function taskVanished(error:unknown,allowExited:boolean):boolean{return allowExited&&(error as {code?:unknown}|null)?.code==='ESRCH';}
export function sampleLinuxHighWater(pid:number,read:(path:string)=>string,allowExited=false):number|null{
 validSamplePid(pid);
 const sampledRead=(path:string):string|null=>{try{return read(path);}catch(error){if(taskVanished(error,allowExited))return null;throw error;}};
 const status=sampledRead('/proc/'+pid+'/status');if(status===null)return null;
 try{return parseLinuxHighWater(status,allowExited);}catch(error){if(needsExitProof(error,allowExited)){const stat=sampledRead('/proc/'+pid+'/stat');if(stat===null||kernelExitFlag(stat,pid))return null;}throw error;}
}
export async function sampleLinuxHighWaterAsync(pid:number,read:(path:string)=>Promise<string>,allowExited=false):Promise<number|null>{
 validSamplePid(pid);
 const sampledRead=async(path:string):Promise<string|null>=>{try{return await read(path);}catch(error){if(taskVanished(error,allowExited))return null;throw error;}};
 const status=await sampledRead('/proc/'+pid+'/status');if(status===null)return null;
 try{return parseLinuxHighWater(status,allowExited);}catch(error){if(needsExitProof(error,allowExited)){const stat=await sampledRead('/proc/'+pid+'/stat');if(stat===null||kernelExitFlag(stat,pid))return null;}throw error;}
}
export function parseCompletedNativePeak(bytes:Buffer):number {
 if(!Buffer.isBuffer(bytes)||bytes.length>128)throw Error('PROCESSING_UNAVAILABLE');
 const match=/^PHASE30_RSS_KIB=([1-9]\d*)\n$/.exec(bytes.toString('utf8'));if(!match)throw Error('PROCESSING_UNAVAILABLE');
 const peak=Number(match[1])*1024;if(!Number.isSafeInteger(peak)||peak<1)throw Error('PROCESSING_UNAVAILABLE');return peak;
}
export function measuredNativeInvocation(executable:string,args:string[],measurementFile:string,platform:NodeJS.Platform):{executable:string;args:string[]}{
 return platform==='linux'?{executable:'/usr/bin/time',args:['-q','-f','PHASE30_RSS_KIB=%M','-o',measurementFile,'--',executable,...args]}:{executable,args:[...args]};
}
export async function waitForLinuxGroupExit(groupId:number,probe:(pid:number)=>void=pid=>{process.kill(pid,0);},pause:()=>Promise<void>=()=>new Promise(done=>setTimeout(done,25))):Promise<boolean>{
 if(!Number.isSafeInteger(groupId)||groupId<1)return false;
 for(let attempt=0;attempt<=40;attempt++){
  try{probe(-groupId);}catch(error:any){return error?.code==='ESRCH';}
  if(attempt<40)await pause();
 }
 return false;
}
