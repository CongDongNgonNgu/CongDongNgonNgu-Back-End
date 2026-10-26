import {Module,type MiddlewareConsumer,type NestModule} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';import type {Request,Response,NextFunction} from 'express';
import {AuthModule} from '../auth/auth.module';import {OptionalAccessTokenGuard} from '../community/optional-access-token.guard';
import {AttachmentController,ATTACHMENT_HTTP_APPLICATION} from './http/attachment.controller';import {AttachmentRuntime} from './attachment-runtime';
@Module({imports:[AuthModule],controllers:[AttachmentController],providers:[OptionalAccessTokenGuard,{provide:ATTACHMENT_HTTP_APPLICATION,inject:[ConfigService],useFactory:(config:ConfigService)=>new AttachmentRuntime(config)}]})
export class AttachmentModule implements NestModule {
 configure(consumer:MiddlewareConsumer){consumer.apply((_req:Request,res:Response,next:NextFunction)=>{res.setHeader('Cache-Control','private, no-store');res.vary('Authorization');res.vary('Cookie');next();}).forRoutes(AttachmentController);}
}
