/**
 * Wave 2 — Same-Date Conflict Relaxation Golden Test Suite
 * W2-B: Semantic Compatibility Relaxation (OPTION B)
 * GT-W2-01 〜 GT-W2-19
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { ConflictService } from '../services/conflictService';

describe('Wave 2 Same-Date Conflict Relaxation Golden Suite (GT-W2-01〜19)', () => {
  let db: any;
  let teacher1: any;
  let vp: any;
  let principal: any;
  let office: any;

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();

    teacher1 = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get('teacher1') as any;
    vp = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get('vice_principal') as any;
    principal = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get('principal') as any;
    office = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get('office') as any;

    // 特例法22条研修ポリシーを確定 (CONFIRMED) 状態に設定
    db.prepare(`
      UPDATE policy_rules
      SET display_code = '研修', aggregation_category = 'TRAINING', rule_definition_json = ?
      WHERE policy_code = 'SPECIAL_ACT_22_2'
    `).run(JSON.stringify({
      status: 'CONFIRMED',
      hourlyAllowed: 'CONFIRMED',
      dailyDisplayRule: 'CONFIRMED',
      travelOrderRequirement: 'POLICY_DEFINED',
      workTimeTreatment: 'COUNT_AS_WORK',
      deductionRule: 'NONE',
      monthlyAggregationRule: 'CONFIRMED',
      annualAggregationRule: 'CONFIRMED',
    }));
  });

  const getTeacherUser = () => ({
    id: teacher1.id,
    username: teacher1.username,
    displayName: teacher1.display_name,
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1'
  });

  const getVpUser = () => ({
    id: vp.id,
    username: vp.username,
    displayName: vp.display_name,
    roles: ['VICE_PRINCIPAL'],
    ipAddress: '127.0.0.1'
  });

  const getPrincipalUser = () => ({
    id: principal.id,
    username: principal.username,
    displayName: principal.display_name,
    roles: ['PRINCIPAL'],
    ipAddress: '127.0.0.1'
  });

  const getOfficeUser = () => ({
    id: office.id,
    username: office.username,
    displayName: office.display_name,
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1'
  });

  // =========================================================================
  // Compatibility: WORK_COUNTED DAY_EVENT × TIME_EVENT (GT-W2-01〜04)
  // =========================================================================
  it('GT-W2-01: Existing 終日出張 + Incoming 時間年休 (14:00-16:00) → PASS (200 OK)', () => {
    const user = getTeacherUser();

    // 1. 2026-09-01 終日出張を提出
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '市内出張',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        purpose: '会議',
        destination: '市役所',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);

    // 2. 同日 14:00〜16:00 時間年休を提出 → W2-B により正常受理
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'TIME',
        startTime: '14:00',
        endTime: '16:00',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
    assert.ok(leaveRes.data?.id);
  });

  it('GT-W2-02: Existing 時間年休 (14:00-16:00) + Incoming 終日出張 → PASS (双方向対称性)', () => {
    const user = getTeacherUser();

    // 1. 2026-09-01 14:00〜16:00 時間年休を提出
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'TIME',
        startTime: '14:00',
        endTime: '16:00',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);

    // 2. 同日 終日出張を提出 → W2-B により正常受理 (双方向対称性)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '市内出張',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        purpose: '会議',
        destination: '市役所',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);
    assert.ok(tripRes.data?.id);
  });

  it('GT-W2-03: Existing 終日研修 (特例法22条2項) + Incoming 時間年休 → PASS (200 OK)', () => {
    const user = getTeacherUser();

    // 1. 2026-09-01 終日研修を提出
    const trainingRes = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修',
      formData: {
        targetDate: '2026-09-01',
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        unitType: 'DAY',
        purpose: '研究協議',
        reason: '研究協議'
      }
    });
    assert.strictEqual(trainingRes.success, true);
    assert.strictEqual(trainingRes.statusCode, 200);

    // 2. 同日 時間年休を提出 → 正常受理
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'TIME',
        startTime: '15:00',
        endTime: '16:00',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
  });

  it('GT-W2-04: Existing 時間年休 + Incoming 終日研修 (特例法22条2項) → PASS (双方向対称性)', () => {
    const user = getTeacherUser();

    // 1. 2026-09-01 時間年休を提出
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'TIME',
        startTime: '15:00',
        endTime: '16:00',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);

    // 2. 同日 終日研修を提出 → 正常受理
    const trainingRes = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修',
      formData: {
        targetDate: '2026-09-01',
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        unitType: 'DAY',
        purpose: '研究協議',
        reason: '研究協議'
      }
    });
    assert.strictEqual(trainingRes.success, true);
    assert.strictEqual(trainingRes.statusCode, 200);
  });

  // =========================================================================
  // DAY_EVENT × DAY_EVENT Firewall (GT-W2-05〜11)
  // =========================================================================
  it('GT-W2-05: 終日出張 + 終日年休 → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-02', endDate: '2026-09-02', purpose: '会議' }
    });

    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: { targetDate: '2026-09-02', startDate: '2026-09-02', endDate: '2026-09-02', unitType: 'DAY', reason: '私用' }
    });
    assert.strictEqual(leaveRes.success, false);
    assert.strictEqual(leaveRes.statusCode, 422);
    assert.strictEqual(leaveRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-W2-06: 終日年休 + 終日出張 → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: { targetDate: '2026-09-02', startDate: '2026-09-02', endDate: '2026-09-02', unitType: 'DAY', reason: '私用' }
    });

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-02', endDate: '2026-09-02', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, false);
    assert.strictEqual(tripRes.statusCode, 422);
    assert.strictEqual(tripRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-W2-07: 終日研修 + 終日病気休暇 → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    const trainingRes = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修',
      formData: { targetDate: '2026-09-03', startDate: '2026-09-03', endDate: '2026-09-03', unitType: 'DAY', purpose: '研究協議', reason: '研究協議' }
    });
    if (!trainingRes.success) {
      console.log('GT-W2-07 trainingRes failed:', JSON.stringify(trainingRes));
    }
    assert.strictEqual(trainingRes.success, true);

    const sickRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_SICK',
      title: '病気休暇',
      formData: { startDate: '2026-09-03', endDate: '2026-09-03', unitType: 'DAY', reason: '療養' }
    });
    assert.strictEqual(sickRes.success, false);
    assert.strictEqual(sickRes.statusCode, 422);
    assert.strictEqual(sickRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-W2-08: 終日病気休暇 + 終日研修 → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    const sickRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_SICK',
      title: '病気休暇',
      formData: { startDate: '2026-09-03', endDate: '2026-09-03', unitType: 'DAY', reason: '療養' }
    });
    assert.strictEqual(sickRes.success, true);

    const trainingRes = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修',
      formData: { targetDate: '2026-09-03', startDate: '2026-09-03', endDate: '2026-09-03', unitType: 'DAY', purpose: '研究協議', reason: '研究協議' }
    });
    assert.strictEqual(trainingRes.success, false);
    assert.strictEqual(trainingRes.statusCode, 422);
    assert.strictEqual(trainingRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-W2-09: 終日出張 + 別の終日出張 → PASS (COEXIST_BY_POLICY / 同一日複数出張の許容)', () => {
    const user = getTeacherUser();

    const tripARes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張A',
      formData: { startDate: '2026-09-04', endDate: '2026-09-04', purpose: '会議A' }
    });
    assert.strictEqual(tripARes.success, true);
    assert.strictEqual(tripARes.statusCode, 200);

    const tripBRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張B',
      formData: { startDate: '2026-09-04', endDate: '2026-09-04', purpose: '会議B' }
    });
    assert.strictEqual(tripBRes.success, true);
    assert.strictEqual(tripBRes.statusCode, 200);
    assert.ok(tripBRes.data?.id);
  });

  it('GT-W2-10: 終日出張 + 終日研修 → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-07', endDate: '2026-09-07', purpose: '会議' }
    });

    const trainingRes = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修',
      formData: { targetDate: '2026-09-07', startDate: '2026-09-07', endDate: '2026-09-07', unitType: 'DAY', purpose: '研究協議', reason: '研究協議' }
    });
    assert.strictEqual(trainingRes.success, false);
    assert.strictEqual(trainingRes.statusCode, 422);
    assert.strictEqual(trainingRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-W2-11: 終日研修 + 別の終日研修 → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    const t1 = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修1',
      formData: { targetDate: '2026-09-08', startDate: '2026-09-08', endDate: '2026-09-08', unitType: 'DAY', purpose: '研究協議1', reason: '研究協議1' }
    });
    assert.strictEqual(t1.success, true);

    const training2Res = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修2',
      formData: { targetDate: '2026-09-08', startDate: '2026-09-08', endDate: '2026-09-08', unitType: 'DAY', purpose: '研究協議2', reason: '研究協議2' }
    });
    assert.strictEqual(training2Res.success, false);
    assert.strictEqual(training2Res.statusCode, 422);
    assert.strictEqual(training2Res.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  // =========================================================================
  // TIME_EVENT × TIME_EVENT Firewall (GT-W2-12〜14: Unit Level)
  // =========================================================================
  it('GT-W2-12: 時間単位申請の開区間重複 (10:00-12:00 vs 11:00-13:00) → TIME_CONFLICT', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-07', unitType: 'TIME', startTime: '10:00', endTime: '12:00' }
    });

    const check = ConflictService.validate({
      userId: user.id,
      startDate: '2026-09-07',
      endDate: '2026-09-07',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '11:00',
      endTime: '13:00'
    });
    assert.strictEqual(check.hasConflict, true);
    assert.strictEqual(check.conflictType, 'TIME_CONFLICT');
  });

  it('GT-W2-13: 時間単位申請の境界接触 (12:00-13:00 vs 13:00-14:00) → PASS (hasConflict: false)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-08', unitType: 'TIME', startTime: '12:00', endTime: '13:00' }
    });

    const check = ConflictService.validate({
      userId: user.id,
      startDate: '2026-09-08',
      endDate: '2026-09-08',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '13:00',
      endTime: '14:00'
    });
    assert.strictEqual(check.hasConflict, false);
  });

  it('GT-W2-14: 時間単位申請の非重複時間帯 (09:00-10:00 vs 15:00-16:00) → PASS (hasConflict: false)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-09', unitType: 'TIME', startTime: '09:00', endTime: '10:00' }
    });

    const check = ConflictService.validate({
      userId: user.id,
      startDate: '2026-09-09',
      endDate: '2026-09-09',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '15:00',
      endTime: '16:00'
    });
    assert.strictEqual(check.hasConflict, false);
  });

  // =========================================================================
  // Multi-Fact (GT-W2-15, 16)
  // =========================================================================
  it('GT-W2-15: 終日出張 + 複数非重複時間事象 (出張 + 10-11時年休 + 14-15時年休) → 全件 PASS', () => {
    const user = getTeacherUser();

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-10', endDate: '2026-09-10', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);

    const time1Res = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前時間年休',
      formData: { targetDate: '2026-09-10', unitType: 'TIME', startTime: '10:00', endTime: '11:00' }
    });
    assert.strictEqual(time1Res.success, true);

    const time2Res = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後時間年休',
      formData: { targetDate: '2026-09-10', unitType: 'TIME', startTime: '14:00', endTime: '15:00' }
    });
    assert.strictEqual(time2Res.success, true);
  });

  it('GT-W2-16: 終日出張 + 重複時間事象ペア (出張 + 10-12時年休 + 11-13時年休) → 2件目 TIME_CONFLICT', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-11', endDate: '2026-09-11', purpose: '会議' }
    });

    const time1Res = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休1',
      formData: { targetDate: '2026-09-11', unitType: 'TIME', startTime: '10:00', endTime: '12:00' }
    });
    assert.strictEqual(time1Res.success, true);

    const time2Res = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休2',
      formData: { targetDate: '2026-09-11', unitType: 'TIME', startTime: '11:00', endTime: '13:00' }
    });
    assert.strictEqual(time2Res.success, false);
    assert.strictEqual(time2Res.statusCode, 422);
    assert.strictEqual(time2Res.errorCode, 'TIME_CONFLICT');
  });

  // =========================================================================
  // Lifecycle (GT-W2-17〜19)
  // =========================================================================
  it('GT-W2-17: 決裁時再検証 (Final Approval Revalidation) — 出張×時間年休で 409 誤遮断が発生せず承認完了すること', () => {
    const user = getTeacherUser();
    const vpUser = getVpUser();
    const principalUser = getPrincipalUser();

    // 1. 出張を提出
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-09', endDate: '2026-09-09', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);
    const tripAppId = tripRes.data.id;

    // 2. 時間年休を提出
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-09', unitType: 'TIME', startTime: '14:00', endTime: '16:00' }
    });
    assert.strictEqual(leaveRes.success, true);
    const leaveAppId = leaveRes.data.id;

    // 3. 出張を教頭確認 → 校長決裁
    WorkflowEngine.approveApplication(vpUser, { applicationId: tripAppId, expectedVersion: 1, comment: '確認' });
    const appTrip = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(principalUser, { applicationId: tripAppId, expectedVersion: appTrip.version, comment: '決裁' });

    // 4. 時間年休を教頭確認 → 校長決裁 → 409 にならず成功すること
    WorkflowEngine.approveApplication(vpUser, { applicationId: leaveAppId, expectedVersion: 1, comment: '年休確認' });
    const appLeave = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveAppId) as any;
    const approveLeave = WorkflowEngine.approveApplication(principalUser, {
      applicationId: leaveAppId,
      expectedVersion: appLeave.version,
      comment: '年休決裁'
    });
    assert.strictEqual(approveLeave.success, true);
    assert.strictEqual(approveLeave.data.nextStatus, 'FINAL_APPROVED');
  });

  it('GT-W2-18: 差戻し後の再提出 (RESUBMIT) における出張×時間年休が正常受理されること', () => {
    const user = getTeacherUser();
    const vpUser = getVpUser();

    // 1. 出張を提出
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-10', endDate: '2026-09-10', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);

    // 2. 時間年休を提出
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-10', unitType: 'TIME', startTime: '14:00', endTime: '16:00' }
    });
    assert.strictEqual(leaveRes.success, true);

    // 3. 差戻し (教頭が差戻し)
    const appLeave = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveRes.data.id) as any;
    const returnRes = WorkflowEngine.returnApplication(vpUser, {
      applicationId: leaveRes.data.id,
      expectedVersion: appLeave.version,
      comment: '理由追記'
    });
    assert.strictEqual(returnRes.success, true);

    // 4. 再提出 (RESUBMIT) → 正常受理されること
    const resubmitRes = WorkflowEngine.resubmitApplication(user, {
      applicationId: leaveRes.data.id,
      expectedVersion: 2,
      title: '時間年休 (再提出)',
      formData: { targetDate: '2026-09-10', unitType: 'TIME', startTime: '14:00', endTime: '16:00', reason: '通院のため' }
    });
    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.statusCode, 200);
  });

  it('GT-W2-19: 代理申請 (PROXY) における出張×時間年休が正常受理されること', () => {
    const officeUser = getOfficeUser();

    // 事務職員が教員1の終日出張を代理提出
    const tripRes = WorkflowEngine.submitApplication(officeUser, {
      typeId: 'BUSINESS_TRIP',
      title: '【代理】終日出張',
      subjectUserId: teacher1.id,
      actorType: 'PROXY',
      formData: { startDate: '2026-09-14', endDate: '2026-09-14', purpose: '研修会議' }
    });
    assert.strictEqual(tripRes.success, true);

    // 教員1本人が同日時間年休を提出 → 正常受理されること
    const leaveRes = WorkflowEngine.submitApplication(getTeacherUser(), {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-14', unitType: 'TIME', startTime: '15:00', endTime: '16:00' }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
  });
});
