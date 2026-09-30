/**
 * Model P3 Minimum Production Foundation Golden Test Suite
 * DAY_EVENT × TIME_EVENT Composition — Frozen v1.0 FINAL Baseline
 * 
 * GT-P3MIN-01 〜 GT-P3MIN-15
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { CanonicalAttendanceEvaluator } from '../services/canonical/evaluator';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { ConflictService } from '../services/conflictService';
import { WorkflowEngine } from '../workflow/engine';
import { CanonicalServiceFact } from '../services/canonical/types';

describe('Model P3 Minimum Production Foundation Golden Test Suite (GT-P3MIN-01〜15)', () => {
  let db: any;

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  // =========================================================================
  // GT-P3MIN-01: 通常勤務日 (Factなし)
  // =========================================================================
  it('GT-P3MIN-01: 通常勤務日 (Factなし) — 既存挙動不変', () => {
    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      []
    );
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 0);
    assert.strictEqual(res.countedWorkMinutes, 465);
    assert.strictEqual(res.effectiveWorkMinutes, 465);
    assert.strictEqual(res.primaryCanonicalStatus, 'WORKED' as any);
  });

  // =========================================================================
  // GT-P3MIN-02: 通常勤務 + 時間年休 60分
  // =========================================================================
  it('GT-P3MIN-02: 通常勤務 + 時間年休 60分 — 既存挙動不変', () => {
    const timeLeaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-001',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 101,
      targetDate: '2026-06-15',
      startTime: '15:00',
      endTime: '16:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [timeLeaveFact]
    );
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 60);
    assert.strictEqual(res.countedWorkMinutes, 405);
    assert.strictEqual(res.effectiveWorkMinutes, 405);
    assert.strictEqual(res.primaryCanonicalStatus, 'ANNUAL_LEAVE');
    assert.strictEqual(res.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // GT-P3MIN-03: 単独終日出張
  // =========================================================================
  it('GT-P3MIN-03: 単独終日出張 — 既存挙動不変 (実働全額算入)', () => {
    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-001',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 201,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [tripFact]
    );
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 0);
    assert.strictEqual(res.countedWorkMinutes, 465);
    assert.strictEqual(res.effectiveWorkMinutes, 465);
    assert.strictEqual(res.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
    assert.deepStrictEqual(res.secondaryCanonicalStatuses, []);
    assert.strictEqual(res.appliedConflictAction, 'OVERRIDE_ALL');
  });

  // =========================================================================
  // GT-P3MIN-04: 出張 + 時間年休 60分 (MINUTES-CASE-A 中心Golden)
  // =========================================================================
  it('GT-P3MIN-04: 出張 + 時間年休 60分 (MINUTES-CASE-A 中心Golden)', () => {
    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-002',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 202,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-002',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 102,
      targetDate: '2026-06-15',
      startTime: '15:00',
      endTime: '16:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [tripFact, leaveFact]
    );

    // MINUTES-CASE-A 契約完全検証
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 60);
    assert.strictEqual(res.countedWorkMinutes, 405);
    assert.strictEqual(res.effectiveWorkMinutes, 405);
    assert.strictEqual(res.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
    assert.deepStrictEqual(res.secondaryCanonicalStatuses, ['ANNUAL_LEAVE']);
    assert.strictEqual(res.appliedConflictAction, 'COEXIST_AND_DEDUCT');
    assert.strictEqual(res.aggregationCategory, 'BUSINESS_TRIP');

    // Authoritative Minutes Fail-Closed Guard 検証: 不正 quantityUnits で例外停止すること
    const invalidLeaveFact: CanonicalServiceFact = {
      ...leaveFact,
      factId: 'fact-leave-invalid',
      quantityUnits: undefined,
    };
    assert.throws(() => {
      CanonicalAttendanceEvaluator.evaluateDay(
        { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
        [tripFact, invalidLeaveFact]
      );
    }, /Fail-Closed/);
  });

  // =========================================================================
  // GT-P3MIN-05: 出張 + 複数時間事象 (出張 + 年休 60分 + 介護時間 30分)
  // =========================================================================
  it('GT-P3MIN-05: 出張 + 複数時間事象 (出張 + 年休 60分 + 介護時間 30分)', () => {
    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-003',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 203,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-003',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 103,
      targetDate: '2026-06-15',
      startTime: '14:00',
      endTime: '15:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    const careFact: CanonicalServiceFact = {
      factId: 'fact-care-003',
      userId: 1,
      canonicalStatus: 'CARE_TIME',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 104,
      targetDate: '2026-06-15',
      startTime: '16:10',
      endTime: '16:40',
      quantityUnits: 30,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [tripFact, leaveFact, careFact]
    );

    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 90); // 60 + 30
    assert.strictEqual(res.countedWorkMinutes, 375); // 465 - 90
    assert.strictEqual(res.effectiveWorkMinutes, 375);
    assert.strictEqual(res.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
    assert.deepStrictEqual(res.secondaryCanonicalStatuses, ['ANNUAL_LEAVE', 'CARE_TIME']);
    assert.strictEqual(res.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // GT-P3MIN-06: TRAINING + 時間年休 60分
  // =========================================================================
  it('GT-P3MIN-06: TRAINING (特例法研修) + 時間年休 60分', () => {
    const trainingFact: CanonicalServiceFact = {
      factId: 'fact-train-001',
      userId: 1,
      canonicalStatus: 'TRAINING',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 301,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-004',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 105,
      targetDate: '2026-06-15',
      startTime: '15:00',
      endTime: '16:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [trainingFact, leaveFact]
    );

    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 60);
    assert.strictEqual(res.countedWorkMinutes, 405);
    assert.strictEqual(res.effectiveWorkMinutes, 405);
    assert.strictEqual(res.primaryCanonicalStatus, 'TRAINING');
    assert.deepStrictEqual(res.secondaryCanonicalStatuses, ['ANNUAL_LEAVE']);
    assert.strictEqual(res.appliedConflictAction, 'COEXIST_AND_DEDUCT');
    assert.strictEqual(res.aggregationCategory, 'TRAINING');
  });

  // =========================================================================
  // GT-P3MIN-07: 終日年休の完全排他 (OVERRIDE_ALL)
  // =========================================================================
  it('GT-P3MIN-07: 終日年休の完全排他 — 既存挙動不変', () => {
    const fullLeaveFact: CanonicalServiceFact = {
      factId: 'fact-full-leave-001',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 401,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [fullLeaveFact]
    );
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.countedWorkMinutes, 0);
    assert.strictEqual(res.deductionMinutes, 465);
    assert.strictEqual(res.effectiveWorkMinutes, 0);
    assert.strictEqual(res.primaryCanonicalStatus, 'ANNUAL_LEAVE');
    assert.strictEqual(res.appliedConflictAction, 'OVERRIDE_ALL');
  });

  // =========================================================================
  // GT-P3MIN-08: 全日欠勤の完全排他 (OVERRIDE_ALL)
  // =========================================================================
  it('GT-P3MIN-08: 全日欠勤の完全排他 — 既存挙動不変', () => {
    const fullAbsenceFact: CanonicalServiceFact = {
      factId: 'fact-absence-001',
      userId: 1,
      canonicalStatus: 'ABSENCE',
      factType: 'DAY_EVENT',
      sourceType: 'ADMIN_REGISTRATION',
      sourceTable: 'absences',
      sourceId: 501,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: true,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [fullAbsenceFact]
    );
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.countedWorkMinutes, 0);
    assert.strictEqual(res.deductionMinutes, 465);
    assert.strictEqual(res.effectiveWorkMinutes, 0);
    assert.strictEqual(res.primaryCanonicalStatus, 'ABSENCE');
    assert.strictEqual(res.appliedConflictAction, 'OVERRIDE_ALL');
  });

  // =========================================================================
  // GT-P3MIN-09: Wave 1 C6 週休日出張 (Zero-Schedule 完全維持)
  // =========================================================================
  it('GT-P3MIN-09: Wave 1 C6 週休日出張 — Non-Inversion & Zero-Schedule 完全維持', () => {
    const weekOffFact: CanonicalServiceFact = {
      factId: 'fact-weekoff-001',
      userId: 1,
      canonicalStatus: 'WEEKLY_OFF',
      factType: 'CALENDAR_STATUS',
      sourceType: 'WORK_SCHEDULE',
      sourceTable: 'user_work_patterns',
      sourceId: 601,
      targetDate: '2026-06-14', // 日曜日
      isRestricted: false,
    };

    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-004',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 204,
      targetDate: '2026-06-14',
      quantityUnits: 1,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-14', scheduledWorkMinutes: 0, isWorkDay: false },
      [weekOffFact, tripFact]
    );

    // C6 Frozen Invariant 100% 保持確認
    assert.strictEqual(res.isScheduledWorkDay, false);
    assert.strictEqual(res.dutyStatus, 'NO_WORK_REQUIRED');
    assert.strictEqual(res.scheduledWorkMinutes, 0);
    assert.strictEqual(res.countedWorkMinutes, 0);
    assert.strictEqual(res.deductionMinutes, 0);
    assert.strictEqual(res.effectiveWorkMinutes, 0);
    assert.strictEqual(res.primaryCanonicalStatus, 'WEEKLY_OFF');
    assert.deepStrictEqual(res.secondaryCanonicalStatuses, ['OFFICIAL_BUSINESS_TRIP']);
    assert.strictEqual(res.appliedConflictAction, 'DISPLAY_PRECEDENCE');
  });

  // =========================================================================
  // GT-P3MIN-10: 育児短時間勤務 (240分) + 出張 + 時間年休 60分
  // =========================================================================
  it('GT-P3MIN-10: 育児短時間勤務 (240分) + 出張 + 時間年休 60分 — Schedule SSOT 遵守', () => {
    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-005',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 205,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-005',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 106,
      targetDate: '2026-06-15',
      startTime: '10:00',
      endTime: '11:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 240, isWorkDay: true },
      [tripFact, leaveFact]
    );

    // 465 ハードコードではなく 240 から控除されること
    assert.strictEqual(res.scheduledWorkMinutes, 240);
    assert.strictEqual(res.deductionMinutes, 60);
    assert.strictEqual(res.countedWorkMinutes, 180); // 240 - 60
    assert.strictEqual(res.effectiveWorkMinutes, 180);
    assert.strictEqual(res.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
    assert.deepStrictEqual(res.secondaryCanonicalStatuses, ['ANNUAL_LEAVE']);
    assert.strictEqual(res.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // GT-P3MIN-11: 控除時間境界 (一致: scheduled = 465, deduction = 465)
  // =========================================================================
  it('GT-P3MIN-11: 控除時間境界 (一致: scheduled = 465, deduction = 465)', () => {
    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-006',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 206,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-006',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 107,
      targetDate: '2026-06-15',
      startTime: '08:15',
      endTime: '16:45',
      quantityUnits: 465,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [tripFact, leaveFact]
    );

    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.deductionMinutes, 465);
    assert.strictEqual(res.countedWorkMinutes, 0);
    assert.strictEqual(res.effectiveWorkMinutes, 0);
    assert.strictEqual(res.appliedConflictAction, 'COEXIST_AND_DEDUCT');
  });

  // =========================================================================
  // GT-P3MIN-12: 過大控除安全網 (scheduled = 240, deduction = 300)
  // =========================================================================
  it('GT-P3MIN-12: 過大控除安全網 (scheduled = 240, deduction = 300) — Math.max(0, ...) 遵守', () => {
    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-007',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 207,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-007',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 108,
      targetDate: '2026-06-15',
      startTime: '08:15',
      endTime: '13:15',
      quantityUnits: 300,
      isRestricted: false,
    };

    const res = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-06-15', scheduledWorkMinutes: 240, isWorkDay: true },
      [tripFact, leaveFact]
    );

    assert.strictEqual(res.scheduledWorkMinutes, 240);
    assert.strictEqual(res.deductionMinutes, 300);
    assert.strictEqual(res.countedWorkMinutes, 0); // Math.max(0, 240 - 300) === 0
    assert.strictEqual(res.effectiveWorkMinutes, 0);
  });

  // =========================================================================
  // GT-P3MIN-13: Multi-Stamp 保持検証 (出張 + 時間年休)
  // =========================================================================
  it('GT-P3MIN-13: Multi-Stamp 保持検証 — Stamps 配列に出張と年休の両方が保持されること', () => {
    const teacher = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;

    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-008',
      userId: teacher.id,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 208,
      targetDate: '2026-06-15',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: 'fact-leave-008',
      userId: teacher.id,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 109,
      targetDate: '2026-06-15',
      startTime: '15:00',
      endTime: '16:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    // Evaluator で評価
    const domainResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: teacher.id, date: '2026-06-15', scheduledWorkMinutes: 465, isWorkDay: true },
      [tripFact, leaveFact]
    );

    // domainResult が正しく COEXIST_AND_DEDUCT で合成されていること
    assert.strictEqual(domainResult.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
    assert.deepStrictEqual(domainResult.secondaryCanonicalStatuses, ['ANNUAL_LEAVE']);
    assert.strictEqual(domainResult.effectiveWorkMinutes, 405);
    assert.strictEqual(domainResult.deductionMinutes, 60);
  });

  // =========================================================================
  // GT-P3MIN-14: 月次 Projection 整合性
  // =========================================================================
  it('GT-P3MIN-14: 月次 Projection 整合性 — actualWorkMinutes と deductionMinutes の正確な集約', () => {
    const teacher = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;

    // 承認済み出張申請と時間年休申請をDB直接登録 (Evaluator への到達を模倣)
    const now = '2026-06-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES (801, 'BUSINESS_TRIP', ?, ?, 'SELF', 'SINGLE', '市内出張', ?, 'FINAL_APPROVED', 1, 1, ?, ?)
    `).run(teacher.id, teacher.id, JSON.stringify({ startDate: '2026-06-15', endDate: '2026-06-15', purpose: '会議' }), now, now);

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode, title, form_data, final_calculation_snapshot, current_status, current_step_order, version, created_at, updated_at)
      VALUES (802, 'LEAVE_ANNUAL', ?, ?, 'SELF', 'SINGLE', '時間年休', ?, ?, 'FINAL_APPROVED', 1, 1, ?, ?)
    `).run(
      teacher.id,
      teacher.id,
      JSON.stringify({ startDate: '2026-06-15', endDate: '2026-06-15', targetDate: '2026-06-15', startTime: '15:00', endTime: '16:00', durationMinutes: 60, unitType: 'TIME' }),
      JSON.stringify({ attendanceDeductionMinutes: 60 }),
      now,
      now
    );

    const monthly = CanonicalAttendanceProjectionEngine.getMonthlyProjection(teacher.id, '2026-06');
    const day15 = monthly.days.find(d => d.date === '2026-06-15');

    assert.ok(day15, 'Day 15 DTO must exist');
    assert.strictEqual(day15.actualWorkMinutes, 405);
    assert.strictEqual(day15.deductionMinutes, 60);
    assert.strictEqual(day15.displaySymbol, '張');
    assert.ok(day15.stamps.some(s => s.symbol === '張'));
    assert.ok(day15.stamps.some(s => s.symbol === '年'));
  });

  // =========================================================================
  // GT-P3MIN-15: [SUPERSEDED by Wave 2 W2-B] Validation 緩和と P3 Evaluator 合成の結合検証
  // =========================================================================
  it('GT-P3MIN-15: [SUPERSEDED by Wave 2 W2-B] 出張日への時間年休申請が正常受理 (200 OK) され、P3 Evaluator で COEXIST_AND_DEDUCT 控除合成されること', () => {
    const teacher = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    const user = { id: teacher.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };

    // 1. 2026-09-01 終日出張を提出
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '終日出張',
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

    // 2. 同日 14:00〜15:00 の時間年休 (60分) を提出 -> 正常受理 (Wave 2 W2-B)
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'TIME',
        startTime: '14:00',
        endTime: '15:00',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);
    assert.strictEqual(leaveRes.statusCode, 200);

    // 3. P3 Evaluator による合成評価の検証
    const tripFact: CanonicalServiceFact = {
      factId: `fact-trip-${tripRes.data.id}`,
      userId: teacher.id,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: tripRes.data.id,
      targetDate: '2026-09-01',
      quantityUnits: 1,
      isRestricted: false,
    };

    const leaveFact: CanonicalServiceFact = {
      factId: `fact-leave-${leaveRes.data.id}`,
      userId: teacher.id,
      canonicalStatus: 'ANNUAL_LEAVE',
      factType: 'TIME_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: leaveRes.data.id,
      targetDate: '2026-09-01',
      startTime: '14:00',
      endTime: '15:00',
      quantityUnits: 60,
      isRestricted: false,
    };

    const evalResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: teacher.id, date: '2026-09-01', scheduledWorkMinutes: 465, isWorkDay: true },
      [tripFact, leaveFact]
    );

    assert.strictEqual(evalResult.appliedConflictAction, 'COEXIST_AND_DEDUCT');
    assert.strictEqual(evalResult.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
    assert.deepStrictEqual(evalResult.secondaryCanonicalStatuses, ['ANNUAL_LEAVE']);
    assert.strictEqual(evalResult.countedWorkMinutes, 405);
    assert.strictEqual(evalResult.deductionMinutes, 60);
    assert.strictEqual(evalResult.effectiveWorkMinutes, 405);
  });

  // =========================================================================
  // GT-P3MIN-16: Authoritative Minutes Fail-Closed Guard 検証
  // =========================================================================
  it('GT-P3MIN-16: Authoritative Minutes Fail-Closed Guard — 不正・未設定 quantityUnits は例外送出で Fail-Closed 遮断すること', () => {
    const teacher = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;

    const baseCtx = {
      userId: teacher.id,
      date: '2026-09-01',
      dailySchedule: {
        patternCode: 'NORMAL' as const,
        source: 'PATTERN' as const,
        scheduleDate: '2026-09-01',
        workMinutes: 465,
        startTime: '08:30',
        endTime: '17:00',
        restMinutes: 45
      }
    };

    const tripFact = {
      factId: 'fact-trip-1',
      sourceType: 'APPLICATION' as const,
      sourceId: 'app-trip-1',
      factType: 'DAY_EVENT' as const,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP' as const,
      temporalScope: 'FULL_DAY' as const,
      effectiveDate: '2026-09-01',
      createdAt: '2026-09-01T00:00:00Z',
      precedence: 60
    };

    // 1. quantityUnits が undefined の場合
    const invalidFactUndefined = {
      factId: 'fact-time-undef',
      sourceType: 'APPLICATION' as const,
      sourceId: 'app-time-1',
      factType: 'TIME_EVENT' as const,
      canonicalStatus: 'ANNUAL_LEAVE' as const,
      temporalScope: 'PART_DAY' as const,
      effectiveDate: '2026-09-01',
      createdAt: '2026-09-01T00:00:00Z',
      precedence: 50
      // quantityUnits なし
    };

    assert.throws(
      () => CanonicalAttendanceEvaluator.evaluateDay(baseCtx, [tripFact, invalidFactUndefined]),
      /\[Evaluator Fail-Closed\]/
    );

    // 2. quantityUnits が 0 の場合
    const invalidFactZero = {
      ...invalidFactUndefined,
      factId: 'fact-time-zero',
      quantityUnits: 0
    };

    assert.throws(
      () => CanonicalAttendanceEvaluator.evaluateDay(baseCtx, [tripFact, invalidFactZero]),
      /\[Evaluator Fail-Closed\]/
    );

    // 3. quantityUnits が 負数 の場合
    const invalidFactNegative = {
      ...invalidFactUndefined,
      factId: 'fact-time-neg',
      quantityUnits: -60
    };

    assert.throws(
      () => CanonicalAttendanceEvaluator.evaluateDay(baseCtx, [tripFact, invalidFactNegative]),
      /\[Evaluator Fail-Closed\]/
    );
  });
});

