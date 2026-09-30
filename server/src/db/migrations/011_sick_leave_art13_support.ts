import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 011: 山口県勤務条例第13条「病気休暇（公務・通勤災害認定含む）」基盤の導入
 * 
 * 1. sick_leave_applications テーブル新設 (コア単位: FULL_DAY | TIME, 3軸状態: application, disaster, reevaluation)
 * 2. medical_evidence_records テーブル新設 (機微医療情報・診断書物理分離)
 * 3. attendance_display_policies テーブル新設 (出勤簿表示Policy)
 * 4. attendance_aggregation_policies テーブル新設 (集計Policy)
 * 5. attendance_records テーブル新設 (Idempotency保証出勤簿確定レコード)
 * 6. application_types に LEAVE_SICK が存在することを保証 (ルート1)
 * 7. policy_rules に SICK_LEAVE_ART13 の UNCONFIRMED skeleton を登録 (Fail-Closed)
 * 8. permissions および role_permissions に sick_leave.* パーミッションを登録
 */
export const migration011: Migration = {
  version: 11,
  name: 'sick_leave_art13_support',
  up: (db: Database) => {
    // 1. sick_leave_applications テーブル作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS sick_leave_applications (
        id TEXT PRIMARY KEY,
        application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        target_date TEXT NOT NULL,
        duration_type TEXT NOT NULL CHECK (duration_type IN ('FULL_DAY', 'TIME')),
        policy_specific_duration_code TEXT,
        start_at TEXT,
        end_at TEXT,
        calculated_minutes INTEGER NOT NULL DEFAULT 0,
        legal_basis_id TEXT NOT NULL DEFAULT 'YAMAGUCHI_WORK_ORDINANCE_ART13',
        applied_policy_version TEXT NOT NULL DEFAULT '2026.1',
        application_status TEXT NOT NULL CHECK (application_status IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED', 'CANCELLED')),
        disaster_recognition_status TEXT NOT NULL DEFAULT 'NONE' CHECK (disaster_recognition_status IN ('NONE', 'APPLICATION_PENDING', 'PUBLIC_DUTY_RECOGNIZED', 'COMMUTING_RECOGNIZED', 'NOT_RECOGNIZED', 'WITHDRAWN')),
        disaster_recognized_at TEXT,
        disaster_recognition_authority TEXT,
        disaster_recognition_reference TEXT,
        disaster_recognition_updated_at TEXT,
        reevaluation_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (reevaluation_status IN ('NOT_REQUIRED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
        evidence_requirement TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (evidence_requirement IN ('REQUIRED', 'OPTIONAL', 'NOT_REQUIRED')),
        evidence_status TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (evidence_status IN ('NOT_SUBMITTED', 'SUBMITTED', 'VERIFIED', 'REJECTED')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sick_leave_user_date ON sick_leave_applications(user_id, target_date);
      CREATE INDEX IF NOT EXISTS idx_sick_leave_app_id ON sick_leave_applications(application_id);
    `);

    // 2. medical_evidence_records テーブル作成 (物理分離・機密管理)
    db.exec(`
      CREATE TABLE IF NOT EXISTS medical_evidence_records (
        id TEXT PRIMARY KEY,
        sick_leave_id TEXT NOT NULL UNIQUE REFERENCES sick_leave_applications(id) ON DELETE CASCADE,
        file_storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        verified_by_user_id INTEGER REFERENCES users(id),
        verified_at TEXT,
        retention_limit_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_med_evidence_sick_id ON medical_evidence_records(sick_leave_id);
    `);

    // 3. attendance_display_policies テーブル作成 (出勤簿表示Policy)
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_display_policies (
        policy_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        PRIMARY KEY (policy_id, policy_version)
      );
    `);

    // 4. attendance_aggregation_policies テーブル作成 (集計Policy)
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_aggregation_policies (
        policy_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        PRIMARY KEY (policy_id, policy_version)
      );
    `);

    // 5. attendance_records テーブル作成 (Idempotency保証出勤簿確定レコード)
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        target_date TEXT NOT NULL,
        source_application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
        service_status_type TEXT NOT NULL,
        display_text TEXT NOT NULL,
        effective_minutes INTEGER NOT NULL,
        policy_version_applied TEXT NOT NULL,
        is_locked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        CONSTRAINT uq_user_date_source UNIQUE (user_id, target_date, source_application_id)
      );

      CREATE INDEX IF NOT EXISTS idx_att_records_user_date ON attendance_records(user_id, target_date);
    `);

    // 6. application_types に LEAVE_SICK を確認・更新
    const existingType = db.prepare("SELECT id FROM application_types WHERE id = 'LEAVE_SICK'").get();
    if (!existingType) {
      db.prepare(`
        INSERT INTO application_types (id, name, description, default_route_id)
        VALUES ('LEAVE_SICK', '病気休暇 (山口県勤務条例第13条)', '病気・負傷による療養休暇申請 (公務・通勤災害認定連携)', 1)
      `).run();
    }

    // 7. policy_rules に SICK_LEAVE_ART13 の UNCONFIRMED skeleton を登録 (Fail-Closed)
    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO policy_rules (
        policy_code, authority_id, version, official_name, display_code, aggregation_category, max_minutes_per_day, effective_from, effective_to, rule_definition_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const skeletonSickLeave = JSON.stringify({
      legalBasis: 'YAMAGUCHI_WORK_ORDINANCE_ART13',
      status: 'UNCONFIRMED',
      hourlyAllowed: 'CONFIRMED', // 時間単位取得可能
      halfDayAllowed: 'UNCONFIRMED', // 半日は自治体Policy未定義時は不許可 (Fail-Closed)
      dailyDisplayRule: 'UNCONFIRMED',
      halfDayDisplayRule: 'UNCONFIRMED',
      hourlyDisplayRule: 'UNCONFIRMED',
      workTimeTreatment: 'EXEMPT',
      deductionRule: 'DEDUCT_WORK_TIME',
      monthlyAggregationRule: 'UNCONFIRMED',
      annualAggregationRule: 'UNCONFIRMED'
    });

    insertPolicy.run(
      'SICK_LEAVE_ART13',
      'DEFAULT_MUNICIPALITY',
      '2026.1',
      '病気休暇 (山口県勤務条例第13条)',
      'UNCONFIRMED',
      'UNCONFIRMED',
      465,
      '2026-04-01',
      '9999-12-31',
      skeletonSickLeave
    );

    // 8. permissions 登録
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('sick_leave.apply', '病気休暇の申請 (本人)');
    insertPerm.run('sick_leave.approve', '病気休暇の承認・決裁 (管理職)');
    insertPerm.run('sick_leave.disaster_update', '公務・通勤災害認定ステータスの更新・再評価実行 (管理職・事務室)');
    insertPerm.run('sick_leave.evidence_verify', '診断書等原本の確認・検証 (校長・教頭)');

    // role_permissions 付与
    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    // 一般教職員
    insertRolePerm.run('TEACHER', 'sick_leave.apply');
    // 教頭
    insertRolePerm.run('VICE_PRINCIPAL', 'sick_leave.apply');
    insertRolePerm.run('VICE_PRINCIPAL', 'sick_leave.approve');
    insertRolePerm.run('VICE_PRINCIPAL', 'sick_leave.evidence_verify');
    // 校長
    insertRolePerm.run('PRINCIPAL', 'sick_leave.apply');
    insertRolePerm.run('PRINCIPAL', 'sick_leave.approve');
    insertRolePerm.run('PRINCIPAL', 'sick_leave.disaster_update');
    insertRolePerm.run('PRINCIPAL', 'sick_leave.evidence_verify');
    // 事務室
    insertRolePerm.run('OFFICE', 'sick_leave.disaster_update');
    // 管理者
    insertRolePerm.run('ADMIN', 'sick_leave.apply');
    insertRolePerm.run('ADMIN', 'sick_leave.approve');
    insertRolePerm.run('ADMIN', 'sick_leave.disaster_update');
    insertRolePerm.run('ADMIN', 'sick_leave.evidence_verify');
  }
};
