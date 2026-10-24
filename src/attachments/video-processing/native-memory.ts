/** Linux /proc emits task_mem only while task has an mm:
 * https://raw.githubusercontent.com/torvalds/linux/master/fs/proc/array.c
 * GNU time %M is lifetime maximum resident set in KiB, surviving short commands:
 * https://www.gnu.org/software/time/manual/html_node/Memory-Resources.html
 * These are observed/post-exit peaks, not an OS-enforced memory sandbox. */
export function parseLinuxHighWater(status:string,allowExited=false):number|null {
 const match=/^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
 if(!match){if(allowExited&&/^State:\s+[ZX]\b/m.test(status))return null;throw Error('PROCESSING_UNAVAILABLE');}
 const bytes=Number(match[1])*1024;if(!Number.isSafeInteger(bytes)||bytes<1)throw Error('PROCESSING_UNAVAILABLE');return bytes;
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
