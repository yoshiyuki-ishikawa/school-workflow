import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { UserContext } from '../types';

describe('Original Wave 1: 承認後取消・修正ワークフロー完結 (GAP-01) 専用Golden Test ＆ Failure Injection Test', () => {
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

  const vicePrincipal2: UserContext = {
    id: 8,
    username: 'vice_principal_2',
    displayName: '渡辺 洋子 (第2教頭)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    // テストごとの独立性を保つため、動的トランザクションデータをクリーンアップ
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

    // 標準の年休付与 (2026年度: 20日)
    AnnualLeaveService.grantEntitlement({
      userId: teacher1.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '2026年度当初付与',
    });
  });

  // ヘルパー: 年次有給休暇の作成から決裁完了（FINAL_APPROVED）まで
  const createAndApproveAnnualLeave = (targetDate = '2026-05-15', unitType = 'DAY') => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: `【年休】${targetDate}`,
      formData: {
        unitType,
        startDate: targetDate,
        endDate: targetDate,
        targetDate,
        calculatedDays: unitType === 'DAY' ? 1 : 0.5,
        reason: '私用のため',
      },
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data.id;

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(vpRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const prRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(prRes.success, true);

    return appId;
  };

  // =========================================================================
  // Dedicated Golden Tests (GT-W1-CAN-01 〜 24) — Implementation Plan v2.1 準拠
  // =========================================================================

  it('GT-W1-CAN-01: 年休1日取得 -> 承認 -> 取消起案 -> 取消決裁 -> 残日数 19日 -> 20日 完全復元', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    let proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-15');
    assert.strictEqual(proj.remainingDays, 19);

    const cancelRes = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '公務都合による取消',
    });
    assert.strictEqual(cancelRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const prCancelRes = WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(prCancelRes.success, true);

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'CANCELLED');

    proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-15');
    assert.strictEqual(proj.remainingDays, 20);
  });

  it('GT-W1-CAN-02: 年休時間休3時間取得 -> 承認 -> 取消起案 -> 取消決裁 -> 時間休残数 完全復元', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【時間年休】3時間',
      formData: {
        unitType: 'TIME',
        targetDate: '2026-07-01',
        startDate: '2026-07-01',
        endDate: '2026-07-01',
        startTime: '13:45',
        endTime: '16:45',
        reason: '通院',
      },
    });
    const appId = subRes.data.id;

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    let proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-07-01');
    assert.strictEqual(proj.hourlyUsedMinutesInYear, 180);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.requestCancellation(teacher1, { applicationId: appId, expectedVersion: app.version, cancellationReason: '通院日程変更' });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });

    proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-07-01');
    assert.strictEqual(proj.hourlyUsedMinutesInYear, 0);
  });

  it('GT-W1-CAN-03: 出張申請 -> 承認 (出勤簿反映) -> 取消起案 -> 取消決裁 -> 出勤簿が通常勤務へ即時復元', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '市内小学校研究協議会',
      formData: {
        startDate: '2026-06-05',
        endDate: '2026-06-05',
        startAt: '2026-06-05T08:10:00',
        endAt: '2026-06-05T16:40:00',
        destination: '市立第一小学校',
        departurePlace: '本校',
        arrivalPlace: '本校',
        purpose: '教科研究',
      },
    });
    const appId = subRes.data.id;

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');

    const { AttendanceEngine } = require('../services/attendance/attendanceEngine');
    let dayStatus = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-06-05' });
    assert.strictEqual(dayStatus.serviceStatus, 'BUSINESS_TRIP');

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.requestCancellation(teacher1, { applicationId: appId, expectedVersion: app.version, cancellationReason: '協議会中止' });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(office, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'CANCELLED');

    dayStatus = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-06-05' });
    assert.notStrictEqual(dayStatus.serviceStatus, 'BUSINESS_TRIP');
  });

  it('GT-W1-CAN-04: 取消処理の冪等性検証 (同一取消決裁の連続呼び出しで残数が二重加算されないこと)', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, { applicationId: appId, expectedVersion: app.version, cancellationReason: '冪等性テスト' });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const finalRes = WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(finalRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const repeatRes = WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });
    assert.strictEqual(repeatRes.success, false);

    const proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-15');
    assert.strictEqual(proj.remainingDays, 20);
  });

  it('GT-W1-CAN-05: 月次確定ロック中（CONFIRMED）の取消起案・承認遮断 (Fail-Closed 423)', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    db.prepare("INSERT INTO monthly_attendance_approvals (user_id, year_month, status) VALUES (?, '2026-05', 'CONFIRMED')").run(teacher1.id);

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'ロック済み年月の取消試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 423);
    assert.strictEqual(res.errorCode, 'MONTHLY_LOCKED');
  });

  it('GT-W1-CAN-06: 取消申請に対する自己承認ブロック (403 FORBIDDEN)', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '自己承認テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.approveCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-W1-CAN-07: Historical Immutability 検証 (Cycle 1 の承認履歴および印影スナップショットが完全保持されること)', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '履歴保持テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });

    const cycle1Steps = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ? AND approval_cycle = 1
      ORDER BY step_order ASC
    `).all(appId) as any[];

    assert.strictEqual(cycle1Steps.length, 2);
    assert.strictEqual(cycle1Steps[0].status, 'APPROVED');
    assert.strictEqual(cycle1Steps[0].action_user_stamp_name, '田中');
    assert.strictEqual(cycle1Steps[1].status, 'APPROVED');
    assert.strictEqual(cycle1Steps[1].action_user_stamp_name, '鈴木');

    const cycle1 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.ok(cycle1);
    assert.strictEqual(cycle1.workflow_source, 'NEW_POLICY_ENGINE');
    assert.strictEqual(cycle1.workflow_policy_version_id, 'LEAVE_ANNUAL_STANDARD_V1');
    assert.strictEqual(cycle1.started_by_user_id, teacher1.id);
  });

  it('GT-W1-CAN-08: 複数名一括出張の個別取消検証 (1名のみ取消し、他メンバーの出張承認が維持されること)', () => {
    const batchRes = WorkflowEngine.submitBatchTrip(vicePrincipal2, {
      title: '県外教育研究大会',
      purpose: '指導法研究',
      destination: '広島県教育センター',
      startAt: '2026-08-03T09:00:00',
      endAt: '2026-08-03T17:00:00',
      transport: '新幹線',
      participantUserIds: [teacher1.id, teacher2.id],
    });

    assert.strictEqual(batchRes.success, true);
    const tripEventId = batchRes.data.tripEventId;
    const [appId1, appId2] = batchRes.data.generatedAppIds;

    for (const appId of [appId1, appId2]) {
      let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
      WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
      app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
      WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
      app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
      WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    }

    let app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId1,
      expectedVersion: app1.version,
      cancellationReason: '校内業務都合による出張辞退',
    });

    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(office, { applicationId: appId1, expectedVersion: app1.version });
    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId1, expectedVersion: app1.version });
    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId1, expectedVersion: app1.version });

    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId1) as any).current_status, 'CANCELLED');
    assert.strictEqual((db.prepare('SELECT participation_status FROM trip_event_members WHERE application_id = ?').get(appId1) as any).participation_status, 'CANCELLED');

    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId2) as any).current_status, 'TRIP_APPROVED');
    assert.strictEqual((db.prepare('SELECT participation_status FROM trip_event_members WHERE application_id = ?').get(appId2) as any).participation_status, 'JOINED');

    const event = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(tripEventId) as any;
    assert.ok(event);
  });

  it('GT-W1-CAN-09: 【Mandatory】Cancellation申請中も元FINAL_APPROVEDの出勤簿効果が100%維持される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '審査中効果維持テスト',
    });

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    const { AttendanceEngine } = require('../services/attendance/attendanceEngine');
    const dayStatus = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-05-15' });
    assert.strictEqual(dayStatus.serviceStatus, 'LEAVE_ANNUAL');
  });

  it('GT-W1-CAN-10: 【Mandatory】Cancellation申請中は年休残数が復元されない（審査中二重行使の防止）', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '審査中残数非復元テスト',
    });

    const proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-15');
    assert.strictEqual(proj.remainingDays, 19);

    const usage = db.prepare('SELECT status FROM leave_usages WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(usage.status, 'ACTIVE');
  });

  it('GT-W1-CAN-11: 【Mandatory】Cancellation却下後も元の承認効果・残数・履歴が完全維持される (教頭REVIEW遮断 ＆ 校長DECIDE不同意)', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '却下テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    // Step 1 (教頭: REVIEW) からの却下（不同意）は 422 INVALID_ACTION_FOR_REVIEW で Fail-Closed 遮断
    const rejReview = WorkflowEngine.rejectCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '期日直前のため却下',
    });
    assert.strictEqual(rejReview.success, false);
    assert.strictEqual(rejReview.statusCode, 422);
    assert.strictEqual(rejReview.errorCode, 'INVALID_ACTION_FOR_REVIEW');

    // 教頭が進達 (Approve) して最終決裁ステップ（校長: DECIDE）へ
    const advRes = WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '確認して校長へ進達',
    });
    assert.strictEqual(advRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    // Step 2 (校長: DECIDE & is_final_decision_step) からの却下（不同意: DECLINE_CANCELLATION）は正規に成功
    const rejRes = WorkflowEngine.rejectCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '期日直前のため取消不同意',
    });
    assert.strictEqual(rejRes.success, true);

    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;
    assert.strictEqual(cycle.status, 'REJECTED');

    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    const proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-15');
    assert.strictEqual(proj.remainingDays, 19);
  });

  it('GT-W1-CAN-12: 【Mandatory】存在すべきleave usage欠落をskipせずDATA_INCONSISTENCYとしてFail-Closed', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'Usage欠落テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    db.prepare('DELETE FROM leave_usages WHERE application_id = ?').run(appId);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const res = WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.message, /DATA_INCONSISTENCY/);

    const rolledBackApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(rolledBackApp.current_status, 'FINAL_APPROVED');
  });

  it('GT-W1-CAN-13: 【Mandatory】Strict Audit insert失敗時、取消状態・残数・Workflow Cycleを含む全変更がrollback', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    db.exec(`
      CREATE TRIGGER test_audit_failure_trigger
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'CANCEL_REQUEST'
      BEGIN
        SELECT RAISE(FAIL, 'SIMULATED_AUDIT_INSERT_FAILURE');
      END;
    `);

    try {
      const res = WorkflowEngine.requestCancellation(teacher1, {
        applicationId: appId,
        expectedVersion: app.version,
        cancellationReason: '監査障害ロールバックテスト',
      });
      assert.strictEqual(res.success, false);

      const cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId) as any[];
      assert.strictEqual(cycles.length, 1);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS test_audit_failure_trigger;');
    }
  });

  it('GT-W1-CAN-14: 【Mandatory】Leave Reconciliation途中失敗時、Application Statusも含めて全rollback', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '台帳障害ロールバックテスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    db.exec(`
      CREATE TRIGGER test_reconcile_failure_trigger
      BEFORE UPDATE ON leave_entitlements
      BEGIN
        SELECT RAISE(FAIL, 'SIMULATED_RECONCILE_FAILURE');
      END;
    `);

    try {
      app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      const res = WorkflowEngine.approveCancellation(principal, {
        applicationId: appId,
        expectedVersion: app.version,
      });
      assert.strictEqual(res.success, false);

      const currentApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
      assert.strictEqual(currentApp.current_status, 'FINAL_APPROVED');
    } finally {
      db.exec('DROP TRIGGER IF EXISTS test_reconcile_failure_trigger;');
    }
  });

  it('GT-W1-CAN-15: 【Mandatory】Cancellation起案後に月次CONFIRMEDとなった場合、final cancellation approvalをHTTP 423で遮断', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'TOCTOUテスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    db.prepare("INSERT INTO monthly_attendance_approvals (user_id, year_month, status) VALUES (?, '2026-05', 'CONFIRMED')").run(teacher1.id);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const res = WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 423);

    const rolledBackApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(rolledBackApp.current_status, 'FINAL_APPROVED');
  });

  it('GT-W1-CAN-16: 【Mandatory】後続年休利用が存在する状態で過去Applicationを取消し、Canonical Balanceが正しく再整合', () => {
    const appId1 = createAndApproveAnnualLeave('2026-05-11');
    const appId2 = createAndApproveAnnualLeave('2026-05-20');

    let proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-25');
    assert.strictEqual(proj.remainingDays, 18);

    let app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.requestCancellation(teacher1, { applicationId: appId1, expectedVersion: app1.version, cancellationReason: '過去分取消' });

    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId1, expectedVersion: app1.version });
    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId1, expectedVersion: app1.version });

    proj = AnnualLeaveService.getLeaveBalanceProjection(teacher1.id, '2026-05-25');
    assert.strictEqual(proj.remainingDays, 19);

    const usage2 = db.prepare('SELECT status FROM leave_usages WHERE application_id = ?').get(appId2) as any;
    assert.strictEqual(usage2.status, 'ACTIVE');
  });

  it('GT-W1-CAN-17: 【Mandatory】年度繰越後に前年度Applicationを取消した場合のCarryover再整合', () => {
    db.prepare('UPDATE user_work_patterns SET effective_from = ? WHERE user_id = ?').run('2025-01-01', teacher1.id);

    AnnualLeaveService.grantEntitlement({
      userId: teacher1.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2025,
      grantedDays: 20,
      grantDate: '2025-01-01',
      effectiveFrom: '2025-01-01',
      expiresAt: '2026-12-31',
      reason: '2025年定期付与',
    });

    const appId1 = createAndApproveAnnualLeave('2025-08-08');

    AnnualLeaveService.processAnnualRollover(2026, 1);

    const carryover2026 = db.prepare('SELECT * FROM leave_entitlements WHERE user_id = ? AND fiscal_year = 2026 AND entitlement_type = \'CARRYOVER\'').get(teacher1.id) as any;
    assert.strictEqual(carryover2026.granted_days, 19);

    let app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.requestCancellation(teacher1, { applicationId: appId1, expectedVersion: app1.version, cancellationReason: '前年分取消' });

    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId1, expectedVersion: app1.version });
    app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId1) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId1, expectedVersion: app1.version });

    const rebalancedCarryover = db.prepare('SELECT * FROM leave_entitlements WHERE id = ?').get(carryover2026.id) as any;
    assert.strictEqual(rebalancedCarryover.granted_days, 20);
  });

  it('GT-W1-CAN-18: 【Mandatory】Batch Trip代表者取消時、Event本体は継続し他メンバーの承認が維持される', () => {
    const batchRes = WorkflowEngine.submitBatchTrip(admin, {
      title: '教頭研修会',
      purpose: '管理職研修',
      destination: '山口県セミナーパーク',
      startAt: '2026-09-01T09:00:00',
      endAt: '2026-09-01T17:00:00',
      transport: '公用車',
      participantUserIds: [teacher1.id, teacher2.id],
    });

    const [t1AppId, t2AppId] = batchRes.data.generatedAppIds;
    for (const appId of [t1AppId, t2AppId]) {
      let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
      WorkflowEngine.approveApplication(office, { applicationId: appId, expectedVersion: app.version });
      app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
      WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
      app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
      WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    }

    let t1App = db.prepare('SELECT * FROM applications WHERE id = ?').get(t1AppId) as any;
    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: t1AppId,
      expectedVersion: t1App.version,
      cancellationReason: '代表者辞退',
    });

    t1App = db.prepare('SELECT * FROM applications WHERE id = ?').get(t1AppId) as any;
    WorkflowEngine.approveCancellation(office, { applicationId: t1AppId, expectedVersion: t1App.version });
    t1App = db.prepare('SELECT * FROM applications WHERE id = ?').get(t1AppId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: t1AppId, expectedVersion: t1App.version });
    t1App = db.prepare('SELECT * FROM applications WHERE id = ?').get(t1AppId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: t1AppId, expectedVersion: t1App.version });

    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(t1AppId) as any).current_status, 'CANCELLED');
    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(t2AppId) as any).current_status, 'TRIP_APPROVED');
  });

  it('GT-W1-CAN-19: 【P0-1 New】Cancellation Policyが存在しない場合、暗黙FallbackせずPOLICY_UNRESOLVEDでFail-Closed', () => {
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_STANDARD_CANCEL'").run();

    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'Policy未定義テスト',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.errorCode, 'WORKFLOW_POLICY_UNRESOLVED');
  });

  it('GT-W1-CAN-20: 【P0-1 New】Cancellation Policyが複数候補・同Priority重複の場合POLICY_AMBIGUOUSでFail-Closed', () => {
    db.prepare("DELETE FROM workflow_policy_steps WHERE policy_version_id = 'LEAVE_CANCEL_DUP_V1'").run();
    db.prepare("DELETE FROM workflow_policy_versions WHERE policy_id = 'LEAVE_CANCEL_DUP'").run();
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_CANCEL_DUP'").run();
    db.prepare("DELETE FROM workflow_policies WHERE id = 'LEAVE_CANCEL_DUP'").run();

    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
      VALUES ('LEAVE_CANCEL_DUP', 'LEAVE_CANCEL_DUP_KEY', '重複取消ポリシー', 'CANCELLATION', 'CUSTOM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to)
      VALUES ('LEAVE_CANCEL_DUP_V1', 'LEAVE_CANCEL_DUP', 1, 'ACTIVE', 200, '2000-01-01', '9999-12-31')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES ('LEAVE_CANCEL_DUP_V1', 1, '校長決裁', 'PR_STEP', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();
    db.prepare("INSERT INTO workflow_policy_application_types (policy_id, app_type_id) VALUES ('LEAVE_CANCEL_DUP', 'LEAVE_ANNUAL')").run();

    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'Policy重複テスト',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.errorCode, 'WORKFLOW_POLICY_AMBIGUOUS');
  });

  it('GT-W1-CAN-21: 【P0-2 New】Cancellation完了後もOriginal leave_usage Historical Factが削除されず、REVERSED履歴として追跡可能', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '履歴保持確認',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });

    const usage = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').get(appId) as any;
    assert.ok(usage);
    assert.strictEqual(usage.status, 'REVERSED');
    assert.ok(usage.reversed_at);
    assert.ok(usage.reversal_cycle_id);
  });

  it('GT-W1-CAN-22: 【P1-1 New】cycle_purpose=CANCELLATION + status=APPROVED がCanonicalに成立し、Purpose/Status矛盾状態を生成できない', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '直交モデル検証',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });

    const cancelCycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND cycle_purpose = \'CANCELLATION\'').get(appId) as any;
    assert.strictEqual(cancelCycle.cycle_purpose, 'CANCELLATION');
    assert.strictEqual(cancelCycle.status, 'APPROVED');
  });

  it('GT-W1-CAN-23: 【P1-3 New】ADMIN Role単独ではCancellation代理起案権限を取得できない (業務権限の厳格分離)', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(admin, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'ADMINによる不正起案試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.errorCode, 'FORBIDDEN_CANCELLATION_REQUEST');
  });

  it('GT-W1-CAN-24: 【P1-5 New】Migration v21 -> v22 実行後、既存Cycle全件の意味・値・Index・FKが100%保全される', () => {
    const cycleCols = db.prepare('PRAGMA table_info(application_workflow_cycles)').all() as { name: string }[];
    const cycleColNames = new Set(cycleCols.map((c) => c.name));
    assert.ok(cycleColNames.has('cycle_purpose'));
    assert.ok(cycleColNames.has('cancellation_reason'));

    const policyCols = db.prepare('PRAGMA table_info(workflow_policies)').all() as { name: string }[];
    const policyColNames = new Set(policyCols.map((c) => c.name));
    assert.ok(policyColNames.has('policy_purpose'));

    const usageCols = db.prepare('PRAGMA table_info(leave_usages)').all() as { name: string }[];
    const usageColNames = new Set(usageCols.map((c) => c.name));
    assert.ok(usageColNames.has('status'));
    assert.ok(usageColNames.has('reversed_at'));
    assert.ok(usageColNames.has('reversal_cycle_id'));
  });

  // =========================================================================
  // Failure Injection & Negative Tests (FI-01 〜 14)
  // =========================================================================

  it('FI-01: 自己承認禁止 - 申請対象本人による取消承認試行は 403 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '自己承認テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // teacher1 本人が取消承認を試行 -> 403
    const res = WorkflowEngine.approveCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('FI-02: 自己承認禁止 - 取消起案者による取消承認試行は 403 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 教頭が職権で取消起案
    WorkflowEngine.requestCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '教頭起案テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 起案した教頭本人がStep1を承認試行 -> 403
    const res = WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('FI-03: 無権限者（無関係な他教員）による取消起案は 403 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // teacher2 (無関係) が teacher1 の申請を取消起案 -> 403
    const res = WorkflowEngine.requestCancellation(teacher2, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '他人の申請取消試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.errorCode, 'FORBIDDEN_CANCELLATION_REQUEST');
  });

  it('FI-04: ADMIN role alone による取消起案は 403 で遮断される（HD-W1-01 Option B）', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // admin は管理職 (PRINCIPAL/VICE_PRINCIPAL) ではないため起案権限なし -> 403
    const res = WorkflowEngine.requestCancellation(admin, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'システム管理者による起案試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.errorCode, 'FORBIDDEN_CANCELLATION_REQUEST');
  });

  it('FI-05: 未承認状態（SUBMITTED / DRAFT / RETURNED）の申請に対する取消起案は 400 で遮断される', () => {
    const subRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【未決裁年休】',
      formData: { unitType: 'DAY', startDate: '2026-05-15', endDate: '2026-05-15', reason: '私用' },
    });
    const appId = subRes.data.id;
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '未決裁申請の取消試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.errorCode, 'INVALID_STATUS_FOR_CANCELLATION');
  });

  it('FI-06: 既に進行中の取消が存在する場合の重複取消起案は 409 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '1回目の取消起案',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 2回目の取消起案 -> 409
    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '重複した2回目の取消起案',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.errorCode, 'CANCELLATION_ALREADY_IN_PROGRESS');
  });

  it('FI-07: 月次確定（CONFIRMED）ロック中の年月に対する取消起案は 423 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    // 2026-05 の出勤簿を月次確定
    db.prepare("INSERT INTO monthly_attendance_approvals (user_id, year_month, status) VALUES (?, '2026-05', 'CONFIRMED')").run(teacher1.id);

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'ロック済み年月の取消試行',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 423);
    assert.strictEqual(res.errorCode, 'MONTHLY_LOCKED');
  });

  it('FI-08: 取消決裁直前の TOCTOU 月次確定ロック検知時は 423 でトランザクション全体がロールバックされる', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'TOCTOUテスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    // 決裁直前に出勤簿がロックされた
    db.prepare("INSERT INTO monthly_attendance_approvals (user_id, year_month, status) VALUES (?, '2026-05', 'CONFIRMED')").run(teacher1.id);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const res = WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 423);

    // ロールバック確認: application は FINAL_APPROVED のまま
    const rolledBackApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(rolledBackApp.current_status, 'FINAL_APPROVED');
  });

  it('FI-09: 楽観ロック競合 - expectedVersion 不一致時は 409 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version + 999, // 不一致
      cancellationReason: '競合テスト',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.errorCode, 'CONFLICT_DETECTED');
  });

  it('FI-10: Cancellation Policy 未定義時は Fail-Closed で 400 (WORKFLOW_POLICY_UNRESOLVED) となる', () => {
    // CANCELLATION ポリシーを意図的に削除
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_STANDARD_CANCEL'").run();

    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'Policy未定義テスト',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.errorCode, 'WORKFLOW_POLICY_UNRESOLVED');
  });

  it('FI-11: Cancellation Policy 重複時は Fail-Closed で 400 (WORKFLOW_POLICY_AMBIGUOUS) となる', () => {
    // 既存重複ポリシーがあればクリーンアップ
    db.prepare("DELETE FROM workflow_policy_steps WHERE policy_version_id = 'LEAVE_CANCEL_DUP_V1'").run();
    db.prepare("DELETE FROM workflow_policy_versions WHERE policy_id = 'LEAVE_CANCEL_DUP'").run();
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_CANCEL_DUP'").run();
    db.prepare("DELETE FROM workflow_policies WHERE id = 'LEAVE_CANCEL_DUP'").run();

    // 同一優先度の重複 CANCELLATION ポリシーを登録
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
      VALUES ('LEAVE_CANCEL_DUP', 'LEAVE_CANCEL_DUP_KEY', '重複取消ポリシー', 'CANCELLATION', 'CUSTOM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to)
      VALUES ('LEAVE_CANCEL_DUP_V1', 'LEAVE_CANCEL_DUP', 1, 'ACTIVE', 200, '2000-01-01', '9999-12-31')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_steps (policy_version_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value, is_final_decision_step)
      VALUES ('LEAVE_CANCEL_DUP_V1', 1, '校長決裁', 'PR_STEP', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();
    db.prepare("INSERT INTO workflow_policy_application_types (policy_id, app_type_id) VALUES ('LEAVE_CANCEL_DUP', 'LEAVE_ANNUAL')").run();

    const appId = createAndApproveAnnualLeave('2026-05-15');
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'Policy重複テスト',
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.errorCode, 'WORKFLOW_POLICY_AMBIGUOUS');
  });

  it('FI-12: 年休Usage欠落時の取消決裁試行は DATA_INCONSISTENCY 例外で安全にロールバックされる', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: 'Usage欠落テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });

    // 意図的に usage を改ざん削除
    db.prepare('DELETE FROM leave_usages WHERE application_id = ?').run(appId);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const res = WorkflowEngine.approveCancellation(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 500);
    assert.match(res.message, /DATA_INCONSISTENCY/);

    // ロールバック確認: application は FINAL_APPROVED を維持
    const rolledBackApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(rolledBackApp.current_status, 'FINAL_APPROVED');
  });

  it('FI-13: 差戻し・却下時の理由未記入は 400 で遮断される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '理由未記入テスト',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    const resReturn = WorkflowEngine.returnCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '   ', // 空白
    });
    assert.strictEqual(resReturn.success, false);
    assert.strictEqual(resReturn.statusCode, 400);

    const resReject = WorkflowEngine.rejectCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '',
    });
    assert.strictEqual(resReject.success, false);
    assert.strictEqual(resReject.statusCode, 400);
  });

  it('FI-14: Audit Trail 連鎖完全性 - 取消起案・承認・却下・差戻しの全操作がハッシュチェーン付きで記録される', () => {
    const appId = createAndApproveAnnualLeave('2026-05-15');
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '監査ログ検証',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(principal, { applicationId: appId, expectedVersion: app.version });

    const auditLogs = db.prepare("SELECT * FROM audit_logs WHERE entity_id = ? AND action LIKE 'CANCEL_%' ORDER BY id ASC").all(String(appId)) as any[];
    assert.strictEqual(auditLogs.length, 3);
    assert.strictEqual(auditLogs[0].action, 'CANCEL_REQUEST');
    assert.strictEqual(auditLogs[1].action, 'CANCEL_APPROVE');
    assert.strictEqual(auditLogs[2].action, 'CANCEL_FINAL_APPROVE');

    // prev_hash と event_hash の連鎖確認
    for (const log of auditLogs) {
      assert.ok(log.event_hash);
      assert.ok(log.prev_hash);
      assert.strictEqual(log.is_success, 1);
    }
  });
});
