import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, seedDatabase, getDb } from '../db';
import { WorkflowEngine, UserContext } from '../workflow/engine';

describe('公文書規程名称 撤去・Write停止・Snapshot純化 回帰テスト (INV-026, INV-016, INV-008)', () => {
  const teacherA: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '192.168.1.100',
  };
  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL'],
    ipAddress: '192.168.1.102',
  };
  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL'],
    ipAddress: '192.168.1.103',
  };
  const admin: UserContext = {
    id: 5,
    username: 'admin',
    displayName: '管理者D',
    roles: ['ADMIN'],
    ipAddress: '192.168.1.104',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM audit_logs').run();

    const tUser = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    if (tUser) teacherA.id = tUser.id;
    const pUser = db.prepare('SELECT id FROM users WHERE username = ?').get('principal') as any;
    if (pUser) principal.id = pUser.id;

    // 初期状態: DB カラムには初期値が存在するが、アプリケーション層からは Write を停止
    db.prepare(`
      INSERT INTO system_settings (
        id, school_name, municipality_name, board_of_education_name,
        app_title, leave_regulation_name, travel_regulation_name, attendance_regulation_name,
        version, updated_at
      ) VALUES (
        1, '〇〇市立第一小学校', '〇〇市', '〇〇市教育委員会',
        '第一小学校 服務管理システム', '第一小学校服務規程第15条', '第一小学校旅費規程', '第一小学校勤務時間及び服務規程',
        1, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        school_name = excluded.school_name,
        municipality_name = excluded.municipality_name,
        board_of_education_name = excluded.board_of_education_name,
        app_title = excluded.app_title,
        leave_regulation_name = excluded.leave_regulation_name,
        travel_regulation_name = excluded.travel_regulation_name,
        attendance_regulation_name = excluded.attendance_regulation_name,
        version = 1,
        updated_at = excluded.updated_at
    `).run();
  });

  it('1. [Write停止検証] 旧クライアントから規程名称が送信されても DB 既存値が書き換わらないこと', () => {
    const db = getDb();

    // 更新前の DB 値を確認
    const before = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    assert.strictEqual(before.leave_regulation_name, '第一小学校服務規程第15条');
    assert.strictEqual(before.travel_regulation_name, '第一小学校旅費規程');
    assert.strictEqual(before.attendance_regulation_name, '第一小学校勤務時間及び服務規程');

    // 新しい更新クエリのシミュレーション（学校名・自治体名等のみ更新し、規程名称は SET 句に含まれない）
    const cleanSchoolName = '〇〇市立新設小学校';
    const cleanMunicipalityName = '〇〇新設市';
    const cleanBoardOfEducationName = '〇〇新設市教育委員会';
    const cleanAppTitle = '新設小学校 服務管理システム';
    const newVersion = before.version + 1;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE system_settings
      SET
        school_name = ?,
        municipality_name = ?,
        board_of_education_name = ?,
        app_title = ?,
        version = ?,
        updated_at = ?,
        updated_by_user_id = ?
      WHERE id = 1 AND version = ?
    `).run(
      cleanSchoolName,
      cleanMunicipalityName,
      cleanBoardOfEducationName,
      cleanAppTitle,
      newVersion,
      now,
      admin.id,
      before.version
    );

    // 更新後の DB 値を確認
    const after = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    assert.strictEqual(after.school_name, '〇〇市立新設小学校');
    assert.strictEqual(after.version, 2);
    // 規程名称は DB 内で既存の初期値がそのまま保護されている（Write 停止の確認）
    assert.strictEqual(after.leave_regulation_name, '第一小学校服務規程第15条');
    assert.strictEqual(after.travel_regulation_name, '第一小学校旅費規程');
    assert.strictEqual(after.attendance_regulation_name, '第一小学校勤務時間及び服務規程');
  });

  it('2. [新規Snapshot検証] 改修後の新規確定申請のスナップショットに規程名称が含まれないこと', () => {
    const db = getDb();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (規程名称撤去後)',
      formData: { unitType: 'DAY', calculatedDays: 1, startDate: '2026-06-01', endDate: '2026-06-01' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const finalApproveRes = WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(finalApproveRes.success, true);

    const approvedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(approvedApp.current_status, 'FINAL_APPROVED');
    assert.ok(approvedApp.organization_snapshot);

    const snapshot = JSON.parse(approvedApp.organization_snapshot);
    assert.strictEqual(snapshot.schoolName, '〇〇市立第一小学校');
    assert.strictEqual(snapshot.municipalityName, '〇〇市');
    assert.strictEqual(snapshot.boardOfEducationName, '〇〇市教育委員会');
    assert.strictEqual(snapshot.appTitle, '第一小学校 服務管理システム');
    assert.strictEqual(snapshot.version, 1);
    // 規程名称プロパティが一切存在しないこと
    assert.strictEqual(snapshot.leaveRegulationName, undefined);
    assert.strictEqual(snapshot.travelRegulationName, undefined);
    assert.strictEqual(snapshot.attendanceRegulationName, undefined);
  });

  it('3. [月次確定Snapshot検証] 新規月次確定のスナップショットに規程名称が含まれないこと', () => {
    const db = getDb();
    const targetMonth = '2026-06';
    db.prepare('DELETE FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?').run(teacherA.id, targetMonth);

    const confirmRes = WorkflowEngine.confirmMonthlyAttendance(principal, {
      userId: teacherA.id,
      yearMonth: targetMonth,
      comment: '6月度出勤簿点検完了',
    });
    assert.strictEqual(confirmRes.success, true);

    const monthly = db.prepare('SELECT * FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?').get(teacherA.id, targetMonth) as any;
    assert.strictEqual(monthly.status, 'CONFIRMED');
    assert.ok(monthly.organization_snapshot);

    const snapshot = JSON.parse(monthly.organization_snapshot);
    assert.strictEqual(snapshot.schoolName, '〇〇市立第一小学校');
    assert.strictEqual(snapshot.attendanceRegulationName, undefined);
    assert.strictEqual(snapshot.leaveRegulationName, undefined);
  });

  it('4. [過去Snapshot不変性] 規程名称を含む過去スナップショットが破壊されないこと', () => {
    const db = getDb();

    // 過去スナップショットを持つレコードを直接挿入
    const legacySnapshot = JSON.stringify({
      schoolName: '旧・〇〇市立第一小学校',
      municipalityName: '旧・〇〇市',
      boardOfEducationName: '旧・〇〇市教育委員会',
      appTitle: '旧・第一小学校 服務管理システム',
      leaveRegulationName: '旧・服務規程第15条',
      travelRegulationName: '旧・旅費規程',
      attendanceRegulationName: '旧・勤務時間規程',
      version: 1,
    });

    db.prepare(`
      INSERT INTO applications (
        id, type_id, submitted_by_user_id, subject_user_id, title, form_data,
        current_status, current_step_order, version, created_at, updated_at, organization_snapshot
      ) VALUES (
        999, 'LEAVE_ANNUAL', 1, 1, '過去確定申請', '{}',
        'FINAL_APPROVED', 2, 1, '2025-01-10T10:00:00.000Z', '2025-01-10T10:00:00.000Z', ?
      )
    `).run(legacySnapshot);

    const row = db.prepare('SELECT organization_snapshot FROM applications WHERE id = 999').get() as any;
    assert.strictEqual(row.organization_snapshot, legacySnapshot);

    const parsed = JSON.parse(row.organization_snapshot);
    assert.strictEqual(parsed.schoolName, '旧・〇〇市立第一小学校');
    assert.strictEqual(parsed.leaveRegulationName, '旧・服務規程第15条');
  });
});
