/**
 * HALF-B — Half-Day Leave × Multi-Fact Attendance Day Golden Test Suite
 * GT-HALF-01 〜 GT-HALF-17
 * 
 * Frozen Implementation Contract:
 * - HALF_DAY = TIME_EVENT
 * - Schedule-Derived Break-Bounded Intervals (No Hard-coded Clock Times)
 * - Model P3 Evaluator Zero-Change / COEXIST_AND_DEDUCT Preservation
 * - Wave 2 / C6 Invariant Preservation
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
import { AnnualLeaveService } from '../services/annualLeaveService';
import { adaptApplicationToCanonicalFact } from '../services/canonical/adapters/applicationAdapter';
import { CanonicalAttendanceEvaluator } from '../services/canonical/evaluator';
import { normalizeFormData } from '../routes/applications';

describe('HALF-B: Half-Day Leave × Multi-Fact Attendance Day Golden Suite (GT-HALF-01〜17)', () => {
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

    // 年休ロット付与 (2026年度 20日)
    AnnualLeaveService.grantEntitlement({
      userId: teacher1.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '2026年度当初付与'
    });
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
  // Standalone Half-Day Leave (GT-HALF-01, GT-HALF-02)
  // =========================================================================
  it('GT-HALF-01: 通常勤務日 + MORNING HALF → PASS → authoritative deduction = pre-break full interval (240分)', () => {
    const user = getTeacherUser();

    // 2026-09-01 (火曜日・平日) 今午前半日年休を提出
    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'HALF_DAY',
        halfDayType: 'MORNING',
        reason: '私用'
      }
    });
    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.statusCode, 200);

    const appId = submitRes.data.id;
    // 決裁完了させる (教頭 -> 校長)
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: appId, expectedVersion: 1, comment: '確認' });
    const appAfterVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: appId, expectedVersion: appAfterVp.version, comment: '承認' });

    // Canonical Fact 変換
    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const facts = adaptApplicationToCanonicalFact(finalApp);
    assert.strictEqual(facts.length, 1);
    const fact = facts[0];

    // TIME_EVENT として正規化されていること
    assert.strictEqual(fact.factType, 'TIME_EVENT');
    assert.strictEqual(fact.startTime, '08:10');
    assert.strictEqual(fact.endTime, '12:00');
    assert.strictEqual(fact.quantityUnits, 230);

    // P3 Evaluator で評価
    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-01' },
      facts
    );
    assert.strictEqual(domainResult.scheduledWorkMinutes, 465);
    assert.strictEqual(domainResult.deductionMinutes, 230);
    assert.strictEqual(domainResult.effectiveWorkMinutes, 235);
    assert.strictEqual(domainResult.countedWorkMinutes, 235);
    assert.strictEqual(domainResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  it('GT-HALF-02: 通常勤務日 + AFTERNOON HALF → PASS → authoritative deduction = post-break full interval (235分)', () => {
    const user = getTeacherUser();

    // 2026-09-01 (火曜日・平日) 午後半日年休を提出
    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半日年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'HALF_DAY',
        halfDayType: 'AFTERNOON',
        reason: '通院'
      }
    });
    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.statusCode, 200);

    const appId = submitRes.data.id;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: appId, expectedVersion: 1, comment: '確認' });
    const appAfterVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: appId, expectedVersion: appAfterVp.version, comment: '承認' });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const facts = adaptApplicationToCanonicalFact(finalApp);
    assert.strictEqual(facts.length, 1);
    const fact = facts[0];

    assert.strictEqual(fact.factType, 'TIME_EVENT');
    assert.strictEqual(fact.startTime, '12:45');
    assert.strictEqual(fact.endTime, '16:40');
    assert.strictEqual(fact.quantityUnits, 235);

    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-01' },
      facts
    );
    assert.strictEqual(domainResult.scheduledWorkMinutes, 465);
    assert.strictEqual(domainResult.deductionMinutes, 235);
    assert.strictEqual(domainResult.effectiveWorkMinutes, 230);
    assert.strictEqual(domainResult.countedWorkMinutes, 230);
    assert.strictEqual(domainResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // Half-Day × Business Trip Composition (GT-HALF-03, GT-HALF-04)
  // =========================================================================
  it('GT-HALF-03: MORNING HALF + BUSINESS_TRIP (No-Time) → PASS → COEXIST_AND_DEDUCT', () => {
    const user = getTeacherUser();

    // 1. 今午前半日年休提出
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: {
        targetDate: '2026-09-02',
        unitType: 'HALF_DAY',
        halfDayType: 'MORNING',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);
    const leaveAppId = leaveRes.data.id;

    // 2. 出張提出 (No-Time) → PASS
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '午後出張',
      formData: {
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        purpose: '午後会議',
        destination: '市役所',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);
    const tripAppId = tripRes.data.id;

    // 両方を決裁完了 (年休: 教頭->校長, 出張: 事務->教頭->校長)
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: leaveAppId, expectedVersion: 1, comment: '確認' });
    const lVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveAppId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: leaveAppId, expectedVersion: lVp.version, comment: '承認' });

    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripAppId, expectedVersion: 1, comment: '事務確認' });
    const tOff = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripAppId, expectedVersion: tOff.version, comment: '確認' });
    const tVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripAppId, expectedVersion: tVp.version, comment: '承認' });

    const finalLeave = db.prepare('SELECT * FROM applications WHERE id = ?').get(leaveAppId) as any;
    const finalTrip = db.prepare('SELECT * FROM applications WHERE id = ?').get(tripAppId) as any;

    const leaveFacts = adaptApplicationToCanonicalFact(finalLeave);
    const tripFacts = adaptApplicationToCanonicalFact(finalTrip);
    const allFacts = [...leaveFacts, ...tripFacts];

    // P3 Evaluator 合成
    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-02' },
      allFacts
    );
    assert.strictEqual(domainResult.scheduledWorkMinutes, 465);
    assert.strictEqual(domainResult.deductionMinutes, 230); // 年休控除 230分
    assert.strictEqual(domainResult.effectiveWorkMinutes, 235); // 残勤務 235分
    assert.strictEqual(domainResult.countedWorkMinutes, 235); // 出張実働 235分
    assert.strictEqual(domainResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  it('GT-HALF-04: BUSINESS_TRIP (No-Time) + AFTERNOON HALF → PASS → COEXIST_AND_DEDUCT', () => {
    const user = getTeacherUser();

    // 1. 出張提出 (No-Time)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '午前出張',
      formData: {
        startDate: '2026-09-03',
        endDate: '2026-09-03',
        purpose: '午前会議',
        destination: '市役所',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, true);
    const tripAppId = tripRes.data.id;

    // 2. 午後半日年休提出 → 時間帯重複なしで PASS
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半日年休',
      formData: {
        targetDate: '2026-09-03',
        unitType: 'HALF_DAY',
        halfDayType: 'AFTERNOON',
        reason: '通院'
      }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
    const leaveAppId = leaveRes.data.id;

    // 決裁完了 (出張: 事務->教頭->校長, 年休: 教頭->校長)
    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripAppId, expectedVersion: 1, comment: '事務確認' });
    const tOff = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripAppId, expectedVersion: tOff.version, comment: '確認' });
    const tVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripAppId, expectedVersion: tVp.version, comment: '承認' });

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: leaveAppId, expectedVersion: 1, comment: '確認' });
    const lVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveAppId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: leaveAppId, expectedVersion: lVp.version, comment: '承認' });

    const finalTrip = db.prepare('SELECT * FROM applications WHERE id = ?').get(tripAppId) as any;
    const finalLeave = db.prepare('SELECT * FROM applications WHERE id = ?').get(leaveAppId) as any;

    const allFacts = [...adaptApplicationToCanonicalFact(finalTrip), ...adaptApplicationToCanonicalFact(finalLeave)];

    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-03' },
      allFacts
    );
    assert.strictEqual(domainResult.scheduledWorkMinutes, 465);
    assert.strictEqual(domainResult.deductionMinutes, 235); // 午後年休控除 235分
    assert.strictEqual(domainResult.effectiveWorkMinutes, 230); // 午前出張実働 230分
    assert.strictEqual(domainResult.countedWorkMinutes, 230);
    assert.strictEqual(domainResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // Full-Day Exclusivity (GT-HALF-05 〜 GT-HALF-08)
  // =========================================================================
  it('GT-HALF-05: MORNING HALF + FULL-DAY BUSINESS_TRIP → PASS (COEXIST_ALLOWED) → COEXIST_AND_DEDUCT', () => {
    const user = getTeacherUser();

    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-04', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-04', endDate: '2026-09-04', purpose: '終日会議' }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);
    assert.ok(tripRes.data?.id);
  });

  it('GT-HALF-06: FULL-DAY BUSINESS_TRIP + MORNING HALF → PASS (COEXIST_ALLOWED) → COEXIST_AND_DEDUCT (双方向対称性)', () => {
    const user = getTeacherUser();

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
      formData: { startDate: '2026-09-04', endDate: '2026-09-04', purpose: '終日会議' }
    });
    assert.strictEqual(tripRes.success, true);
    assert.strictEqual(tripRes.statusCode, 200);

    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-04', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);
    assert.ok(leaveRes.data?.id);
  });

  it('GT-HALF-07: FULL-DAY ANNUAL LEAVE + HALF → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: { targetDate: '2026-09-07', startDate: '2026-09-07', endDate: '2026-09-07', unitType: 'DAY' }
    });

    const halfRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半休',
      formData: { targetDate: '2026-09-07', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(halfRes.success, false);
    assert.strictEqual(halfRes.statusCode, 422);
    assert.strictEqual(halfRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('GT-HALF-08: HALF + FULL-DAY ANNUAL LEAVE → BLOCK (422 SERVICE_PERIOD_CONFLICT)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半休',
      formData: { targetDate: '2026-09-07', unitType: 'HALF_DAY', halfDayType: 'AFTERNOON' }
    });

    const fullRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: { targetDate: '2026-09-07', startDate: '2026-09-07', endDate: '2026-09-07', unitType: 'DAY' }
    });
    assert.strictEqual(fullRes.success, false);
    assert.strictEqual(fullRes.statusCode, 422);
    assert.strictEqual(fullRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  // =========================================================================
  // Same-Day Half-Day Conflicts & Combinations (GT-HALF-09 〜 GT-HALF-12)
  // =========================================================================
  it('GT-HALF-09: AM HALF + AM HALF → TIME_CONFLICT (422)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半休1',
      formData: { targetDate: '2026-09-08', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });

    const dupeRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半休2',
      formData: { targetDate: '2026-09-08', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(dupeRes.success, false);
    assert.strictEqual(dupeRes.statusCode, 422);
    assert.strictEqual(dupeRes.errorCode, 'TIME_CONFLICT');
  });

  it('GT-HALF-10: AM HALF + PM HALF → PASS (200 OK) → both Facts preserved (計465分控除・実働0分)', () => {
    const user = getTeacherUser();

    const amRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半休',
      formData: { targetDate: '2026-09-08', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(amRes.success, true);
    const amId = amRes.data.id;

    const pmRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半休',
      formData: { targetDate: '2026-09-08', unitType: 'HALF_DAY', halfDayType: 'AFTERNOON' }
    });
    assert.strictEqual(pmRes.success, true);
    assert.strictEqual(pmRes.statusCode, 200);
    const pmId = pmRes.data.id;

    // 両方を決裁
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: amId, expectedVersion: 1, comment: '確認' });
    const aVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(amId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: amId, expectedVersion: aVp.version, comment: '承認' });

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: pmId, expectedVersion: 1, comment: '確認' });
    const pVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(pmId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: pmId, expectedVersion: pVp.version, comment: '承認' });

    const amApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(amId) as any;
    const pmApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(pmId) as any;

    const facts = [...adaptApplicationToCanonicalFact(amApp), ...adaptApplicationToCanonicalFact(pmApp)];
    assert.strictEqual(facts.length, 2);

    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-08' },
      facts
    );
    assert.strictEqual(domainResult.scheduledWorkMinutes, 465);
    assert.strictEqual(domainResult.deductionMinutes, 465); // 240 + 225 = 465
    assert.strictEqual(domainResult.effectiveWorkMinutes, 0);
    assert.strictEqual(domainResult.countedWorkMinutes, 0);
    assert.strictEqual(domainResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  it('GT-HALF-11: AM HALF + overlapping TIME LEAVE (09:00〜11:00) → TIME_CONFLICT (422)', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半休',
      formData: { targetDate: '2026-09-09', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });

    const timeRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: { targetDate: '2026-09-09', unitType: 'TIME', startTime: '09:00', endTime: '11:00' }
    });
    assert.strictEqual(timeRes.success, false);
    assert.strictEqual(timeRes.statusCode, 422);
    assert.strictEqual(timeRes.errorCode, 'TIME_CONFLICT');
  });

  it('GT-HALF-12: AM HALF + non-overlap TIME LEAVE (14:00〜15:00) → PASS (200 OK) → 合計290分控除・実働175分', () => {
    const user = getTeacherUser();

    const amRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半休',
      formData: { targetDate: '2026-09-09', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(amRes.success, true);
    const amId = amRes.data.id;

    const timeRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後時間年休',
      formData: { targetDate: '2026-09-09', unitType: 'TIME', startTime: '14:00', endTime: '15:00' }
    });
    assert.strictEqual(timeRes.success, true);
    assert.strictEqual(timeRes.statusCode, 200);
    const timeId = timeRes.data.id;

    // 決裁
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: amId, expectedVersion: 1, comment: '確認' });
    const aVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(amId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: amId, expectedVersion: aVp.version, comment: '承認' });

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: timeId, expectedVersion: 1, comment: '確認' });
    const tVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(timeId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: timeId, expectedVersion: tVp.version, comment: '承認' });

    const amApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(amId) as any;
    const timeApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(timeId) as any;

    const facts = [...adaptApplicationToCanonicalFact(amApp), ...adaptApplicationToCanonicalFact(timeApp)];

    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: user.id, date: '2026-09-09' },
      facts
    );
    assert.strictEqual(domainResult.scheduledWorkMinutes, 465);
    assert.strictEqual(domainResult.deductionMinutes, 290); // 230 + 60 = 290
    assert.strictEqual(domainResult.effectiveWorkMinutes, 175); // 465 - 290 = 175
    assert.strictEqual(domainResult.countedWorkMinutes, 175);
    assert.strictEqual(domainResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // Lifecycle Revalidation / Resubmit / Proxy (GT-HALF-13 〜 GT-HALF-15)
  // =========================================================================
  it('GT-HALF-13: 決裁時再検証 (Final Approval Revalidation) — 半日休×午後出張で 409 誤遮断が発生せず承認完了すること', () => {
    const user = getTeacherUser();

    // 1. 今午前半日年休提出
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-10', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(leaveRes.success, true);
    const leaveId = leaveRes.data.id;

    // 2. 午後出張提出 (12:45〜16:40)
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '午後出張',
      formData: {
        startDate: '2026-09-10',
        endDate: '2026-09-10',
        startAt: '2026-09-10T12:45:00',
        endAt: '2026-09-10T16:40:00',
        purpose: '会議'
      }
    });
    assert.strictEqual(tripRes.success, true);
    const tripId = tripRes.data.id;

    // 3. 出張を承認完了 (事務審査 -> 教頭確認 -> 校長決裁)
    WorkflowEngine.approveApplication(getOfficeUser(), { applicationId: tripId, expectedVersion: 1, comment: '事務確認' });
    const tOff = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripId) as any;
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: tripId, expectedVersion: tOff.version, comment: '確認' });
    const tVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: tripId, expectedVersion: tVp.version, comment: '承認' });

    // 4. 半日年休を決裁完了 (409 にならず成功すること)
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: leaveId, expectedVersion: 1, comment: '確認' });
    const lVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveId) as any;
    const approveRes = WorkflowEngine.approveApplication(getPrincipalUser(), {
      applicationId: leaveId,
      expectedVersion: lVp.version,
      comment: '年休決裁'
    });
    assert.strictEqual(approveRes.success, true);
    assert.strictEqual(approveRes.data.nextStatus, 'FINAL_APPROVED');
  });

  it('GT-HALF-14: 差戻し後の再提出 (RESUBMIT) における半日年休が正常受理されること', () => {
    const user = getTeacherUser();

    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休',
      formData: { targetDate: '2026-09-11', unitType: 'HALF_DAY', halfDayType: 'MORNING', reason: '私用' }
    });
    assert.strictEqual(leaveRes.success, true);
    const leaveId = leaveRes.data.id;

    // 教頭が差戻し
    const appLeave = db.prepare('SELECT version FROM applications WHERE id = ?').get(leaveId) as any;
    const returnRes = WorkflowEngine.returnApplication(getVpUser(), {
      applicationId: leaveId,
      expectedVersion: appLeave.version,
      comment: '詳細理由の追記を求む'
    });
    assert.strictEqual(returnRes.success, true);

    // 再提出 (RESUBMIT)
    const resubmitRes = WorkflowEngine.resubmitApplication(user, {
      applicationId: leaveId,
      expectedVersion: 2,
      title: '午前半日年休 (再提出)',
      formData: { targetDate: '2026-09-11', unitType: 'HALF_DAY', halfDayType: 'MORNING', reason: '通院・検査のため' }
    });
    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.statusCode, 200);
  });

  it('GT-HALF-15: 代理申請 (PROXY) における半日年休が正常受理されること', () => {
    const officeUser = getOfficeUser();

    // 事務職員が教員1の代理で午後半日年休を起票
    const submitRes = WorkflowEngine.submitApplication(officeUser, {
      typeId: 'LEAVE_ANNUAL',
      title: '【代理】午後半日年休',
      subjectUserId: teacher1.id,
      actorType: 'PROXY',
      formData: { targetDate: '2026-09-15', unitType: 'HALF_DAY', halfDayType: 'AFTERNOON', reason: '家庭都合' }
    });
    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.statusCode, 200);
  });

  // =========================================================================
  // School-Specific Schedule Authority Proof (GT-HALF-16, GT-HALF-17)
  // =========================================================================
  it('GT-HALF-16: 【学校日課A検証】08:15〜16:45 (休憩12:15〜13:00) → 08:15〜12:15 (240分) が TIME_EVENT 化されること', () => {
    // 学校日課A の定義 (08:15 - 12:15 = 240分, 休憩 12:15-13:00, 13:00 - 16:45 = 225分) を明示的 Fixture として登録
    const scheduleDetailsA = {
      '0': { isWorkDay: false, workMinutes: 0 },
      '1': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:15',
        endTime: '16:45',
        workIntervals: [
          { start: 495, end: 735 },  // 08:15 - 12:15 (240分)
          { start: 780, end: 1005 } // 13:00 - 16:45 (225分)
        ]
      },
      '2': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:15',
        endTime: '16:45',
        workIntervals: [
          { start: 495, end: 735 },
          { start: 780, end: 1005 }
        ]
      },
      '3': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:15',
        endTime: '16:45',
        workIntervals: [
          { start: 495, end: 735 },
          { start: 780, end: 1005 }
        ]
      },
      '4': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:15',
        endTime: '16:45',
        workIntervals: [
          { start: 495, end: 735 },
          { start: 780, end: 1005 }
        ]
      },
      '5': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:15',
        endTime: '16:45',
        workIntervals: [
          { start: 495, end: 735 },
          { start: 780, end: 1005 }
        ]
      },
      '6': { isWorkDay: false, workMinutes: 0 }
    };

    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher1.id);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?, 'School A Standard Shift', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31',
        '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now')
      )
    `).run(teacher1.id, JSON.stringify(scheduleDetailsA));

    const user = getTeacherUser();

    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '学校A 午前半休',
      formData: { targetDate: '2026-09-16', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: appId, expectedVersion: 1, comment: '確認' });
    const appAfterVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: appId, expectedVersion: appAfterVp.version, comment: '承認' });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const facts = adaptApplicationToCanonicalFact(finalApp);
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].startTime, '08:15');
    assert.strictEqual(facts[0].endTime, '12:15');
    assert.strictEqual(facts[0].quantityUnits, 240);
  });

  it('GT-HALF-17: 【学校日課B検証】08:05〜16:35 (休憩12:05〜12:50) → 08:05〜12:05 (240分) が TIME_EVENT 化されること (固定時刻非依存の実証)', () => {
    // 学校日課B の定義を school_work_schedules に挿入し、teacher1 のパターンを紐付ける
    // 08:05 (485分) - 12:05 (725分), 休憩 12:05-12:50, 12:50 (770分) - 16:35 (995分)
    const scheduleDetailsB = {
      '0': { isWorkDay: false, workMinutes: 0 },
      '1': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:05',
        endTime: '16:35',
        workIntervals: [
          { start: 485, end: 725 },
          { start: 770, end: 995 }
        ]
      },
      '2': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:05',
        endTime: '16:35',
        workIntervals: [
          { start: 485, end: 725 },
          { start: 770, end: 995 }
        ]
      },
      '3': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:05',
        endTime: '16:35',
        workIntervals: [
          { start: 485, end: 725 },
          { start: 770, end: 995 }
        ]
      },
      '4': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:05',
        endTime: '16:35',
        workIntervals: [
          { start: 485, end: 725 },
          { start: 770, end: 995 }
        ]
      },
      '5': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:05',
        endTime: '16:35',
        workIntervals: [
          { start: 485, end: 725 },
          { start: 770, end: 995 }
        ]
      },
      '6': { isWorkDay: false, workMinutes: 0 }
    };

    // 既存のパターンを削除して新パターンを登録
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher1.id);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?, 'School B Early Shift', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31',
        '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now')
      )
    `).run(teacher1.id, JSON.stringify(scheduleDetailsB));

    const user = getTeacherUser();

    // 2026-09-17 (木曜日) 今午前半休を申請
    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '学校B 午前半休',
      formData: { targetDate: '2026-09-17', unitType: 'HALF_DAY', halfDayType: 'MORNING' }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    WorkflowEngine.approveApplication(getVpUser(), { applicationId: appId, expectedVersion: 1, comment: '確認' });
    const appAfterVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: appId, expectedVersion: appAfterVp.version, comment: '承認' });

    const finalApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const facts = adaptApplicationToCanonicalFact(finalApp);
    assert.strictEqual(facts.length, 1);
    
    // 学校B の独自時間帯 (08:05〜12:05) が正確に導出されていること！
    assert.strictEqual(facts[0].startTime, '08:05');
    assert.strictEqual(facts[0].endTime, '12:05');
    assert.strictEqual(facts[0].quantityUnits, 240);
  });

  // =========================================================================
  // HALF-B v1.2 FINAL: Specific Goldens (GT-HALF-B-01 〜 GT-HALF-B-10) & Negatives
  // =========================================================================

  it('GT-HALF-B-01: SCHOOL_DEFAULT 職員が学校標準日課 (AM 245分 / PM 220分) に動的追従すること', () => {
    // 職員のパターンを SCHOOL_DEFAULT に設定
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher1.id);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source, schedule_details_json, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?, 'School Default Pattern', 'STANDARD_FULLTIME', 'SCHOOL_DEFAULT', '{}', '2026-01-01', '9999-12-31',
        '0,6', 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now')
      )
    `).run(teacher1.id);

    // 学校標準日課の月曜日を AM: 08:15〜12:20 (245分), 休憩 12:20〜13:05, PM: 13:05〜16:45 (220分) とする
    const standardDailyJson = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null, "intervals": [] },
      "1": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:20"},{"startTime":"13:05","endTime":"16:45"}] },
      "2": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:20"},{"startTime":"13:05","endTime":"16:45"}] },
      "3": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:20"},{"startTime":"13:05","endTime":"16:45"}] },
      "4": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:20"},{"startTime":"13:05","endTime":"16:45"}] },
      "5": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:20"},{"startTime":"13:05","endTime":"16:45"}] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null, "intervals": [] }
    });

    db.prepare('DELETE FROM school_work_schedules').run();
    db.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id
      ) VALUES (
        1, '令和8年度 学校標準日課', '2026-01-01', '9999-12-31', '0,6',
        ?, 2325, 1, 1
      )
    `).run(standardDailyJson);

    const user = getTeacherUser();

    // 2026-09-07 (月曜日) に午前半日年休を提出 (normalizeFormData 経由)
    const rawFormData = { targetDate: '2026-09-07', unitType: 'HALF_DAY', halfDayType: 'MORNING' };
    const normalized = normalizeFormData('LEAVE_ANNUAL', rawFormData, user.id);
    assert.strictEqual(normalized.calculatedMinutes, 245);
    assert.strictEqual(normalized.calculatedDays, 0.5);

    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '月曜午前半休',
      formData: normalized
    });
    assert.strictEqual(submitRes.success, true);
    const app = db.prepare('SELECT form_data FROM applications WHERE id = ?').get(submitRes.data.id) as any;
    const formData = JSON.parse(app.form_data);
    assert.strictEqual(formData.calculatedMinutes, 245);
    assert.strictEqual(formData.calculatedDays, 0.5);
  });

  it('GT-HALF-B-02: INDIVIDUAL 職員は学校標準日課が存在しても個別日課 (230分) を最優先すること (GT-W1-07 不変)', () => {
    // 職員のパターンを INDIVIDUAL (230分) に設定
    const indSchedule = {
      '1': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:10',
        endTime: '16:40',
        workIntervals: [
          { start: 490, end: 720 }, // 08:10〜12:00 = 230分
          { start: 765, end: 1000 } // 12:45〜16:40 = 235分
        ]
      }
    };
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher1.id);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source, schedule_details_json, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?, 'Individual Pattern', 'STANDARD_FULLTIME', 'INDIVIDUAL', ?, '2026-01-01', '9999-12-31',
        '0,6', 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now')
      )
    `).run(teacher1.id, JSON.stringify(indSchedule));

    const user = getTeacherUser();

    // 2026-09-07 (月曜日) に午前半日年休を提出 (normalizeFormData 経由)
    const rawFormData = { targetDate: '2026-09-07', unitType: 'HALF_DAY', halfDayType: 'MORNING' };
    const normalized = normalizeFormData('LEAVE_ANNUAL', rawFormData, user.id);
    assert.strictEqual(normalized.calculatedMinutes, 230); // INDIVIDUAL が最優先
    assert.strictEqual(normalized.calculatedDays, 0.5);

    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '月曜午前半休',
      formData: normalized
    });
    assert.strictEqual(submitRes.success, true);
    const app = db.prepare('SELECT form_data FROM applications WHERE id = ?').get(submitRes.data.id) as any;
    const formData = JSON.parse(app.form_data);
    assert.strictEqual(formData.calculatedMinutes, 230);
    assert.strictEqual(formData.calculatedDays, 0.5);
  });

  it('GT-HALF-B-03 & GT-HALF-B-04 & GT-HALF-B-05: Server-Authoritative な分数・日数永続化 & スナップショット一致', () => {
    const user = getTeacherUser();

    // クライアントが改ざん値 calculatedDays: 1, calculatedMinutes: 999 を送ってきた場合でも Server 確定値で上書きされること
    const rawFormData = {
      targetDate: '2026-09-08',
      unitType: 'HALF_DAY',
      halfDayType: 'AFTERNOON',
      calculatedDays: 1,
      calculatedMinutes: 999,
    };
    const normalized = normalizeFormData('LEAVE_ANNUAL', rawFormData, user.id);

    // Server-Authoritative に 0.5日 / 235分 (平日標準午後) で上書き正規化されていること
    assert.strictEqual(normalized.calculatedDays, 0.5);
    assert.strictEqual(normalized.calculatedMinutes, 235);

    const submitRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '午後半休改ざん送信テスト',
      formData: normalized
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    const savedApp = db.prepare('SELECT form_data FROM applications WHERE id = ?').get(appId) as any;
    const savedFormData = JSON.parse(savedApp.form_data);
    assert.strictEqual(savedFormData.calculatedDays, 0.5);
    assert.strictEqual(savedFormData.calculatedMinutes, 235);

    // 決裁完了してスナップショットの整合性を確認 (GT-HALF-B-05)
    WorkflowEngine.approveApplication(getVpUser(), { applicationId: appId, expectedVersion: 1, comment: '確認' });
    const appVp = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(getPrincipalUser(), { applicationId: appId, expectedVersion: appVp.version, comment: '承認' });

    const finalApp = db.prepare('SELECT form_data, final_calculation_snapshot FROM applications WHERE id = ?').get(appId) as any;
    const snapshot = JSON.parse(finalApp.final_calculation_snapshot);
    assert.strictEqual(snapshot.attendanceDeductionMinutes, 235);
  });

  it('GT-HALF-B-09: 正当な時間単位申請同士の時間帯重複は引き続き 422 TIME_CONFLICT で遮断されること', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休1',
      formData: {
        targetDate: '2026-09-09',
        unitType: 'TIME',
        startTime: '10:00',
        endTime: '12:00'
      }
    });

    const conflictRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休2 (重複)',
      formData: {
        targetDate: '2026-09-09',
        unitType: 'TIME',
        startTime: '11:00',
        endTime: '13:00'
      }
    });
    assert.strictEqual(conflictRes.success, false);
    assert.strictEqual(conflictRes.statusCode, 422);
    assert.strictEqual(conflictRes.errorCode, 'TIME_CONFLICT');
  });

  it('GT-HALF-B-10: 終日年休 × 終日病休等の終日排他申請は引き続き 422 SERVICE_PERIOD_CONFLICT で遮断されること', () => {
    const user = getTeacherUser();

    WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '終日年休',
      formData: {
        startDate: '2026-09-10',
        endDate: '2026-09-10',
        unitType: 'DAY'
      }
    });

    const conflictRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_SICK',
      title: '終日病休',
      formData: {
        startDate: '2026-09-10',
        endDate: '2026-09-10',
        unitType: 'DAY',
        reason: '療養'
      }
    });
    assert.strictEqual(conflictRes.success, false);
    assert.strictEqual(conflictRes.statusCode, 422);
    assert.strictEqual(conflictRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  // =========================================================================
  // NEGATIVE CONTROL MATRIX (N1 〜 N8)
  // =========================================================================

  it('Negative Control N1: INDIVIDUAL 職員が勝手に学校標準日課へフォールバックしないこと', () => {
    const indSchedule = {
      '1': {
        isWorkDay: true,
        workMinutes: 465,
        startTime: '08:10',
        endTime: '16:40',
        workIntervals: [
          { start: 490, end: 720 }, // 230分
          { start: 765, end: 1000 } // 235分
        ]
      }
    };
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher1.id);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source, schedule_details_json, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?, 'Individual Pattern', 'STANDARD_FULLTIME', 'INDIVIDUAL', ?, '2026-01-01', '9999-12-31',
        '0,6', 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now')
      )
    `).run(teacher1.id, JSON.stringify(indSchedule));

    const user = getTeacherUser();
    const rawFormData = { targetDate: '2026-09-07', unitType: 'HALF_DAY', halfDayType: 'MORNING' };
    const normalized = normalizeFormData('LEAVE_ANNUAL', rawFormData, user.id);
    assert.notStrictEqual(normalized.calculatedMinutes, 240); // 決して標準の240分や245分にならないこと
    assert.strictEqual(normalized.calculatedMinutes, 230);
  });

  it('Negative Control N2: HALF_DAY の計算エラー時に calculatedMinutes = 0 として偽装保存されないこと (Fail-Closed)', () => {
    const user = getTeacherUser();
    const rawFormData = {
      targetDate: '2026-09-06', // 日曜日 (週休日)
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING',
    };
    const normalized = normalizeFormData('LEAVE_ANNUAL', rawFormData, user.id);
    assert.strictEqual(normalized.calculatedMinutes, undefined);
  });

  it('Negative Control N3 & N4: クライアント改ざん値 (calculatedMinutes: 999, calculatedDays: 1) が破棄されること', () => {
    const user = getTeacherUser();
    const rawFormData = {
      targetDate: '2026-09-11',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING',
      calculatedMinutes: 999,
      calculatedDays: 1
    };
    const normalized = normalizeFormData('LEAVE_ANNUAL', rawFormData, user.id);
    assert.strictEqual(normalized.calculatedMinutes, 230); // 999 は破棄され 230分 (金曜標準午前)
    assert.strictEqual(normalized.calculatedDays, 0.5); // 1 は破棄され 0.5日
  });
});
