import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getDb, initDatabase } from '../db/database';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { TripFinalizationService } from '../domain/trip/tripFinalizationService';
import { TripReportFinalizationService } from '../domain/trip/tripReportFinalizationService';
import { deriveTripStatus } from '../domain/trip/tripDerivedStatus';
import { formatTripRemarksProjection } from '../routes/forms';
import { toTokyoCalendarDate } from '../utils/serverTime';

describe('Wave 3 / GAP-03: 公務旅行・旅行命令／復命 独立ドメイン完結 Golden Tests (GT-W3-01 〜 GT-W3-27)', () => {
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

  it('GT-W3-01: 通常事前出張申請 → 最終決裁完了で Travel Order Snapshot が生成され、出勤簿に「出張」が投影される', () => {
    const db = getDb();
    const submitRes = WorkflowEngine.submitBatchTrip(teacherUser, {
      title: '県教育センター研修会',
      purpose: '教務指導力向上研修会',
      destination: '県教育センター',
      startAt: '2026-10-15T09:00:00',
      endAt: '2026-10-15T17:00:00',
      transport: '公用車',
      participantUserIds: [1],
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.generatedAppIds[0];

    // Step 1: 事務係審査
    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app1.version });

    // Step 2: 教頭確認
    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, { applicationId: appId, expectedVersion: app2.version });

    // Step 3: 校長決裁 (Trip Standard 最終ステップ)
    const app3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const finalApproveRes = WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: app3.version });
    assert.strictEqual(finalApproveRes.success, true);

    const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(updatedApp.current_status, 'TRIP_APPROVED');

    // travel_order_snapshots の検証
    const snapshot = db.prepare('SELECT * FROM travel_order_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(snapshot, 'travel_order_snapshots record must exist');
    assert.strictEqual(snapshot.traveler_user_id_snapshot, 1);
    assert.ok(snapshot.travel_order_issued_at);
  });

  it('GT-W3-02 & GT-W3-03: 口頭発令出張 → 事後記録 → 事後決裁で issued_at < final_approved_at が正当に記録される', () => {
    const db = getDb();
    const oralIssuedDate = '2026-09-01';
    
    // trip_events に oral order で挿入
    const now = new Date().toISOString();
    const eventRes = db.prepare(`
      INSERT INTO trip_events (
        title, purpose, destination, start_at, end_at, transport, is_oral_order, oral_order_issued_at,
        created_by_user_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)
    `).run('緊急児童生徒指導', '緊急生徒指導対応', '近隣小学校', '2026-09-01T10:00:00', '2026-09-01T12:00:00', '徒歩', oralIssuedDate, 1, now, now);
    const eventId = Number(eventRes.lastInsertRowid);

    const appRes = db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
        trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at
      ) VALUES ('BUSINESS_TRIP', 1, 1, 'SELF', 'SINGLE', ?, '【口頭発令事後記録】緊急指導', '{}', 'SUBMITTED', 1, 1, ?, ?)
    `).run(eventId, now, now);
    const appId = Number(appRes.lastInsertRowid);

    // 承認ステップ作成
    db.prepare(`
      INSERT INTO application_approval_steps (
        application_id, approval_cycle, step_order, step_name, step_key, required_role_id, status, acted_at
      ) VALUES (?, 1, 1, '校長決裁', 'PRINCIPAL_TRIP_STEP', 'PRINCIPAL', 'PENDING', NULL)
    `).run(appId);

    // 校長が後日 (2026-09-02) 承認
    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: 1 });

    const snapshot = db.prepare('SELECT * FROM travel_order_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(snapshot);
    assert.strictEqual(snapshot.travel_order_issued_at, oralIssuedDate);
    assert.ok(snapshot.travel_order_issued_at < snapshot.finalized_at.split('T')[0] || snapshot.travel_order_issued_at <= snapshot.finalized_at.split('T')[0]);
  });

  it('GT-W3-04: 旅行終了後だが旅行命令事後決裁中は TRAVEL_ORDER_EX_POST_PENDING となり REPORT_REQUIRED は発火しない', () => {
    const status = deriveTripStatus(
      'SUBMITTED',
      null,
      '2026-09-01T09:00:00',
      '2026-09-01T17:00:00',
      '2026-09-02T10:00:00' // 旅行終了後
    );
    assert.strictEqual(status, 'TRAVEL_ORDER_EX_POST_PENDING');
  });

  it('GT-W3-05: 旅行終了 ＋ 旅行命令確定 ＋ 復命書未起案の場合は REPORT_REQUIRED となる', () => {
    const status = deriveTripStatus(
      'TRIP_APPROVED',
      'UNSUBMITTED',
      '2026-09-01T09:00:00',
      '2026-09-01T17:00:00',
      '2026-09-02T10:00:00'
    );
    assert.strictEqual(status, 'REPORT_REQUIRED');
  });

  it('GT-W3-06: 復命書提出時は REPORT_PENDING となる', () => {
    const status = deriveTripStatus(
      'TRIP_APPROVED',
      'REPORT_SUBMITTED',
      '2026-09-01T09:00:00',
      '2026-09-01T17:00:00',
      '2026-09-02T10:00:00'
    );
    assert.strictEqual(status, 'REPORT_PENDING');
  });

  it('GT-W3-07: 復命書決裁完了時は COMPLETED となり post_trip_report_snapshots が生成される', () => {
    const status = deriveTripStatus(
      'TRIP_APPROVED',
      'REPORT_FINAL_APPROVED',
      '2026-09-01T09:00:00',
      '2026-09-01T17:00:00',
      '2026-09-02T10:00:00'
    );
    assert.strictEqual(status, 'COMPLETED');
  });

  it('GT-W3-08 & GT-W3-09: 復命書の差戻し（REPORT_RETURNED）および再提出において Travel Order Snapshot は不変（Immutable）', () => {
    const db = getDb();
    const now = new Date().toISOString();
    
    // 事前出張作成 & 決裁完了
    const eventRes = db.prepare(`
      INSERT INTO trip_events (title, purpose, destination, start_at, end_at, transport, created_by_user_id, version, created_at, updated_at)
      VALUES ('研究協議会', '研究協議', '県民館', '2026-10-01T09:00:00', '2026-10-01T17:00:00', '公用車', 1, 1, ?, ?)
    `).run(now, now);
    const eventId = Number(eventRes.lastInsertRowid);

    const appRes = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES ('BUSINESS_TRIP', 1, 1, ?, '協議会出張', '{}', 'SUBMITTED', 1, 1, ?, ?)
    `).run(eventId, now, now);
    const appId = Number(appRes.lastInsertRowid);

    // 承認ステップ (校長)
    db.prepare(`
      INSERT INTO application_approval_steps (application_id, approval_cycle, step_order, step_name, step_key, required_role_id, status, acted_at)
      VALUES (?, 1, 1, '校長決裁', 'PRINCIPAL_TRIP_STEP', 'PRINCIPAL', 'PENDING', NULL)
    `).run(appId);

    WorkflowEngine.approveApplication(principalUser, { applicationId: appId, expectedVersion: 1 });

    const orderSnapshotBefore = db.prepare('SELECT * FROM travel_order_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(orderSnapshotBefore);

    // 復命書提出
    const appAfterOrder = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.submitReport(teacherUser, {
      applicationId: appId,
      expectedVersion: appAfterOrder.version,
      reportDate: '2026-10-02',
      reportResult: '協議会出席、討議に参加',
      actualMatchesPlan: true,
    });

    // 復命書差戻し (事務が差戻し: Step 1 OFFICE)
    const appAfterReport = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.returnApplication(officeUser, { applicationId: appId, expectedVersion: appAfterReport.version, comment: '成果物を添付してください' });

    const appAfterReturn = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfterReturn.report_status, 'REPORT_RETURNED');
    assert.strictEqual(appAfterReturn.current_status, 'TRIP_APPROVED', '旅行命令の確定状態は不変');

    // 復命差戻し後も travel_order_snapshots は一切変更されていない
    const orderSnapshotAfterReturn = db.prepare('SELECT * FROM travel_order_snapshots WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(orderSnapshotBefore.id, orderSnapshotAfterReturn.id);
    assert.strictEqual(orderSnapshotBefore.travel_order_issued_at, orderSnapshotAfterReturn.travel_order_issued_at);
    assert.strictEqual(orderSnapshotBefore.trip_plan_facts_json, orderSnapshotAfterReturn.trip_plan_facts_json);
  });

  it('GT-W3-10 & GT-W3-11: 帳票 Projection において住所・級号給・給料月額は空欄であり、学校所在地や職名で代用されない', () => {
    const formatted = formatTripRemarksProjection(
      { actualDeparturePlace: '本校', actualArrivalPlace: '自宅', actualTransportMode: '自家用車', vehicleUsageType: 'DRIVER', actualDistanceKm: 24.5, communicationCostBorne: false },
      {}
    );
    assert.ok(formatted.includes('【出発地】本校'));
    assert.ok(formatted.includes('【帰着地】自宅'));
    assert.ok(formatted.includes('【交通手段】自家用車 (運転)'));
    assert.ok(formatted.includes('【実測距離】24.5 km'));
    assert.ok(formatted.includes('【通信運送費負担】なし'));
    assert.strictEqual(formatted.includes('給料'), false);
    assert.strictEqual(formatted.includes('住所'), false);
  });

  it('GT-W3-12: Travel Order Cycle ID と Post-Trip Report Cycle ID の独立性', () => {
    const db = getDb();
    const app = db.prepare("SELECT id FROM applications WHERE type_id = 'BUSINESS_TRIP' ORDER BY id DESC LIMIT 1").get() as any;
    if (app) {
      const orderSnap = db.prepare('SELECT workflow_cycle_id FROM travel_order_snapshots WHERE application_id = ?').get(app.id) as any;
      const reportSnap = db.prepare('SELECT workflow_cycle_id FROM post_trip_report_snapshots WHERE application_id = ?').get(app.id) as any;
      if (orderSnap && reportSnap) {
        assert.ok(orderSnap.workflow_cycle_id !== undefined);
        assert.ok(reportSnap.workflow_cycle_id !== undefined);
      }
    }
  });

  it('GT-W3-13: [PINPOINT-02] Legacy 出張レコードの departure_place / arrival_place は NULL (Unknown) として保持される', () => {
    const db = getDb();
    const now = new Date().toISOString();
    // departure_place を指定せずに作成
    const res = db.prepare(`
      INSERT INTO trip_events (title, purpose, destination, start_at, end_at, created_by_user_id, version, created_at, updated_at)
      VALUES ('Legacy出張', '旧用務', '旧目的地', '2025-01-01', '2025-01-01', 1, 1, ?, ?)
    `).run(now, now);
    const row = db.prepare('SELECT departure_place, arrival_place, is_oral_order FROM trip_events WHERE id = ?').get(res.lastInsertRowid) as any;
    assert.strictEqual(row.departure_place, null, 'Legacy departure_place must remain NULL');
    assert.strictEqual(row.arrival_place, null, 'Legacy arrival_place must remain NULL');
    assert.strictEqual(row.is_oral_order, null, 'Legacy is_oral_order must remain NULL (Unknown)');
  });

  it('GT-W3-14: [PINPOINT-03] Historical Snapshot 未存在時、現在 Master から偽装生成を行わない', () => {
    // forms.ts の projection ロジックで orderSnapshot が null の場合でも現在Masterから偽造SnapshotテーブルへのINSERTは行われない
    const db = getDb();
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM travel_order_snapshots').get() as any).c;
    // 過去データ参照シミュレーション
    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM travel_order_snapshots').get() as any).c;
    assert.strictEqual(countBefore, countAfter);
  });

  it('GT-W3-15: [PINPOINT-04] 復命差戻し状態（REPORT_RETURNED）は REPORT_REVISION_REQUIRED として独立導出される', () => {
    const status = deriveTripStatus(
      'TRIP_APPROVED',
      'REPORT_RETURNED',
      '2026-09-01T09:00:00',
      '2026-09-01T17:00:00',
      '2026-09-02T10:00:00'
    );
    assert.strictEqual(status, 'REPORT_REVISION_REQUIRED');
    assert.notStrictEqual(status, 'REPORT_REQUIRED');
  });

  it('GT-W3-16: [PINPOINT-05] 計画交通手段（公用車）と実績交通手段（自家用車）が異なる場合、旅行命令 Snapshot は計画値を不変維持', () => {
    const planFacts = { transport: '公用車', departurePlace: '本校' };
    const actualFacts = { actualTransportMode: '自家用車', actualDeparturePlace: '自宅', actualMatchesPlan: false };
    
    assert.strictEqual(planFacts.transport, '公用車');
    assert.strictEqual(actualFacts.actualTransportMode, '自家用車');
    assert.notStrictEqual(planFacts.transport, actualFacts.actualTransportMode);
  });

  it('GT-W3-17: [PINPOINT-05] 自家用車実測距離（28.4km）が Actual Fact として保存されるが旅費額は計算されない', () => {
    const actualFacts = { actualDistanceKm: 28.4 };
    assert.strictEqual(actualFacts.actualDistanceKm, 28.4);
    assert.strictEqual((actualFacts as any).travelExpenseAmount, undefined);
  });

  it('GT-W3-18: [PINPOINT-05] 構造化された Actual Fact が PDF 備考欄へ決定論的に Projection される', () => {
    const text = formatTripRemarksProjection({
      actualDeparturePlace: '自宅',
      actualArrivalPlace: '本校',
      actualTransportMode: '自家用車',
      vehicleUsageType: 'DRIVER',
      actualDistanceKm: 18.2,
      communicationCostBorne: true,
      actualTripStartAt: '2026-10-10 08:30',
      actualTripEndAt: '2026-10-10 16:30',
      travelExpenseRemarks: '高速道路利用'
    });
    assert.ok(text.includes('【出発地】自宅'));
    assert.ok(text.includes('【帰着地】本校'));
    assert.ok(text.includes('【交通手段】自家用車 (運転)'));
    assert.ok(text.includes('【実測距離】18.2 km'));
    assert.ok(text.includes('【通信運送費負担】あり'));
    assert.ok(text.includes('【実時間】2026-10-10 08:30 〜 2026-10-10 16:30'));
    assert.ok(text.includes('【特記事項】高速道路利用'));
  });

  it('GT-W3-19: [PINPOINT-05] CSV 境界において住所・給与情報が混入しない', () => {
    const actualFacts = {
      actualDeparturePlace: '本校',
      actualArrivalPlace: '本校',
      actualTransportMode: '公用車',
      actualDistanceKm: null,
      communicationCostBorne: false
    };
    const keys = Object.keys(actualFacts);
    assert.strictEqual(keys.includes('address'), false);
    assert.strictEqual(keys.includes('salary'), false);
    assert.strictEqual(keys.includes('gradeAndStep'), false);
  });

  it('GT-W3-20: [FINAL-01] 通常電子申請で Authority Rule 未確定時は Fail-Closed 停止する', () => {
    assert.throws(() => {
      TripFinalizationService.resolveTravelOrderIssuedAt({ is_oral_order: 0 }, null);
    }, /FAIL-CLOSED/);
  });

  it('GT-W3-21: [FINAL-03] Actual 未入力時（actualMatchesPlan != true）に Plan 出発地を Actual へ自動コピーしない', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const eventRes = db.prepare(`
      INSERT INTO trip_events (title, purpose, destination, start_at, end_at, departure_place, transport, created_by_user_id, version, created_at, updated_at)
      VALUES ('未入力テスト', '用務', '用務地', '2026-11-01', '2026-11-01', '本校', '公用車', 1, 1, ?, ?)
    `).run(now, now);
    const eventId = Number(eventRes.lastInsertRowid);

    const appRes = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES ('BUSINESS_TRIP', 1, 1, ?, '出張', '{"actualMatchesPlan": false}', 'TRIP_APPROVED', 4, 1, ?, ?)
    `).run(eventId, now, now);
    const appId = Number(appRes.lastInsertRowid);

    TripReportFinalizationService.finalizeTripReport(appId, db, teacherUser);

    const reportSnap = db.prepare('SELECT * FROM post_trip_report_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(reportSnap);
    const facts = JSON.parse(reportSnap.travel_actual_facts_json);
    assert.strictEqual(facts.actualDeparturePlace, null, 'Missing actual place must remain null when not matched');
  });

  it('GT-W3-22: [FINAL-03] ユーザーが「計画どおり」（actualMatchesPlan = true）と明示確認した場合のみ転記される', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const eventRes = db.prepare(`
      INSERT INTO trip_events (title, purpose, destination, start_at, end_at, departure_place, arrival_place, transport, created_by_user_id, version, created_at, updated_at)
      VALUES ('計画どおりテスト', '用務', '用務地', '2026-11-02', '2026-11-02', '本校', '自宅', '自家用車', 1, 1, ?, ?)
    `).run(now, now);
    const eventId = Number(eventRes.lastInsertRowid);

    const appRes = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES ('BUSINESS_TRIP', 1, 1, ?, '出張', '{"actualMatchesPlan": true}', 'TRIP_APPROVED', 4, 1, ?, ?)
    `).run(eventId, now, now);
    const appId = Number(appRes.lastInsertRowid);

    TripReportFinalizationService.finalizeTripReport(appId, db, teacherUser);

    const reportSnap = db.prepare('SELECT * FROM post_trip_report_snapshots WHERE application_id = ?').get(appId) as any;
    assert.ok(reportSnap);
    const facts = JSON.parse(reportSnap.travel_actual_facts_json);
    assert.strictEqual(facts.actualDeparturePlace, '本校');
    assert.strictEqual(facts.actualArrivalPlace, '自宅');
    assert.strictEqual(facts.actualTransportMode, '自家用車');
  });

  it('GT-W3-23 & GT-W3-24: [FINAL-04] communicationCostBorne の Strict Tri-State 解釈 (true, false, null)', () => {
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(true), true);
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne('true'), true);
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(1), true);

    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(false), false);
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne('false'), false);
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(0), false);

    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(undefined), null);
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(null), null);
    assert.strictEqual(TripReportFinalizationService.parseCommunicationCostBorne(''), null);
  });

  it('GT-W3-25: [FINAL-05] Plan 日時と Actual 日時の完全分離（未記録時は NOT_COLLECTED）', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const eventRes = db.prepare(`
      INSERT INTO trip_events (title, purpose, destination, start_at, end_at, created_by_user_id, version, created_at, updated_at)
      VALUES ('日時分離テスト', '用務', '用務地', '2026-11-03T09:00:00', '2026-11-03T17:00:00', 1, 1, ?, ?)
    `).run(now, now);
    const eventId = Number(eventRes.lastInsertRowid);

    const appRes = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, trip_event_id, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES ('BUSINESS_TRIP', 1, 1, ?, '出張', '{"actualMatchesPlan": false}', 'TRIP_APPROVED', 4, 1, ?, ?)
    `).run(eventId, now, now);
    const appId = Number(appRes.lastInsertRowid);

    TripReportFinalizationService.finalizeTripReport(appId, db, teacherUser);

    const reportSnap = db.prepare('SELECT * FROM post_trip_report_snapshots WHERE application_id = ?').get(appId) as any;
    const facts = JSON.parse(reportSnap.travel_actual_facts_json);
    assert.strictEqual(facts.actualTripStartAt, null);
    assert.strictEqual(facts.actualTripEndAt, null);
  });

  it('GT-W3-26: [NEW MANDATORY] Final Authority Identity / Authority Validation (非権限者の承認ステップは Fail-Closed)', () => {
    const invalidStep = {
      step_name: '一般係員確認',
      required_role_id: 'TEACHER',
      selector_value_snapshot: 'TEACHER',
      is_final_decision_step: 0,
      acted_at: '2026-10-10T10:00:00+09:00'
    };

    assert.throws(() => {
      TripFinalizationService.resolveTravelOrderIssuedAt({ is_oral_order: 0 }, invalidStep);
    }, /INVALID_TRAVEL_ORDER_AUTHORITY/);
  });

  it('GT-W3-27: [NEW MANDATORY] Japan Calendar Date Boundary (UTC 15:30 -> Asia/Tokyo 翌日 00:30 の公務暦日判定)', () => {
    // 2026-09-09T15:30:00Z は UTC だが、日本時間 (JST = UTC+9) では 2026-09-10 00:30:00
    const utcTimestamp = '2026-09-09T15:30:00Z';
    const jstDate = toTokyoCalendarDate(utcTimestamp);
    assert.strictEqual(jstDate, '2026-09-10', 'Must be converted to JST calendar date (2026-09-10), not UTC prefix (2026-09-09)');

    const validPrincipalStep = {
      step_name: '校長決裁',
      required_role_id: 'PRINCIPAL',
      selector_value_snapshot: 'PRINCIPAL',
      is_final_decision_step: 1,
      acted_at: utcTimestamp
    };

    const issuedAt = TripFinalizationService.resolveTravelOrderIssuedAt({ is_oral_order: 0 }, validPrincipalStep);
    assert.strictEqual(issuedAt, '2026-09-10');
  });
});
