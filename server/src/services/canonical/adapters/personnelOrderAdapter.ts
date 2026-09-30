import { CanonicalServiceFact, CanonicalServiceStatus, ServiceFactType } from '../types';
import { generateCanonicalFactIdentity } from '../identity';

export interface PersonnelStatusRecord {
  id: number;
  user_id: number;
  status_type: string;
  document_reference_no?: string | null;
  effective_from: string;
  effective_to: string;
  status: string;
  reason_code: string;
}

/**
 * 人事身分種別から CanonicalServiceStatus への決定論的マッピング
 */
export function mapPersonnelStatusTypeToCanonicalStatus(statusType: string): CanonicalServiceStatus {
  switch (statusType) {
    case 'CHILDCARE_LEAVE':
      return 'CHILDCARE_LEAVE';
    case 'SUSPENSION':
    case 'ADMINISTRATIVE_LEAVE':
    case 'ADMINISTRATIVE_LEAVE_SUSPENSION':
      return 'ADMINISTRATIVE_LEAVE_SUSPENSION';
    case 'DISCIPLINARY_SUSPENSION':
      return 'DISCIPLINARY_SUSPENSION';
    case 'UNION_FULL_TIME_RELEASE':
    case 'UNION_FULL_TIME':
    case 'UNION_FULL_TIME_SUSPENSION':
      return 'UNION_FULL_TIME_SUSPENSION';
    case 'SELF_DEVELOPMENT_LEAVE':
      return 'SELF_DEVELOPMENT_LEAVE';
    case 'SPOUSAL_ACCOMPANIMENT_LEAVE':
      return 'SPOUSAL_ACCOMPANIMENT_LEAVE';
    case 'DISPATCH':
    case 'FOREIGN_DISPATCH':
    case 'DOMESTIC_DISPATCH':
      return 'DISPATCH';
    default:
      return 'ADMINISTRATIVE_LEAVE_SUSPENSION';
  }
}

/**
 * 指定評価日の PersonnelStatus を Fact へ正規化
 */
export function normalizePersonnelStatusToFact(
  record: PersonnelStatusRecord,
  targetDate: string
): CanonicalServiceFact | null {
  // 有効状態 ('CONFIRMED', 'EFFECTIVE') かつ 評価日が期間内であること
  if (!['CONFIRMED', 'EFFECTIVE'].includes(record.status)) {
    return null;
  }
  if (targetDate < record.effective_from || targetDate > record.effective_to) {
    return null;
  }

  const canonicalStatus = mapPersonnelStatusTypeToCanonicalStatus(record.status_type);
  const isRestricted = ['SUSPENSION', 'DISCIPLINARY_SUSPENSION', 'ADMINISTRATIVE_LEAVE'].includes(record.status_type);

  const factId = generateCanonicalFactIdentity({
    sourceType: 'PERSONNEL_ORDER',
    sourceTable: 'personnel_statuses',
    sourceId: record.id,
    sourceVersion: null, // 身分レコードは単一世代
    workflowCycleId: null,
    targetDate,
    startTime: null,
    endTime: null,
    canonicalStatus
  });

  return {
    factId,
    userId: record.user_id,
    canonicalStatus,
    factType: 'PERIOD_STATUS',
    sourceType: 'PERSONNEL_ORDER',
    sourceTable: 'personnel_statuses',
    sourceId: record.id,
    targetDate,
    effectiveFrom: record.effective_from,
    effectiveTo: record.effective_to,
    isRestricted,
    legalBasisReference: record.document_reference_no || undefined,
    details: {
      statusType: record.status_type,
      reasonCode: record.reason_code,
      documentRefNo: record.document_reference_no
    }
  };
}
