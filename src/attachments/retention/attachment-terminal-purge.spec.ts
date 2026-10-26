import type {Pool} from 'pg';
import {AttachmentTerminalPurge} from './attachment-terminal-purge';
describe('terminal purge transaction admission',()=>{
 it.each([-1,0,21,1.5,NaN,Infinity])('rejects invalid budget %s before SQL',async budget=>{const connect=jest.fn();await expect(new AttachmentTerminalPurge({connect} as unknown as Pool).purgeOne('00000000-0000-4000-8000-000000000001',budget)).rejects.toThrow('ATTACHMENT_TERMINAL_PURGE_INVALID');expect(connect).not.toHaveBeenCalled();});
 it('rejects an arbitrary candidate id before SQL',async()=>{const connect=jest.fn();await expect(new AttachmentTerminalPurge({connect} as unknown as Pool).purgeOne('other',20)).rejects.toThrow('ATTACHMENT_TERMINAL_PURGE_INVALID');expect(connect).not.toHaveBeenCalled();});
});
