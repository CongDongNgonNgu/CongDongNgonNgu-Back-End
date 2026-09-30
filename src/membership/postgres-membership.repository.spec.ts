import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';
import { PostgresMembershipRepository } from './membership.repository';

describe('PostgresMembershipRepository', () => {
  it('maps versioned plan and entitlement facts without exposing payment fields', async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('membership_plan_versions')) {
          return {
            rows: [{
              id: '33333333-3333-4333-8333-333333333333',
              product_code: 'COMMUNITY_MEMBER',
              version: 1,
              status: 'ACTIVE',
              display_name: 'Community Member',
              description: 'Member plan',
              created_at: '2026-09-01T00:00:00.000Z',
              activated_at: '2026-09-01T00:00:00.000Z',
              retired_at: null,
            }],
          };
        }
        return {
          rows: [{
            id: '55555555-5555-4555-8555-555555555555',
            product_version_id: '33333333-3333-4333-8333-333333333333',
            feature_key: 'practice.advanced',
            limit_value: 20,
            limit_unit: 'per_month',
            parameters: { mode: 'guided' },
          }],
        };
      },
    } as unknown as Pool;
    const repository = new PostgresMembershipRepository(pool);

    const plan = await repository.findPlanVersionById('33333333-3333-4333-8333-333333333333');
    const entitlements = await repository.listEntitlements(plan!.id);

    expect(plan).toMatchObject({ productCode: 'COMMUNITY_MEMBER', version: 1, status: 'ACTIVE' });
    expect(entitlements).toEqual([expect.objectContaining({
      featureKey: 'practice.advanced',
      limit: 20,
      limitUnit: 'per_month',
      parameters: { mode: 'guided' },
    })]);
    expect(calls.join('\n')).not.toMatch(/payment|payos|webhook|secret/iu);
  });

  it('fails closed for malformed identifiers without issuing a query', async () => {
    let queried = false;
    const pool = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    } as unknown as Pool;
    const repository = new PostgresMembershipRepository(pool);

    await expect(repository.findPlanVersionById('not-a-uuid')).resolves.toBeNull();
    await expect(repository.listEntitlements('not-a-uuid')).resolves.toEqual([]);
    expect(queried).toBe(false);
  });
});
