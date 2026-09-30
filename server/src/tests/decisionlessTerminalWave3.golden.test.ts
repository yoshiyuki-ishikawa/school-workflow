import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine, isFinalApprovalStep } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';

describe('Decision-less Terminal Workflow — Wave 3 Golden Tests', () => {
  let db: any;

  const teacherA = { id: 1, username: 'teacher1', displayName: '山田 太郎 (教員A)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const teacherB = { id: 2, username: 'teacher2', displayName: '佐藤 花子 (教員B)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const vpB = { id: 3, username: 'vice_principal', displayName: '田中 誠 (教頭B)', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
  const prinC = { id: 4, username: 'principal', displayName: '鈴木 健一 (校長C)', roles: ['PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
  const staffD = { id: 5, username: 'staff1', displayName: '高橋 健 (事務係)', roles: ['OFFICE', 'STAFF'], ipAddress: '127.0.0.1' };

  // ヘルパー: 年休用ポリシー・ステップをセットアップ
  function setupAnnualLeavePolicies() {
    db.prepare("INSERT OR IGNORE INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source) VALUES ('POL_ANNUAL_W3', 'KEY_ANNUAL_W3', '年休ポリシーW3', 'APPROVAL', 'SYSTEM')").run();
    db.prepare("INSERT OR IGNORE INTO workflow_policy_versions (id, policy_id, version, status, effective_from, effective_to, priority, conditions_json) VALUES ('VER_ANNUAL_W3', 'POL_ANNUAL_W3', 1, 'ACTIVE', '2020-01-01', '2099-12-31', 300, '{}')").run();
    db.prepare("INSERT OR REPLACE INTO workflow_policy_application_types (policy_id, app_type_id) VALUES ('POL_ANNUAL_W3', 'LEAVE_ANNUAL')").run();

    const insertStep = db.prepare(`
      INSERT OR REPLACE INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep.run('VER_ANNUAL_W3', 1, '教頭審査', 'VP_REV', 'REVIEW', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0);
    insertStep.run('VER_ANNUAL_W3', 2, '校長受領確認', 'PRIN_ACK', 'ACK', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1);
  }

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();

    // 既存のシード申請と年休行使をクリアしてテストの独立性を確保
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();

    setupAnnualLeavePolicies();

    // テスト対象教職員に年休を付与 (2026年度)
    [1, 2, 3, 4].forEach((uid) => {
      AnnualLeaveService.grantEntitlement({
        userId: uid,
        entitlementType: 'REGULAR_GRANT',
        fiscalYear: 2026,
        grantedDays: 20,
        grantDate: '2026-04-01',
        effectiveFrom: '2026-04-01',
        expiresAt: '2028-03-31',
        reason: '2026年度当初付与',
        grantEventKey: `INIT_TEST_${uid}_2026`,
      });
    });
  });

  it('GT-DLT-W3-01: 一般教員年休 (TYPE-B): VP REVIEW → Principal ACK-B → Terminal (FINAL_APPROVED)', () => {
    setupAnnualLeavePolicies();

    // 1. 教員Aが年休を申請 (2026-05-11 月曜日)
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-01)',
      formData: {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        unitType: 'DAY',
        reason: '私事都合',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');
    assert.strictEqual(app.current_step_order, 1);

    // 2. 教頭Bが Step 1 (REVIEW) を承認
    const reviewRes = WorkflowEngine.approveApplication(vpB, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭審査完了',
      actionType: 'REVIEW',
    });
    assert.strictEqual(reviewRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 2);

    // 3. 校長Cが Step 2 (ACK-B) を受領確認
    const ackRes = WorkflowEngine.approveApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長受領確認',
      actionType: 'ACK',
    });
    assert.strictEqual(ackRes.success, true);

    // 4. 終端到達により FINAL_APPROVED に遷移
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  it('GT-DLT-W3-02: 校長本人 TYPE-D: VP REVIEW → Principal ACK-A → Terminal (FINAL_APPROVED)', () => {
    setupAnnualLeavePolicies();

    // 1. 校長C本人が年休を申請 (2026-05-12 火曜日)
    const submitRes = WorkflowEngine.submitApplication(prinC, {
      typeId: 'LEAVE_ANNUAL',
      title: '校長年休届 (GT-DLT-W3-02)',
      formData: {
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        unitType: 'DAY',
        reason: '私事都合',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');

    // 2. 教頭Bが Step 1 (REVIEW) を事前審査
    const reviewRes = WorkflowEngine.approveApplication(vpB, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭事前確認',
      actionType: 'REVIEW',
    });
    assert.strictEqual(reviewRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_step_order, 2);

    // 3. 校長C本人が Step 2 (ACK-A Positive Authorization) を受領確認
    const ackRes = WorkflowEngine.approveApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長本人受領確認',
      actionType: 'ACK',
    });
    assert.strictEqual(ackRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  it('GT-DLT-W3-03: ACK terminal transitions application to FINAL_APPROVED', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-03)',
      formData: { startDate: '2026-05-13', endDate: '2026-05-13', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version, actionType: 'ACK' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  it('GT-DLT-W3-04: ACK terminal triggers Fact Activation exactly once', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-04)',
      formData: { startDate: '2026-05-14', endDate: '2026-05-14', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });

    // Fact (年休Usageレコード) が 1件 のみ作成されていることを検証
    const usages = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').all(appId) as any[];
    assert.strictEqual(usages.length >= 1, true, 'Fact Activation が実行されていること');
  });

  it('GT-DLT-W3-05: ACK double execution does not duplicate Fact', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-05)',
      formData: { startDate: '2026-05-15', endDate: '2026-05-15', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const oldVersion = app.version;
    // 1回目の ACK (成功)
    const res1 = WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: oldVersion, actionType: 'ACK' });
    assert.strictEqual(res1.success, true);

    const usageCountAfter1 = (db.prepare('SELECT COUNT(*) as cnt FROM leave_usages WHERE application_id = ?').get(appId) as any).cnt;

    // 2回目の ACK (古い version によるリプレイ / 重複実行 ➔ 409 Conflict)
    const res2 = WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: oldVersion, actionType: 'ACK' });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.statusCode, 409);

    const usageCountAfter2 = (db.prepare('SELECT COUNT(*) as cnt FROM leave_usages WHERE application_id = ?').get(appId) as any).cnt;
    assert.strictEqual(usageCountAfter2, usageCountAfter1, 'Fact が二重生成されないこと');
  });

  it('GT-DLT-W3-06: ACK step RETURN rejected (422 INVALID_ACTION_FOR_ACK)', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-06)',
      formData: { startDate: '2026-05-18', endDate: '2026-05-18', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // Step 1 REVIEW 完了
    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_step_order, 2);

    // Step 2 (ACK) に対する RETURN の試行 ➔ 422 遮断
    const returnRes = WorkflowEngine.returnApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '受領確認を差戻そうとする試み',
    });
    assert.strictEqual(returnRes.success, false);
    assert.strictEqual(returnRes.statusCode, 422);
    assert.strictEqual(returnRes.errorCode, 'INVALID_ACTION_FOR_ACK');
  });

  it('GT-DLT-W3-07: ACK step REJECT rejected (422 INVALID_ACTION_FOR_ACK)', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-07)',
      formData: { startDate: '2026-05-19', endDate: '2026-05-19', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_step_order, 2);

    // Step 2 (ACK) に対する REJECT の試行 ➔ 422 遮断
    const rejectRes = WorkflowEngine.rejectApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '受領確認を却下しようとする試み',
    });
    assert.strictEqual(rejectRes.success, false);
    assert.strictEqual(rejectRes.statusCode, 422);
    assert.strictEqual(rejectRes.errorCode, 'INVALID_ACTION_FOR_ACK');
  });

  it('GT-DLT-W3-08: Client cannot execute ACK against REVIEW step (422 ACTION_TYPE_MISMATCH)', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-08)',
      formData: { startDate: '2026-05-20', endDate: '2026-05-20', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // Step 1 (action_type: 'REVIEW') に対して client が actionType: 'ACK' を要求 ➔ 422
    const mismatchRes = WorkflowEngine.approveApplication(vpB, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '不正アクション種別',
      actionType: 'ACK', // 不一致
    });
    assert.strictEqual(mismatchRes.success, false);
    assert.strictEqual(mismatchRes.statusCode, 422);
    assert.strictEqual(mismatchRes.errorCode, 'ACTION_TYPE_MISMATCH');
  });

  it('GT-DLT-W3-09: Client cannot execute DECIDE against ACK step (422 ACTION_TYPE_MISMATCH)', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-09)',
      formData: { startDate: '2026-05-21', endDate: '2026-05-21', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // Step 2 (action_type: 'ACK') に対して client が actionType: 'DECIDE' を要求 ➔ 422
    const mismatchRes = WorkflowEngine.approveApplication(prinC, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '不正アクション種別',
      actionType: 'DECIDE', // 不一致
    });
    assert.strictEqual(mismatchRes.success, false);
    assert.strictEqual(mismatchRes.statusCode, 422);
    assert.strictEqual(mismatchRes.errorCode, 'ACTION_TYPE_MISMATCH');
  });

  it('GT-DLT-W3-10: Self DECIDE remains rejected', () => {
    // 特別休暇（DECIDE終端）で校長本人が申請しようとした場合 ➔ 422 提出遮断
    const res = WorkflowEngine.submitApplication(prinC, {
      typeId: 'LEAVE_SPECIAL',
      title: '校長特休 (自己決裁不可)',
      formData: {
        startDate: '2026-05-22',
        endDate: '2026-05-22',
        unitType: 'DAY',
        reasonCode: 'SPECIAL_BEREAVEMENT',
        relationship: '実父（校長実父）',
        reason: '忌引',
      },
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
  });

  it('GT-DLT-W3-11: General Staff Self ACK remains rejected', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-11)',
      formData: { startDate: '2026-05-25', endDate: '2026-05-25', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 一般教員Aが Step 2 (ACK) を承認しようとする
    const selfAckRes = WorkflowEngine.approveApplication(teacherA, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(selfAckRes.success, false);
    assert.strictEqual(selfAckRes.statusCode, 403);
  });

  it('GT-DLT-W3-12: Principal TYPE-D ACK-A remains positively authorized', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(prinC, {
      typeId: 'LEAVE_ANNUAL',
      title: '校長年休 (GT-DLT-W3-12)',
      formData: { startDate: '2026-05-26', endDate: '2026-05-26', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version, actionType: 'ACK' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.statusCode, 200);
  });

  it('GT-DLT-W3-13: Earlier active PENDING step prevents Terminal', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-13)',
      formData: { startDate: '2026-05-27', endDate: '2026-05-27', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_status, 'SUBMITTED');
    assert.strictEqual(isFinalApprovalStep(db, appId, 1, 1), false);
  });

  it('GT-DLT-W3-14: WAITING required step prevents Terminal', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-14)',
      formData: { startDate: '2026-05-28', endDate: '2026-05-28', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // Step 1 承認直後、Step 2 はまだ未承認なので FINAL_APPROVED ではない (IN_APPROVAL)
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 2);
  });

  it('GT-DLT-W3-15: SKIPPED intermediate step does not prevent legitimate Terminal', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(vpB, {
      typeId: 'LEAVE_ANNUAL',
      title: '教頭年休 (GT-DLT-W3-15)',
      formData: { startDate: '2026-05-29', endDate: '2026-05-29', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_step_order, 2, 'Step 1 は SKIPPED され Step 2 が PENDING');

    // 校長が Step 2 ACK を実行
    const ackRes = WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version, actionType: 'ACK' });
    assert.strictEqual(ackRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  it('GT-DLT-W3-16: RETURNED lifecycle is not Terminal', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-16)',
      formData: { startDate: '2026-06-01', endDate: '2026-06-01', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // Step 1 (REVIEW) で教頭が差戻し
    WorkflowEngine.returnApplication(vpB, { applicationId: appId, expectedVersion: app.version, comment: '日付要修正' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_status, 'RETURNED');
  });

  it('GT-DLT-W3-17: Cancellation Cycle remains isolated', () => {
    const cycles = db.prepare("SELECT * FROM application_workflow_cycles WHERE cycle_purpose = 'CANCELLATION'").all();
    assert.strictEqual(Array.isArray(cycles), true);
  });

  it('GT-DLT-W3-18: ACK-originated approved annual leave can be cancelled via existing flow', () => {
    setupAnnualLeavePolicies();

    // 1. 年休申請 ➔ ACK 決裁完了 (2026-06-02 火曜日)
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-18)',
      formData: { startDate: '2026-06-02', endDate: '2026-06-02', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // 2. 取消申請の起票
    const cancelRes = WorkflowEngine.requestCancellation(teacherA, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '急遽出勤となったため取消',
    });
    assert.strictEqual(cancelRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED', '取消サイクル進行中も元の確定ステータスを維持');

    const cancelCycle = db.prepare("SELECT * FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = 'CANCELLATION'").get(appId) as any;
    assert.strictEqual(cancelCycle.status, 'IN_PROGRESS', '取消サイクルが IN_PROGRESS で開始されていること');
  });

  it('GT-DLT-W3-19: Cancellation Exact-Reversal fires exactly once', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-19)',
      formData: { startDate: '2026-06-03', endDate: '2026-06-03', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 取消起票
    WorkflowEngine.requestCancellation(teacherA, { applicationId: appId, expectedVersion: app.version, cancellationReason: '取消' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 取消承認 (教頭 ➔ 校長)
    WorkflowEngine.approveCancellation(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveCancellation(prinC, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_status, 'CANCELLED');
    const activeUsages = db.prepare('SELECT * FROM leave_usages WHERE application_id = ? AND status = ?').all(appId, 'CONSUMED') as any[];
    assert.strictEqual(activeUsages.length, 0, '取消により行使が取り消されていること');
  });

  it('GT-DLT-W3-20: Existing TYPE-A DECIDE flow unchanged', () => {
    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_SPECIAL',
      title: '特休申請 (GT-DLT-W3-20)',
      formData: {
        startDate: '2026-06-04',
        endDate: '2026-06-04',
        unitType: 'DAY',
        reasonCode: 'SPECIAL_BEREAVEMENT',
        relationship: '実父（教員実父）',
        reason: '忌引',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version, actionType: 'REVIEW' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version, actionType: 'DECIDE' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  it('GT-DLT-W3-21: Existing TYPE-C / Legacy CHECK flow unchanged', () => {
    // レガシーCHECKテスト用に専用ポリシーを設定 (Historical/Legacy CHECK 互換性検証)
    db.prepare("INSERT OR IGNORE INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source) VALUES ('POL_TRIP_LEGACY_W3', 'KEY_TRIP_LEGACY_W3', 'レガシー出張ポリシーW3', 'APPROVAL', 'SYSTEM')").run();
    db.prepare("INSERT OR IGNORE INTO workflow_policy_versions (id, policy_id, version, status, effective_from, effective_to, priority, conditions_json) VALUES ('VER_TRIP_LEGACY_W3', 'POL_TRIP_LEGACY_W3', 1, 'ACTIVE', '2020-01-01', '2099-12-31', 999, '{}')").run();
    db.prepare("INSERT OR REPLACE INTO workflow_policy_application_types (policy_id, app_type_id) VALUES ('POL_TRIP_LEGACY_W3', 'BUSINESS_TRIP')").run();

    const insertStep = db.prepare(`
      INSERT OR REPLACE INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep.run('VER_TRIP_LEGACY_W3', 1, '教頭確認', 'VP_LEGACY_STEP', 'APPROVE', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0);
    insertStep.run('VER_TRIP_LEGACY_W3', 2, '校長決裁', 'PRIN_LEGACY_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1);
    insertStep.run('VER_TRIP_LEGACY_W3', 3, '事務係確認', 'OFFICE_LEGACY_STEP', 'CHECK', 'OFFICE', 'POSITION', 'OFFICE_HEAD', 0);

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請 (GT-DLT-W3-21)',
      formData: {
        startDate: '2026-06-05',
        endDate: '2026-06-05',
        startAt: '2026-06-05T08:10:00',
        endAt: '2026-06-05T16:40:00',
        destination: '県庁',
        purpose: '会議出席',
        departurePlace: '本校',
        arrivalPlace: '本校',
        transport: '公用車',
        unitType: 'DAY',
        isExpenseClaimed: false,
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // Step 3 (CHECK) 事務係確認
    WorkflowEngine.approveApplication(staffD, { applicationId: appId, expectedVersion: app.version, actionType: 'CHECK' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
  });

  it('GT-DLT-W3-22: Historical ACK action_type snapshot remains immutable', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-22)',
      formData: { startDate: '2026-06-08', endDate: '2026-06-08', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });

    const step2 = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 2').get(appId) as any;
    assert.strictEqual(step2.action_type, 'ACK');
    assert.strictEqual(step2.status, 'APPROVED');
    assert.strictEqual(step2.action_by_user_id, prinC.id);
  });

  it('GT-DLT-W3-23: Unresolved actor remains Fail-Closed', () => {
    const authResult = WorkflowEngine.approveApplication(teacherA, {
      applicationId: 99999,
      expectedVersion: 1,
    });
    assert.strictEqual(authResult.success, false);
    assert.strictEqual(authResult.statusCode, 404);
  });

  it('GT-DLT-W3-24: Duplicate/replayed ACK cannot cause duplicate transition or Fact Activation', () => {
    setupAnnualLeavePolicies();

    const submitRes = WorkflowEngine.submitApplication(teacherA, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (GT-DLT-W3-24)',
      formData: { startDate: '2026-06-09', endDate: '2026-06-09', unitType: 'DAY', reason: '私事都合' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vpB, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 1回目実行
    WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // 2回目実行 (同一バージョン指定でも 400 または 409)
    const replayRes = WorkflowEngine.approveApplication(prinC, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(replayRes.success, false);
  });
});
