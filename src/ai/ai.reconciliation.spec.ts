import { describe, expect, it } from '@jest/globals';
import type { AiUsageRecord } from './ai.types';
import {
  reconcileAiUsageRecords,
  type AiUsageReconciliationReport,
} from './ai.reconciliation';

function record(overrides: Partial<AiUsageRecord> = {}): AiUsageRecord {
  return {
    requestId: 'request-09f-001',
    userId: 'user-09f-001',
    feature: 'ai.conversation',
    providerId: 'deterministic-test-provider',
    modelId: 'deterministic-test-model',
    attempts: 1,
    status: 'SUCCEEDED',
    inputTokens: 12,
    outputTokens: 6,
    totalTokens: 18,
    estimatedCostUsd: 0.000024,
    occurredAt: new Date('2026-09-30T00:00:00.000Z'),
    ...overrides,
  };
}

function issueCodes(report: AiUsageReconciliationReport): string[] {
  return report.issues.map((issue) => issue.code);
}

describe('reconcileAiUsageRecords', () => {
  it('passes a valid immutable usage ledger and does not apply repairs', () => {
    const records = [record()];
    const before = structuredClone(records);

    const report = reconcileAiUsageRecords(records);

    expect(report).toMatchObject({
      version: 'ai.usage.reconciliation.v1',
      status: 'PASS',
      recordsChecked: 1,
      repairStatus: 'NOT_APPLIED',
      mutationApplied: false,
    });
    expect(report.issues).toEqual([]);
    expect(records).toEqual(before);
  });

  it('detects duplicate request charges, invalid totals and invalid costs', () => {
    const report = reconcileAiUsageRecords([
      record(),
      record({
        inputTokens: 20,
        totalTokens: 21,
        estimatedCostUsd: Number.NaN,
      }),
    ]);

    expect(report.status).toBe('MISMATCH');
    expect(issueCodes(report)).toEqual(expect.arrayContaining([
      'DUPLICATE_REQUEST_ID',
      'TOKEN_TOTAL_MISMATCH',
      'COST_INVALID',
    ]));
  });

  it('rejects non-zero usage on a failed or rejected record', () => {
    const report = reconcileAiUsageRecords([
      record({
        status: 'FAILED',
        errorCode: 'AI_PROVIDER_TIMEOUT',
        inputTokens: 1,
        totalTokens: 1,
        estimatedCostUsd: 0.000001,
      }),
      record({
        requestId: 'request-09f-002',
        status: 'REJECTED',
        attempts: 0,
        errorCode: 'AI_QUOTA_EXCEEDED',
        inputTokens: 1,
        totalTokens: 1,
        estimatedCostUsd: 0.000001,
      }),
    ]);

    expect(report.status).toBe('MISMATCH');
    expect(issueCodes(report)).toEqual(expect.arrayContaining([
      'NON_SUCCESS_USAGE',
      'NON_SUCCESS_COST',
    ]));
  });

  it('bounds reconciliation and reports that no repair was attempted', () => {
    const report = reconcileAiUsageRecords(
      Array.from({ length: 3 }, (_, index) => record({ requestId: `request-${index}` })),
      { maxRecords: 2 },
    );

    expect(report).toMatchObject({
      status: 'MISMATCH',
      recordsChecked: 0,
      repairStatus: 'NOT_APPLIED',
      mutationApplied: false,
    });
    expect(issueCodes(report)).toEqual(['RECORD_LIMIT_EXCEEDED']);
  });
});
