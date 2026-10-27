import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
@ApiTags("Attachments")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiResponse({ status: 503, description: 'Attachment capability disabled or temporarily unavailable', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiResponse({ status: 404, description: 'Attachment unavailable or not visible to this identity', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiResponse({ status: 409, description: 'Attachment state or metadata version conflict', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiResponse({ status: 413, description: 'Attachment policy size limit exceeded', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiResponse({ status: 415, description: 'Unsupported or mismatched declared content type', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiResponse({ status: 429, description: 'Attachment rate or quota limit exceeded', schema: { $ref: '#/components/schemas/ApiError' } })
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
 @ApiOperation({ summary: "Initiate - Attachments" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiBody({ required: true, description: 'Reserves a draft under existing scope, ownership, format and quota policies; capabilities may be disabled', schema: {"type":"object","additionalProperties":false,"required":["clientUploadId","scope","filename","mime","bytes"],"properties":{"clientUploadId":{"type":"string","format":"uuid"},"scope":{"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","postType","languageId","visibility"],"properties":{"kind":{"type":"string","enum":["COMMUNITY"]},"postType":{"type":"string","enum":["DISCUSSION","QUESTION","RESOURCE","LEARNING_JOURNAL","CULTURE","PRONUNCIATION_REQUEST","CORRECTION_REQUEST","CHALLENGE"]},"languageId":{"type":"string","format":"uuid"},"visibility":{"type":"string","enum":["PUBLIC","PRIVATE"]}}},{"type":"object","additionalProperties":false,"required":["kind","groupId"],"properties":{"kind":{"type":"string","enum":["STUDY_GROUP"]},"groupId":{"type":"string","format":"uuid"}}},{"type":"object","additionalProperties":false,"required":["kind","conversationId"],"properties":{"kind":{"type":"string","enum":["DIRECT_MESSAGE"]},"conversationId":{"type":"string","format":"uuid"}}}]},"filename":{"type":"string","minLength":1,"maxLength":180,"description":"Normalized filename; path separators and control characters are rejected"},"mime":{"type":"string","enum":["image/jpeg","image/png","image/webp","text/plain","video/mp4"]},"bytes":{"type":"integer","minimum":1,"maximum":4194304,"description":"Source bytes; format-specific and parent-budget limits also apply"},"caption":{"type":"string","maxLength":500},"alt":{"type":"string","maxLength":300}}} })
  @Post() @UseGuards(AccessTokenGuard) @Header('Cache-Control','private, no-store')
 async initiate(@Req()req:AuthenticatedRequest,@Body()input:unknown,@Query()query:Record<string,unknown>){try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.initiate(this.identity(req),input));}catch(e){throw attachmentHttpError(e);}}
 @ApiOperation({ summary: "Metadata - Attachments", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':id') @UseGuards(OptionalAccessTokenGuard) @Header('Cache-Control','private, no-store')
 async metadata(@Req()req:AuthenticatedRequest,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){try{this.query(query);return success(await this.application.metadata(this.identity(req),id,req.user?undefined:this.ip(req)));}catch(e){throw attachmentHttpError(e);}}
 @ApiOperation({ summary: "Metadata Patch - Attachments" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiBody({ required: true, description: 'Optimistic metadata update for an owned unbound draft', schema: {"type":"object","additionalProperties":false,"required":["expectedMetadataVersion","caption","alt"],"properties":{"expectedMetadataVersion":{"type":"integer","minimum":0},"caption":{"type":"string","maxLength":500},"alt":{"type":"string","maxLength":300}}} })
  @Patch(':id/metadata') @UseGuards(AccessTokenGuard) @Header('Cache-Control','private, no-store')
 async metadataPatch(@Req()req:AuthenticatedRequest,@Param('id',uuid())id:string,@Body()input:unknown,@Query()query:Record<string,unknown>){try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.patchMetadata(this.identity(req),id,input));}catch(e){throw attachmentHttpError(e);}}
 @ApiOperation({ summary: "Remove - Attachments" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete(':id') @UseGuards(AccessTokenGuard) @Header('Cache-Control','private, no-store')
 async remove(@Req()req:AuthenticatedRequest,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.delete(this.identity(req),id));}catch(e){throw attachmentHttpError(e);}}
 @ApiOperation({ summary: "Upload - Attachments" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiConsumes('image/jpeg', 'image/png', 'image/webp', 'text/plain', 'video/mp4')
  @ApiHeader({ name: 'Content-Length', required: true, schema: { type: 'integer', minimum: 1, maximum: ATTACHMENT_LIMITS.imageBytes } })
  @ApiBody({ required: true, description: 'Raw bytes matching the draft declaration, subject to capability and source-byte limits', schema: { type: 'string', format: 'binary' } })
  @Put(':id/content') @UseGuards(AccessTokenGuard) @HttpCode(200) @Header('Cache-Control','private, no-store')
 async upload(@Req()req:AuthenticatedRequest,@Res({passthrough:true})response:Response,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){
  const transfer=this.transfer(req,response);try{this.query(query);this.sessions.assertCsrfForCookie(req);const length=req.headers['content-length'],type=req.headers['content-type'];if(typeof length!=='string'||!/^\d{1,16}$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)<1||typeof type!=='string')throw new AttachmentValidationError('ATTACHMENT_INVALID_REQUEST');if(Number(length)>ATTACHMENT_LIMITS.imageBytes)throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');return success(await this.application.upload({...this.protectedIdentity(req),attachmentId:id,contentType:type,contentLength:Number(length),body:req,signal:transfer.signal}));}catch(e){throw attachmentHttpError(e);}finally{transfer.release();}
 }
 @ApiOperation({ summary: "Finalize - Attachments" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':id/finalize') @UseGuards(AccessTokenGuard) @HttpCode(200) @Header('Cache-Control','private, no-store')
 async finalize(@Req()req:AuthenticatedRequest,@Res({passthrough:true})response:Response,@Param('id',uuid())id:string,@Query()query:Record<string,unknown>){const transfer=this.transfer(req,response);try{this.query(query);this.sessions.assertCsrfForCookie(req);return success(await this.application.finalize({...this.protectedIdentity(req),attachmentId:id,signal:transfer.signal}));}catch(e){throw attachmentHttpError(e);}finally{transfer.release();}}
 @ApiOperation({ summary: "Head Content - Attachments", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Range', required: false, description: 'Optional byte range', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Authorized attachment bytes or HEAD metadata' })
  @ApiResponse({ status: 206, description: 'Partial attachment content' })
  @ApiResponse({ status: 416, description: 'Requested byte range is not satisfiable' })
  @Head(':id/content') @UseGuards(OptionalAccessTokenGuard)
 headContent(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'HEAD','normalized',q);}
 @ApiOperation({ summary: "Get Content - Attachments", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Range', required: false, description: 'Optional byte range', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Authorized attachment bytes or HEAD metadata', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 206, description: 'Partial attachment content' })
  @ApiResponse({ status: 416, description: 'Requested byte range is not satisfiable' })
  @Get(':id/content') @UseGuards(OptionalAccessTokenGuard)
 getContent(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'GET','normalized',q);}
 @ApiOperation({ summary: "Head Preview - Attachments", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Range', required: false, description: 'Optional byte range', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Authorized attachment bytes or HEAD metadata' })
  @ApiResponse({ status: 206, description: 'Partial attachment content' })
  @ApiResponse({ status: 416, description: 'Requested byte range is not satisfiable' })
  @Head(':id/preview') @UseGuards(OptionalAccessTokenGuard)
 headPreview(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'HEAD','thumbnail',q);}
 @ApiOperation({ summary: "Get Preview - Attachments", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "id", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Range', required: false, description: 'Optional byte range', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Authorized attachment bytes or HEAD metadata', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 206, description: 'Partial attachment content' })
  @ApiResponse({ status: 416, description: 'Requested byte range is not satisfiable' })
  @Get(':id/preview') @UseGuards(OptionalAccessTokenGuard)
 getPreview(@Req()req:AuthenticatedRequest,@Res()res:Response,@Param('id',uuid())id:string,@Query()q:Record<string,unknown>){return this.bytes(req,res,id,'GET','thumbnail',q);}
 private async bytes(req:AuthenticatedRequest,res:Response,id:string,method:'GET'|'HEAD',variant:'normalized'|'thumbnail',query:Record<string,unknown>){
  const transfer=this.transfer(req,res);try{this.query(query);const result=await this.application.read(this.identity(req),id,method,{variant,range:req.headers.range,trustedIpHash:req.user?undefined:this.ip(req),signal:transfer.signal});res.status(result.status);for(const [key,value]of Object.entries(result.headers)){if(key.toLowerCase()==='vary')res.vary(value);else res.setHeader(key,value);}if(method==='HEAD'){result.body?.destroy();res.end();}else if(result.body)await pipeline(result.body,res,{signal:transfer.signal});else throw new Error('Attachment stream missing');}
  catch(error){if(res.headersSent){res.destroy();return;}throw attachmentHttpError(error);}finally{transfer.release();}
 }
}
