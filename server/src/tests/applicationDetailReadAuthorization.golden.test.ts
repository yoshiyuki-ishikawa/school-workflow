import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

describe('Application Detail Read Authorization Canonical Golden Tests (GT-READ-01 〜 GT-READ-17)', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher2: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '佐藤 花子 (教員B)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const office: UserContext = {
    id: 5,
    username: 'office',
    displayName: '高橋 節子 (事務D)',
    roles: ['OFFICE', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const admin: UserContext = {
    id: 6,
    username: 'admin',
    displayName: 'システム管理者E',
    roles: ['ADMIN'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const chiefTeacher: UserContext = {
    id: 7,
    username: 'chief_teacher',
    displayName: '小林 繁 (教務主任)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  // 無関係な別事務職員 (ID: 99, 役職・Snapshot なし)
  const unrelatedOffice: UserContext = {
    id: 99,
    username: 'office_unrelated',
    displayName: '別事務 職員',
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const standardTripFormData = {
    destination: '県教育センター',
    purpose: '情報教育研修会参加',
    startDate: '2026-10-01',
    endDate: '2026-10-01',
    startAt: '2026-10-01T09:00:00',
    endAt: '2026-10-01T17:00:00',
    transport: '公共交通機関',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();

    // unrelatedOffice ユーザーを DB に登録
    db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, display_name, family_name, given_name, stamp_name, department, is_active, created_at)
      VALUES (99, 'office_unrelated', 'hash', '別事務 職員', '別事務', '職員', '別事務', '事務室', 1, '2026-04-01T00:00:00')
    `).run();
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (99, 'OFFICE')").run();
  });

  it('GT-READ-01: Subject 本人閲覧権限の保証 & 自己承認ブロック', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '教員研究会出張',
      formData: standardTripFormData,
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    // 1. 本人は詳細閲覧可能 (ALLOW / 200)
    const detail = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.statusCode, 200);
    assert.strictEqual(detail.data.application.id, appId);

    // 2. 本人による自己承認は禁止 (Action DENY)
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approveRes = WorkflowEngine.approveApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(approveRes.success, false);
    assert.strictEqual(approveRes.statusCode, 403);
  });

  it('GT-READ-02: Proxy Submitter 代理起票者閲覧権限の保証', () => {
    const proxyRes = WorkflowEngine.submitProxyApplication(vicePrincipal, {
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacher1.id,
      title: '教頭代理起票年休',
      formData: {
        unitType: 'DAY',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        reason: '私用',
      },
      proxyReason: '急病のため教頭代理',
    });
    assert.strictEqual(proxyRes.success, true);
    const appId = proxyRes.data.id;

    // 代理起票者は詳細閲覧可能 (ALLOW / 200)
    const detail = WorkflowEngine.getApplicationDetail(vicePrincipal, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.statusCode, 200);
    assert.strictEqual(detail.data.application.submitted_by_user_id, vicePrincipal.id);
  });

  it('GT-READ-03: Current OFFICE Actor (出張Step1) の詳細閲覧 ALLOW & 承認 Action ALLOW (P1直接解消)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（P1解消検証）',
      formData: standardTripFormData,
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    // Step 1 が PENDING であり、Snapshot 承認者が office (id: 5) であることを確認
    const step1 = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ? AND step_order = 1
    `).get(appId) as any;
    assert.strictEqual(step1.status, 'PENDING');
    assert.strictEqual(step1.approver_user_id_snapshot, office.id);

    // 【最重要検証】事務職員 office で詳細閲覧が ALLOW / 200 になること
    const detail = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.statusCode, 200);
    assert.ok(detail.data.application);
    assert.strictEqual(detail.data.application.title, '出張申請（P1解消検証）');

    // 承認 Action (REVIEW) も ALLOW
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approveRes = WorkflowEngine.approveApplication(office, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(approveRes.success, true);
  });

  it('GT-READ-04: Current CHIEF_TEACHER (大規模校Step1) の詳細閲覧 ALLOW & 承認 Action ALLOW', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: '大規模校年休申請',
      formData: {
        startDate: '2026-11-02',
        endDate: '2026-11-02',
        calculatedDays: 1,
        reason: '私事都合',
      },
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    // Step 1 は教務主任 (chiefTeacher: id 7, role: TEACHER)
    const step1 = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ? AND step_order = 1
    `).get(appId) as any;
    assert.strictEqual(step1.status, 'PENDING');
    assert.strictEqual(step1.approver_user_id_snapshot, chiefTeacher.id);

    // 非管理職教員アクター chiefTeacher で詳細閲覧が ALLOW / 200 になること
    const detail = WorkflowEngine.getApplicationDetail(chiefTeacher, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.statusCode, 200);

    // 承認 Action (REVIEW) も ALLOW
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approveRes = WorkflowEngine.approveApplication(chiefTeacher, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(approveRes.success, true);
  });

  it('GT-READ-05: Unrelated TEACHER (無関係教員) の詳細閲覧 DENY / 403 (IDOR防護)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '教員Aの個別出張',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // 当該申請に関与しない teacher2 は 403 で遮断
    const detail = WorkflowEngine.getApplicationDetail(teacher2, appId);
    assert.strictEqual(detail.success, false);
    assert.strictEqual(detail.statusCode, 403);
    assert.strictEqual(detail.message, 'この申請を閲覧する権限がありません');
  });

  it('GT-READ-06: Unrelated OFFICE (無関係事務職員) の詳細閲覧 DENY / 403 (Role漏洩防止)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '教員Aの出張',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // OFFICE ロールを持っていても、ステップに Snapshot アサインされていない unrelatedOffice は 403
    const detail = WorkflowEngine.getApplicationDetail(unrelatedOffice, appId);
    assert.strictEqual(detail.success, false);
    assert.strictEqual(detail.statusCode, 403);
    assert.strictEqual(detail.message, 'この申請を閲覧する権限がありません');
  });

  it('GT-READ-07: Current Cycle Future Participant の下見閲覧 ALLOW & 手番外 Action DENY', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '教員Aの出張（事前下見）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // 現在 Step 1 (事務 PENDING)。教頭 vicePrincipal は Step 2、校長 principal は Step 3 の Future Participant
    const step2 = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ? AND step_order = 2
    `).get(appId) as any;
    assert.strictEqual(step2.approver_user_id_snapshot, vicePrincipal.id);
    assert.strictEqual(step2.status, 'WAITING');

    // Future Participant である教頭は詳細閲覧 ALLOW / 200 (下見・事前確認)
    const detail = WorkflowEngine.getApplicationDetail(vicePrincipal, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.statusCode, 200);

    // しかし Step 1 の段階で教頭がフライング承認を試みた場合、Action は DENY
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approveRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(approveRes.success, false);
    assert.strictEqual(approveRes.statusCode, 403);
  });

  it('GT-READ-08: Current Cycle Past Participant の同サイクル内継続閲覧 ALLOW & 二重Action DENY', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '教員Aの出張（自ステップ完了後）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // Step 1: 事務 office が承認完了
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const ap1 = WorkflowEngine.approveApplication(office, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(ap1.success, true);

    // 現在 Step 2 (教頭確認中, Cycle 1 は依然として IN_PROGRESS)
    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(cycle.status, 'IN_PROGRESS');

    // 自ステップ処理済みの Past Participant である office は、詳細閲覧 ALLOW / 200
    const detail = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.statusCode, 200);

    // 既に処理済みのため、再度 approveApplication を呼んでも Action は DENY (403)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const doubleApprove = WorkflowEngine.approveApplication(office, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(doubleApprove.success, false);
    assert.strictEqual(doubleApprove.statusCode, 403);
  });

  it('GT-READ-09: Closed Cycle Only Participant の詳細閲覧 DENY / 403 (Historical ≠ Permanent Read)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '教員Aの出張（全承認完了後）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // Step 1: 事務承認
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });

    // Step 2: 教頭承認
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    // Step 3: 校長決裁
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    // 申請全体が TRIP_APPROVED となり、Cycle 1 は APPROVED (クローズ)
    const cycle1 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.strictEqual(cycle1.status, 'APPROVED');

    // IN_PROGRESS なサイクルが 0 件であることを確認
    const activeCycles = db.prepare("SELECT * FROM application_workflow_cycles WHERE application_id = ? AND status = 'IN_PROGRESS'").all(appId);
    assert.strictEqual(activeCycles.length, 0);

    // 非管理職の office ユーザー（Cycle 1 のみの参加者）は、決裁完了後は Read DENY / 403
    const detailOffice = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detailOffice.success, false);
    assert.strictEqual(detailOffice.statusCode, 403);
    assert.strictEqual(detailOffice.message, 'この申請を閲覧する権限がありません');

    // 一方、本人 (teacher1) および包括管理職 (principal) は依然として ALLOW / 200
    assert.strictEqual(WorkflowEngine.getApplicationDetail(teacher1, appId).statusCode, 200);
    assert.strictEqual(WorkflowEngine.getApplicationDetail(principal, appId).statusCode, 200);
  });

  it('GT-READ-10: Cancellation Current Actor の元申請閲覧 ALLOW & 取消決裁 Action ALLOW', () => {
    // 1. 通常出張承認完了
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（取消予定）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    // 2. 取消起票 (Cycle 2: CANCELLATION, IN_PROGRESS 生成)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const cancelReq = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '急遽用務中止のため取消',
    });
    assert.strictEqual(cancelReq.success, true);

    const cycle2 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    assert.strictEqual(cycle2.status, 'IN_PROGRESS');
    assert.strictEqual(cycle2.cycle_purpose, 'CANCELLATION');

    // 取消サイクルの Step 1 担当者である教頭 vicePrincipal は、元申請の詳細を閲覧可能 (ALLOW / 200)
    const detailVP = WorkflowEngine.getApplicationDetail(vicePrincipal, appId);
    assert.strictEqual(detailVP.success, true);
    assert.strictEqual(detailVP.statusCode, 200);
    assert.strictEqual(detailVP.data.application.title, '出張申請（取消予定）');
  });

  it('GT-READ-11: Previous Closed Cycle Only Participant の取消進行中詳細閲覧 DENY / 403', () => {
    // 1. 通常出張承認完了
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（元担当者閲覧遮断検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    // 2. 取消起票 (Cycle 2: CANCELLATION, IN_PROGRESS)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reason: '中止',
    });

    // Cycle 1 のみに参加していた事務 office は、Cycle 2 (教頭→校長) には参加していないため、Read DENY / 403
    const detailOffice = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detailOffice.success, false);
    assert.strictEqual(detailOffice.statusCode, 403);
    assert.strictEqual(detailOffice.message, 'この申請を閲覧する権限がありません');
  });

  it('GT-READ-12: Read / Action Decoupling (Read ALLOW が Action ALLOW を意味しないことの検証)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（認可分離検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // 教頭 vicePrincipal は Read ALLOW
    const detailVP = WorkflowEngine.getApplicationDetail(vicePrincipal, appId);
    assert.strictEqual(detailVP.success, true);
    assert.strictEqual(detailVP.statusCode, 200);

    // しかし現在は Step 1 (事務 office 手番) のため、教頭の Action は DENY (403)
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const approveVP = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(approveVP.success, false);
    assert.strictEqual(approveVP.statusCode, 403);
  });

  it('GT-READ-13A: Historical Snapshot Immutability (役職・ロール変更後も Snapshot が不変であること)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（Snapshot不変性検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    const step1Before = db.prepare(`
      SELECT approver_user_id_snapshot, approver_name_snapshot, approver_position_code_snapshot
      FROM application_approval_steps
      WHERE application_id = ? AND step_order = 1
    `).get(appId) as any;

    assert.strictEqual(step1Before.approver_user_id_snapshot, office.id);
    assert.strictEqual(step1Before.approver_position_code_snapshot, 'OFFICE_HEAD');

    // 人事異動シミュレーション: office ユーザーの役職を退任
    db.prepare('DELETE FROM user_positions WHERE user_id = ?').run(office.id);

    const step1After = db.prepare(`
      SELECT approver_user_id_snapshot, approver_name_snapshot, approver_position_code_snapshot
      FROM application_approval_steps
      WHERE application_id = ? AND step_order = 1
    `).get(appId) as any;

    // Snapshot 列は完全に維持される
    assert.deepStrictEqual(step1Before, step1After);
  });

  it('GT-READ-13B: Historical Participation ≠ Permanent Read (過去参加記録単体で恒久権限が付与されないこと)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（履歴と権限の分離検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // 全承認完了させてサイクルをクローズ
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    // DB上、office の action_by_user_id や approver_user_id_snapshot は確実に存在する
    const stepRow = db.prepare('SELECT approver_user_id_snapshot, action_by_user_id FROM application_approval_steps WHERE application_id = ? AND step_order = 1').get(appId) as any;
    assert.strictEqual(stepRow.approver_user_id_snapshot, office.id);
    assert.strictEqual(stepRow.action_by_user_id, office.id);

    // しかし、クローズ後は Read DENY / 403
    const detail = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detail.success, false);
    assert.strictEqual(detail.statusCode, 403);
  });

  it('GT-READ-14: Active Cycle Selection (status = IN_PROGRESS のサイクルのみが Participant 判定に使用されること)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（アクティブサイクル選択検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // Cycle 1 を手動で RETURNED (Closed) に設定し、Cycle 2 を IN_PROGRESS で作成
    db.prepare("UPDATE application_workflow_cycles SET status = 'RETURNED' WHERE application_id = ? AND approval_cycle = 1").run(appId);
    db.prepare(`
      INSERT INTO application_workflow_cycles (
        application_id, approval_cycle, workflow_source, workflow_policy_version_id,
        policy_evaluation_at, status, started_at, started_by_user_id
      ) VALUES (?, 2, 'NEW_POLICY_ENGINE', 'TRIP_STANDARD_V2', '2026-10-01', 'IN_PROGRESS', '2026-10-01', ?)
    `).run(appId, teacher1.id);

    // Cycle 2 には teacher2 のみをステップ登録 (office は未登録)
    db.prepare(`
      INSERT INTO application_approval_steps (
        application_id, approval_cycle, step_order, step_name, step_key,
        approver_user_id_snapshot, assigned_user_id, status, action_type, is_final_decision_step, required_role_id
      ) VALUES (?, 2, 1, '新審査', 'NEW_STEP', ?, ?, 'PENDING', 'REVIEW', 1, 'TEACHER')
    `).run(appId, teacher2.id, teacher2.id);

    // Cycle 2 の Snapshot 担当者である teacher2 は Read ALLOW / 200
    const detailT2 = WorkflowEngine.getApplicationDetail(teacher2, appId);
    assert.strictEqual(detailT2.success, true);
    assert.strictEqual(detailT2.statusCode, 200);

    // 終了した Cycle 1 にしかいない office は Read DENY / 403
    const detailOffice = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detailOffice.success, false);
    assert.strictEqual(detailOffice.statusCode, 403);
  });

  it('GT-READ-15: Snapshot Priority (approver_user_id_snapshot が assigned_user_id より優先されること)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（Snapshot優先度検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // Step 1 の DB レコードを直接書き換え:
    // approver_user_id_snapshot = office.id (5)
    // assigned_user_id = teacher2.id (2)
    db.prepare(`
      UPDATE application_approval_steps
      SET approver_user_id_snapshot = ?, assigned_user_id = ?
      WHERE application_id = ? AND step_order = 1
    `).run(office.id, teacher2.id, appId);

    // Snapshot 側 (office) は Read ALLOW / 200
    const detailOffice = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detailOffice.success, true);
    assert.strictEqual(detailOffice.statusCode, 200);

    // assigned_user_id 側 (teacher2) は Snapshot が存在するため無視され Read DENY / 403
    const detailT2 = WorkflowEngine.getApplicationDetail(teacher2, appId);
    assert.strictEqual(detailT2.success, false);
    assert.strictEqual(detailT2.statusCode, 403);
  });

  it('GT-READ-16: Fallback Case (approver_user_id_snapshot = NULL 時に assigned_user_id が機能すること)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（レガシーフォールバック検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // Step 1 の DB レコードを直接書き換え:
    // approver_user_id_snapshot = NULL
    // assigned_user_id = chiefTeacher.id (7)
    db.prepare(`
      UPDATE application_approval_steps
      SET approver_user_id_snapshot = NULL, assigned_user_id = ?
      WHERE application_id = ? AND step_order = 1
    `).run(chiefTeacher.id, appId);

    // Snapshot が NULL のため、assigned_user_id (chiefTeacher) でフォールバックして Read ALLOW / 200
    const detailChief = WorkflowEngine.getApplicationDetail(chiefTeacher, appId);
    assert.strictEqual(detailChief.success, true);
    assert.strictEqual(detailChief.statusCode, 200);
  });

  it('GT-READ-17: No Active Cycle (IN_PROGRESS Cycle 不在時、Participant 権限は不成立だが本人は閲覧可能)', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（アクティブ不在検証）',
      formData: standardTripFormData,
    });
    const appId = subRes.data.id;

    // サイクルを一時的に WITHDRAWN に更新
    db.prepare("UPDATE application_workflow_cycles SET status = 'WITHDRAWN' WHERE application_id = ?").run(appId);

    // 非管理職の office は Read DENY / 403
    const detailOffice = WorkflowEngine.getApplicationDetail(office, appId);
    assert.strictEqual(detailOffice.success, false);
    assert.strictEqual(detailOffice.statusCode, 403);

    // 申請本人 teacher1 は依然として Read ALLOW / 200
    const detailSubject = WorkflowEngine.getApplicationDetail(teacher1, appId);
    assert.strictEqual(detailSubject.success, true);
    assert.strictEqual(detailSubject.statusCode, 200);

    // 包括管理職 principal も依然として Read ALLOW / 200
    const detailPrincipal = WorkflowEngine.getApplicationDetail(principal, appId);
    assert.strictEqual(detailPrincipal.success, true);
    assert.strictEqual(detailPrincipal.statusCode, 200);
  });
});
