import { describe, expect, it, jest } from '@jest/globals';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { ChallengeController } from './challenge.controller';
import type { ChallengeService } from './challenge.service';
import type { SessionService } from '../auth/session/session.service';

const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '22222222-2222-4222-8222-222222222222';

describe('ChallengeController', () => {
  it('keeps public discovery and detail delegated to the public service contract', async () => {
    const service = {
      listPublicChallenges: jest.fn(async () => [{ id: CHALLENGE_ID, state: 'ACTIVE' }]),
      getPublicChallenge: jest.fn(async () => ({ id: CHALLENGE_ID, state: 'EXPIRED' })),
    } as unknown as ChallengeService;
    const controller = new ChallengeController(service, {} as SessionService);

    await expect(controller.list({ state: 'ALL', limit: 10 })).resolves.toMatchObject({
      success: true,
      data: [{ id: CHALLENGE_ID, state: 'ACTIVE' }],
    });
    await expect(controller.detail(CHALLENGE_ID)).resolves.toMatchObject({
      success: true,
      data: { id: CHALLENGE_ID, state: 'EXPIRED' },
    });
    expect(service.listPublicChallenges).toHaveBeenCalledWith({ state: 'ALL', limit: 10 });
    expect(service.getPublicChallenge).toHaveBeenCalledWith(CHALLENGE_ID);
  });

  it('requires CSRF validation for join and returns only public participation fields', async () => {
    const service = {
      joinChallenge: jest.fn(async () => ({
        replayed: true,
        record: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          challengeId: CHALLENGE_ID,
          userId: USER_ID,
          status: 'JOINED',
          joinedAt: new Date('2026-10-01T00:00:00.000Z'),
          leftAt: null,
          completedAt: null,
          progressValue: 0,
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      })),
    } as unknown as ChallengeService;
    const sessions = { assertCsrfForCookie: jest.fn() } as unknown as SessionService;
    const controller = new ChallengeController(service, sessions);
    const request = {
      user: { user: { id: USER_ID } },
    } as AuthenticatedRequest;

    const response = await controller.join(CHALLENGE_ID, request);

    expect(response).toMatchObject({
      success: true,
      data: { replayed: true, participation: { status: 'JOINED', progressValue: 0 } },
    });
    expect(response.data.participation).not.toHaveProperty('userId');
    expect(sessions.assertCsrfForCookie).toHaveBeenCalledWith(request);
    expect(service.joinChallenge).toHaveBeenCalledWith(CHALLENGE_ID, USER_ID);
  });
});
