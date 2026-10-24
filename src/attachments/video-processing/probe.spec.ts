import { inspectProbe } from './probe';
describe('strict native probe', () => {
 const source = {format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'0.5',tags:{}},streams:[{codec_type:'video',codec_name:'h264',profile:'Constrained Baseline',pix_fmt:'yuv420p',width:128,height:72,avg_frame_rate:'4/1',r_frame_rate:'4/1',sample_aspect_ratio:'1:1',duration:'0.5',tags:{}}]};
 it('accepts exact bounded generated source',()=>expect(inspectProbe(source).width).toBe(128));
 it.each([{profile:'High'},{avg_frame_rate:'8/1'},{sample_aspect_ratio:'4:3'},{side_data_list:[{rotation:90}]},{duration:'16'},{width:1281}])('rejects incompatible native metadata %j',patch=>expect(()=>inspectProbe({...source,streams:[{...source.streams[0],...patch}]})).toThrow());
 it('permits no inherited output metadata',()=>expect(()=>inspectProbe({...source,format:{...source.format,tags:{title:'private'}}},true)).toThrow());
});
