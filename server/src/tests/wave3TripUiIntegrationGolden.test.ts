import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getDb, initDatabase } from '../db/database';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { TripFinalizationService } from '../domain/trip/tripFinalizationService';
import { TripReportFinalizationService } from '../domain/trip/tripReportFinalizationService';

describe('Wave 3 / GAP-03: Business Trip UI Runtime Integration Dedicated Golden Tests (GT-GAP03-UI-*)', () => {
  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
  });

  const teacherUser = { id: 1, username: 'teacher1', displayName: '山田 太郎 (教員A)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const vpUser = { id: 3, username: 'vice_principal', displayName: '田中 誠 (教頭B)', roles: ['VICE_PRINCIPAL'], ipAddress: '127.0.0.1' };
  const principalUser = { id: 4, username: 'principal', displayName: '鈴木 健一 (校長C)', roles: ['PRINCIPAL'], ipAddress: '127.0.0.1' };
  const officeUser = { id: 5, username: 'office', displayName: '高橋 節子 (事務D)', roles: ['OFFICE'], ipAddress: '127.0.0.1' };

  /**
   * ヘルパー: 出張申請を作成し、旅行命令発令完了（TRIP_APPROVED）まで承認を進める
   */
  function createAndApproveTrip(tripParams?: Partial<{
    title: string;
    purpose: string;
    destination: string;
    startAt: string;
    endAt: string;
    transport: string;
    formData: Record<string, any>;
  }>): { appId: number; tripEventId: number } {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'BUSINESS_TRIP',
      title: tripParams?.title || '県教育センター出張',
      formData: {
        purpose: tripParams?.purpose || '教務指導研究会',
        destination: tripParams?.destination || '県教育センター',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        startAt: tripParams?.startAt || '2026-10-15T09:00:00',
        endAt: tripParams?.endAt || '2026-10-15T17:00:00',
        transport: tripParams?.transport || '公用車',
        departurePlace: '本校',
        arrivalPlace: '本校',
        ...(tripParams?.transport === '自家用車' ? { privateCarReason: '用務のため' } : {}),
        ...(tripParams?.formData || {}),
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // Step 1: 事務係審査 (REVIEW)
    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app1.version });

    // Step 2: 教頭確認 (APPROVE)
    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app2.version });

    // Step 3: 校長決裁 (DECIDE)
    const app3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app3.version });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'TRIP_APPROVED');

    return { appId, tripEventId: finalApp.trip_event_id };
  }

  // ==========================================
  // Oral Order Validation Tests
  // ==========================================
  it('GT-GAP03-UI-O01: isOralOrder === true かつ oralOrderIssuedAt 欠落時の 400 エラー拒絶（Fail-Closed & Zero Mutation）', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'BUSINESS_TRIP',
      title: '緊急出張（口頭発令）',
      formData: {
        purpose: '緊急生徒対応',
        destination: '県立中央病院',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        startAt: '2026-10-15T09:00:00',
        endAt: '2026-10-15T17:00:00',
        transport: '自家用車',
        departurePlace: '本校',
        arrivalPlace: '本校',
        isOralOrder: true,
        // oralOrderIssuedAt: 欠落
      },
    });

    assert.strictEqual(submitRes.success, false);
    assert.strictEqual(submitRes.statusCode, 422);

    // DB に申請・出張レコードが作成されていないこと
    const appsCount = db.prepare('SELECT count(*) as count FROM applications').get() as any;
    assert.strictEqual(appsCount.count, 0);
  });

  // ==========================================
  // Post-Trip Report Submission & Confirmation Tests
  // ==========================================
  it('GT-GAP03-UI-A01: Post-Trip Report Submission with actualMatchesPlan: true 正常系', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip({ transport: '公用車' });

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '計画どおり研修協議完了',
      actualMatchesPlan: true,
      communicationCostBorne: false,
    });

    assert.strictEqual(reportRes.success, true);
    assert.strictEqual(reportRes.statusCode, 200);

    const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(updatedApp.report_status, 'REPORT_SUBMITTED');
    const fd = JSON.parse(updatedApp.form_data);
    assert.strictEqual(fd.actualMatchesPlan, true);
    assert.strictEqual(fd.reportResult, '計画どおり研修協議完了');
    assert.strictEqual(fd.communicationCostBorne, false);
  });

  it('GT-GAP03-UI-A03: actualMatchesPlan 未選択 (null / undefined) での 400 エラー拒絶（Fail-Closed & Zero Mutation）', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip();

    const appBefore = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: appBefore.version,
      reportDate: '2026-10-16',
      reportResult: '結果報告',
      // actualMatchesPlan 未選択
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_MATCHES_PLAN_REQUIRED');

    const appAfter = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfter.version, appBefore.version);
    assert.strictEqual(appAfter.report_status, 'UNSUBMITTED');
  });

  // ==========================================
  // Contradiction & Forbidden Fact Rejection Tests (X01 〜 X07)
  // ==========================================
  it('GT-GAP03-UI-X01: actualMatchesPlan: true かつ actualDeparturePlace 送信時の 400 拒絶 (ACTUAL_FACT_CONTRADICTION)', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip();

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '結果報告',
      actualMatchesPlan: true,
      actualDeparturePlace: '自宅', // 矛盾
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_FACT_CONTRADICTION');
  });

  it('GT-GAP03-UI-X02: actualMatchesPlan: true かつ actualArrivalPlace 送信時の 400 拒絶 (ACTUAL_FACT_CONTRADICTION)', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip();

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '結果報告',
      actualMatchesPlan: true,
      actualArrivalPlace: '自宅', // 矛盾
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_FACT_CONTRADICTION');
  });

  it('GT-GAP03-UI-X03: actualMatchesPlan: true かつ actualTransportMode 送信時の 400 拒絶 (ACTUAL_FACT_CONTRADICTION)', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip();

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '結果報告',
      actualMatchesPlan: true,
      actualTransportMode: '公共交通機関', // 矛盾
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_FACT_CONTRADICTION');
  });

  it('GT-GAP03-UI-X04: PASSENGER かつ actualDistanceKm > 0 送信時の 400 拒絶 (ACTUAL_DISTANCE_FORBIDDEN_FOR_PASSENGER)', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip({ transport: '自家用車' });

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '同乗出張完了',
      actualMatchesPlan: true,
      vehicleUsageType: 'PASSENGER',
      actualDistanceKm: 25.0, // 同乗者なのに走行距離送信（Forbidden）
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_DISTANCE_FORBIDDEN_FOR_PASSENGER');
  });

  it('GT-GAP03-UI-X05: 公共交通機関 かつ vehicleUsageType 送信時の 400 拒絶 (VEHICLE_USAGE_TYPE_FORBIDDEN)', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip({ transport: '公共交通機関' });

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '電車出張完了',
      actualMatchesPlan: true,
      vehicleUsageType: 'DRIVER', // 公共交通機関なのにvehicleUsageType送信（Forbidden）
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'VEHICLE_USAGE_TYPE_FORBIDDEN');
  });

  it('GT-GAP03-UI-X06: 公共交通機関 かつ actualDistanceKm 送信時の 400 拒絶 (ACTUAL_DISTANCE_FORBIDDEN)', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip({ transport: '公共交通機関' });

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '電車出張完了',
      actualMatchesPlan: true,
      actualDistanceKm: 30.5, // 公共交通機関なのにactualDistanceKm送信（Forbidden）
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_DISTANCE_FORBIDDEN');
  });

  it('GT-GAP03-UI-X07: 公用車 かつ vehicleUsageType / actualDistanceKm 送信時の 400 拒絶', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip({ transport: '公用車' });

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '公用車出張完了',
      actualMatchesPlan: true,
      vehicleUsageType: 'DRIVER', // 公用車なのにvehicleUsageType送信
      actualDistanceKm: 15.0,    // 公用車なのにactualDistanceKm送信
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'VEHICLE_USAGE_TYPE_FORBIDDEN');
  });

  // ==========================================
  // Difference Facts Validation Tests
  // ==========================================
  it('GT-GAP03-UI-V01: actualMatchesPlan: false 時に実出発地・実帰着地・実交通手段が欠落している場合の 400 拒絶', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip();

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-10-16',
      reportResult: '差異あり出張報告',
      actualMatchesPlan: false,
      // actualDeparturePlace, actualArrivalPlace, actualTransportMode が欠落
    });

    assert.strictEqual(reportRes.success, false);
    assert.strictEqual(reportRes.statusCode, 400);
    assert.strictEqual(reportRes.errorCode, 'ACTUAL_TRIP_FACTS_REQUIRED');
  });

  // ==========================================
  // Strict Tri-State Tests (T01 〜 T03)
  // ==========================================
  it('GT-GAP03-UI-T01: communicationCostBorne: null (未入力/不明) の厳格保持', () => {
    const res = TripReportFinalizationService.parseCommunicationCostBorne(null);
    assert.strictEqual(res, null);

    const resUndef = TripReportFinalizationService.parseCommunicationCostBorne(undefined);
    assert.strictEqual(resUndef, null);
  });

  it('GT-GAP03-UI-T02: communicationCostBorne: false (明示的「負担なし」) の厳格保持', () => {
    const res = TripReportFinalizationService.parseCommunicationCostBorne(false);
    assert.strictEqual(res, false);

    const resStr = TripReportFinalizationService.parseCommunicationCostBorne('false');
    assert.strictEqual(resStr, false);

    const resZero = TripReportFinalizationService.parseCommunicationCostBorne(0);
    assert.strictEqual(resZero, false);
  });

  it('GT-GAP03-UI-T03: communicationCostBorne: true (明示的「負担あり」) の厳格保持', () => {
    const res = TripReportFinalizationService.parseCommunicationCostBorne(true);
    assert.strictEqual(res, true);

    const resStr = TripReportFinalizationService.parseCommunicationCostBorne('true');
    assert.strictEqual(resStr, true);

    const resOne = TripReportFinalizationService.parseCommunicationCostBorne(1);
    assert.strictEqual(resOne, true);
  });

  // ==========================================
  // End-to-End Post-Trip Finalization & Snapshot Test
  // ==========================================
  it('GT-GAP03-UI-E2E: 出張申請 → 命令発令 → 差異復命提出 → 復命決裁完了 で PostTripReportSnapshot に正確な実差異情報が永続化されること', () => {
    const db = getDb();
    const { appId } = createAndApproveTrip({ transport: '公用車' });

    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const reportRes = WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: app1.version,
      reportDate: '2026-10-16',
      reportResult: '急遽自家用車に変更して出張実施',
      actualMatchesPlan: false,
      actualDeparturePlace: '自宅',
      actualArrivalPlace: '本校',
      actualTransportMode: '自家用車',
      vehicleUsageType: 'DRIVER',
      actualDistanceKm: 32.4,
      communicationCostBorne: true,
      travelExpenseRemarks: '高速料金領収書添付',
    });
    assert.strictEqual(reportRes.success, true);

    // 復命 Step 1: 事務係審査 (REVIEW)
    const repApp1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: repApp1.version });

    // 復命 Step 2: 教頭確認 (APPROVE)
    const repApp2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: repApp2.version });

    // 復命 Step 3: 校長決裁 (DECIDE: 復命完了 & スナップショット生成)
    const repApp3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const finalReportApprove = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: repApp3.version });
    assert.strictEqual(finalReportApprove.success, true);

    // Snapshot 検証
    const snapshot = db.prepare('SELECT * FROM post_trip_report_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(snapshot, 'Post-Trip Report Snapshot must exist');
    assert.strictEqual(snapshot.report_date, '2026-10-16');
    assert.strictEqual(snapshot.result_summary, '急遽自家用車に変更して出張実施');

    const actualFacts = JSON.parse(snapshot.travel_actual_facts_json);
    assert.strictEqual(actualFacts.actualMatchesPlan, false);
    assert.strictEqual(actualFacts.actualDeparturePlace, '自宅');
    assert.strictEqual(actualFacts.actualArrivalPlace, '本校');
    assert.strictEqual(actualFacts.actualTransportMode, '自家用車');
    assert.strictEqual(actualFacts.vehicleUsageType, 'DRIVER');
    assert.strictEqual(actualFacts.actualDistanceKm, 32.4);
    assert.strictEqual(actualFacts.communicationCostBorne, true);
    assert.strictEqual(actualFacts.travelExpenseRemarks, '高速料金領収書添付');
  });
});
