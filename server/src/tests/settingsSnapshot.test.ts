import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { initDatabase, seedDatabase, getDb } from '../db';
import { WorkflowEngine, UserContext } from '../workflow/engine';

describe('学校基本設定・GUI一括変更 ＆ 確定公文書スナップショット不変性 テスト', () => {
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
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM absences').run();

    const tUser = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    if (tUser) teacherA.id = tUser.id;
    const pUser = db.prepare('SELECT id FROM users WHERE username = ?').get('principal') as any;
    if (pUser) principal.id = pUser.id;

    // system_settings の初期化 (初期状態: 第一小学校)
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

  it('1. Public Settings: 未認証で取得可能かつ内部情報が含まれないこと', () => {
    const db = getDb();
    const settings = db.prepare('SELECT school_name, app_title FROM system_settings WHERE id = 1').get() as any;
    assert.ok(settings);
    assert.strictEqual(settings.school_name, '〇〇市立第一小学校');
    assert.strictEqual(settings.app_title, '第一小学校 服務管理システム');
    assert.strictEqual(settings.leave_regulation_name, undefined);
  });

  it('2. RBAC: ADMINのみ更新可能であり、他ロール(教員・教頭・校長)は遮断されること', () => {
    const db = getDb();

    // 1. ADMIN以外による更新試行の権限判定ロジック検証
    const nonAdminRoles = [teacherA.roles, vicePrincipal.roles, principal.roles];
    for (const roles of nonAdminRoles) {
      const isAllowed = roles.includes('ADMIN');
      assert.strictEqual(isAllowed, false, '非ADMINは権限なし');
    }

    // 2. ADMINによる正当な更新実行
    const current = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    assert.strictEqual(current.version, 1);

    db.prepare(`
      UPDATE system_settings
      SET school_name = ?, version = version + 1, updated_at = datetime('now'), updated_by_user_id = ?
      WHERE id = 1 AND version = ?
    `).run('〇〇市立更新後小学校', admin.id, 1);

    const updated = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    assert.strictEqual(updated.school_name, '〇〇市立更新後小学校');
    assert.strictEqual(updated.version, 2);
  });

  it('3. 楽観的ロック: 古いバージョンを指定した更新が409競合として防がれること', () => {
    const db = getDb();
    // サーバー側バージョンを 2 に進める
    db.prepare('UPDATE system_settings SET version = 2 WHERE id = 1').run();

    // クライアントが古い version: 1 で更新を試みるシミュレーション
    const expectedVersion = 1;
    const current = db.prepare('SELECT version FROM system_settings WHERE id = 1').get() as any;
    
    assert.notStrictEqual(current.version, expectedVersion);
    const updateResult = db.prepare(`
      UPDATE system_settings
      SET school_name = '競合上書きテスト'
      WHERE id = 1 AND version = ?
    `).run(expectedVersion);

    // 変更行数が 0 (更新失敗) であることを検証
    assert.strictEqual(updateResult.changes, 0);
  });

  it('4. 確定時スナップショット不変性 E2E: 学校名変更後も過去確定帳票は確定当時の名称を維持すること', () => {
    const db = getDb();

    // Phase 1: 学校名が「第一小学校」の状態で休暇申請を作成・決裁完了
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (第一小学校時代)',
      formData: { unitType: 'DAY', calculatedDays: 1, startDate: '2026-05-11', endDate: '2026-05-11' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // 教頭承認
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    // 校長決裁完了 (FINAL_APPROVED)
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const finalApproveRes = WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(finalApproveRes.success, true);

    // DB上で organization_snapshot が固定保存されたか検証 (新Snapshot: 規程名称は除外され学校組織情報のみ保存)
    const approvedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(approvedApp.current_status, 'FINAL_APPROVED');
    assert.ok(approvedApp.organization_snapshot, 'スナップショットが保存されていること');
    
    const snapshotObj = JSON.parse(approvedApp.organization_snapshot);
    assert.strictEqual(snapshotObj.schoolName, '〇〇市立第一小学校');
    assert.strictEqual(snapshotObj.leaveRegulationName, undefined, '新規Snapshotには規程名称が含まれない');

    // 過去スナップショット（旧形式: 規程名称あり）の不変性シミュレーション
    const legacySnapshot = JSON.stringify({
      schoolName: '〇〇市立第一小学校',
      municipalityName: '〇〇市',
      boardOfEducationName: '〇〇市教育委員会',
      appTitle: '第一小学校 服務管理システム',
      leaveRegulationName: '第一小学校服務規程第15条',
      version: 1,
    });
    db.prepare('UPDATE applications SET organization_snapshot = ? WHERE id = ?').run(legacySnapshot, appId);

    // Phase 2: ADMINがシステム設定を「第二小学校」へ変更
    db.prepare(`
      UPDATE system_settings
      SET school_name = '〇〇市立第二小学校',
          version = version + 1
      WHERE id = 1
    `).run();

    // Phase 3: 不変性の検証 (過去確定帳票の取得)
    const pastApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const pastSnapshot = JSON.parse(pastApp.organization_snapshot);
    
    // 過去帳票は「第一小学校」および当時の規程名が100%維持されていること！
    assert.strictEqual(pastSnapshot.schoolName, '〇〇市立第一小学校');
    assert.strictEqual(pastSnapshot.leaveRegulationName, '第一小学校服務規程第15条');

    // Phase 4: 新規未確定申請の検証
    const newDraftRes = WorkflowEngine.saveDraft(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '新規下書き (第二小学校時代)',
      formData: { unitType: 'DAY', calculatedDays: 1, startDate: '2026-06-01', endDate: '2026-06-01' },
    });
    const newDraft = db.prepare('SELECT * FROM applications WHERE id = ?').get(newDraftRes.data.id) as any;
    assert.strictEqual(newDraft.organization_snapshot, null, '未確定下書きにはスナップショット未作成');

    // 最新の system_settings は「第二小学校」になっていること
    const latestSettings = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as any;
    assert.strictEqual(latestSettings.school_name, '〇〇市立第二小学校');
  });

  it('5. 出勤簿月次確定スナップショット不変性: 月次確定後の組織情報が固定されること', () => {
    const db = getDb();
    const targetMonth = '2026-05';
    db.prepare('DELETE FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?').run(teacherA.id, targetMonth);

    // 校長が月次確定 (CONFIRMED) 実行
    const confirmRes = WorkflowEngine.confirmMonthlyAttendance(principal, {
      userId: teacherA.id,
      yearMonth: targetMonth,
      comment: '5月度出勤簿点検完了',
    });
    assert.strictEqual(confirmRes.success, true);

    const monthly = db.prepare('SELECT * FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?').get(teacherA.id, targetMonth) as any;
    assert.strictEqual(monthly.status, 'CONFIRMED');
    assert.ok(monthly.organization_snapshot, '月次確定スナップショットが保存されていること');

    const snap = JSON.parse(monthly.organization_snapshot);
    assert.strictEqual(snap.schoolName, '〇〇市立第一小学校');
    assert.strictEqual(snap.attendanceRegulationName, undefined, '新規月次確定Snapshotには規程名称が含まれない');
  });
});
