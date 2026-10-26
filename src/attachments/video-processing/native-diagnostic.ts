import {NativeMemoryObservationError} from './native-memory';
const stages=['BOOT','VERIFY_FFMPEG','VERIFY_FFPROBE','SOURCE_PROBE','SOURCE_DECODE','NORMALIZE','OUTPUT_VALIDATE','OUTPUT_PROBE','OUTPUT_DECODE','THUMBNAIL','THUMBNAIL_VALIDATE','THUMBNAIL_DECODE','RESULT','SUPERVISOR'] as const;
const points=['WORKER_MEMORY','LAUNCHER_MEMORY','CHILD_LIST','NATIVE_MEMORY','SCRATCH_LIST','SCRATCH_STAT','SCRATCH_LIMIT','MEMORY_LIMIT','COMMAND_SPAWN','COMMAND_STDOUT','COMMAND_STDERR','COMMAND_METRIC','COMMAND_UNLINK','COMMAND_EXIT','MAIN','HEARTBEAT','IPC','WORKER_EXIT'] as const;
const reasons=['HWM_MISSING','HWM_INVALID','ENOENT','ESRCH','EIO','EACCES','EPERM','FORMAT','LIMIT','EXCEPTION','SPAWN','NONZERO','NO_WORKER_RSS','NO_NATIVE_RSS'] as const;
const states=['R','S','D','T','t','X','Z','P','I','W','UNKNOWN'] as const;
export interface NativeDiagnostic {stage:typeof stages[number];point:typeof points[number];reason:typeof reasons[number];state?:typeof states[number];}
/** Closed vocabulary only: no native stderr, arbitrary exception text, PID,
 * paths, filenames, bytes, URLs, arguments, tokens or environment values. */
export function parseNativeDiagnostic(input:unknown):NativeDiagnostic|null{
 if(!input||typeof input!=='object'||Array.isArray(input))return null;const d=input as Record<string,unknown>;
 if(Object.keys(d).some(k=>!['stage','point','reason','state'].includes(k))||!stages.includes(d.stage as never)||!points.includes(d.point as never)||!reasons.includes(d.reason as never)||(d.state!==undefined&&!states.includes(d.state as never)))return null;
 return {stage:d.stage as NativeDiagnostic['stage'],point:d.point as NativeDiagnostic['point'],reason:d.reason as NativeDiagnostic['reason'],...(d.state!==undefined?{state:d.state as NativeDiagnostic['state']}:{})};
}
export class NativeDiagnosticFailure extends Error{readonly diagnostic:NativeDiagnostic;constructor(input:NativeDiagnostic){super('PROCESSING_INVALID');this.name='NativeDiagnosticFailure';this.diagnostic=parseNativeDiagnostic(input)??{stage:'SUPERVISOR',point:'IPC',reason:'FORMAT'};}}
export function diagnoseNativeFailure(error:unknown,stage:NativeDiagnostic['stage'],point:NativeDiagnostic['point']):NativeDiagnostic{
 if(error instanceof NativeDiagnosticFailure)return error.diagnostic;
 if(error instanceof NativeMemoryObservationError)return {stage,point,reason:error.reason,state:error.state};
 const code=(error as {code?:unknown}|null)?.code;return {stage,point,reason:code==='ENOENT'||code==='ESRCH'||code==='EIO'||code==='EACCES'||code==='EPERM'?code:'EXCEPTION'};
}
export function formatNativeDiagnostic(d:NativeDiagnostic):string{return d.stage+'/'+d.point+'/'+d.reason+(d.state?'/'+d.state:'');}
