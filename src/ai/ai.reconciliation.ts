import type { AiUsageRecord } from './ai.types';

export const AI_USAGE_RECONCILIATION_CONTRACT_VERSION = 'ai.usage.reconciliation.v1' as const;
export const AI_USAGE_RECONCILIATION_MAX_RECORDS = 1_000;

export type AiUsageReconciliationStatus = 'PASS' | 'MISMATCH';
export type AiUsageReconciliationIssueCode =
  | 'RECONCILIATION_POLICY_INVALID'
  | 'RECORD_LIMIT_EXCEEDED'
  | 'RECORD_INVALID'
  | 'DUPLICATE_REQUEST_ID'
  | 'ATTEMPTS_INVALID'
  | 'TOKEN_COUNT_INVALID'
  | 'TOKEN_TOTAL_MISMATCH'
  | 'NON_SUCCESS_USAGE'
  | 'COST_INVALID'
  | 'NON_SUCCESS_COST'
  | 'OCCURRED_AT_INVALID'
  | 'ERROR_CODE_MISSING'
  | 'ERROR_CODE_ON_SUCCESS';

export interface AiUsageReconciliationIssue {
  recordIndex: number | null;
  code: AiUsageReconciliationIssueCode;
}

export interface AiUsageReconciliationReport {
  version: typeof AI_USAGE_RECONCILIATION_CONTRACT_VERSION;
  status: AiUsageReconciliationStatus;
  recordsChecked: number;
  issues: readonly AiUsageReconciliationIssue[];
  issuesTruncated: boolean;
  repairStatus: 'NOT_APPLIED';
  mutationApplied: false;
}

const MAX_REPORTED_ISSUES = 100;
const USAGE_STATUSES = ['SUCCEEDED', 'FAILED', 'REJECTED'] as const;

export function reconcileAiUsageRecords(
  records: readonly AiUsageRecord[],
  options: { maxRecords?: number } = {},
): AiUsageReconciliationReport {
  const maxRecords = options.maxRecords ?? AI_USAGE_RECONCILIATION_MAX_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > AI_USAGE_RECONCILIATION_MAX_RECORDS) {
    return report(0, [{ recordIndex: null, code: 'RECONCILIATION_POLICY_INVALID' }], false);
  }
  if (!Array.isArray(records) || records.length > maxRecords) {
    return report(0, [{ recordIndex: null, code: 'RECORD_LIMIT_EXCEEDED' }], false);
  }

  const issues: AiUsageReconciliationIssue[] = [];
  let issuesTruncated = false;
  const requestIds = new Set<string>();
  const addIssue = (recordIndex: number, code: AiUsageReconciliationIssueCode): void => {
    if (issues.length < MAX_REPORTED_ISSUES) {
      issues.push({ recordIndex, code });
    } else {
      issuesTruncated = true;
    }
  };

  records.forEach((record, recordIndex) => {
    if (!isRecord(record)) {
      addIssue(recordIndex, 'RECORD_INVALID');
      return;
    }

    const value = record as unknown as Partial<AiUsageRecord>;
    const requestId = value.requestId;
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      addIssue(recordIndex, 'RECORD_INVALID');
    } else if (requestIds.has(requestId)) {
      addIssue(recordIndex, 'DUPLICATE_REQUEST_ID');
    } else {
      requestIds.add(requestId);
    }

    if (
      typeof value.userId !== 'string' || value.userId.trim() === '' ||
      typeof value.feature !== 'string' || value.feature.trim() === '' ||
      typeof value.providerId !== 'string' || value.providerId.trim() === '' ||
      typeof value.modelId !== 'string' || value.modelId.trim() === '' ||
      !USAGE_STATUSES.includes(value.status as typeof USAGE_STATUSES[number])
    ) {
      addIssue(recordIndex, 'RECORD_INVALID');
    }

    const status = value.status;
    const attempts = value.attempts;
    const attemptsValid = isSafeNonNegativeInteger(attempts)
      && (status === 'REJECTED' ? attempts === 0 : attempts >= 1);
    if (!attemptsValid) addIssue(recordIndex, 'ATTEMPTS_INVALID');

    const tokenValues = [value.inputTokens, value.outputTokens, value.totalTokens];
    if (tokenValues.some((tokenValue) => !isSafeNonNegativeInteger(tokenValue))) {
      addIssue(recordIndex, 'TOKEN_COUNT_INVALID');
    } else if (value.totalTokens !== value.inputTokens! + value.outputTokens!) {
      addIssue(recordIndex, 'TOKEN_TOTAL_MISMATCH');
    }

    if (status === 'FAILED' || status === 'REJECTED') {
      if (value.inputTokens !== 0 || value.outputTokens !== 0 || value.totalTokens !== 0) {
        addIssue(recordIndex, 'NON_SUCCESS_USAGE');
      }
    }

    const estimatedCostUsd = value.estimatedCostUsd;
    if (
      estimatedCostUsd !== null &&
      (typeof estimatedCostUsd !== 'number' || !Number.isFinite(estimatedCostUsd)
        || estimatedCostUsd < 0 || estimatedCostUsd > Number.MAX_SAFE_INTEGER)
    ) {
      addIssue(recordIndex, 'COST_INVALID');
    }
    if ((status === 'FAILED' || status === 'REJECTED') && estimatedCostUsd !== null) {
      addIssue(recordIndex, 'NON_SUCCESS_COST');
    }

    if (!(value.occurredAt instanceof Date) || !Number.isFinite(value.occurredAt.getTime())) {
      addIssue(recordIndex, 'OCCURRED_AT_INVALID');
    }

    if (status === 'SUCCEEDED' && value.errorCode !== undefined) {
      addIssue(recordIndex, 'ERROR_CODE_ON_SUCCESS');
    }
    if ((status === 'FAILED' || status === 'REJECTED')
      && (typeof value.errorCode !== 'string' || value.errorCode.trim() === '')) {
      addIssue(recordIndex, 'ERROR_CODE_MISSING');
    }
  });

  return report(records.length, issues, issuesTruncated);
}

function report(
  recordsChecked: number,
  issues: readonly AiUsageReconciliationIssue[],
  issuesTruncated: boolean,
): AiUsageReconciliationReport {
  return {
    version: AI_USAGE_RECONCILIATION_CONTRACT_VERSION,
    status: issues.length > 0 || issuesTruncated ? 'MISMATCH' : 'PASS',
    recordsChecked,
    issues,
    issuesTruncated,
    repairStatus: 'NOT_APPLIED',
    mutationApplied: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
