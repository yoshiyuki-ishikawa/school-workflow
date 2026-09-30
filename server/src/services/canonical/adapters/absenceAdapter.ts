import { CanonicalServiceFact, ServiceFactType } from '../types';
import { generateCanonicalFactIdentity } from '../identity';

export interface AbsenceRecord {
  id: number;
  user_id: number;
  absence_type: 'FULL_DAY' | 'HOURLY';
  target_date: string;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes: number;
  reason: string;
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED' | 'CORRECTED';
}

/**
 * Absence Pure Normalizer
 */
export function normalizeAbsenceToFact(
  record: AbsenceRecord,
  targetDate: string
): CanonicalServiceFact | null {
  if (record.status !== 'CONFIRMED' || record.target_date !== targetDate) {
    return null;
  }

  const isHourly = record.absence_type === 'HOURLY';
  const factType: ServiceFactType = isHourly ? 'TIME_EVENT' : 'DAY_EVENT';

  const factId = generateCanonicalFactIdentity({
    sourceType: 'ADMIN_REGISTRATION',
    sourceTable: 'absences',
    sourceId: record.id,
    sourceVersion: null,
    workflowCycleId: null,
    targetDate,
    startTime: isHourly ? record.start_time : null,
    endTime: isHourly ? record.end_time : null,
    canonicalStatus: 'ABSENCE'
  });

  return {
    factId,
    userId: record.user_id,
    canonicalStatus: 'ABSENCE',
    factType,
    sourceType: 'ADMIN_REGISTRATION',
    sourceTable: 'absences',
    sourceId: record.id,
    targetDate,
    startTime: isHourly ? (record.start_time || undefined) : undefined,
    endTime: isHourly ? (record.end_time || undefined) : undefined,
    quantityUnits: isHourly ? record.duration_minutes : 1,
    isRestricted: true, // 欠勤理由はセンシティブ
    details: {
      absenceType: record.absence_type,
      durationMinutes: record.duration_minutes,
      reason: record.reason
    }
  };
}
