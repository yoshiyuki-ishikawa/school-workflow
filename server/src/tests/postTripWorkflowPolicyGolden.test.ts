import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

describe('Business Trip POST-TRIP Policy Remediation Golden & Safety Tests (GT-BT-MIG-01..06, GT-BT-WF-01..12)', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
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

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  // =========================================================================
  // 1. Migration Safety Golden Tests (GT-BT-MIG-01 〜 GT-BT-MIG-06)
  // =========================================================================
  it('GT-BT-MIG-01..05: Migration 027 整合性・FKチェック・CHECK制約の検証', () => {
    // 1. Foreign Key Check
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
    assert.equal(fkCheck.length, 0, 'Foreign key violations detected');

    // 2. Policy Purpose CHECK constraint verification
    const policies = db.prepare('SELECT id, policy_purpose FROM workflow_policies').all() as any[];
    assert.ok(policies.length > 0);
    const postPolicy = policies.find((p) => p.id === 'TRIP_REPORT_STANDARD');
    assert.ok(postPolicy, 'TRIP_REPORT_STANDARD policy exists');
    assert.equal(postPolicy.policy_purpose, 'POST_TRIP_REPORT');

    // 3. Invalid policy_purpose must throw
    assert.throws(() => {
      db.prepare(`
        INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
        VALUES ('INVALID_PURPOSE_TEST', 'INVALID_PURPOSE_TEST', '無効テスト', 'INVALID_PURPOSE', 'CUSTOM')
      `).run();
    });

    // 4. Invalid cycle_purpose must throw
    assert.throws(() => {
      db.prepare(`
        INSERT INTO application_workflow_cycles (application_id, approval_cycle, cycle_purpose, workflow_source)
        VALUES (9999, 1, 'INVALID_PURPOSE', 'LEGACY_SNAPSHOT')
      `).run();
    });
  });

  it('GT-BT-MIG-06: POST_TRIP_REPORT Purpose の Policy / Cycle 正常保存確認', () => {
    const postPolicy = db.prepare('SELECT * FROM workflow_policies WHERE id = ?').get('TRIP_REPORT_STANDARD') as any;
    assert.equal(postPolicy.policy_purpose, 'POST_TRIP_REPORT');

    const appTypes = db.prepare('SELECT * FROM workflow_policy_application_types WHERE policy_id = ?').all('TRIP_REPORT_STANDARD') as any[];
    assert.equal(appTypes.length, 1);
    assert.equal(appTypes[0].app_type_id, 'BUSINESS_TRIP');

    const version = db.prepare("SELECT * FROM workflow_policy_versions WHERE policy_id = 'TRIP_REPORT_STANDARD' AND status = 'ACTIVE'").get() as any;
    assert.equal(version.status, 'ACTIVE');

    const steps = db.prepare('SELECT * FROM workflow_policy_steps WHERE policy_version_id = ? ORDER BY step_order ASC').all(version.id) as any[];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].step_order, 1);
    assert.equal(steps[1].step_order, 2);
    assert.equal(steps[2].step_order, 3);
  });

  // =========================================================================
  // 2. Workflow Policy Lifecycle Golden Tests (GT-BT-WF-01 〜 GT-BT-WF-12)
  // =========================================================================

  it('GT-BT-WF-02: PRE 3 Steps (教頭→校長→事務) ➔ POST 3 Steps (教頭→校長→事務) の標準完結ライフサイクル', () => {
    // 1. 出張申請提出 (PRE-TRIP: Cycle 1, Step 1..3)
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（研修会）',
      formData: {
        destination: '県教育センター',
        purpose: '情報教育研修会参加',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        startAt: '2026-10-01T09:00:00',
        endAt: '2026-10-01T17:00:00',
        transport: '公共交通機関',
      },
    });
    assert.equal(submitRes.success, true);
    const appId = submitRes.data.id;

    // PRE Step 1 (事務審査)
    const app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app1.current_step_order, 1);
    assert.equal(app1.current_status, 'SUBMITTED');
    const ap1 = WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app1.version });
    assert.equal(ap1.success, true);

    // PRE Step 2 (教頭確認)
    const app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app2.current_step_order, 2);
    assert.equal(app2.current_status, 'IN_APPROVAL');
    const ap2 = WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app2.version });
    assert.equal(ap2.success, true);

    // PRE Step 3 (校長決裁)
    const app3 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app3.current_step_order, 3);
    assert.equal(app3.current_status, 'IN_APPROVAL');
    const ap3 = WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app3.version });
    assert.equal(ap3.success, true);

    // 旅行命令成立 (TRIP_APPROVED, Cycle 1 APPROVED)
    const appPreDone = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(appPreDone.current_status, 'TRIP_APPROVED');
    assert.equal(appPreDone.report_status, 'UNSUBMITTED');

    const cycle1 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.equal(cycle1.status, 'APPROVED');
    assert.equal(cycle1.cycle_purpose, 'APPROVAL');

    // 2. 復命書提出 (POST-TRIP: Cycle 2, Step 1..3)
    const repRes = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: appPreDone.version,
      reportDate: '2026-10-02',
      reportResult: '無事研修を修了しました。',
      actualMatchesPlan: true,
    });
    assert.equal(repRes.success, true);

    const appPost1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(appPost1.current_status, 'TRIP_APPROVED');
    assert.equal(appPost1.report_status, 'REPORT_SUBMITTED');
    assert.equal(appPost1.current_step_order, 1, 'POST Cycle 2 starts at step_order = 1');

    const cycle2 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    assert.equal(cycle2.status, 'IN_PROGRESS');
    assert.equal(cycle2.cycle_purpose, 'POST_TRIP_REPORT');
    assert.equal(cycle2.workflow_policy_version_id, 'TRIP_REPORT_STANDARD_V2');

    const postSteps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 ORDER BY step_order ASC').all(appId) as any[];
    assert.equal(postSteps.length, 3);
    assert.equal(postSteps[0].step_order, 1);
    assert.equal(postSteps[0].status, 'PENDING');
    assert.equal(postSteps[1].step_order, 2);
    assert.equal(postSteps[1].status, 'WAITING');
    assert.equal(postSteps[2].step_order, 3);
    assert.equal(postSteps[2].status, 'WAITING');

    // POST Step 1 (事務審査)
    const postAp1 = WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: appPost1.version });
    assert.equal(postAp1.success, true);

    const appPost2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(appPost2.current_step_order, 2);

    // POST Step 2 (教頭確認)
    const postAp2 = WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: appPost2.version });
    assert.equal(postAp2.success, true);

    const appPost3 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(appPost3.current_step_order, 3);

    // POST Step 3 (校長決裁)
    const postAp3 = WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: appPost3.version });
    assert.equal(postAp3.success, true);

    // 復命完了 (REPORT_FINAL_APPROVED, Cycle 2 APPROVED)
    const appFinal = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(appFinal.current_status, 'TRIP_APPROVED');
    assert.equal(appFinal.report_status, 'REPORT_FINAL_APPROVED');

    const cycle2Done = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    assert.equal(cycle2Done.status, 'APPROVED');
  });

  it('GT-BT-WF-05: POST Policy 未設定時、submitReport が HTTP 400 (WORKFLOW_POLICY_UNRESOLVED) で Fail-Closed', () => {
    // TRIP_REPORT_STANDARD のバインディングを解除して 0件にする
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'TRIP_REPORT_STANDARD'").run();

    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請',
      formData: {
        destination: 'テスト先',
        purpose: 'テスト',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        startAt: '2026-10-01T09:00:00',
        endAt: '2026-10-01T17:00:00',
        transport: '公共交通機関',
      },
    });
    const appId = submitRes.data.id;

    // PRE 承認を完了
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_status, 'TRIP_APPROVED');

    // 復命書提出 ➔ Policy 未設定のため Fail-Closed
    const repRes = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-02',
      reportResult: '結果報告',
      actualMatchesPlan: true,
    });

    assert.equal(repRes.success, false);
    assert.equal(repRes.statusCode, 400);
    assert.equal(repRes.errorCode, 'WORKFLOW_POLICY_UNRESOLVED');
  });

  it('GT-BT-WF-09 & GT-BT-WF-10 & GT-BT-WF-11: 復命差戻し (Return) ➔ Policy改定 (v2) ➔ 再提出 (Resubmit) で最新 Active Version (v2) が新 Cycle に適用されること', () => {
    // 1. 出張申請 ＆ 承認
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請',
      formData: {
        destination: '県教委',
        purpose: '打合せ',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        startAt: '2026-10-01T09:00:00',
        endAt: '2026-10-01T17:00:00',
        transport: '公共交通機関',
      },
    });
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 2. 復命書提出 (Cycle 2, v1: 3 steps)
    const rep1 = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-02',
      reportResult: '初回復命',
      actualMatchesPlan: true,
    });
    assert.equal(rep1.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.report_status, 'REPORT_SUBMITTED');

    // 3. 事務が復命書を差戻し (Return) - Step 1 が事務 REVIEW のため事務が差戻し
    const retRes = WorkflowEngine.returnApplication(office, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '記載内容を修正してください',
    });
    assert.equal(retRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.report_status, 'REPORT_RETURNED');
    assert.equal(app.current_status, 'TRIP_APPROVED', 'current_status remains TRIP_APPROVED');

    const cycle2 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    assert.equal(cycle2.status, 'RETURNED');
    assert.equal(cycle2.return_reason, '記載内容を修正してください');

    // 4. 管理者が復命ポリシーを v3 (2 steps: 教頭→校長) に改定・ACTIVE 化
    db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE policy_id = 'TRIP_REPORT_STANDARD' AND status = 'ACTIVE'").run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('TRIP_REPORT_STANDARD_V3', 'TRIP_REPORT_STANDARD', 3, 'ACTIVE', 300, '2000-01-01', '9999-12-31', '{}')
    `).run();
    const insertStep = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep.run('TRIP_REPORT_STANDARD_V3', 1, '復命 教頭確認', 'VP_REPORT_STEP_V3', 'APPROVE', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0);
    insertStep.run('TRIP_REPORT_STANDARD_V3', 2, '復命 校長決裁', 'PRINCIPAL_REPORT_STEP_V3', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1);

    // 5. 教員が復命書を再提出 (Resubmit ➔ Cycle 3)
    const rep2 = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-02',
      reportResult: '修正後の復命報告',
      actualMatchesPlan: true,
    });
    assert.equal(rep2.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.report_status, 'REPORT_SUBMITTED');
    assert.equal(app.current_step_order, 1);

    // Cycle 3 の検証 (v3 が適用され、Step 数は 2段階)
    const cycle3 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 3').get(appId) as any;
    assert.equal(cycle3.status, 'IN_PROGRESS');
    assert.equal(cycle3.cycle_purpose, 'POST_TRIP_REPORT');
    assert.equal(cycle3.workflow_policy_version_id, 'TRIP_REPORT_STANDARD_V3');

    const cycle3Steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 3 ORDER BY step_order ASC').all(appId) as any[];
    assert.equal(cycle3Steps.length, 2, 'Cycle 3 has 2 steps from v3');

    // 過去 Cycle 2 の不変性確認 (Historical Immutability)
    const cycle2Again = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    assert.equal(cycle2Again.workflow_policy_version_id, 'TRIP_REPORT_STANDARD_V2');
    const cycle2Steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 ORDER BY step_order ASC').all(appId) as any[];
    assert.equal(cycle2Steps.length, 3, 'Cycle 2 steps immutable');

    // Cycle 3 の承認完結 (教頭→校長)
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_step_order, 2);

    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.report_status, 'REPORT_FINAL_APPROVED');

    const cycle3Done = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 3').get(appId) as any;
    assert.equal(cycle3Done.status, 'APPROVED');
  });

  it('GT-BT-WF-03 & GT-BT-WF-04: PRE 1 Step (校長) ➔ POST 3 Steps (教頭→校長→事務) などの任意非対称可変長ルート対応', () => {
    // 出張承認ポリシーを 1段階 (校長のみ) に変更
    db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE policy_id = 'TRIP_STANDARD' AND status = 'ACTIVE'").run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES ('TRIP_STANDARD_V_1STEP', 'TRIP_STANDARD', 99, 'ACTIVE', 200, '2000-01-01', '9999-12-31', '{}')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES ('TRIP_STANDARD_V_1STEP', 1, '校長決裁', 'PRINCIPAL_ONLY_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    // 1. 出張申請提出 (PRE: 1 step)
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '即時決裁出張',
      formData: {
        destination: '近隣校',
        purpose: '打合せ',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        startAt: '2026-10-01T09:00:00',
        endAt: '2026-10-01T17:00:00',
        transport: '公共交通機関',
      },
    });
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_step_order, 1);

    // PRE Step 1 (校長決裁) ➔ 即時 TRIP_APPROVED
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_status, 'TRIP_APPROVED');
    assert.equal(app.report_status, 'UNSUBMITTED');

    // 2. 復命書提出 (POST: 3 steps)
    const repRes = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-02',
      reportResult: '打合せ完了',
      actualMatchesPlan: true,
    });
    assert.equal(repRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_step_order, 1);

    // POST 3 steps 承認 (事務審査 ➔ 教頭確認 ➔ 校長決裁)
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_step_order, 2);

    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.current_step_order, 3);

    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.equal(app.report_status, 'REPORT_FINAL_APPROVED');
  });
});
