import { createHash } from 'node:crypto';
import type { ProcessedImage } from '../processing/image-processor';
import type { ProcessedVideo } from '../video-processing/video-processor';
import { formatForDeclaration,ATTACHMENT_LIMITS as L,type AttachmentFormat } from '../attachment-policy';
import { validateTextFile } from '../validation/text';
import { validateImageStructure } from '../validation/image';
import { validateMp4Structure } from '../video/mp4';
declare const proofBrand:unique symbol;
export interface ValidatedProcessorProof {readonly [proofBrand]:true}
export interface ProcessorArtifact {variant:'normalized'|'thumbnail';contentType:'application/octet-stream'|'image/webp'|'image/jpeg'|'video/mp4';bytes:Buffer;sha256:string;sizeBytes:number}
export interface ProcessorProofFacts {format:AttachmentFormat;sourceBytes:number;sourceSha256:string;filename:string;mime:string;artifacts:readonly ProcessorArtifact[]}
export type CompletedProcessorResult={format:'TEXT'}|{format:'IMAGE';result:ProcessedImage}|{format:'VIDEO';result:ProcessedVideo};
const proofs=new WeakMap<ValidatedProcessorProof,Readonly<ProcessorProofFacts>>();
const invalid=():never=>{throw Error('ATTACHMENT_PROCESSOR_PROOF_INVALID');};
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Pure pre-moderation inspection only: returns detached validated byte facts,
 * never an opaque publication token or proof of moderation/native execution. */
export function inspectProcessorResult(source:Buffer,declaration:{filename:string;mime:string},completed:CompletedProcessorResult):Readonly<ProcessorProofFacts> {
 const format=formatForDeclaration(declaration.filename,declaration.mime,source.length);if(format!==completed.format)return invalid();
 const artifacts:ProcessorArtifact[]=[];
 const add=(variant:ProcessorArtifact['variant'],bytes:Buffer,contentType:ProcessorArtifact['contentType'],maximum:number)=>{if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>maximum)return invalid();const owned=Buffer.from(bytes);artifacts.push({variant,bytes:owned,contentType,sha256:hash(owned),sizeBytes:owned.length});};
 if(completed.format==='TEXT')add('normalized',Buffer.from(validateTextFile(source,declaration),'utf8'),'application/octet-stream',L.textBytes);
 else{
  const r=completed.result;if(!Number.isSafeInteger(r.peakRssBytes)||r.peakRssBytes<1||r.peakRssBytes>L.workerObservedRssBytes)return invalid();
  if(completed.format==='IMAGE'){
   validateImageStructure(source,declaration);
   const normal=validateImageStructure(r.normalized,{filename:'normalized.webp',mime:'image/webp'}),thumb=validateImageStructure(r.thumbnail,{filename:'thumbnail.webp',mime:'image/webp'});
   if(normal.metadataBytes||thumb.metadataBytes||normal.width!==r.width||normal.height!==r.height||thumb.width!==r.thumbnailWidth||thumb.height!==r.thumbnailHeight||Math.max(thumb.width,thumb.height)>L.thumbnailEdge)return invalid();
   add('normalized',r.normalized,'image/webp',L.imageBytes);add('thumbnail',r.thumbnail,'image/webp',L.thumbnailBytes);
  }else{
   const input=validateMp4Structure(source,declaration),v=completed.result;
   const normal=validateMp4Structure(v.normalized,{filename:'normalized.mp4',mime:'video/mp4'}),thumb=validateImageStructure(v.thumbnail,{filename:'thumbnail.jpg',mime:'image/jpeg'});
   if(normal.seiUnits||normal.width!==v.width||normal.height!==v.height||normal.videoSamples!==input.videoSamples||normal.audioSamples!==input.audioSamples||normal.durationSeconds!==v.durationSeconds||thumb.metadataBytes||thumb.width!==v.thumbnailWidth||thumb.height!==v.thumbnailHeight||Math.max(thumb.width,thumb.height)>L.thumbnailEdge)return invalid();
   add('normalized',v.normalized,'video/mp4',L.videoBytes);add('thumbnail',v.thumbnail,'image/jpeg',L.thumbnailBytes);
  }
 }
 return {format,sourceBytes:source.length,sourceSha256:hash(source),filename:declaration.filename,mime:declaration.mime,artifacts};
}
/** INTERNAL trusted-server publication boundary, never a request DTO. Only call
 * after the reviewed processor child is closed and actual moderation is ALLOW.
 * Reinspect to avoid trusting caller-mutated pre-moderation inspection facts. */
export function createProcessorProof(source:Buffer,declaration:{filename:string;mime:string},completed:CompletedProcessorResult,moderation:'ALLOW'):ValidatedProcessorProof {
 if(moderation!=='ALLOW')return invalid();
 const facts=inspectProcessorResult(source,declaration,completed);
 const proof=Object.freeze({}) as ValidatedProcessorProof;proofs.set(proof,facts);return proof;
}
export function processorProofFacts(proof:ValidatedProcessorProof):Readonly<ProcessorProofFacts>{const value=proofs.get(proof);if(!value)return invalid();return {...value,artifacts:value.artifacts.map(a=>({...a,bytes:Buffer.from(a.bytes)}))};}
export function processorProofArtifacts(proof:ValidatedProcessorProof):readonly ProcessorArtifact[]{return processorProofFacts(proof).artifacts;}
