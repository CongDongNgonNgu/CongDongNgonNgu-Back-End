import { createHash } from 'node:crypto';

const fixture = require('./sei-fixture.json') as {base64:string;sha256:string;prefixedSha256:string};
const hash = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Test-only transform for one exact synthetic sample; never accepts user media. */
export function prefixSyntheticSei(source:Buffer):Buffer {
 if(!Buffer.isBuffer(source)||source.length!==1109||hash(source)!==fixture.sha256)throw Error('OWNED_SEI_FIXTURE_REQUIRED');
 if(source.readUInt32BE(958)!==69||(source[962]&31)!==5||source.readUInt32BE(1031)!==47||(source[1035]&31)!==6||source.readUInt32BE(1082)!==23||(source[1086]&31)!==1)throw Error('SEI_FIXTURE_LAYOUT');
 const result=Buffer.concat([source.subarray(0,958),source.subarray(1031,1082),source.subarray(958,1031),source.subarray(1082)]);
 if(hash(result)!==fixture.prefixedSha256)throw Error('SEI_FIXTURE_OUTPUT');
 return result;
}

export function loadSyntheticNativeSource():Buffer {
 return prefixSyntheticSei(Buffer.from(fixture.base64,'base64'));
}
