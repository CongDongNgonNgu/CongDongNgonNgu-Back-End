import type {PoolClient} from 'pg';
import {AttachmentLifecycleLedger} from './attachment-lifecycle-ledger';
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
describe('opaque owner deletion failures',()=>{
 it.each(['missing','foreign','malformed'] as const)('normalizes %s attachment identifiers before granting owner deletion',async scenario=>{
  const query=jest.fn(async(sql:string)=>({rows:scenario==='foreign'&&sql.startsWith('SELECT * FROM attachments')?[{uploader_id:'33333333-3333-4333-8333-333333333333'}]:[],rowCount:0}));
  await expect(new AttachmentLifecycleLedger().deleteOwned({query} as unknown as PoolClient,actor,scenario==='malformed'?'invalid':id)).rejects.toMatchObject({code:'ATTACHMENT_UNAVAILABLE',status:404});
 });
});
