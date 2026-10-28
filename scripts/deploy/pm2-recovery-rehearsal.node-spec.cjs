'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {diagnosticTokens}=require('./pm2-recovery-rehearsal.cjs');
test('private launch failures produce fixed diagnostic tokens without disclosing unknown module or CLI text',()=>{
 const secret='NEVER_PRINT_THIS_PRIVATE_SENTINEL';
 const known=diagnosticTokens("Cannot find module '@nestjs/core' "+secret);assert.deepEqual(known,['MODULE_NOT_FOUND','MISSING_NEST_CORE']);
 const unknown=diagnosticTokens("Cannot find module '"+secret+"' unknown option '--"+secret+"'");assert.deepEqual(unknown,['CLI_UNKNOWN_OPTION','MODULE_NOT_FOUND']);assert.equal(JSON.stringify(unknown).includes(secret),false);
});
test('configuration and startup errors retain only enum classifications',()=>{
 const secret='NEVER_PRINT_THIS_PRIVATE_SENTINEL';
 const tokens=diagnosticTokens('DATABASE_URL=postgresql://'+secret+' EADDRINUSE SyntaxError');assert.deepEqual(tokens,['CONFIG_VALIDATION_HINT','EADDRINUSE','SYNTAX_ERROR']);assert.equal(JSON.stringify(tokens).includes(secret),false);assert.deepEqual(diagnosticTokens(secret),[]);
});
