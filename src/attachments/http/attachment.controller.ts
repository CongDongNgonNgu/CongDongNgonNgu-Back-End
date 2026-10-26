import {ATTACHMENT_LIMITS} from '../attachment-policy';
import {AttachmentValidationError} from '../validation/validation-error';
import {Body,Controller,Delete,Get,Head,Header,HttpCode,Inject,Param,ParseUUIDPipe,Patch,Post,Put,Query,Req,Res,UseGuards} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHmac} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import type {Response} from 'express';
import {AccessTokenGuard,type AuthenticatedRequest} from '../../auth/guards/access-token.guard';
import {OptionalAccessTokenGuard} from '../../community/optional-access-token.guard';
import {SessionService,SessionFailure} from '../../auth/session/session.service';
import {success} from '../../common/http/api-response';
import {attachmentHttpError} from './attachment-errors';
import type {AttachmentReadService} from '../service/attachment-read-service';
import type {AttachmentUploadService} from '../service/attachment-upload-service';
import type {AttachmentFinalizeService} from '../service/attachment-finalize-service';
export const ATTACHMENT_HTTP_APPLICATION='ATTACHMENT_HTTP_APPLICATION';
export interface AttachmentHttpApplication extends Pick<AttachmentReadService,'metadata'|'patchMetadata'|'delete'|'read'> {
 initiate(refresh:()=>Promise<string|null>,input:unknown):Promise<unknown>;
 upload(input:Parameters<AttachmentUploadService['upload']>[0]):ReturnType<AttachmentUploadService['upload']>;
 finalize(input:Parameters<AttachmentFinalizeService['finalize']>[0]):ReturnType<AttachmentFinalizeService['finalize']>;
}
const uuid=()=>new ParseUUIDPipe({version:'4'});
@Controller('attachments')
export class AttachmentController {
 constructor(@Inject(ATTACHMENT_HTTP_APPLICATION)private readonly application:AttachmentHttpApplication,private readonly sessions:SessionService,private readonly config:ConfigService){}
 private query(value:Record<string,unknown>):void{if(Object.keys(value).length)throw new AttachmentValidationError('ATTACHMENT_INVALID_REQUEST');}
 private identity(request:AuthenticatedRequest):()=>Promise<string|null>{
  const principal=request.user,authorization=request.headers.authorization;
  if(!authorization){if(principal)throw new SessionFailure('AUTH_UNAUTHORIZED');return async()=>null;}
  if(!principal||!authorization.startsWith('Bearer '))throw new SessionFailure('AUTH_UNAUTHORIZED');
  const token=authorization.slice(7).trim(),actor=principal.user.id,session=principal.claims.sid;
  return async()=>{const current=await this.sessions.authenticate(token);if(current.user.id!==actor||current.claims.sid!==session)throw new SessionFailure('AUTH_SESSION_EXPIRED');return actor;};
 }
 private protectedIdentity(request:AuthenticatedRequest):{actorId:string;reauthorize:()=>Promise<void>}{
  if(!request.user)throw new SessionFailure('AUTH_UNAUTHORIZED');const refresh=this.identity(request),actorId=request.user.user.id;
  return {actorId,reauthorize:async()=>{if(await refresh()!==actorId)throw new SessionFailure('AUTH_UNAUTHORIZED');}};
 }
 private ip(request:AuthenticatedRequest):string{
  // No client-controlled forwarded header is trusted. The direct peer remains a
  // conservative shared bucket behind a proxy until an approved proxy policy exists.
  const address=request.socket.remoteAddress,secret=this.config.get<string>('auth.accessSecret');
  if(!address||!secret)throw new SessionFailure('AUTH_UNAUTHORIZED');return createHmac('sha256',secret).update('attachment-peer:'+address).digest('hex');
 }
 private transfer(request:AuthenticatedRequest,response:Response){
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!response.writableFinished)abort();};
  request.once('aborted',abort);response.once('close',closed);if(request.aborted)abort();
  return {signal:controller.signal,release:()=>{request.removeListener('aborted',abort);response.removeListener('close',closed);}};
 }
 @Post() @UseGuards(AccessTokenGuard) @Header('Cache-Control','private, no-store')
 async initiate(@Req()req:AuthenticatedRequest,@Body()input:unknown,@Query()query:Record<string,unknown>){try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.initiate(this.identity(req),input));}catch(e){throw attachmentHttpError(e);}}
 @Get(':id') @UseGuards(OptionalAccessTokenGuard) @Header('Cache-Control','private, no-store')
 async metadata(@Req()req:AuthenticatedRequest,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){try{this.query(query);return success(await this.application.metadata(this.identity(req),id,req.user?undefined:this.ip(req)));}catch(e){throw attachmentHttpError(e);}}
 @Patch(':id/metadata') @UseGuards(AccessTokenGuard) @Header('Cache-Control','private, no-store')
 async metadataPatch(@Req()req:AuthenticatedRequest,@Param('id',uuid())id:string,@Body()input:unknown,@Query()query:Record<string,unknown>){try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.patchMetadata(this.identity(req),id,input));}catch(e){throw attachmentHttpError(e);}}
 @Delete(':id') @UseGuards(AccessTokenGuard) @Header('Cache-Control','private, no-store')
 async remove(@Req()req:AuthenticatedRequest,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.delete(this.identity(req),id));}catch(e){throw attachmentHttpError(e);}}
 @Put(':id/content') @UseGuards(AccessTokenGuard) @HttpCode(200) @Header('Cache-Control','private, no-store')
 async upload(@Req()req:AuthenticatedRequest,@Res({passthrough:true})response:Response,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){
  const transfer=this.transfer(req,response);try{this.query(query);this.sessions.assertCsrfForCookie(req);const length=req.headers['content-length'],type=req.headers['content-type'];if(typeof length!=='string'||!/^\d{1,16}$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)<1||typeof type!=='string')throw new AttachmentValidationError('ATTACHMENT_INVALID_REQUEST');if(Number(length)>ATTACHMENT_LIMITS.imageBytes)throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');return success(await this.application.upload({...this.protectedIdentity(req),attachmentId:id,contentType:type,contentLength:Number(length),body:req,signal:transfer.signal}));}catch(e){throw attachmentHttpError(e);}finally{transfer.release();}
 }
 @Post(':id/finalize') @UseGuards(AccessTokenGuard) @HttpCode(200) @Header('Cache-Control','private, no-store')
 async finalize(@Req()req:AuthenticatedRequest,@Res({passthrough:true})response:Response,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){const transfer=this.transfer(req,response);try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.finalize({...this.protectedIdentity(req),attachmentId:id,signal:transfer.signal}));}catch(e){throw attachmentHttpError(e);}finally{transfer.release();}}
 @Head(':id/content') @UseGuards(OptionalAccessTokenGuard)
 headContent(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'HEAD','normalized',q);}
 @Get(':id/content') @UseGuards(OptionalAccessTokenGuard)
 getContent(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'GET','normalized',q);}
 @Head(':id/preview') @UseGuards(OptionalAccessTokenGuard)
 headPreview(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'HEAD','thumbnail',q);}
 @Get(':id/preview') @UseGuards(OptionalAccessTokenGuard)
 getPreview(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'GET','thumbnail',q);}
 private async bytes(req:AuthenticatedRequest,res:Response,id:string,method:'GET'|'HEAD',variant:'normalized'|'thumbnail',query:Record<string,unknown>){
  const transfer=this.transfer(req,res);try{this.query(query);const result=await this.application.read(this.identity(req),id,method,{variant,range:req.headers.range,trustedIpHash:req.user?undefined:this.ip(req),signal:transfer.signal});res.status(result.status);for(const [key,value]of Object.entries(result.headers)){if(key.toLowerCase()==='vary')res.vary(value);else res.setHeader(key,value);}if(method==='HEAD'){result.body?.destroy();res.end();}else if(result.body)await pipeline(result.body,res,{signal:transfer.signal});else throw new Error('Attachment stream missing');}
  catch(error){if(res.headersSent){res.destroy();return;}throw attachmentHttpError(error);}finally{transfer.release();}
 }
}
