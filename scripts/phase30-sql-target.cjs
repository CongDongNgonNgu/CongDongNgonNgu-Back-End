// Pure TEST connection guard; no credential loading, network, or database calls.
function validatedTestTarget(raw){
 const original=new URL(raw),local=['localhost','127.0.0.1','[::1]'].includes(original.hostname);
 const remote=original.hostname==='ep-crimson-grass-azmsfir8-pooler.c-3.ap-southeast-1.aws.neon.tech';
 if((!local&&!remote)||original.pathname!==(local?'/congdongngonngu_phase22_ci':'/neondb')||original.searchParams.has('options'))throw Error('EXACT_APPROVED_TEST_TARGET_REQUIRED');
 if(!['postgres:','postgresql:'].includes(original.protocol)||!['','5432'].includes(original.port)||original.hash)throw Error('UNAPPROVED_TEST_TRANSPORT');
 const keys=[...original.searchParams.keys()];if(new Set(keys).size!==keys.length)throw Error('DUPLICATE_TEST_CONNECTION_OPTION');
 for(const name of keys)if(!['sslmode','channel_binding'].includes(name))throw Error('UNAPPROVED_TEST_CONNECTION_OPTION');
 if(remote&&!['require','verify-ca','verify-full'].includes(original.searchParams.get('sslmode')))throw Error('TEST_TLS_REQUIRED');
 if(original.searchParams.has('channel_binding')&&!['prefer','require'].includes(original.searchParams.get('channel_binding')))throw Error('UNAPPROVED_CHANNEL_BINDING');
 const direct=new URL(original);if(remote)direct.hostname='ep-crimson-grass-azmsfir8.c-3.ap-southeast-1.aws.neon.tech';
 return {original,direct,local};
}
module.exports={validatedTestTarget};
