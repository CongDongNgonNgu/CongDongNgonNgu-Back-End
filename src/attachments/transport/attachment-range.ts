import type {AttachmentByteRange} from '../storage/attachment-storage.port';
import type {AttachmentFormat} from '../attachment-policy';
export class AttachmentRangeError extends Error {constructor(){super('ATTACHMENT_RANGE_INVALID');this.name='AttachmentRangeError';}}
export function attachmentRange(header:string|undefined,size:number):AttachmentByteRange|undefined {
 if(!Number.isSafeInteger(size)||size<1||size>4194304)throw new AttachmentRangeError();
 if(header===undefined)return undefined;
 if(typeof header!=='string'||header.length>64)throw new AttachmentRangeError();
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2]))throw new AttachmentRangeError();
 const number=(v:string)=>{const n=Number(v);if(!Number.isSafeInteger(n))throw new AttachmentRangeError();return n;};
 if(!match[1]){const suffix=number(match[2]);if(suffix<1)throw new AttachmentRangeError();return {start:Math.max(0,size-suffix),end:size-1};}
 const start=number(match[1]),end=match[2]?Math.min(number(match[2]),size-1):size-1;
 if(start>=size||end<start)throw new AttachmentRangeError();return {start,end};
}
/** Filename is deliberately server-generated; display names are metadata only. */
export function attachmentDownloadHeaders(format:AttachmentFormat,variant:'normalized'|'thumbnail',_displayFilename:string):Record<string,string>{
 if(!['normalized','thumbnail'].includes(variant)||!['IMAGE','VIDEO','TEXT'].includes(format)||(format==='TEXT'&&variant==='thumbnail'))throw new AttachmentRangeError();
 const type=variant==='thumbnail'?(format==='VIDEO'?'image/jpeg':'image/webp'):format==='IMAGE'?'image/webp':format==='VIDEO'?'video/mp4':'application/octet-stream';
 const extension=type==='image/webp'?'webp':type==='image/jpeg'?'jpg':type==='video/mp4'?'mp4':'txt';
 const filename='attachment.'+extension;
 return {'Content-Type':type,'Content-Disposition':(format==='TEXT'?'attachment':'inline')+'; filename="'+filename+'"; filename*=UTF-8'+String.fromCharCode(39,39)+filename,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Authorization, Cookie','Accept-Ranges':'bytes'};
}
