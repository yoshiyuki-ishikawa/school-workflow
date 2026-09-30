export const SCHEMA_SQL = `
-- 0. schema_migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 1. users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  family_name TEXT NOT NULL DEFAULT '',
  given_name TEXT NOT NULL DEFAULT '',
  stamp_name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 1,
  password_changed_at TEXT,
  created_at TEXT NOT NULL
);

-- 2. roles
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- 3. user_roles
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- 4. approval_routes
CREATE TABLE IF NOT EXISTS approval_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT
);

-- 4.1 positions
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rank_order INTEGER NOT NULL,
  holder_type TEXT NOT NULL DEFAULT 'SINGLE_HOLDER' CHECK (holder_type IN ('SINGLE_HOLDER', 'MULTIPLE_HOLDER')),
  description TEXT
);

-- 4.2 user_positions
CREATE TABLE IF NOT EXISTS user_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE(user_id, position_id, effective_from)
);

-- 5. approval_route_steps
CREATE TABLE IF NOT EXISTS approval_route_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES approval_routes(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  step_key TEXT NOT NULL DEFAULT '',
  required_role_id TEXT NOT NULL REFERENCES roles(id),
  selector_type TEXT NOT NULL DEFAULT 'ROLE' CHECK(selector_type IN ('POSITION', 'ROLE', 'USER')),
  selector_value TEXT NOT NULL DEFAULT '',
  assigned_user_id INTEGER REFERENCES users(id)
);

-- 6. application_types
CREATE TABLE IF NOT EXISTS application_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  default_route_id INTEGER NOT NULL REFERENCES approval_routes(id)
);

-- 7. trip_events
CREATE TABLE IF NOT EXISTS trip_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  destination TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT '',
  notes TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. applications
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id TEXT NOT NULL REFERENCES application_types(id),
  subject_user_id INTEGER NOT NULL REFERENCES users(id),
  submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
  submission_actor_type TEXT NOT NULL DEFAULT 'SELF',
  submission_mode TEXT NOT NULL DEFAULT 'SINGLE',
  trip_event_id INTEGER REFERENCES trip_events(id),
  title TEXT NOT NULL,
  form_data TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'DRAFT',
  current_step_order INTEGER NOT NULL DEFAULT 1,
  pre_supersede_status TEXT,
  pre_supersede_workflow_cycle_id INTEGER REFERENCES application_workflow_cycles(id),
  superseded_by_personnel_status_id INTEGER REFERENCES personnel_statuses(id),
  superseded_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 9. trip_event_members
CREATE TABLE IF NOT EXISTS trip_event_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_event_id INTEGER NOT NULL REFERENCES trip_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  participation_status TEXT NOT NULL DEFAULT 'JOINED',
  individual_notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(trip_event_id, user_id)
);

-- 10. official_form_templates
CREATE TABLE IF NOT EXISTS official_form_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  authority_id TEXT NOT NULL DEFAULT 'DEFAULT_MUNICIPALITY',
  form_code TEXT NOT NULL,
  form_name TEXT NOT NULL,
  form_type TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  paper_size TEXT NOT NULL DEFAULT 'A4',
  orientation TEXT NOT NULL DEFAULT 'PORTRAIT',
  template_definition TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(authority_id, form_code, version)
);

-- 11. application_approval_steps
CREATE TABLE IF NOT EXISTS application_approval_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  approval_cycle INTEGER NOT NULL DEFAULT 1,
  workflow_cycle_id INTEGER REFERENCES application_workflow_cycles(id),
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  step_key TEXT,
  step_label_snapshot TEXT NOT NULL DEFAULT '',
  selector_type_snapshot TEXT NOT NULL DEFAULT 'ROLE',
  selector_value_snapshot TEXT NOT NULL DEFAULT '',
  approver_user_id_snapshot INTEGER REFERENCES users(id),
  approver_name_snapshot TEXT NOT NULL DEFAULT '',
  approver_position_code_snapshot TEXT,
  approver_position_name_snapshot TEXT,
  required_role_id TEXT NOT NULL REFERENCES roles(id),
  assigned_user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'WAITING',
  resolution_reason TEXT,
  action_type TEXT,
  is_final_decision_step INTEGER,
  action_by_user_id INTEGER REFERENCES users(id),
  action_user_display_name TEXT,
  action_user_stamp_name TEXT,
  action_user_role_name TEXT,
  comment TEXT,
  acted_at TEXT
);

-- 12. audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  server_timestamp TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_username TEXT NOT NULL,
  subject_user_id INTEGER,
  submission_actor_type TEXT,
  submission_mode TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  entity_version INTEGER,
  request_id TEXT,
  before_state TEXT,
  after_state TEXT,
  comment TEXT,
  ip_address TEXT NOT NULL,
  user_agent TEXT,
  metadata TEXT,
  prev_hash TEXT,
  event_hash TEXT,
  is_success INTEGER NOT NULL DEFAULT 1
);

-- 13. sessions
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired INTEGER NOT NULL
);

-- 14. calendar_overrides
CREATE TABLE IF NOT EXISTS calendar_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'ALL',
  user_id INTEGER REFERENCES users(id),
  override_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 15. monthly_attendance_approvals
CREATE TABLE IF NOT EXISTS monthly_attendance_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  confirmed_by_user_id INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  comment TEXT,
  UNIQUE(user_id, year_month)
);

-- 16. calendar_adjustments
CREATE TABLE IF NOT EXISTS calendar_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_code TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('ALL', 'USER')),
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  adjustment_type TEXT NOT NULL CHECK(adjustment_type IN (
    'WEEK_OFF_TRANSFER',
    'SUBSTITUTE_HOLIDAY',
    'SINGLE_WORKDAY_OVERRIDE',
    'DESIGNATED_NON_WORKDAY'
  )),
  reason_code TEXT NOT NULL CHECK(reason_code IN (
    'SCHOOL_EVENT',
    'CLUB_ACTIVITY',
    'OFFICIAL_DUTY',
    'SCHOOL_DESIGNATED_HOLIDAY',
    'OTHER_AUTHORIZED'
  )),
  authority_basis TEXT,
  source_date TEXT NOT NULL,
  source_duty_status TEXT NOT NULL CHECK(source_duty_status IN ('WORK_REQUIRED', 'NO_WORK_REQUIRED')),
  target_date TEXT,
  target_duty_status TEXT CHECK(target_duty_status IN ('WORK_REQUIRED', 'NO_WORK_REQUIRED')),
  related_adjustment_id INTEGER REFERENCES calendar_adjustments(id),
  event_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CANCELLED')),
  import_batch_id INTEGER REFERENCES calendar_import_batches(id),
  record_origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK(record_origin IN ('MANUAL', 'CSV_IMPORT', 'MIGRATION')),
  superseded_by_adjustment_id INTEGER REFERENCES calendar_adjustments(id),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  cancelled_by_user_id INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT
);

-- 17. custom_holidays
CREATE TABLE IF NOT EXISTS custom_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT NOT NULL,
  name TEXT NOT NULL,
  holiday_type TEXT NOT NULL CHECK(holiday_type IN ('NATIONAL_LEGAL_OVERRIDE', 'SCHOOL_HOLIDAY', 'MUNICIPALITY_HOLIDAY')),
  source TEXT NOT NULL CHECK(source IN ('SYSTEM_CALCULATION_OVERRIDE', 'CUSTOM')),
  is_active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  import_batch_id INTEGER REFERENCES calendar_import_batches(id),
  record_origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK(record_origin IN ('MANUAL', 'CSV_IMPORT', 'SYSTEM_INITIAL')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(holiday_date, holiday_type)
);

-- 17.1 calendar_import_batches
CREATE TABLE IF NOT EXISTS calendar_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_code TEXT NOT NULL UNIQUE,
  fiscal_year INTEGER NOT NULL,
  imported_by_user_id INTEGER NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  applied_adjustments_count INTEGER NOT NULL,
  applied_custom_holidays_count INTEGER NOT NULL,
  superseded_adjustments_count INTEGER NOT NULL DEFAULT 0,
  superseded_custom_holidays_count INTEGER NOT NULL DEFAULT 0,
  commit_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 18. user_work_patterns
CREATE TABLE IF NOT EXISTS user_work_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pattern_name TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK(pattern_type IN ('STANDARD_FULLTIME', 'SHORT_TIME', 'CUSTOM')),
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL,
  weekly_off_days TEXT NOT NULL,
  schedule_details_json TEXT,
  weekly_total_minutes INTEGER NOT NULL DEFAULT 2325,
  memo TEXT,
  record_origin TEXT NOT NULL DEFAULT 'ADMIN_CONFIGURED' CHECK(record_origin IN ('MIGRATION_INITIAL', 'ADMIN_CONFIGURED', 'IMPORT')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  statutory_pattern_code TEXT CHECK(statutory_pattern_code IS NULL OR statutory_pattern_code IN ('CST_01', 'CST_02', 'CST_03', 'CST_04')),
  schedule_source TEXT DEFAULT 'INDIVIDUAL' CHECK(schedule_source IS NULL OR schedule_source IN ('SCHOOL_DEFAULT', 'INDIVIDUAL'))
);

-- 19. permissions
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 20. role_permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- 21. policy_rules
CREATE TABLE IF NOT EXISTS policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_code TEXT NOT NULL,
  authority_id TEXT NOT NULL DEFAULT 'DEFAULT_MUNICIPALITY',
  version TEXT NOT NULL DEFAULT '2026.1',
  official_name TEXT NOT NULL,
  display_code TEXT NOT NULL,
  aggregation_category TEXT NOT NULL,
  max_minutes_per_day INTEGER DEFAULT 0,
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL,
  rule_definition_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE(policy_code, authority_id, version)
);

-- 22. personnel_statuses
CREATE TABLE IF NOT EXISTS personnel_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status_type TEXT NOT NULL,
  policy_rule_id INTEGER REFERENCES policy_rules(id),
  source_application_id INTEGER UNIQUE REFERENCES applications(id) ON DELETE SET NULL,
  document_reference_no TEXT,
  issued_at TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('REGISTERED', 'CONFIRMED', 'EFFECTIVE', 'ENDED', 'CANCELLED', 'SUPERSEDED_BY_AMENDMENT')),
  authority_basis TEXT NOT NULL CHECK(authority_basis IN ('OFFICIAL_ORDER', 'OFFICIAL_NOTICE', 'ELECTRONIC_NOTICE', 'UNVERIFIED_LEGACY')),
  order_authority_snapshot TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
  confirmed_by_user_id INTEGER REFERENCES users(id),
  superseded_by_status_id INTEGER REFERENCES personnel_statuses(id),
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

-- 23. personnel_actions
CREATE TABLE IF NOT EXISTS personnel_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_status_id INTEGER NOT NULL REFERENCES personnel_statuses(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_date TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  previous_state_json TEXT,
  new_state_json TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 24. monthly_attendance_snapshots
CREATE TABLE IF NOT EXISTS monthly_attendance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  year_month TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('LOCKED', 'NEEDS_RECONFIRMATION', 'SUPERSEDED')),
  confirmed_at TEXT NOT NULL,
  confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  confirmed_by_user_name TEXT NOT NULL,
  confirmed_user_stamp_name TEXT NOT NULL,
  monthly_summary_json TEXT NOT NULL,
  policy_rule_versions_json TEXT NOT NULL DEFAULT '{}',
  work_pattern_snapshot_json TEXT NOT NULL DEFAULT '{}',
  calendar_version TEXT NOT NULL DEFAULT '1.0',
  checksum TEXT NOT NULL,
  reconfirmation_reason TEXT,
  supersedes_snapshot_id INTEGER REFERENCES monthly_attendance_snapshots(id),
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE (user_id, year_month, version)
);

-- 25. monthly_attendance_snapshot_days
CREATE TABLE IF NOT EXISTS monthly_attendance_snapshot_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES monthly_attendance_snapshots(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  day_of_month INTEGER NOT NULL,
  is_required_work_day INTEGER NOT NULL,
  scheduled_work_minutes INTEGER NOT NULL,
  actual_work_minutes INTEGER NOT NULL,
  personnel_status_code TEXT NOT NULL,
  daily_event_code TEXT,
  display_symbol TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aggregation_category TEXT NOT NULL,
  resolution_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE (snapshot_id, date)
);

-- 26. absences
CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  absence_type TEXT NOT NULL CHECK(absence_type IN ('FULL_DAY', 'HOURLY')),
  target_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('DRAFT', 'CONFIRMED', 'CANCELLED', 'CORRECTED')),
  correction_target_type TEXT CHECK(correction_target_type IN ('LEAVE_ANNUAL', 'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT', 'OTHER')),
  corrected_application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  correction_reason TEXT,
  corrected_by_user_id INTEGER REFERENCES users(id),
  corrected_at TEXT,
  registered_by_user_id INTEGER NOT NULL REFERENCES users(id),
  confirmed_by_user_id INTEGER REFERENCES users(id),
  cancelled_by_user_id INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'DRAFT' AND confirmed_by_user_id IS NULL) OR
    (status IN ('CONFIRMED', 'CANCELLED', 'CORRECTED') AND confirmed_by_user_id IS NOT NULL)
  ),
  CHECK (
    absence_type = 'FULL_DAY' OR
    (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  )
);

-- 27. care_cases
CREATE TABLE IF NOT EXISTS care_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_relation TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  condition_summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ENDED')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 28. care_periods
CREATE TABLE IF NOT EXISTS care_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  care_case_id INTEGER NOT NULL REFERENCES care_cases(id) ON DELETE RESTRICT,
  period_number INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK(status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'EXPIRED', 'CANCELLED')),
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at TEXT,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  CHECK (start_date <= end_date)
);

-- 29. leave_entitlements
CREATE TABLE IF NOT EXISTS leave_entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement_code TEXT NOT NULL UNIQUE,
  entitlement_type TEXT NOT NULL CHECK(entitlement_type IN ('REGULAR_GRANT', 'MID_CAREER_GRANT', 'TEMPORARY_GRANT', 'CARRYOVER', 'MANUAL_ADJUSTMENT')),
  fiscal_year INTEGER NOT NULL,
  granted_days INTEGER NOT NULL,
  used_half_days INTEGER NOT NULL DEFAULT 0,
  used_hourly_minutes INTEGER NOT NULL DEFAULT 0,
  grant_date TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source_policy_id INTEGER REFERENCES policy_rules(id),
  carryover_from_id INTEGER REFERENCES leave_entitlements(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'LEGACY_UNVERIFIED')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  CHECK (effective_from <= expires_at)
);

-- 30. leave_usages
CREATE TABLE IF NOT EXISTS leave_usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement_id INTEGER NOT NULL REFERENCES leave_entitlements(id) ON DELETE CASCADE,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_date TEXT NOT NULL,
  unit_type TEXT NOT NULL CHECK(unit_type IN ('FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'HOURLY')),
  day_deduction_units INTEGER NOT NULL DEFAULT 0,
  hourly_minutes INTEGER NOT NULL DEFAULT 0,
  attendance_deduction_minutes INTEGER NOT NULL,
  calculation_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'REVERSED')),
  reversed_at TEXT,
  reversal_reason TEXT,
  reversal_cycle_id INTEGER REFERENCES application_workflow_cycles(id),
  created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 31. workflow_policies
CREATE TABLE IF NOT EXISTS workflow_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL UNIQUE,
  policy_name TEXT NOT NULL,
  description TEXT,
  policy_purpose TEXT NOT NULL DEFAULT 'APPROVAL' CHECK (policy_purpose IN ('APPROVAL', 'CANCELLATION', 'POST_TRIP_REPORT')),
  policy_source TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (policy_source IN ('LEGACY_MIGRATED', 'TEMPLATE', 'CUSTOM', 'SYSTEM')),
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  created_by_user_id INTEGER REFERENCES users(id)
);

-- 32. workflow_policy_application_types
CREATE TABLE IF NOT EXISTS workflow_policy_application_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id TEXT NOT NULL REFERENCES workflow_policies(id) ON DELETE CASCADE,
  app_type_id TEXT NOT NULL REFERENCES application_types(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE(policy_id, app_type_id)
);

-- 33. workflow_policy_versions
CREATE TABLE IF NOT EXISTS workflow_policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES workflow_policies(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
  priority INTEGER NOT NULL DEFAULT 100,
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL DEFAULT '9999-12-31',
  conditions_json TEXT NOT NULL DEFAULT '{}',
  is_used INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  created_by_user_id INTEGER REFERENCES users(id),
  UNIQUE(policy_id, version)
);

-- 34. workflow_policy_steps
CREATE TABLE IF NOT EXISTS workflow_policy_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_version_id TEXT NOT NULL REFERENCES workflow_policy_versions(id) ON DELETE RESTRICT,
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  step_key TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'APPROVE' CHECK (action_type IN ('REVIEW', 'APPROVE', 'DECIDE', 'ORDER', 'CHECK')),
  required_role_id TEXT NOT NULL REFERENCES roles(id),
  selector_type TEXT NOT NULL DEFAULT 'POSITION' CHECK (selector_type IN ('POSITION', 'ROLE')),
  selector_value TEXT NOT NULL,
  is_final_decision_step INTEGER NOT NULL DEFAULT 0 CHECK (is_final_decision_step IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE(policy_version_id, step_order),
  UNIQUE(policy_version_id, step_key)
);

-- 35. application_workflow_cycles
CREATE TABLE IF NOT EXISTS application_workflow_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  approval_cycle INTEGER NOT NULL,
  cycle_purpose TEXT NOT NULL DEFAULT 'APPROVAL' CHECK (cycle_purpose IN ('APPROVAL', 'RESUBMISSION', 'CANCELLATION', 'POST_TRIP_REPORT')),
  workflow_source TEXT NOT NULL DEFAULT 'NEW_POLICY_ENGINE' CHECK (workflow_source IN ('NEW_POLICY_ENGINE', 'LEGACY_SNAPSHOT')),
  workflow_policy_version_id TEXT REFERENCES workflow_policy_versions(id),
  policy_evaluation_at TEXT,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN')),
  cancellation_reason TEXT,
  started_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  started_by_user_id INTEGER REFERENCES users(id),
  ended_at TEXT,
  return_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  UNIQUE(application_id, approval_cycle),
  CHECK (
    (workflow_source = 'NEW_POLICY_ENGINE' AND workflow_policy_version_id IS NOT NULL AND policy_evaluation_at IS NOT NULL AND started_by_user_id IS NOT NULL)
    OR
    (workflow_source = 'LEGACY_SNAPSHOT')
  )
);

-- 36. official_job_titles
CREATE TABLE IF NOT EXISTS official_job_titles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
);

-- 37. user_job_titles
CREATE TABLE IF NOT EXISTS user_job_titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_title_id TEXT NOT NULL REFERENCES official_job_titles(id) ON DELETE RESTRICT,
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL,
  order_reference_no TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  CHECK (effective_from <= effective_to)
);
CREATE INDEX IF NOT EXISTS idx_user_job_titles_lookup 
ON user_job_titles (user_id, effective_from, effective_to);

-- 38. school_work_schedules (Single-School Scope, Effective-Dated, workIntervals Canonical)
CREATE TABLE IF NOT EXISTS school_work_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_name TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL,
  weekly_off_days TEXT NOT NULL DEFAULT '0,6',
  schedule_details_json TEXT NOT NULL,
  weekly_total_minutes INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  updated_by_user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id),
  CHECK (effective_from <= effective_to)
);
CREATE INDEX IF NOT EXISTS idx_school_work_schedules_effective
ON school_work_schedules (effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_school_work_schedules_active
ON school_work_schedules (is_active);
`;

