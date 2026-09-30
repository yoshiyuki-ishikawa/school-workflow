/**
 * 山口県勤務条例第13条「病気休暇（公務・通勤災害認定含む）」共通ドメイン型定義
 */

// コア取得単位（病気休暇の基本モデル）
export type SickLeaveDurationType = 'FULL_DAY' | 'TIME';

// 申請ステータス（ライフサイクル）
export type SickLeaveApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'RETURNED'
  | 'REJECTED'
  | 'APPROVED'
  | 'CANCELLED';

// 災害認定ステータス（外部機関認定結果）
export type DisasterRecognitionStatus =
  | 'NONE'
  | 'APPLICATION_PENDING'
  | 'PUBLIC_DUTY_RECOGNIZED'
  | 'COMMUTING_RECOGNIZED'
  | 'NOT_RECOGNIZED'
  | 'WITHDRAWN';

// 出勤簿再評価ステータス
export type AttendanceReevaluationStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

// 診断書・証明書確認ステータス
export type EvidenceRequirement = 'REQUIRED' | 'OPTIONAL' | 'NOT_REQUIRED';
export type EvidenceStatus = 'NOT_SUBMITTED' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

// 病気休暇申請インターフェース
export interface SickLeaveApplicationRecord {
  id: string;
  applicationId?: number;
  userId: number;
  targetDate: string; // YYYY-MM-DD
  durationType: SickLeaveDurationType;
  policySpecificDurationCode?: string; // 自治体Policyで拡張単位が定義されている場合のみ
  startAt?: string; // HH:mm (TIMEの場合)
  endAt?: string;   // HH:mm (TIMEの場合)
  calculatedMinutes: number; // Server-Authoritative算出正味分数
  
  legalBasisId: string; // 例: "YAMAGUCHI_WORK_ORDINANCE_ART13"
  appliedPolicyVersion: string;
  
  // 3軸の独立状態
  applicationStatus: SickLeaveApplicationStatus;
  disasterRecognitionStatus: DisasterRecognitionStatus;
  disasterRecognizedAt?: string;
  disasterRecognitionAuthority?: string;
  disasterRecognitionReference?: string;
  disasterRecognitionUpdatedAt?: string;
  reevaluationStatus: AttendanceReevaluationStatus;

  // 証明書メタデータ (医療情報実体は分離)
  evidenceRequirement: EvidenceRequirement;
  evidenceStatus: EvidenceStatus;

  version: number;
  createdAt: string;
  updatedAt: string;
}

// 医療証拠書類（物理分離）
export interface MedicalEvidenceRecord {
  id: string;
  sickLeaveId: string;
  fileStoragePath: string;
  mimeType: string;
  verifiedByUserId?: number;
  verifiedAt?: string;
  retentionLimitDate: string;
  createdAt: string;
}

// 出勤簿表示Policyインターフェース (Fail-Closed)
export interface AttendanceDisplayPolicy {
  policyId: string;
  policyVersion: string;
  effectiveFrom: string;
  effectiveTo: string;
  rules: {
    SICK_LEAVE?: {
      FULL_DAY?: {
        [key in DisasterRecognitionStatus]?: {
          displayText: string;
          code: string;
          symbol?: string;
        };
      };
      TIME?: {
        [key in DisasterRecognitionStatus]?: {
          template: string;
          unit: 'HOURLY_CEIL' | 'EXACT_MINUTES';
        };
      };
      policySpecificDurations?: {
        [code: string]: {
          displayText: string;
          symbol?: string;
        };
      };
    };
    [key: string]: any;
  };
}

// 集計Policyインターフェース
export interface AttendanceAggregationPolicy {
  policyId: string;
  policyVersion: string;
  effectiveFrom: string;
  effectiveTo?: string;
  rules: {
    aggregationCategory: string;
    fullDayConversionRule: string;
    timeAggregationRule: string;
    roundingRule: string;
    disasterRecognitionAggregationRule?: {
      [key in DisasterRecognitionStatus]?: string;
    };
    payrollIntegrationCode?: string;
    hrIntegrationCode?: string;
  };
}

// 出勤簿確定レコード (Idempotency保証)
export interface AttendanceRecord {
  id: string;
  userId: number;
  targetDate: string;
  sourceApplicationId?: number;
  serviceStatusType: string;
  displayText: string;
  effectiveMinutes: number;
  policyVersionApplied: string;
  isLocked: number;
  updatedAt: string;
}
