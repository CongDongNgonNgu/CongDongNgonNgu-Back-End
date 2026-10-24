import { NativeVideoProcessor } from './video-processor';
describe('native video processor admission',()=>{
 it('rejects nonabsolute processor paths',()=>expect(()=>new NativeVideoProcessor({processorsDirectory:'relative'})).toThrow());
 it('rejects deadlines beyond frozen 15 seconds',()=>expect(()=>new NativeVideoProcessor({processorsDirectory:process.cwd(),deadlineMs:15001})).toThrow());
 it('rejects malformed media before filesystem/native work',async()=>{const p=new NativeVideoProcessor({processorsDirectory:process.cwd()});await expect(p.process(Buffer.from('bad'),{filename:'x.mp4',mime:'video/mp4'})).rejects.toThrow();});
});
