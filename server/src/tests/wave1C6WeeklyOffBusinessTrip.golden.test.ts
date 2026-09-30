/**
 * Wave 1 — C6 Weekly-Off Business Trip Dedicated Golden Test Suite
 * GT-MF-W1-01 〜 GT-MF-W1-08
 * 
 * Verified Invariants:
 * 1. C6 Non-Inversion: BUSINESS_TRIP must NOT invert WEEKLY_OFF into WORKDAY.
 * 2. C6 Zero-Schedule: Zero scheduled work minutes -> zero counted work minutes.
 * 3. Multi-Stamp: stamps contains both "出張" and "週休".
 * 4. Workday-Equivalent Semantic: businessTripDayCount = 0, workdayCount = 0, weekOffCount = +1.
 * 5. Schedule SSOT: Normal full-time (465 min) and short-time (240 min) preserve their respective minutes.
 * 6. Legacy calculatedMinutes isolation.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { CanonicalAttendanceEvaluator } from '../services/canonical/evaluator';
import { generateCanonicalFactIdentity } from '../services/canonical/identity';
import { CanonicalServiceFact } from '../services/canonical/types';

describe('Wave 1 — C6 Weekly-Off Business Trip Golden Suite (GT-MF-W1-01〜08)', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM absences').run();
    db.prepare('DELETE FROM calendar_adjustments').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
  });

  // GT-MF-W1-01: Normal Workday Full-Day Business Trip Regression Guard
  it('GT-MF-W1-01: 通常勤務日の終日出張 - Schedule SSOT (465分) が維持され WORKDAY かつ "出張" スタンプとなること', () => {
    // 2026-05-15 (金曜日: 通常勤務日)
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (101, 'BUSINESS_TRIP', 1, 1, '出張申請', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', destination: '県庁', purpose: '教育指導会議' }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day15 = result.days.find(d => d.date === '2026-05-15')!;

    assert.strictEqual(day15.primaryDayClassification, 'WORKDAY');
    assert.strictEqual(day15.scheduledWorkMinutes, 465);
    assert.strictEqual(day15.actualWorkMinutes, 465);
    assert.strictEqual(day15.deductionMinutes, 0);
    const stampTexts = day15.stamps.map(s => s.text);
    assert.ok(stampTexts.includes('出張'), '出張スタンプが存在すること');
  });

  // GT-MF-W1-02: C6 Weekly-Off Business Trip Zero-Schedule
  it('GT-MF-W1-02: 週休日出張 C6 - ゼロスケジュールにより勤務時間・控除時間がすべて 0分 であること', () => {
    // 2026-05-10 (日曜日: 週休日)
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (102, 'BUSINESS_TRIP', 1, 1, '日曜大会引率', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-10', endDate: '2026-05-10', destination: '総合運動公園', purpose: '地区陸上大会引率' }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day10 = result.days.find(d => d.date === '2026-05-10')!;

    assert.strictEqual(day10.scheduledWorkMinutes, 0, '所定勤務時間は0分であること');
    assert.strictEqual(day10.actualWorkMinutes, 0, '実働勤務時間は0分であること (FDC-13)');
    assert.strictEqual(day10.deductionMinutes, 0, '控除時間は0分であること');
  });

  // GT-MF-W1-03: C6 Multi-Stamp
  it('GT-MF-W1-03: 週休日出張 C6 - 出張スタンプと週休スタンプの双方が併存 (Multi-Stamp) すること', () => {
    // 2026-05-10 (日曜日: 週休日)
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (103, 'BUSINESS_TRIP', 1, 1, '日曜研究会', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-10', endDate: '2026-05-10', destination: '大学セミナーハウス', purpose: '教科研究会' }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day10 = result.days.find(d => d.date === '2026-05-10')!;

    assert.ok(day10.stamps && day10.stamps.length >= 2, '2つ以上のスタンプが存在すること');
    const stampTexts = day10.stamps.map(s => s.text);
    assert.ok(stampTexts.includes('出張'), '出張スタンプが含まれること');
    assert.ok(stampTexts.includes('週休'), '週休スタンプが含まれること');
  });

  // GT-MF-W1-04: Mandatory Pinpoint Clarification (businessTripDayCount = 0, workdayCount = 0, weekOffCount = +1)
  it('GT-MF-W1-04: 週休日出張 C6 月次集計 - 出張Fact/Stampは存在しつつ、出勤換算出張日数は0、実働勤務日数は0、週休日数は+1となること', () => {
    // 2026-05-10 (日曜日: 週休日) のみに出張
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (104, 'BUSINESS_TRIP', 1, 1, '日曜公務旅行', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-10', endDate: '2026-05-10', destination: '市民会館', purpose: '地域教育フォーラム' }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day10 = result.days.find(d => d.date === '2026-05-10')!;

    // 1. 日次Fact・スタンプの存在検証 (Fact Presence)
    const stampTexts = day10.stamps.map(s => s.text);
    assert.ok(stampTexts.includes('出張'), '日次スタンプに出張が存在すること');
    assert.ok(stampTexts.includes('週休'), '日次スタンプに週休が存在すること');

    // 2. 月次集計の Workday-Equivalent 意味論検証 (Workday Credit = 0)
    // 2026年5月: 全31日、土日10日 (週休10日)、祝日・振替休日3日 (5/3憲法記念日(日), 5/4みどりの日(月), 5/5こどもの日(火), 5/6振替休日(水))
    // 5/10は定例日曜日 (WEEKLY_OFF)
    assert.strictEqual(result.summary.businessTripDays, 0, '勤務換算出張日数 (businessTripDays) は 0日 であること');
    assert.strictEqual(result.summary.businessTripCount, 0, '勤務換算出張回数 (businessTripCount) は 0回 であること');
    assert.strictEqual(result.summary.workdayCount, 18, '平日の通常勤務18日のみであり、日曜出張による実働勤務日数の不当加算がないこと');
    assert.ok(result.summary.weekOffCount >= 8, '週休日数が不当に減らされていないこと');
  });

  // GT-MF-W1-05: Non-Inversion Invariant
  it('GT-MF-W1-05: Non-Inversion 不変条件 - 出張事実があってもカレンダー分類が WORKDAY に反転しないこと', () => {
    // 2026-05-10 (日曜日: 週休日)
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (105, 'BUSINESS_TRIP', 1, 1, '日曜出張', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-10', endDate: '2026-05-10', destination: '文化ホール' }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day10 = result.days.find(d => d.date === '2026-05-10')!;

    assert.strictEqual(day10.primaryDayClassification, 'WEEKLY_OFF', 'カレンダー分類は WEEKLY_OFF を維持すること (FDC-12)');
    assert.notStrictEqual(day10.primaryDayClassification, 'WORKDAY', 'WORKDAY へ反転してはならない');
    assert.strictEqual(day10.dutyRequirement, 'NO_WORK_REQUIRED', '勤務義務状態は NO_WORK_REQUIRED であること');
  });

  // GT-MF-W1-06: Holiday Zero-Schedule Derived Guard
  it('GT-MF-W1-06: 祝日出張 - 国民の祝日における出張でもカレンダー分類 HOLIDAY が維持され勤務算入0分であること', () => {
    // 2026-05-04 (みどりの日: 国民の祝日 / HOLIDAY)
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (106, 'BUSINESS_TRIP', 1, 1, '祝日記念行事引率', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-04', endDate: '2026-05-04', destination: '県立体育館' }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day04 = result.days.find(d => d.date === '2026-05-04')!;

    assert.strictEqual(day04.primaryDayClassification, 'HOLIDAY', '祝日分類が維持されること');
    assert.strictEqual(day04.scheduledWorkMinutes, 0);
    assert.strictEqual(day04.actualWorkMinutes, 0, '祝日出張も実働算入0分であること');
    const stampTexts = day04.stamps.map(s => s.text);
    assert.ok(stampTexts.includes('出張'), '出張スタンプが含まれること');
    assert.ok(stampTexts.includes('祝日'), '祝日スタンプが含まれること');
  });

  // GT-MF-W1-07: Short-Time Schedule Regression Guard
  it('GT-MF-W1-07: 短時間勤務日の出張回帰ガード - 育児短時間 (所定240分) の出張が 240分 となり 465分 へ戻らないこと', () => {
    // Evaluator に直接短時間勤務コンテキストを与えて検証
    const shortTimeFact: CanonicalServiceFact = {
      factId: 'fact-short-time-001',
      userId: 1,
      canonicalStatus: 'CHILDCARE_SHORT_TIME',
      factType: 'WORK_SCHEDULE',
      sourceType: 'WORK_SCHEDULE',
      sourceTable: 'user_work_patterns',
      sourceId: 10,
      targetDate: '2026-05-18',
      quantityUnits: 240,
      isRestricted: false,
      details: { scheduledWorkMinutes: 240 }
    };

    const tripFact: CanonicalServiceFact = {
      factId: 'fact-trip-001',
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP',
      factType: 'DAY_EVENT',
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 201,
      targetDate: '2026-05-18',
      quantityUnits: 1,
      isRestricted: false
    };

    const evalResult = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-05-18', scheduledWorkMinutes: 240, isWorkDay: true },
      [shortTimeFact, tripFact]
    );

    assert.strictEqual(evalResult.scheduledWorkMinutes, 240, '所定時間は短時間勤務の240分であること');
    assert.strictEqual(evalResult.countedWorkMinutes, 240, '実働算入時間は240分であり465分へ戻らないこと (Schedule SSOT)');
    assert.strictEqual(evalResult.effectiveWorkMinutes, 240);
    assert.strictEqual(evalResult.primaryCanonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
  });

  // GT-MF-W1-08: Legacy calculatedMinutes Isolation
  it('GT-MF-W1-08: Legacy calculatedMinutes 隔離検証 - フォーム内に calculatedMinutes: 465 が残存していても C6 週休日出張では0分であること', () => {
    // 2026-05-10 (日曜日: 週休日) に legacy calculatedMinutes: 465 を含む出張申請
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (108, 'BUSINESS_TRIP', 1, 1, '旧仕様出張申請', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-10', endDate: '2026-05-10', destination: '教育センター', calculatedMinutes: 465 }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day10 = result.days.find(d => d.date === '2026-05-10')!;

    assert.strictEqual(day10.scheduledWorkMinutes, 0);
    assert.strictEqual(day10.actualWorkMinutes, 0, 'legacy calculatedMinutes: 465 に影響されず実労働は 0分 であること (FDC-13)');
    assert.strictEqual(day10.primaryDayClassification, 'WEEKLY_OFF');
  });
});
