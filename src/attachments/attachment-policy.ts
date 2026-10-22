// Frozen Phase30 TEST policy. These ceilings are not a provider billing cap.
export type AttachmentFormat = 'IMAGE' | 'VIDEO' | 'TEXT';
export type AttachmentState = 'TEMPORARY' | 'UPLOADING' | 'PENDING' | 'READY' | 'REJECTED' | 'DELETED';
export type AttachmentScope = 'COMMUNITY' | 'STUDY_GROUP' | 'DIRECT_MESSAGE';
export const ATTACHMENT_LIMITS = Object.freeze({
  imageBytes:4*1048576, imagePixels:3000000, imageEdge:2000,
  videoBytes:3*1048576, videoSeconds:15, videoFps:24, videoWidth:1280, videoHeight:720, videoPixels:921600,
  textBytes:65536, thumbnailBytes:256*1024, thumbnailEdge:320,
  parentCount:4, parentVideos:1, parentBytes:16*1048576,
  actorReservedBytes:64*1048576, deploymentReservedBytes:256*1048576,
  deploymentMetadata:512, actorActiveUploads:1, deploymentActiveUploads:1, pendingJobs:8,
  actorInitiationsPerHour:10, deploymentInitiationsPerHour:40,
  actorSourceBytesPerDay:32*1048576, deploymentSourceBytesPerDay:128*1048576,
  actorReadsPerMinute:60, anonymousReadsPerMinute:30, deploymentReadsPerMinute:300,
  uploadTotalMs:30000, uploadIdleMs:10000, storageCallMs:10000,
  streamIdleMs:10000, streamTotalMs:60000,
  draftTtlMs:3600000, uploadLeaseMs:60000, processingLeaseMs:120000,
  cleanupIntervalMs:60000, cleanupBatch:20, objectListPage:100,
  cleanupAttempts:10, cleanupMaxBackoffMs:3600000,
  initRetentionMs:86400000, tombstoneRetentionMs:7*86400000, counterRetentionMs:48*3600000,
  workerHeapMiB:64, workerObservedRssBytes:192*1048576, temporaryBytes:64*1048576,
  imageStageMs:10000, imageChildMs:30000, videoChildMs:15000,
});
export class AttachmentPolicyError extends Error {
  constructor() { super('Attachment policy rejected the request'); this.name='AttachmentPolicyError'; }
}
const reject = (): never => { throw new AttachmentPolicyError(); };
export function parseAttachmentCapabilities(input:Record<string,unknown>) {
  const flag = (name:string):boolean => {
    const value=input[name];
    if(value===undefined || value==='false') return false;
    if(value==='true') return true;
    return reject();
  };
  const enabled=flag('ATTACHMENTS_ENABLED');
  const image=flag('ATTACHMENTS_IMAGE_ENABLED'), video=flag('ATTACHMENTS_VIDEO_ENABLED'), text=flag('ATTACHMENTS_TEXT_ENABLED');
  if(!enabled && (image || video || text)) reject();
  return Object.freeze({enabled,image,video,text});
}
const edges:Readonly<Record<AttachmentState,readonly AttachmentState[]>> = {
  TEMPORARY:['UPLOADING','DELETED'], UPLOADING:['PENDING','DELETED'],
  PENDING:['READY','REJECTED','DELETED'], READY:['DELETED'], REJECTED:['DELETED'], DELETED:[],
};
export function assertAttachmentTransition(from:AttachmentState,to:AttachmentState):void {
  if(!edges[from]?.includes(to)) reject();
}
export function sourceByteLimit(format:AttachmentFormat):number {
  switch(format) { case 'IMAGE':return ATTACHMENT_LIMITS.imageBytes; case 'VIDEO':return ATTACHMENT_LIMITS.videoBytes; case 'TEXT':return ATTACHMENT_LIMITS.textBytes; default:return reject(); }
}
export function attachmentReservationBytes(format:AttachmentFormat,sourceBytes:number):number {
  if(!Number.isSafeInteger(sourceBytes) || sourceBytes<1 || sourceBytes>sourceByteLimit(format)) reject();
  return sourceBytes+(format==='TEXT'?ATTACHMENT_LIMITS.textBytes:sourceByteLimit(format)+ATTACHMENT_LIMITS.thumbnailBytes);
}
export function formatForDeclaration(filename:string,mime:string,bytes:number):AttachmentFormat {
  const extension=filename.slice(filename.lastIndexOf('.')+1).toLowerCase();
  const formats:Readonly<Record<string,readonly [string,AttachmentFormat]>> = {
    jpg:['image/jpeg','IMAGE'], jpeg:['image/jpeg','IMAGE'], png:['image/png','IMAGE'], webp:['image/webp','IMAGE'], mp4:['video/mp4','VIDEO'], txt:['text/plain','TEXT'],
  };
  const declaration=formats[extension];
  if(!declaration || declaration[0]!==mime) return reject();
  attachmentReservationBytes(declaration[1],bytes);
  return declaration[1];
}
export function assertParentBudget(scope:AttachmentScope,postType:string|null,items:readonly {format:AttachmentFormat;sourceBytes:number}[]):void {
  let allowed:readonly AttachmentFormat[];
  if(scope==='COMMUNITY') {
    switch(postType) {
      case 'DISCUSSION':case 'LEARNING_JOURNAL':case 'CULTURE':allowed=['IMAGE','VIDEO','TEXT'];break;
      case 'QUESTION':case 'RESOURCE':case 'CHALLENGE':case 'CORRECTION_REQUEST':allowed=['IMAGE','TEXT'];break;
      case 'PRONUNCIATION_REQUEST':allowed=['VIDEO'];break;
      default:return reject();
    }
  } else if(scope==='STUDY_GROUP' || scope==='DIRECT_MESSAGE') allowed=['IMAGE','VIDEO','TEXT'];
  else return reject();
  if(items.length>ATTACHMENT_LIMITS.parentCount || items.filter(x=>x.format==='VIDEO').length>ATTACHMENT_LIMITS.parentVideos) reject();
  let total=0;
  for(const item of items) {
    if(!allowed.includes(item.format)) reject();
    attachmentReservationBytes(item.format,item.sourceBytes); total+=item.sourceBytes;
  }
  if(total>ATTACHMENT_LIMITS.parentBytes) reject();
}
