import {validateEnvironment} from './env.validation';
import {buildConfiguration} from './configuration';
const base={NODE_ENV:'test',PORT:'3000',PUBLIC_APP_URL:'http://localhost:5173',CORS_ALLOWED_ORIGINS:'http://localhost:5173',DATABASE_URL:'postgresql://postgres:postgres@localhost:5432/congdongngonngu',JWT_ACCESS_SECRET:'synthetic-access-secret-at-least-32-characters',JWT_REFRESH_SECRET:'synthetic-refresh-secret-at-least-32-characters'};
describe('attachment opt-in configuration',()=>{
 it('does not activate uploads or processing through existing backup R2 configuration',()=>{
  expect(buildConfiguration(validateEnvironment(base)).attachments).toEqual({enabled:false,image:false,video:false,text:false});
 });
 it('rejects ambiguous flags and individually activated formats without the master gate',()=>{
  expect(()=>validateEnvironment({...base,ATTACHMENTS_ENABLED:'yes'})).toThrow();
  expect(()=>validateEnvironment({...base,ATTACHMENTS_IMAGE_ENABLED:'true'})).toThrow();
 });
 it('requires real R2 storage for any enabled format',()=>{
  expect(()=>validateEnvironment({...base,ATTACHMENTS_ENABLED:'true',ATTACHMENTS_TEXT_ENABLED:'true'})).toThrow('Attachment formats require R2 storage');
 });
});
