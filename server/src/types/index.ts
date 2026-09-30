// 共通型定義 (ドメイン分離モデル v3.0)

export type RoleId = 'TEACHER' | 'VICE_PRINCIPAL' | 'PRINCIPAL' | 'OFFICE' | 'ADMIN';

export type PermissionId =
  | 'personnel.status.read.basic'
  | 'personnel.status.read.restricted'
  | 'personnel.status.manage'
  | 'workpattern.manage'
  | 'calendar.manage'
  | 'attendance.read'
  | 'attendance.finalize'
  | 'attendance.reconfirm'
  | 'absence.read.self'
  | 'absence.read.managed'
  | 'absence.manage'
  | 'absence.correct'
  | 'care.case.read.self'
  | 'care.case.read.managed'
  | 'care.case.manage'
  | 'policy.read'
  | 'policy.manage'
  | 'audit.read'
  | 'system.manage'
  | 'application.create.self'
  | 'application.create.proxy'
  | 'application.create.batch'
  | 'user.credential.reset'
  | 'job_title.master.manage'
  | 'job_title.assignment.manage';

export interface PolicyRule {
  id: number;
  policy_code: string;
  authority_id: string;
  version: string;
  official_name: string;
  display_code: string;
  aggregation_category: string;
  max_minutes_per_day: number;
  effective_from: string;
  effective_to: string;
  rule_definition_json: string;
  is_active: number;
  created_at: string;
}

export type PersonnelStatusType =
  | 'CHILDCARE_LEAVE'
  | 'SUSPENSION'
  | 'DISCIPLINARY_SUSPENSION'
  | 'UNION_FULL_TIME_RELEASE'
  | 'GRADUATE_STUDY_LEAVE'
  | 'SELF_DEVELOPMENT_LEAVE'
  | 'SPOUSAL_ACCOMPANIMENT_LEAVE'
  | 'DISPATCH';

export type AuthorityBasis = 'OFFICIAL_ORDER' | 'OFFICIAL_NOTICE' | 'ELECTRONIC_NOTICE' | 'UNVERIFIED_LEGACY';

export type PersonnelStatusState = 'REGISTERED' | 'CONFIRMED' | 'EFFECTIVE' | 'ENDED' | 'CANCELLED' | 'SUPERSEDED_BY_AMENDMENT';

export interface PersonnelStatus {
  id: number;
  user_id: number;
  status_type: PersonnelStatusType;
  policy_rule_id?: number;
  source_application_id?: number;
  document_reference_no?: string;
  issued_at?: string;
  effective_from: string;
  effective_to?: string;
  ended_at?: string;
  status: PersonnelStatusState;
  authority_basis: AuthorityBasis;
  order_authority_snapshot: string;
  reason_code: string;
  registered_by_user_id: number;
  confirmed_by_user_id?: number;
  superseded_by_status_id?: number;
  created_at: string;
  updated_at: string;
}

export interface PersonnelAction {
  id: number;
  personnel_status_id: number;
  action_type: 'CREATE' | 'CREATE_FROM_APPLICATION' | 'CONFIRM' | 'EXTEND' | 'SHORTEN' | 'RETURN_TO_DUTY' | 'CANCEL' | 'AMEND';
  action_date: string;
  actor_user_id: number;
  previous_state_json?: string;
  new_state_json?: string;
  comment?: string;
  created_at: string;
}

export interface AttendanceExplanation {
  layer: 'CALENDAR' | 'WORK_PATTERN' | 'PERSONNEL_STATUS' | 'DAILY_EVENT' | 'HOURLY_EVENT' | 'POLICY_RULE';
  sourceType: string;
  sourceId?: number;
  ruleCode?: string;
  messageCode: string;
}

export interface AttendanceResolution {
  date: string;
  userId: number;
  dayOfMonth: number;
  calendarType: string;
  workPatternType: string;
  scheduledWorkMinutes: number;
  actualWorkMinutes: number;
  isRequiredWorkDay: boolean;
  
  personnelStatusCode: string;
  dailyEventCode?: string;
  hourlyEventMinutes: {
    hourlyLeaveMinutes: number;
    partialChildcareMinutes: number;
    partialCareMinutes: number;
    dutyExemptMinutes: number;
  };
  
