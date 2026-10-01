import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryMediaProvider } from './media-provider';
import { InMemorySpeakingRoomParticipantRepository } from './room.participant.repository';
import { InMemorySpeakingRoomRepository } from './room.repository';
import { InMemorySpeakingRoomInteractionRepository } from './room.interaction.repository';
import { SpeakingRoomService } from './room.service';

describe('SpeakingRoomService', () => {
  async function setup() {
    const identities = new InMemoryIdentityRepository();
    const host = await identities.createUser({
      email: 'host@example.test',
      displayName: 'Host',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const other = await identities.createUser({
      email: 'other@example.test',
      displayName: 'Other',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const repository = new InMemorySpeakingRoomRepository();
    const participants = new InMemorySpeakingRoomParticipantRepository();
    const profiles = new InMemoryProfileRepository();
    const interactions = new InMemorySpeakingRoomInteractionRepository(participants);
    const service = new SpeakingRoomService(
      repository,
      profiles,
      identities,
      new InMemoryMediaProvider(),
      participants,
      interactions,
    );
    return { service, repository, participants, interactions, profiles, identities, host, other };
  }

  it('creates public rooms with a bounded projection and no access secret', async () => {
    const { service, host } = await setup();
    const result = await service.createRoom(host.id, {
      languageCode: 'en',
      topic: 'Daily conversation',
      visibility: 'PUBLIC',
      capacity: 20,
    });

    expect(result.privateAccessToken).toBeNull();
    expect(result.room.visibility).toBe('PUBLIC');
    expect(result.room.topic).toBe('Daily conversation');
    expect(result.room).not.toHaveProperty('accessTokenHash');
  });

  it('only exposes private rooms to the owner or the non-guessable access token', async () => {
    const { service, host, other } = await setup();
    const created = await service.createRoom(host.id, {
      languageCode: 'en',
      topic: 'Private practice',
      visibility: 'PRIVATE',
    });
    expect(created.privateAccessToken).toMatch(/^room_/);

    await expect(service.getRoom(created.room.id, other.id)).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
      status: 404,
    });
    await expect(service.getRoom(created.room.id, other.id, 'room_guess')).rejects.toMatchObject({
      code: 'ROOM_NOT_FOUND',
      status: 404,
    });
    await expect(service.getRoom(created.room.id, other.id, created.privateAccessToken!)).resolves.toMatchObject({
      id: created.room.id,
      visibility: 'PRIVATE',
    });
  });

  it('derives media role from server-side ownership and replays the same request idempotently', async () => {
    const { service, repository, participants, profiles, identities, host } = await setup();
    const created = await service.createRoom(host.id, {
      languageCode: 'en',
      topic: 'Host practice',
    });
    await service.joinRoom(created.room.id, host.id, {
      requestId: 'c2d8a0f4-3de4-4b2c-9a5c-9dd9e5c3e3a0',
      deviceId: 'host-browser',
    });

    const first = await service.issueMediaSession(created.room.id, host.id, {
      requestId: 'd7e52a8f-9a7f-4a35-9bb4-7a50be79d69d',
    });
    const replay = await service.issueMediaSession(created.room.id, host.id, {
      requestId: 'd7e52a8f-9a7f-4a35-9bb4-7a50be79d69d',
    });

    expect(first.role).toBe('HOST');
    expect(replay).toEqual(first);
  });

  it('fails safely when the configured media provider is disabled', async () => {
    const { service, repository, participants, profiles, identities, host } = await setup();
    const created = await service.createRoom(host.id, {
      languageCode: 'en',
      topic: 'Disabled adapter',
    });
    await service.joinRoom(created.room.id, host.id, {
      requestId: 'b4de7bbf-7ea8-48c0-8fa8-5fc76c12cdb6',
      deviceId: 'host-browser',
    });
    const disabled = new (await import('./media-provider')).DisabledMediaProvider();
    const interactions = new InMemorySpeakingRoomInteractionRepository(participants);
    const disabledService = new SpeakingRoomService(repository, profiles, identities, disabled, participants, interactions);

    await expect(disabledService.issueMediaSession(created.room.id, host.id, {
      requestId: '7a14f2b7-4dcb-4e78-930c-6fa6b8cf3f95',
    })).rejects.toMatchObject({ code: 'ROOM_MEDIA_UNAVAILABLE', status: 503 });
  });
});
