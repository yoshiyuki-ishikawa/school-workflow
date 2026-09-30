/**
 * Same-Date Conflict v1.0 FINAL Golden Test Suite
 * GT-SDC-01 〜 GT-SDC-07 (Positive Coexistence & Symmetry)
 * GT-SDC-N01 〜 GT-SDC-N05 (Negative Controls & Invariants)
 * 
 * Formal Verification of Same-Date Conflict Explicit Semantic Contract v1.0 FINAL
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
import { adaptApplicationToCanonicalFact } from '../services/canonical/adapters/applicationAdapter';
import { CanonicalAttendanceEvaluator } from '../services/canonical/evaluator';

describe('Same-Date Conflict v1.0 FINAL Golden Suite (GT-SDC-01〜07, GT-SDC-N01〜N05)', () => {
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
  // Positive Goldens: Trip × Trip & Order-Independent Trip × Leave (GT-SDC-01〜07)
  // =========================================================================

  it('GT-SDC-01: BUSINESS_TRIP × BUSINESS_TRIP same date (No-Time) → PASS (COEXIST_BY_POLICY) & No Double-Count', () => {
    const user = getTeacherUser();

    // 1. 同日出張A提出 (No-Time)
    const tripARes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張A',
      formData: { startDate: '2026-09-15', endDate: '2026-09-15', purpose: '午前会議用務' }
    });
    assert.strictEqual(tripARes.success, true);
    assert.strictEqual(tripARes.statusCode, 200);
    const tripAId = tripARes.data.id;

    // 2. 同日出張B提出 (No-Time) → 同一日という事実だけでは遮断されず PASS
    const tripBRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張B',
      formData: { startDate: '2026-09-15', endDate: '2026-09-15', purpose: '午後協議用務' }
    });
    assert.strictEqual(tripBRes.success, true);
    assert.strictEqual(tripBRes.statusCode, 200);
    const tripBId = tripBRes.data.id;

    // 3. 両方決裁完了
    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripAId, expectedVersion: 1, comment: '事務' });
    const tAVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripAId, expectedVersion: tAVp.version, comment: '教頭' });
    const tAPrinc = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripAId, expectedVersion: tAPrinc.version, comment: '校長決裁' });

    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripBId, expectedVersion: 1, comment: '事務' });
    const tBVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripBId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripBId, expectedVersion: tBVp.version, comment: '教頭' });
    const tBPrinc = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripBId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripBId, expectedVersion: tBPrinc.version, comment: '校長決裁' });

    // 4. Evaluator で勤怠評価 (所定勤務時間の二重加算がないことを検証)
    const finalTripA = db.prepare('SELECT * FROM applications WHERE id = ?').get(tripAId) as any;
    const finalTripB = db.prepare('SELECT * FROM applications WHERE id = ?').get(tripBId) as any;
    const allFacts = [...adaptApplicationToCanonicalFact(finalTripA), ...adaptApplicationToCanonicalFact(finalTripB)];

    const evalResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-15' },
      allFacts
    );

    assert.strictEqual(evalResult.isScheduledWorkDay, true);
    assert.strictEqual(evalResult.dutyStatus, 'WORK_REQUIRED');
    assert.strictEqual(evalResult.scheduledWorkMinutes, 465); // 所定日課465分
    assert.strictEqual(evalResult.countedWorkMinutes, 465); // 二重加算されず465分
    assert.strictEqual(evalResult.deductionMinutes, 0);
    assert.strictEqual(evalResult.effectiveWorkMinutes, 465);
    // Evaluator Internal Action は OVERRIDE_ALL (Conflict Semantic は COEXIST_BY_POLICY)
    assert.strictEqual(evalResult.appliedConflictAction, 'OVERRIDE_ALL');
  });

  it('GT-SDC-02: Existing BUSINESS_TRIP + New HALF_DAY MORNING → PASS → COEXIST_AND_DEDUCT', () => {
    const user = getTeacherUser();

    // 1. 出張 (No-Time)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-16', endDate: '2026-09-16', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);
    const tripId = tripRes.data.id;

    // 2. 今午前半日年休提出 → 遮断されず PASS
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-16', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
    const leaveId = leaveRes.data.id;

    // 決裁完了 & Evaluator 合成検証
    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripId, expectedVersion: 1, comment: '確認' });
    const tVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripId, expectedVersion: tVp.version, comment: '確認' });
    const tP = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripId, expectedVersion: tP.version, comment: '承認' });

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: leaveId, expectedVersion: 1, comment: '年休確認' });
    const lP = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: leaveId, expectedVersion: lP.version, comment: '年休承認' });

    const finalTrip = db.prepare('SELECT * FROM applications WHERE id = ?').get(tripId) as any;
    const finalLeave = db.prepare('SELECT * FROM applications WHERE id = ?').get(leaveId) as any;
    const allFacts = [...adaptApplicationToCanonicalFact(finalTrip), ...adaptApplicationToCanonicalFact(finalLeave)];

    const evalResult = CanonicalAttendanceEvaluator.evaluateDay({ userId: user.id, date: '2026-09-16' }, allFacts);
    assert.strictEqual(evalResult.scheduledWorkMinutes, 465);
    assert.strictEqual(evalResult.deductionMinutes, 230); // 午前免除 230分
    assert.strictEqual(evalResult.effectiveWorkMinutes, 235); // 控除後の残勤務時間 235分を勤務認定
    assert.strictEqual(evalResult.countedWorkMinutes, 235);
    assert.strictEqual(evalResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  it('GT-SDC-03: Existing HALF_DAY MORNING + New BUSINESS_TRIP → PASS → COEXIST_AND_DEDUCT (Symmetric with SDC-02)', () => {
    const user = getTeacherUser();

    // 1. 午前年休
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-16', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(leaveRes.success, true);

    // 2. 出張提出 → PASS (申請順序非依存)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-16', endDate: '2026-09-16', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);
  });

  it('GT-SDC-04: Existing BUSINESS_TRIP + New HALF_DAY AFTERNOON → PASS → COEXIST_AND_DEDUCT', () => {
    const user = getTeacherUser();

    // 1. 出張
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-17', endDate: '2026-09-17', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);
    const tripId = tripRes.data.id;

    // 2. 午後半日年休 → PASS
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半日年休',
      formData: { targetDate: '2026-09-17', unitType: 'HALF_DAY', halfDayType: 'AFTERNOON' }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
    const leaveId = leaveRes.data.id;

    // 決裁 & Evaluator
    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripId, expectedVersion: 1, comment: '確認' });
    const tVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripId, expectedVersion: tVp.version, comment: '確認' });
    const tP = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripId, expectedVersion: tP.version, comment: '承認' });

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: leaveId, expectedVersion: 1, comment: '年休確認' });
    const lP = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: leaveId, expectedVersion: lP.version, comment: '年休承認' });

    const finalTrip = db.prepare('SELECT * FROM applications WHERE id = ?').get(tripId) as any;
    const finalLeave = db.prepare('SELECT * FROM applications WHERE id = ?').get(leaveId) as any;
    const allFacts = [...adaptApplicationToCanonicalFact(finalTrip), ...adaptApplicationToCanonicalFact(finalLeave)];

    const evalResult = CanonicalAttendanceEvaluator.evaluateDay({ userId: user.id, date: '2026-09-17' }, allFacts);
    assert.strictEqual(evalResult.scheduledWorkMinutes, 465);
    assert.strictEqual(evalResult.deductionMinutes, 235); // 午後免除 235分
    assert.strictEqual(evalResult.effectiveWorkMinutes, 230); // 控除後の残勤務時間 230分を勤務認定
    assert.strictEqual(evalResult.countedWorkMinutes, 230);
    assert.strictEqual(evalResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  it('GT-SDC-05: Existing HALF_DAY AFTERNOON + New BUSINESS_TRIP → PASS → COEXIST_AND_DEDUCT (Symmetric with SDC-04)', () => {
    const user = getTeacherUser();

    // 1. 午後半日年休
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半日年休',
      formData: { targetDate: '2026-09-17', unitType: 'HALF_DAY', halfDayType: 'AFTERNOON' }
    });
    assert.strictEqual(leaveRes.success, true);

    // 2. 出張 → PASS (双方向対称性)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-17', endDate: '2026-09-17', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);
  });

  it('GT-SDC-06: Existing BUSINESS_TRIP + New TIME_LEAVE → PASS → COEXIST_AND_DEDUCT', () => {
    const user = getTeacherUser();

    // 1. 出張
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-18', endDate: '2026-09-18', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);

    // 2. 時間年休 (14:00-16:00) → PASS
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-18', unitType: 'TIME', startTime: '14:00', endTime: '16:00' }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
  });

  it('GT-SDC-07: Existing TIME_LEAVE + New BUSINESS_TRIP → PASS → COEXIST_AND_DEDUCT (Symmetric with SDC-06)', () => {
    const user = getTeacherUser();

    // 1. 時間年休 (14:00-16:00)
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-18', unitType: 'TIME', startTime: '14:00', endTime: '16:00' }
    });
    assert.strictEqual(leaveRes.success, true);

    // 2. 出張 → PASS (双方向対称性)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-18', endDate: '2026-09-18', purpose: '会議' }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);
  });

  // =========================================================================
  // Negative Controls: Invariants & Overlap Firewall (GT-SDC-N01〜N05)
  // =========================================================================

  it('GT-SDC-N01: FULL_DAY LEAVE + BUSINESS_TRIP → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: { targetDate: '2026-09-28', startDate: '2026-09-28', endDate: '2026-09-28', unitType: 'DAY', reason: '私用' }
    });
    assert.strictEqual(leaveRes.success, true);

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-28', endDate: '2026-09-28', purpose: '出張' }
    });
    assert.strictEqual(tripRes.success, false);
    assert.strictEqual(tripRes.statusCode, 422);
    assert.strictEqual(tripRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-SDC-N02: BUSINESS_TRIP + FULL_DAY LEAVE → BLOCK (422 SERVICE_PERIOD_CONFLICT) (Symmetric with N01)', () => {
    const user = getTeacherUser();

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      formData: { startDate: '2026-09-28', endDate: '2026-09-28', purpose: '出張' }
    });
    assert.strictEqual(tripRes.success, true);

    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: { targetDate: '2026-09-28', startDate: '2026-09-28', endDate: '2026-09-28', unitType: 'DAY', reason: '私用' }
    });
    assert.strictEqual(leaveRes.success, false);
    assert.strictEqual(leaveRes.statusCode, 422);
    assert.strictEqual(leaveRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-SDC-N03: TIME_LEAVE 10:00-12:00 vs 11:00-13:00 → BLOCK (422 TIME_CONFLICT)', () => {
    const user = getTeacherUser();

    const res1 = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休1',
      formData: { targetDate: '2026-09-29', unitType: 'TIME', startTime: '10:00', endTime: '12:00', reason: '私用' }
    });
    assert.strictEqual(res1.success, true);

    const check = ConflictService.validate({
      userId: user.id,
      startDate: '2026-09-29',
      endDate: '2026-09-29',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '11:00',
      endTime: '13:00'
    });
    assert.strictEqual(check.hasConflict, true);
    assert.strictEqual(check.conflictType, 'TIME_CONFLICT');
  });

  it('GT-SDC-N04: HALF_DAY MORNING vs TIME_LEAVE within morning interval → BLOCK (422 TIME_CONFLICT)', () => {
    const user = getTeacherUser();

    const res1 = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-29', unitType: 'HALF_DAY', halfDayType: 'MORNING', reason: '私用' }
    });
    assert.strictEqual(res1.success, true);

    // 09:00〜11:00 は午前の勤務区間内
    const check = ConflictService.validate({
      userId: user.id,
      startDate: '2026-09-29',
      endDate: '2026-09-29',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '09:00',
      endTime: '11:00'
    });
    assert.strictEqual(check.hasConflict, true);
    assert.strictEqual(check.conflictType, 'TIME_CONFLICT');
  });

  it('GT-SDC-N05: HALF_DAY MORNING + HALF_DAY AFTERNOON → PASS (Non-overlapping intervals)', () => {
    const user = getTeacherUser();

    const amRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-30', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(amRes.success, true);

    const pmRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半日年休',
      formData: { targetDate: '2026-09-30', unitType: 'HALF_DAY', halfDayType: 'AFTERNOON' }
    });
    assert.strictEqual(pmRes.success, true);
    assert.strictEqual(pmRes.statusCode, 200);
  });
});