  displaySymbol: string;
  displayName: string;
  displayColor?: string;
  aggregationCategory: string;
  
  sourceIds: {
    workPatternId?: number;
    personnelStatusId?: number;
    applicationIds?: number[];
  };
  ruleVersion: string;
  resolutionStatus: 'VALID' | 'RESOLUTION_ERROR';
  errorMessage?: string;
  explanations: AttendanceExplanation[];
}

export interface MonthlyAttendanceSnapshot {
  id: number;
  userId: number;
  yearMonth: string;
  version: number;
  status: 'LOCKED' | 'NEEDS_RECONFIRMATION' | 'SUPERSEDED';
  confirmedAt: string;
  confirmedByUserId: number;
  confirmedByUserName: string;
  confirmedUserStampName: string;
  monthlySummaryJson: string;
  policyRuleVersionsJson: string;
  workPatternSnapshotJson: string;
  calendarVersion: string;
  checksum: string;
  reconfirmationReason?: string;
  supersedesSnapshotId?: number;
  createdAt: string;
  days?: MonthlyAttendanceSnapshotDay[];
}

export interface MonthlyAttendanceSnapshotDay {
  id: number;
  snapshotId: number;
  date: string;
  dayOfMonth: number;
  isRequiredWorkDay: number;
  scheduledWorkMinutes: number;
  actualWorkMinutes: number;
  personnelStatusCode: string;
  dailyEventCode?: string;
  displaySymbol: string;
  displayName: string;
  aggregationCategory: string;
  resolutionJson: string;
  createdAt: string;
}

// -------------------------------------------------------------
// 年次有給休暇 ドメイン型定義 (Entitlement / Usage / Projection)
// -------------------------------------------------------------

export type LeaveUnit = 'FULL_DAY' | 'HALF_DAY_AM' | 'HALF_DAY_PM' | 'HOURLY';

export type EntitlementType =
  | 'REGULAR_GRANT'
  | 'MID_CAREER_GRANT'
  | 'TEMPORARY_GRANT'
  | 'CARRYOVER'
  | 'MANUAL_ADJUSTMENT';

export type EntitlementStatus =
  | 'ACTIVE'
  | 'EXHAUSTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'LEGACY_UNVERIFIED';

export interface LeaveEntitlement {
  id: number;
  user_id: number;
  entitlement_code: string;
  entitlement_type: EntitlementType;
  fiscal_year: number;
  granted_days: number;
  used_half_days: number;
  used_hourly_minutes: number;
  grant_date: string;
  effective_from: string;
  expires_at: string;
  source_policy_id?: number;
  carryover_from_id?: number;
  status: EntitlementStatus;
  reason: string;
  created_at: string;
  updated_at: string;
}

export type LeaveUsageStatus = 'ACTIVE' | 'REVERSED';

export interface LeaveUsage {
  id: number;
  entitlement_id: number;
  application_id: number;
  user_id: number;
  target_date: string;
  unit_type: LeaveUnit;
  day_deduction_units: number;
  hourly_minutes: number;
  attendance_deduction_minutes: number;
  calculation_snapshot?: string;
  status: LeaveUsageStatus;
  reversed_at?: string;
  reversal_reason?: string;
  reversal_cycle_id?: number;
  created_at: string;
}

export interface LeaveBalanceProjection {
  totalGrantedDays: number;
  remainingDays: number;
  remainingHalfDayUnits: number;
  hourlyUsedMinutesInYear: number;
  hourlyLimitMinutesInYear: number;
  hourlyRemainingMinutesInYear: number;
  formattedRemaining: string;
  formattedHourlyUsage: string;
}

// -------------------------------------------------------------
// ワークフローポリシー / サイクル Purpose 型定義 (ADR-01)
// -------------------------------------------------------------

export type WorkflowPolicyPurpose = 'APPROVAL' | 'CANCELLATION' | 'POST_TRIP_REPORT';
export type WorkflowCyclePurpose = 'APPROVAL' | 'RESUBMISSION' | 'CANCELLATION' | 'POST_TRIP_REPORT';

