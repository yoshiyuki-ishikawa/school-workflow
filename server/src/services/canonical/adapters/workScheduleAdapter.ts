import { CanonicalServiceFact, CanonicalServiceStatus, ServiceFactType } from '../types';
import { generateCanonicalFactIdentity } from '../identity';

export interface UserWorkPatternRecord {
  id: number;
  user_id: number;
  pattern_name: string;
  pattern_type: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
  effective_from: string;
  effective_to: string;
  weekly_off_days: string; // '0,6' 等
  schedule_details_json?: string | null;
  weekly_total_minutes: number;
}

/**
 * Work Schedule Pure Normalizer
 */
export function normalizeWorkScheduleToFact(
  record: UserWorkPatternRecord,
  targetDate: string
): CanonicalServiceFact | null {
  if (targetDate < record.effective_from || targetDate > record.effective_to) {
    return null;
  }

  const dt = new Date(targetDate);
  const dayOfWeek = dt.getDay();
  const offDays = record.weekly_off_days.split(',').map(s => parseInt(s.trim(), 10));
  const isWeeklyOff = offDays.includes(dayOfWeek);

  let canonicalStatus: CanonicalServiceStatus = 'WEEKLY_OFF';
  let factType: ServiceFactType = 'CALENDAR_STATUS';

  if (!isWeeklyOff) {
    if (record.pattern_type === 'SHORT_TIME') {
      canonicalStatus = 'CHILDCARE_SHORT_TIME';
      factType = 'WORK_PATTERN';
    } else {
      return null; // 通常勤務日は個別の除外Factではなく、所定勤務として基底評価される
    }
  }

  const factId = generateCanonicalFactIdentity({
    sourceType: 'WORK_SCHEDULE',
    sourceTable: 'user_work_patterns',
    sourceId: record.id,
    sourceVersion: null,
    workflowCycleId: null,
    targetDate,
    startTime: null,
    endTime: null,
    canonicalStatus
  });

  let scheduledWorkMinutes = 0;
  if (!isWeeklyOff) {
    if (record.schedule_details_json) {
      try {
        const parsed = JSON.parse(record.schedule_details_json);
        if (parsed && parsed[dayOfWeek] && typeof parsed[dayOfWeek].workMinutes === 'number') {
          scheduledWorkMinutes = parsed[dayOfWeek].workMinutes;
        }
      } catch {}
    }
    if (scheduledWorkMinutes === 0 && record.pattern_type === 'STANDARD_FULLTIME') {
      scheduledWorkMinutes = 465;
    }
  }

  return {
    factId,
    userId: record.user_id,
    canonicalStatus,
    factType,
    sourceType: 'WORK_SCHEDULE',
    sourceTable: 'user_work_patterns',
    sourceId: record.id,
    targetDate,
    effectiveFrom: record.effective_from,
    effectiveTo: record.effective_to,
    isRestricted: false,
    details: {
      patternId: record.id,
      patternName: record.pattern_name,
      patternType: record.pattern_type,
      isWeeklyOff,
      scheduledWorkMinutes,
      weeklyTotalMinutes: record.weekly_total_minutes
    }
  };
}
