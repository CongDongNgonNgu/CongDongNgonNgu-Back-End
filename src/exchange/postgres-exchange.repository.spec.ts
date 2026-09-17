import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';
import { PostgresExchangePreferenceRepository } from './postgres-exchange.repository';

describe('PostgresExchangePreferenceRepository', () => {
  it('maps normalized preference selections into one exchange record', async () => {
    const repository = new PostgresExchangePreferenceRepository(fakePool([
      { rows: [{
        user_id: 'user-1',
        exchange_opt_in: true,
        discoverable: true,
        timezone_visibility: 'SUMMARY',
        availability_visibility: 'HIDDEN',
        contact_permission: 'RELATIONSHIP_GATED',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
      }] },
      { rows: [
        { direction: 'OFFER', code: 'vi' },
        { direction: 'WANT', code: 'en' },
      ] },
      { rows: [{ level: 'B1' }, { level: 'A2' }] },
      { rows: [{ goal_code: 'conversation' }] },
      { rows: [{ interest_code: 'music' }] },
    ]));

    await expect(repository.findPreferences('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
      preferredPartnerLevels: ['B1', 'A2'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
      timezoneVisibility: 'SUMMARY',
      availabilityVisibility: 'HIDDEN',
      contactPermission: 'RELATIONSHIP_GATED',
    });
  });

  it('returns conservative defaults when a user has no preference row', async () => {
    const repository = new PostgresExchangePreferenceRepository(fakePool([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]));

    await expect(repository.findPreferences('new-user')).resolves.toMatchObject({
      userId: 'new-user',
      exchangeOptIn: false,
      discoverable: false,
      timezoneVisibility: 'HIDDEN',
      availabilityVisibility: 'HIDDEN',
      contactPermission: 'NO_CONTACT',
      offeredLanguageCodes: [],
      wantedLanguageCodes: [],
    });
  });
});

function fakePool(results: Array<{ rows: Array<Record<string, unknown>> }>): Pool {
  return {
    query: async () => results.shift() ?? { rows: [] },
  } as unknown as Pool;
}
