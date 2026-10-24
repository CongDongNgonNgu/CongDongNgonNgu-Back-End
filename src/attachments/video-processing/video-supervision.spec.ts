import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import * as files from 'node:fs/promises';
import {NativeVideoProcessor} from './video-processor';
jest.mock('node:child_process',()=>({spawn:jest.fn()}));
jest.mock('node:fs/promises',()=>({readFile:jest.fn()}));
describe('Linux native command completion and descendant supervision',()=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!;let child:EventEmitter&{pid:number;kill:jest.Mock},kill:jest.SpyInstance;
 beforeEach(()=>{jest.useFakeTimers();Object.defineProperty(process,'platform',{value:'linux'});child=Object.assign(new EventEmitter(),{pid:123,kill:jest.fn()});(spawn as jest.Mock).mockReturnValue(child);kill=jest.spyOn(process,'kill').mockImplementation((_pid,signal)=>{if(signal===0)throw Object.assign(Error(),{code:'ESRCH'});return true;});});
 afterEach(()=>{Object.defineProperty(process,'platform',platform);jest.restoreAllMocks();jest.useRealTimers();});
 const execute=()=>{const p=new NativeVideoProcessor({processorsDirectory:'/approved/processors',workerFile:'/approved/video-worker.js'});return (p as unknown as {execute(d:string,t:number):Promise<{nativeRssObserved:boolean;peakRssBytes:number}>}).execute('/owned',15000);};
 it('accepts lifetime native peak even if the command finished before the first poll',async()=>{const result=execute();child.emit('message',{rss:16*1024*1024,nativePeakRssBytes:8*1024*1024,nativePid:null});child.emit('close',0);await expect(result).resolves.toMatchObject({nativeRssObserved:true,peakRssBytes:16*1024*1024});});
 it('never manufactures native observation from worker RSS alone',async()=>{const result=execute();child.emit('message',{rss:16*1024*1024,nativePid:null});child.emit('close',0);await expect(result).rejects.toMatchObject({code:'PROCESSING_INVALID'});});
 it('tolerates an exiting native zombie while requiring separate lifetime completion evidence',async()=>{(files.readFile as jest.Mock).mockImplementation(async(path:any)=>String(path).includes('/123/')?'State:\tS (sleeping)\nVmHWM:\t16384 kB\n':'State:\tZ (zombie)\n' as any);const result=execute();child.emit('message',{rss:16*1024*1024,nativePid:456});await jest.advanceTimersByTimeAsync(25);child.emit('message',{rss:24*1024*1024,nativePid:null,nativePeakRssBytes:8*1024*1024});child.emit('close',0);await expect(result).resolves.toMatchObject({nativeRssObserved:true});});
 it('kills the whole detached group after direct abnormal worker exit',async()=>{const result=execute();child.emit('close',1);await expect(result).rejects.toMatchObject({code:'PROCESSING_INVALID',producerQuiesced:true});expect(kill).toHaveBeenCalledWith(-123,'SIGKILL');});
 it('retains producer uncertainty if descendants cannot independently be proven gone',async()=>{kill.mockImplementation(()=>true);const result=execute();const rejected=expect(result).rejects.toMatchObject({code:'PROCESSING_UNQUIESCED',producerQuiesced:false});child.emit('close',1);await jest.advanceTimersByTimeAsync(1000);await rejected;expect(kill).toHaveBeenCalledWith(-123,'SIGKILL');});
});
