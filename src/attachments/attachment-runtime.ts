import {Logger,type OnModuleInit,type OnModuleDestroy} from '@nestjs/common';
import type {ConfigService} from '@nestjs/config';
import {Pool} from 'pg';import {join} from 'node:path';
import type {AttachmentHttpApplication} from './http/attachment.controller';
import {AttachmentInitiationRepository,AttachmentInitiationUnavailable} from './initiation/attachment-initiation-repository';
import {AttachmentReadService} from './service/attachment-read-service';
import {AttachmentUploadService} from './service/attachment-upload-service';
import {AttachmentFinalizeService} from './service/attachment-finalize-service';
import {R2AttachmentStorage} from './storage/r2-attachment-storage';
import {ImageProcessor} from './processing/image-processor';import {NativeVideoProcessor} from './video-processing/video-processor';
import {AttachmentCleanupWorker} from './cleanup/attachment-cleanup-worker';import {PostgresAttachmentCleanupRepository} from './cleanup/postgres-attachment-cleanup.repository';
import {AttachmentOrphanDetector} from './reconciliation/attachment-orphan-detector';import {PostgresAttachmentOrphanRepository} from './reconciliation/postgres-attachment-orphan.repository';
import {AttachmentPutRecovery,PostgresAttachmentPutRecoveryRepository} from './reconciliation/attachment-put-recovery';
import {AttachmentPutRecoveryQueue} from './reconciliation/attachment-put-recovery-queue';
import {ATTACHMENT_LIMITS as L,type parseAttachmentCapabilities} from './attachment-policy';
/** TEST-only composition. The master switch defaults off and causes zero storage,
 * processor or DB initialization. Format switches may all be off while the master
 * stays on to retain cleanup of existing media during an upload rollout hold. */
