export interface Position {
  id: string;
  name: string;
  rank_order: number;
  holder_type: 'SINGLE_HOLDER' | 'MULTIPLE_HOLDER';
  description?: string;
}

export interface UserPosition {
  id: number;
  user_id: number;
  position_id: string;
  position_name: string;
  rank_order: number;
  holder_type: 'SINGLE_HOLDER' | 'MULTIPLE_HOLDER';
  position_desc?: string;
  is_primary: number;
  effective_from: string;
  effective_to: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorkflowPolicyStep {
  id?: number;
  stepOrder: number;
  stepName: string;
  stepKey: string;
  actionType: 'REVIEW' | 'APPROVE' | 'DECIDE' | 'ORDER' | 'CHECK' | 'ACK';
  requiredRoleId: string;
  selectorType: 'POSITION' | 'ROLE';
  selectorValue: string;
  isFinalDecisionStep: boolean;
}

export interface WorkflowPolicyVersion {
  id: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  priority: number;
  effectiveFrom: string;
  effectiveTo: string;
  conditionsJson: string;
  isUsed: boolean;
  retiredAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  steps: WorkflowPolicyStep[];
}

export interface PolicyDraftReadinessResult {
  isReady: boolean;
  checks: {
    policyExists: { pass: boolean; message: string };
    versionIsDraft: { pass: boolean; message: string };
    stepsExist: { pass: boolean; message: string };
    stepOrderValid: { pass: boolean; message: string };
    finalDecisionExactlyOne: { pass: boolean; message: string };
    canonicalPositionsValid: { pass: boolean; message: string };
    roleSelectorExcluded: { pass: boolean; message: string };
    applicationTypesBound: { pass: boolean; message: string };
    effectivePeriodValid: { pass: boolean; message: string };
    effectiveFromReached: { pass: boolean; message: string };
    effectiveToNotExpired: { pass: boolean; message: string };
    priorityConflictFree: { pass: boolean; message: string };
    positionHoldersAssigned: { pass: boolean; message: string };
  };
  errors: string[];
}

export interface WorkflowPolicy {
  id: string;
  policyKey: string;
  policyName: string;
  description?: string;
  policyPurpose?: 'APPROVAL' | 'CANCELLATION' | 'POST_TRIP_REPORT';
  policySource: 'LEGACY_MIGRATED' | 'TEMPLATE' | 'CUSTOM' | 'SYSTEM';
  appTypeIds: string[];
  versions: WorkflowPolicyVersion[];
}


export interface OfficialJobTitle {
  id: string;
  code: string;
  display_name: string;
  category: 'TEACHING' | 'NURSING' | 'NUTRITION' | 'ADMINISTRATION' | 'OTHER';
  sort_order: number;
  description?: string;
  is_active: number;
  created_at?: string;
  updated_at?: string;
}

export interface UserJobTitleAssignment {
  id: number;
  user_id: number;
  job_title_id: string;
  job_title_code: string;
  job_title_display_name: string;
  job_title_category: string;
  effective_from: string;
  effective_to: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OfficialJobTitleDetail {
  id: string;
  code: string;
  name: string;
  effectiveFrom: string;
  effectiveTo: string;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  familyName?: string;
  givenName?: string;
  stampName?: string;
  department: string;
  roles: string[];
  mustChangePassword?: boolean;
  authVersion?: number;
  currentOfficialJobTitle?: string | null;
  currentOfficialJobTitleDetail?: OfficialJobTitleDetail | null;
  currentPositions?: {
    id: string;
    name: string;
    rankOrder: number;
    holderType: 'SINGLE_HOLDER' | 'MULTIPLE_HOLDER';
    isPrimary: boolean;
    effectiveFrom: string;
    effectiveTo: string;
  }[];
  currentPrimaryPosition?: {
    id: string;
    name: string;
    rankOrder: number;
    holderType: 'SINGLE_HOLDER' | 'MULTIPLE_HOLDER';
    isPrimary: boolean;
    effectiveFrom: string;
    effectiveTo: string;
  } | null;
}

export type ApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'FIRST_APPROVED'
  | 'SECOND_APPROVED'
  | 'TRIP_APPROVED'
  | 'REPORT_SUBMITTED'
  | 'REPORT_FIRST_APPROVED'
  | 'REPORT_SECOND_APPROVED'
  | 'FINAL_APPROVED'
  | 'RETURNED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'CANCELLED';

export interface PendingTaskItem {
  application_id: number;
  application_type: string;
  applicant_name: string;
  applicant_id: number;
  submitted_at: string;
  current_step_order: number;
  current_step_name: string;
  cycle_number: number;
  cycle_purpose: string;
  title: string;
}

export interface ApplicationType {
  id: string;
  name: string;
  description: string;
  default_route_id: number;
  categoryId?: string;
  categoryName?: string;
  categoryDescription?: string;
  categoryOrder?: number;
}

export interface ApprovalStep {
  id: number;
  application_id: number;
  approval_cycle?: number;
  step_order: number;
  step_name: string;
  required_role_id: string;
  assigned_user_id?: number | null;
  status: 'WAITING' | 'PENDING' | 'APPROVED' | 'RETURNED' | 'REJECTED' | 'SKIPPED';
  resolution_reason?: string | null;
  action_type?: string | null;
  is_final_decision_step?: number | null;
  action_by_user_id?: number | null;
  actor_name?: string | null;
  action_user_name?: string | null;
  action_user_stamp_name?: string | null;
  comment?: string | null;
  acted_at?: string | null;
}


export interface LeaveSummaryItem {
  days: number;
  hours: number;
  minutes: number;
  totalMinutes: number;
  formatted: string;
}

export interface UserLeaveSummary {
  annualLeave: {
    initialDays: number;
    used: LeaveSummaryItem;
    remaining: LeaveSummaryItem;
  };
  sickLeave: LeaveSummaryItem;
  specialLeave: LeaveSummaryItem;
  dutyExempt: LeaveSummaryItem;
  careLeave?: LeaveSummaryItem;
  careTime?: LeaveSummaryItem;
}


export interface WorkflowCycle {
  id: number;
  application_id: number;
  approval_cycle: number;
  cycle_purpose: "APPROVAL" | "RESUBMISSION" | "CANCELLATION" | "POST_TRIP_REPORT";
  workflow_source: string;
  workflow_policy_version_id?: string | null;
  policy_evaluation_at?: string | null;
  status: "IN_PROGRESS" | "APPROVED" | "RETURNED" | "REJECTED" | "WITHDRAWN";
  cancellation_reason?: string | null;
  started_at: string;
  started_by_user_id?: number | null;
  ended_at?: string | null;
  return_reason?: string | null;
}

export interface CancellationReturnMetadata {
  cycleId: number;
  approvalCycle: number;
  status: 'RETURNED';
  returnReason?: string | null;
  returnedAt?: string | null;
  returnedByUserId?: number | null;
  returnedByUserName?: string | null;
  actionActorUserId?: number | null;
}

export type BusinessTripReportStatus =
  | 'UNSUBMITTED'
  | 'REPORT_SUBMITTED'
  | 'REPORT_FIRST_APPROVED'
  | 'REPORT_SECOND_APPROVED'
  | 'REPORT_RETURNED'
  | 'REPORT_FINAL_APPROVED';

export interface Application {
  cycles?: WorkflowCycle[];
  activeCancellationCycle?: WorkflowCycle | null;
  latestCancellationCycle?: WorkflowCycle | null;
  cancellationReturn?: CancellationReturnMetadata | null;
  id: number;
  type_id: string;
  type_name?: string;
  subject_user_id?: number;
  submitted_by_user_id?: number;
  submission_actor_type?: 'SELF' | 'PROXY' | 'SYSTEM';
  submission_mode?: 'SINGLE' | 'BATCH';
  trip_event_id?: number | null;
  subject_user_name?: string;
  subject_stamp_name?: string;
  subject_department?: string;
  proxy_user_name?: string;
  proxy_stamp_name?: string;
  applicant_id: number; // 互換性
  applicant_name?: string; // 互換性
  applicant_department?: string; // 互換性
  title: string;
  form_data: {
    unitType?: 'DAY' | 'TIME';
    startDate?: string;
    endDate?: string;
    targetDate?: string;
    startTime?: string;
    endTime?: string;
    calculatedDays?: number;
    calculatedMinutes?: number;
    specialLeaveType?: string;
    destination?: string;
    reason?: string;
    substituteTeacher?: string;
    proxyReason?: string;
    proxySubmitterName?: string;
    remarks?: string;
    reportDate?: string;
    reportResult?: string;
    reportRemarks?: string;
    tripEventId?: number;
    batchGroupId?: string;
    [key: string]: any;
  };
  current_status: ApplicationStatus;
  report_status?: BusinessTripReportStatus | null;
  current_step_order: number;
  version: number;
  created_at: string;
  updated_at: string;
  steps?: ApprovalStep[];
  leaveSummarySnapshot?: UserLeaveSummary;
}

export interface TripEvent {
  id: number;
  title: string;
  purpose: string;
  destination: string;
  start_at: string;
  end_at: string;
  transport: string;
  notes?: string;
  created_by_user_id: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OfficialFormTemplate {
  id: number;
  authority_id: string;
  form_code: string;
  form_name: string;
  form_type: string;
  version: string;
  paper_size: string;
  orientation: string;
  template_definition: any;
  is_active: number;
}

export interface AuditLog {
  id: number;
  event_id?: string;
  timestamp: string;
  server_timestamp?: string;
  actor_user_id?: number | null;
  actor_username?: string;
  subject_user_id?: number | null;
  submission_actor_type?: string;
  submission_mode?: string;
  user_id?: number | null;
  username: string;
  role_snapshot?: string | null;
  action: string;
  entity_type?: string;
  entity_id?: string | null;
  target_type: string;
  target_id?: string | null;
  before_state?: string | null;
  after_state?: string | null;
  comment?: string | null;
  ip_address: string;
  user_agent?: string | null;
  metadata?: string | null;
  event_hash?: string | null;
  is_success: number;
}

export interface CalendarAdjustment {
  id: number;
  adjustment_code: string;
  scope_type: 'ALL' | 'USER';
  user_id?: number | null;
  target_user_name?: string | null;
  adjustment_type: 'WEEK_OFF_TRANSFER' | 'SUBSTITUTE_HOLIDAY' | 'SINGLE_WORKDAY_OVERRIDE' | 'DESIGNATED_NON_WORKDAY';
  reason_code: 'SCHOOL_EVENT' | 'CLUB_ACTIVITY' | 'OFFICIAL_DUTY' | 'SCHOOL_DESIGNATED_HOLIDAY' | 'OTHER_AUTHORIZED';
  authority_basis?: string | null;
  source_date: string;
  source_duty_status: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  target_date?: string | null;
  target_duty_status?: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | null;
  related_adjustment_id?: number | null;
  event_name: string;
  reason: string;
  status: 'ACTIVE' | 'CANCELLED';
  created_by_user_id: number;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  cancelled_by_user_id?: number | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
}

export interface CustomHoliday {
  id: number;
  holiday_date: string;
  name: string;
  holiday_type: 'NATIONAL_LEGAL_OVERRIDE' | 'SCHOOL_HOLIDAY' | 'MUNICIPALITY_HOLIDAY';
  source: 'SYSTEM_CALCULATION_OVERRIDE' | 'CUSTOM';
  is_active: number;
  note?: string | null;
  created_by_user_id: number;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserWorkPattern {
  id: number;
  user_id: number;
  pattern_name: string;
  pattern_type: 'STANDARD_FULLTIME' | 'SHORT_TIME' | 'CUSTOM';
  effective_from: string;
  effective_to: string;
  weekly_off_days: string;
  schedule_details_json?: string;
  weekly_total_minutes: number;
  statutory_pattern_code?: 'CST_01' | 'CST_02' | 'CST_03' | 'CST_04' | null;
  memo?: string;
  record_origin: 'MIGRATION_INITIAL' | 'ADMIN_CONFIGURED' | 'IMPORT';
  created_by_user_id: number;
  created_by_user_name?: string;
  created_at: string;
  updated_by_user_id?: number;
  updated_at: string;
}

export interface AttendanceStamp {
  status: string;
  symbol: string;
  text: string;
  subText?: string;
  color: 'indigo' | 'emerald' | 'teal' | 'purple' | 'blue' | 'amber' | 'rose' | 'slate';
  startTime?: string;
  endTime?: string;
  isCalendarStatus?: boolean;
  sourceFactId?: string;
}

// 出勤簿 多軸確定状態 (Server-Authoritative)
export interface AttendanceDayCell {
  day: number;
  date: string;
  dayOfWeek: string;
  stamps?: AttendanceStamp[];
  calendarAttributes?: {
    isNationalHoliday: boolean;
    holidayName?: string;
    isSchoolHoliday: boolean;
    schoolHolidayName?: string;
    isMunicipalityHoliday: boolean;
    isWeekend: boolean;
  };
  workScheduleAttributes?: {
    patternId?: number;
    patternName?: string;
    isScheduledWorkDay: boolean;
    isWeeklyOff: boolean;
    scheduledWorkMinutes: number;
  };
  primaryDayClassification?: 'WORKDAY' | 'WEEKLY_OFF' | 'HOLIDAY' | 'SUBSTITUTE_HOLIDAY' | 'OTHER_NON_WORKDAY' | 'UNKNOWN_PATTERN';
  calendarLegalType?: 'REGULAR_DAY' | 'WEEKLY_HOLIDAY' | 'NATIONAL_HOLIDAY' | 'SCHOOL_HOLIDAY' | 'MUNICIPALITY_HOLIDAY';
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  dutyRequirement?: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED';
  isWorkRequired?: boolean;
  isWorkPatternResolved?: boolean;
  isWorkday: boolean;
  isWeekOff: boolean;
  isSubstituteHoliday: boolean;
  overrideReason?: string;
  adjustment?: {
    id: number;
    adjustmentCode: string;
    adjustmentType: string;
    reasonCode: string;
    eventName: string;
    reason: string;
    authorityBasis?: string;
    sourceDate?: string;
    targetDate?: string;
    scopeType: 'ALL' | 'USER';
  };
  serviceStatus?: string;
  applicationInfo?: {
    id: number;
    typeId: string;
    typeName: string;
    title: string;
    unitType?: 'DAY' | 'TIME';
    calculatedMinutes?: number;
  };
  stampText?: string;
  stampSubText?: string;
  stampColor?: string;
  applicationId?: number;
  applicationTitle?: string;
  applicationType?: string;
}

export interface DomainAttendanceSummary {
  scheduledWorkdayCount: number;
  actualWorkedDayCount: number;
  businessTripDayCount: number;
  annualLeaveMinutes: number;
  sickLeaveDays: number;
  specialLeaveDays: number;
  dutyExemptDays: number;
  weekOffCount: number;
  holidayCount: number;
  substituteHolidayCount: number;
}

export interface CarePeriod {
  id: number;
  care_case_id: number;
  period_number: number;
  start_date: string;
  end_date: string;
  status: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  memo?: string;
  created_at: string;
  updated_at: string;
}

export interface CareCase {
  id: number;
  user_id: number;
  user_name?: string;
  recipient_relation: string;
  recipient_name: string;
  condition_summary: string;
  status: 'ACTIVE' | 'ENDED';
  periods?: CarePeriod[];
  created_at: string;
  updated_at: string;
}

export interface AbsenceRecord {
  id: number;
  user_id: number;
  user_name?: string;
  user_department?: string;
  absence_type: 'FULL_DAY' | 'HOURLY';
  target_date: string;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes: number;
  reason: string;
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED' | 'CORRECTED';
  correction_target_type?: string | null;
  corrected_application_id?: number | null;
  correction_reason?: string | null;
  corrected_by_user_id?: number | null;
  corrected_at?: string | null;
  registered_by_user_id: number;
  registered_by_name?: string;
  confirmed_by_user_id?: number | null;
  confirmed_by_name?: string | null;
  cancelled_by_user_id?: number | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyAttendanceSummary {
  workdayCount: number;
  scheduledWorkdayCount?: number;
  actualWorkedDayCount?: number;
  weekOffCount: number;
  holidayCount: number;
  annualLeave: LeaveSummaryItem;
  sickLeave: LeaveSummaryItem;
  specialLeave: LeaveSummaryItem;
  dutyExempt: LeaveSummaryItem;
  careLeave?: { fullDays: number; halfDays: number; hours: number; minutes: number; totalMinutes: number; formatted: string };
  absence: { fullDays: number; totalMinutes: number; formatted: string };
  subTotalLeave: LeaveSummaryItem;
  businessTripCount: number;
  businessTripDays: number;
}

export interface MonthlyAttendanceData {
  userId: number;
  userName: string;
  userJobTitle?: string;
  userDepartment: string;
  yearMonth: string;
  days: AttendanceDayCell[];
  domainSummary?: DomainAttendanceSummary;
  summary: MonthlyAttendanceSummary;
  hasUnknownPattern?: boolean;
  unresolvedDays?: Array<{ date: string; reason: string }>;
  warnings?: string[];
  approval: {
    status: 'OPEN' | 'CONFIRMED' | 'UNLOCKED_FOR_CORRECTION';
    snapshotId?: number;
    confirmedByUserName?: string;
    confirmedUserStampName?: string;
    confirmedAt?: string;
    comment?: string;
    unlockedReason?: string;
    unlockedAt?: string;
  };
}

export interface PublicSettings {
  schoolName: string;
  appTitle: string;
}

export interface SystemSettings {
  id: number;
  schoolName: string;
  municipalityName: string;
  boardOfEducationName: string;
  appTitle: string;
  leaveRegulationName?: string;
  travelRegulationName?: string;
  attendanceRegulationName?: string;
  version: number;
  updatedAt: string;
  updatedByUserName?: string | null;
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

export interface PersonnelStatusRecord {
  id: number;
  user_id: number;
  display_name?: string;
  department?: string;
  status_type: string;
  policy_rule_id?: number;
  official_name?: string;
  display_code?: string;
  document_reference_no?: string | null;
  issued_at?: string | null;
  effective_from: string;
  effective_to?: string | null;
  ended_at?: string | null;
  status: 'REGISTERED' | 'CONFIRMED' | 'EFFECTIVE' | 'ENDED' | 'CANCELLED' | 'SUPERSEDED_BY_AMENDMENT';
  authority_basis: AuthorityBasis;
  order_authority_snapshot: string;
  reason_code: string;
  registered_by_user_id: number;
  confirmed_by_user_id?: number;
  superseded_by_status_id?: number;
  created_at: string;
  updated_at: string;
}



