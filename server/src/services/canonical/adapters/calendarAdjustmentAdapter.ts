import { CanonicalServiceFact, CanonicalServiceStatus } from '../types';
import { generateCanonicalFactIdentity } from '../identity';

export interface CalendarAdjustmentRecord {
  id: number;
  adjustment_code: string;
  scope_type: 'ALL' | 'USER';
  user_id?: number | null;
  adjustment_type: 'WEEK_OFF_TRANSFER' | 'SUBSTITUTE_HOLIDAY' | 'SINGLE_WORKDAY_OVERRIDE' | 'DESIGNATED_NON_WORKDAY';
  reason_code: string;
  source_date: string;
  source_duty_status: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  target_date?: string | null;
  target_duty_status?: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | null;
  event_name: string;
  reason: string;
  status: 'ACTIVE' | 'CANCELLED';
}

/**
 * Calendar Adjustment Pure Normalizer
 */
export function normalizeCalendarAdjustmentToFact(
  record: CalendarAdjustmentRecord,
  userId: number,
  targetDate: string
): CanonicalServiceFact | null {
  if (record.status !== 'ACTIVE') {
    return null;
  }
  if (record.scope_type === 'USER' && record.user_id !== userId) {
    return null;
  }

  const isSource = record.source_date === targetDate;
  const isTarget = record.target_date === targetDate;

  if (!isSource && !isTarget) {
    return null;
  }

  const appliedDuty = isSource ? record.source_duty_status : record.target_duty_status;

  // 代休 (SUBSTITUTE_HOLIDAY) の場合
  let canonicalStatus: CanonicalServiceStatus = 'SUBSTITUTE_HOLIDAY';
  if (record.adjustment_type === 'WEEK_OFF_TRANSFER') {
    canonicalStatus = 'WEEKLY_OFF';
  } else if (record.adjustment_type === 'DESIGNATED_NON_WORKDAY') {
    canonicalStatus = 'HOLIDAY';
  }

  const factId = generateCanonicalFactIdentity({
    sourceType: 'WORK_SCHEDULE',
    sourceTable: 'calendar_adjustments',
    sourceId: record.id,
    sourceVersion: null,
    workflowCycleId: null,
    targetDate,
    startTime: null,
    endTime: null,
    canonicalStatus
  });

  return {
    factId,
    userId,
    canonicalStatus,
    factType: 'CALENDAR_STATUS',
    sourceType: 'WORK_SCHEDULE',
    sourceTable: 'calendar_adjustments',
    sourceId: record.id,
    targetDate,
    isRestricted: false,
    details: {
      adjustmentCode: record.adjustment_code,
      adjustmentType: record.adjustment_type,
      appliedDutyStatus: appliedDuty,
      eventName: record.event_name,
      reason: record.reason
    }
  };
}
