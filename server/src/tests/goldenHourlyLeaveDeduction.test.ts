import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { normalizeApplicationToFacts, InvalidCanonicalFactError, ApplicationRecord } from '../services/canonical/adapters/applicationAdapter';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';

describe('Hourly Leave Authoritative Deduction & Fail-Closed Golden Tests (GT-BUG-HLEAVE-01〜09)', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();

    // ユーザー1に対して 2026-09-10 の 7時間休 (#3840) を投入
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, created_at, updated_at)
      VALUES (3840, 'LEAVE_ANNUAL', 1, 1, '時間単位年次有給休暇', ?, ?, 'FINAL_APPROVED', ?, ?)
    `).run(
      JSON.stringify({ unitType: 'TIME', targetDate: '2026-09-10', startTime: '08:10', endTime: '15:00', calculatedMinutes: 410 }),
      JSON.stringify({ engineVersion: '2026.2-LEAVE-CALC-CANONICAL', chargedHours: 7, chargedMinutes: 420, attendanceDeductionMinutes: 420 }),
      now,
      now
    );
  });

  // GT-BUG-HLEAVE-01: 420分時間休 (7時間) の Fact 正規化
  it('GT-BUG-HLEAVE-01: should normalize 420-min hourly leave to quantityUnits = 420 from snapshot', () => {
    const app: ApplicationRecord = {
      id: 3840,
      type_id: 'LEAVE_ANNUAL',
      subject_user_id: 1,
      current_status: 'FINAL_APPROVED',
      version: 1,
      form_data: JSON.stringify({
        unitType: 'TIME',
        targetDate: '2026-09-10',
        startTime: '08:10',
        endTime: '15:00',
        calculatedMinutes: 410, // Form data only has 410 min
      }),
      final_calculation_snapshot: JSON.stringify({
        engineVersion: '2026.2-LEAVE-CALC-CANONICAL',
        chargedHours: 7,
        chargedMinutes: 420,
        attendanceDeductionMinutes: 420, // Authoritative SSOT
      }),
    };

    const facts = normalizeApplicationToFacts(app);
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].factType, 'TIME_EVENT');
    assert.strictEqual(facts[0].quantityUnits, 420, 'quantityUnits must be 420 minutes, not 60 or 410');
  });

  // GT-BUG-HLEAVE-02: 2026-09-10 Monthly Projection (deductionMinutes === 420, actualWorkMinutes === 45, stampSubText === "7h")
  it('GT-BUG-HLEAVE-02: should project 2026-09-10 monthly attendance with deductionMinutes=420, actualWorkMinutes=45, stampSubText="7h"', () => {
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-09');
    const day10 = projection.days.find(d => d.date === '2026-09-10');
    assert.ok(day10, '2026-09-10 must exist in monthly projection');
    assert.strictEqual(day10.deductionMinutes, 420, 'deductionMinutes must be 420');
    assert.strictEqual(day10.actualWorkMinutes, 45, 'actualWorkMinutes must be 45 (465 - 420)');
    assert.strictEqual(day10.stampSubText, '7h', 'stampSubText must be 7h');
    assert.strictEqual(day10.displayName, '時間単位年休');
  });

  // GT-BUG-HLEAVE-03: 出勤簿 A4 PDF API レスポンス / Document Projection で 7h
  it('GT-BUG-HLEAVE-03: should project Document Projection with 7h and correct attendanceData', () => {
    const doc = CanonicalAttendanceProjectionEngine.getDocumentProjection(1, '2026-09');
    const day10 = doc.attendanceData.days.find(d => d.date === '2026-09-10');
    assert.ok(day10);
    assert.strictEqual(day10.stampSubText, '7h');
    assert.strictEqual(day10.deductionMinutes, 420);
  });

  // GT-BUG-HLEAVE-04: 1時間休 (60分) の申請は 60分 / 1h を維持
  it('GT-BUG-HLEAVE-04: should correctly handle 1-hour leave with 60 min deduction and 1h stamp', () => {
    const app: ApplicationRecord = {
      id: 9901,
      type_id: 'LEAVE_ANNUAL',
      subject_user_id: 1,
      current_status: 'FINAL_APPROVED',
      version: 1,
      form_data: JSON.stringify({
        unitType: 'TIME',
        targetDate: '2026-09-15',
        startTime: '15:40',
        endTime: '16:40',
        calculatedMinutes: 60,
      }),
      final_calculation_snapshot: JSON.stringify({
        attendanceDeductionMinutes: 60,
      }),
    };

    const facts = normalizeApplicationToFacts(app);
    assert.strictEqual(facts.length, 1);
    assert.strictEqual(facts[0].quantityUnits, 60);
  });

  // GT-BUG-HLEAVE-05: 2時間・3時間・6時間等が固定60分にならず正確に射影されること
  it('GT-BUG-HLEAVE-05: should correctly handle 2h (120m), 3h (180m), 6h (360m) without defaulting to 60m', () => {
    for (const [minutes, expectedStamp] of [[120, '2h'], [180, '3h'], [360, '6h']] as const) {
      const app: ApplicationRecord = {
        id: 9900 + minutes,
        type_id: 'LEAVE_ANNUAL',
        subject_user_id: 1,
        current_status: 'FINAL_APPROVED',
        version: 1,
        form_data: JSON.stringify({
          unitType: 'TIME',
          targetDate: '2026-09-20',
          startTime: '09:00',
          endTime: '12:00',
        }),
        final_calculation_snapshot: JSON.stringify({
          attendanceDeductionMinutes: minutes,
        }),
      };

      const facts = normalizeApplicationToFacts(app);
      assert.strictEqual(facts.length, 1);
      assert.strictEqual(facts[0].quantityUnits, minutes);
    }
  });

  // GT-BUG-HLEAVE-06: Authoritative 時間 Fact 欠損時に Silent Fallback せず Fail-Closed となること
  it('GT-BUG-HLEAVE-06: should throw InvalidCanonicalFactError when authoritative deduction is missing or invalid', () => {
    const app: ApplicationRecord = {
      id: 9906,
      type_id: 'LEAVE_SPECIAL',
      subject_user_id: 1,
      current_status: 'FINAL_APPROVED',
      version: 1,
      form_data: JSON.stringify({
        unitType: 'TIME',
        targetDate: '2026-09-21',
        startTime: '09:00',
        endTime: '10:00',
      }),
      final_calculation_snapshot: JSON.stringify({
        attendanceDeductionMinutes: null, // missing deduction
      }),
    };

    assert.throws(
      () => normalizeApplicationToFacts(app),
      (err: any) => err instanceof InvalidCanonicalFactError && err.applicationId === 9906
    );
  });

  // GT-BUG-HLEAVE-07: Legacy 識別条件が存在しない現行リポジトリの立証 (LEGACY IDENTIFICATION NOT PROVEN)
  it('GT-BUG-HLEAVE-07: should fail-closed for non-snapshot applications because legacy identifier is not proven', () => {
    const app: ApplicationRecord = {
      id: 9907,
      type_id: 'LEAVE_ANNUAL',
      subject_user_id: 1,
      current_status: 'FINAL_APPROVED',
      version: 1,
      form_data: JSON.stringify({
        unitType: 'TIME',
        targetDate: '2026-09-22',
        startTime: '09:00',
        endTime: '10:00',
        calculatedMinutes: 60,
      }),
      final_calculation_snapshot: null, // Legacy / Missing
    };

    assert.throws(
      () => normalizeApplicationToFacts(app),
      (err: any) => err instanceof InvalidCanonicalFactError && err.reason.includes('final_calculation_snapshot が存在しません')
    );
  });

  // GT-BUG-HLEAVE-08: FINAL_APPROVED + Malformed Snapshot + form.calculatedMinutes = 410 -> FAIL-CLOSED
  it('GT-BUG-HLEAVE-08: should throw InvalidCanonicalFactError and NOT fallback to calculatedMinutes when snapshot is malformed', () => {
    const app: ApplicationRecord = {
      id: 9908,
      type_id: 'LEAVE_ANNUAL',
      subject_user_id: 1,
      current_status: 'FINAL_APPROVED',
      version: 1,
      form_data: JSON.stringify({
        unitType: 'TIME',
        targetDate: '2026-09-23',
        startTime: '08:10',
        endTime: '15:00',
        calculatedMinutes: 410,
      }),
      final_calculation_snapshot: '{ malformed json !! }',
    };

    assert.throws(
      () => normalizeApplicationToFacts(app),
      (err: any) => err instanceof InvalidCanonicalFactError && err.reason.includes('パースに失敗しました')
    );
  });

  // GT-BUG-HLEAVE-09: FINAL_APPROVED + Snapshot 欠損 + startTime/endTime あり -> FAIL-CLOSED (時刻差分再計算禁止)
  it('GT-BUG-HLEAVE-09: should throw InvalidCanonicalFactError and NOT reconstruct minutes from startTime/endTime', () => {
    const app: ApplicationRecord = {
      id: 9909,
      type_id: 'LEAVE_DUTY_EXEMPT',
      subject_user_id: 1,
      current_status: 'FINAL_APPROVED',
      version: 1,
      form_data: JSON.stringify({
        unitType: 'TIME',
        targetDate: '2026-09-24',
        startTime: '10:00',
        endTime: '12:00',
      }),
      final_calculation_snapshot: undefined,
    };

    assert.throws(
      () => normalizeApplicationToFacts(app),
      (err: any) => err instanceof InvalidCanonicalFactError && err.reason.includes('final_calculation_snapshot が存在しません')
    );
  });
});
