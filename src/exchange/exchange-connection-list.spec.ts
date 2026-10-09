import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { InMemoryExchangeConnectionRepository } from './exchange-connection.repository';

describe('connection management list', () => {
  it('lists only actor-owned incoming, outgoing and connected relationships', async () => {
    const repository = new InMemoryExchangeConnectionRepository();
    const [actor,incoming,outgoing,partner,unrelated] = Array.from({length:5},() => randomUUID());
    await repository.requestConnection(incoming,actor);
    await repository.requestConnection(actor,outgoing);
    await repository.requestConnection(actor,partner);
    await repository.acceptConnection(partner,actor);
    await repository.requestConnection(unrelated,partner);
    for (const [kind,target] of [['INCOMING',incoming],['OUTGOING',outgoing],['CONNECTED',partner]] as const) {
      const page = await repository.listRelationships(actor,{kind,limit:20});
      expect(page.items).toHaveLength(1);
      expect(page.items[0].targetUserId).toBe(target);
      expect(page.nextCursor).toBeNull();
    }
  });

  it('paginates deterministically and rejects a cursor copied from another actor or list', async () => {
    const repository = new InMemoryExchangeConnectionRepository();
    const actor = randomUUID();
    for (let i=0;i<3;i++) await repository.requestConnection(actor,randomUUID());
    const first = await repository.listRelationships(actor,{kind:'OUTGOING',limit:2});
    if (!first.nextCursor) throw new Error('Expected another page');
    expect(Buffer.from(first.nextCursor,'base64url').toString('utf8')).not.toContain(first.items[1].connectionId);
    const second = await repository.listRelationships(actor,{kind:'OUTGOING',limit:2,cursor:first.nextCursor});
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items,...second.items].map(item => item.connectionId)).size).toBe(3);
    await expect(repository.listRelationships(randomUUID(),{kind:'OUTGOING',limit:2,cursor:first.nextCursor}))
      .rejects.toMatchObject({code:'EXCHANGE_INVALID_CURSOR'});
    await expect(repository.listRelationships(actor,{kind:'CONNECTED',limit:2,cursor:first.nextCursor}))
      .rejects.toMatchObject({code:'EXCHANGE_INVALID_CURSOR'});
  });
});
