import { getDb } from '../db/database';
import { CanonicalCancellationDeclineAction } from './types';

/**
 * resolveCancellationDeclineSemantic:
 * Server Authoritative Facts から DECLINE_CANCELLATION を決定論的に解決する。
 */
export function resolveCancellationDeclineSemantic(params: {
  cyclePurpose: string;
  stepActionType: string;
  isFinalDecisionStep: boolean;
  engineAction: string;
}): CanonicalCancellationDeclineAction | null {
  if (
    params.cyclePurpose === 'CANCELLATION' &&
    params.stepActionType === 'DECIDE' &&
    params.isFinalDecisionStep &&
    params.engineAction === 'REJECT'
  ) {
    return 'DECLINE_CANCELLATION';
  }
  return null;
}

export interface HistoricalResolutionResult {
  businessSemantic: CanonicalCancellationDeclineAction | null;
  resolutionLevel: 'STRONG_EVIDENCE' | 'FALLBACK_CONTRACT' | 'UNSUPPORTED';
  reason: string;
}

/**
 * resolveHistoricalCancellationSemantic:
 * 過去データから DECLINE_CANCELLATION を決定論的に復元する (REVISION-01 / P1-02)。
 */
export function resolveHistoricalCancellationSemantic(params: {
  applicationId: number;
  approvalCycle: number;
}): HistoricalResolutionResult {
  const db = getDb();
  const cycle = db.prepare(`
    SELECT * FROM application_workflow_cycles
    WHERE application_id = ? AND approval_cycle = ?
  `).get(params.applicationId, params.approvalCycle) as any;

  if (!cycle || cycle.cycle_purpose !== 'CANCELLATION' || cycle.status !== 'REJECTED') {
    return {
      businessSemantic: null,
      resolutionLevel: 'UNSUPPORTED',
      reason: 'Not a rejected cancellation cycle',
    };
  }

  // LEVEL 1: Strong Evidence Check (Audit Log Correlation: P1-02)
  const auditLog = db.prepare(`
    SELECT * FROM audit_logs
    WHERE entity_type = 'APPLICATION' AND entity_id = ? AND action = 'CANCEL_REJECT'
    ORDER BY id DESC
    LIMIT 1
  `).get(String(params.applicationId)) as any;

  if (auditLog && auditLog.metadata) {
    try {
      const meta = JSON.parse(auditLog.metadata);
      if (meta.approvalCycle === params.approvalCycle) {
        return {
          businessSemantic: 'DECLINE_CANCELLATION',
          resolutionLevel: 'STRONG_EVIDENCE',
          reason: 'Correlated CANCEL_REJECT audit log with matching approvalCycle',
        };
      }
    } catch {
      // JSON parse failure fallback to LEVEL 2
    }
  }

  // LEVEL 2: Fallback Historical Contract
  const app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(params.applicationId) as any;
  if (app && ['FINAL_APPROVED', 'TRIP_APPROVED'].includes(app.current_status)) {
    return {
      businessSemantic: 'DECLINE_CANCELLATION',
      resolutionLevel: 'FALLBACK_CONTRACT',
      reason: 'Historical contract: CANCELLATION + REJECTED with maintained active application status',
    };
  }

  return {
    businessSemantic: null,
    resolutionLevel: 'UNSUPPORTED',
    reason: 'Application status was not maintained or ambiguous',
  };
}