export class AttachmentRuntime implements AttachmentHttpApplication,OnModuleInit,OnModuleDestroy {
 private readonly logger=new Logger('Attachments');
 private readonly capabilities:ReturnType<typeof parseAttachmentCapabilities>;
 private pool?:Pool;private storage?:R2AttachmentStorage;private image?:ImageProcessor;private video?:NativeVideoProcessor;
 private reads?:AttachmentReadService;private uploads?:AttachmentUploadService;private finalizer?:AttachmentFinalizeService;private initiation?:AttachmentInitiationRepository;private cleanup?:AttachmentCleanupWorker;private orphans?:AttachmentOrphanDetector;
 private orphanTimer?:NodeJS.Timeout;private orphanWork:Promise<unknown>|null=null;private stopped=false;private ready=false;private lastKick=0;
 private putRecovery?:AttachmentPutRecoveryQueue;
 private teardown:Promise<void>|undefined;
 private readonly abort=new AbortController();private readonly active=new Set<Promise<unknown>>();
 constructor(config:ConfigService){
  this.capabilities=config.get<ReturnType<typeof parseAttachmentCapabilities>>('attachments')??{enabled:false,image:false,video:false,text:false};
  if(!this.capabilities.enabled)return;
  if(config.get('providers.storage')!=='r2')throw new AttachmentInitiationUnavailable();
  const endpoint=config.get<string>('providers.storageApiUrl'),bucket=config.get<string>('providers.storageBucket'),accessKeyId=config.get<string>('providers.storageAccessKeyId'),secretAccessKey=config.get<string>('providers.storageSecretAccessKey'),url=config.get<string>('database.url');
  let storageEndpoint:URL;try{storageEndpoint=new URL(endpoint??'');}catch{throw new AttachmentInitiationUnavailable();}
  if(storageEndpoint.origin!=='https://4f351f7ca844a641384440a09b1b2ba0.r2.cloudflarestorage.com'||storageEndpoint.pathname!=='/'||storageEndpoint.search||storageEndpoint.hash||storageEndpoint.username||storageEndpoint.password||bucket!=='congdongngonngu'||!accessKeyId||!secretAccessKey||!url)throw new AttachmentInitiationUnavailable();
  // The exact approved TEST database guard is shared with the isolated proof
  // runner. This composition cannot silently activate a production database.
  const {validatedTestTarget}=require('../../scripts/phase30-sql-target.cjs');validatedTestTarget(url);
  this.pool=new Pool({connectionString:url,max:6,connectionTimeoutMillis:10000,statement_timeout:10000,lock_timeout:5000,idle_in_transaction_session_timeout:15000,query_timeout:15000});
  this.storage=new R2AttachmentStorage({classification:'approved-test',endpoint:storageEndpoint.origin,bucket,accessKeyId,secretAccessKey});
  this.image=this.capabilities.image?new ImageProcessor():undefined;
  this.video=this.capabilities.video?new NativeVideoProcessor({processorsDirectory:join(__dirname,'processors')}):undefined;
  this.putRecovery=new AttachmentPutRecoveryQueue(new AttachmentPutRecovery(new PostgresAttachmentPutRecoveryRepository(this.pool),this.storage),event=>this.logger.warn(JSON.stringify(event)));
  const onUncertainPut:NonNullable<ConstructorParameters<typeof AttachmentUploadService>[3]>['onUncertainPut']=(claim,handle)=>this.putRecovery!.enqueue(claim,handle);
  this.reads=new AttachmentReadService(this.pool,this.storage);this.uploads=new AttachmentUploadService(this.pool,this.storage,this.capabilities,{onUncertainPut});
  this.finalizer=new AttachmentFinalizeService(this.pool,this.storage,this.capabilities,{imageProcessor:this.image,videoProcessor:this.video,onUncertainPut});this.initiation=new AttachmentInitiationRepository(this.pool,this.capabilities);
  this.cleanup=new AttachmentCleanupWorker(new PostgresAttachmentCleanupRepository(this.pool),this.storage,event=>this.logger.warn(JSON.stringify(event)));
  this.orphans=new AttachmentOrphanDetector(new PostgresAttachmentOrphanRepository(this.pool),this.storage,event=>this.logger.warn(JSON.stringify(event)));
 }
 async onModuleInit():Promise<void>{
  if(!this.capabilities.enabled||this.stopped)return;
  try {
  // Enabling before the separately reviewed TEST migration fails startup closed.
  await this.pool!.query('SELECT source_object_id,normalized_object_id,thumbnail_object_id,upload_slot_held,pending_slot_held FROM attachments LIMIT 0');
  const lease=await this.pool!.query('SELECT singleton FROM attachment_processing_lease WHERE singleton');if(lease.rowCount!==1)throw new AttachmentInitiationUnavailable();
  await this.pool!.query('SELECT attachment_id,owner FROM attachment_upload_replay_leases LIMIT 0');
  await this.pool!.query('SELECT put_supervision_id,put_abandoned_at FROM attachment_objects LIMIT 0');
  this.ready=true;this.cleanup!.start();this.putRecovery!.start();this.inspectOrphans();this.orphanTimer=setInterval(()=>this.inspectOrphans(),L.cleanupIntervalMs);this.orphanTimer.unref();
  }catch{await this.onModuleDestroy();throw new AttachmentInitiationUnavailable();}
 }
 private inspectOrphans():void{if(this.stopped||this.orphanWork||!this.orphans)return;const work=this.orphans.inspectNextPage();this.orphanWork=work;void work.catch(()=>this.logger.warn('ATTACHMENT_RECONCILIATION_UNAVAILABLE')).finally(()=>{if(this.orphanWork===work)this.orphanWork=null;});}
 private async run<T>(work:()=>Promise<T>):Promise<T>{
  if(!this.ready||this.stopped||!this.capabilities.enabled)throw new AttachmentInitiationUnavailable();
  const promise=work();this.active.add(promise);try{return await promise;}finally{this.active.delete(promise);const now=Date.now();if(!this.stopped&&now-this.lastKick>=L.cleanupIntervalMs){this.lastKick=now;this.cleanup!.kick();void this.putRecovery?.run().catch(()=>this.logger.warn('ATTACHMENT_RECOVERY_UNAVAILABLE'));}}
 }
 initiate(refresh:()=>Promise<string|null>,input:unknown){return this.run(()=>this.reads!.initiate(refresh,this.initiation!,input));}
 metadata(...args:Parameters<AttachmentReadService['metadata']>){return this.run(()=>this.reads!.metadata(...args));}
 patchMetadata(...args:Parameters<AttachmentReadService['patchMetadata']>){return this.run(()=>this.reads!.patchMetadata(...args));}
 delete(...args:Parameters<AttachmentReadService['delete']>){return this.run(()=>this.reads!.delete(...args));}
 read(...args:Parameters<AttachmentReadService['read']>){return this.run(()=>this.reads!.read(args[0],args[1],args[2],{...args[3],signal:args[3]?.signal?AbortSignal.any([args[3].signal,this.abort.signal]):this.abort.signal}));}
 upload(input:Parameters<AttachmentUploadService['upload']>[0]){return this.run(()=>this.uploads!.upload({...input,signal:input.signal?AbortSignal.any([input.signal,this.abort.signal]):this.abort.signal}));}
 finalize(input:Parameters<AttachmentFinalizeService['finalize']>[0]){return this.run(()=>this.finalizer!.finalize({...input,signal:input.signal?AbortSignal.any([input.signal,this.abort.signal]):this.abort.signal}));}
 onModuleDestroy():Promise<void>{if(!this.teardown)this.teardown=this.destroy();return this.teardown;}
 private async destroy():Promise<void>{
  this.stopped=true;this.ready=false;this.abort.abort();if(this.orphanTimer)clearInterval(this.orphanTimer);
  await Promise.allSettled([Promise.resolve().then(()=>this.image?.shutdown()),Promise.resolve().then(()=>this.video?.shutdown())]);
  await Promise.allSettled([...this.active]);
  const outcomes=await Promise.allSettled([Promise.resolve().then(()=>this.cleanup?.stop()),Promise.resolve().then(()=>this.putRecovery?.stop()),this.orphanWork??Promise.resolve()]);
  try{this.storage?.close();}finally{await this.pool?.end();}
  if(outcomes.some(x=>x.status==='rejected'))this.logger.warn('ATTACHMENT_SHUTDOWN_DEBT_RETAINED');
 }
}
