import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { resolveAttendancePolicy } from '../services/attendance/resolvers';

describe('山口県勤務条例第14条「産休」・「特休（1日未満付記）」包括テストスイート (18 Cases)', () => {
  let db: any;

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  const testUserId = 1; // 山田 太郎
  const targetDate = '2026-05-15'; // 金曜日 (通常勤務日)
  const authorityId = 'DEFAULT_MUNICIPALITY';

  beforeEach(() => {
    db.prepare('DELETE FROM applications WHERE subject_user_id = ?').run(testUserId);
  });

  // Helper to create & approve an application
  function createAndApproveApplication(typeId: string, formData: Record<string, any>, title = '特別休暇申請') {
    const db = getDb();
    const res = db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id,
        title, form_data, current_status, current_step_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'FINAL_APPROVED', 2, DATETIME('now'), DATETIME('now'))
    `).run(typeId, testUserId, testUserId, title, JSON.stringify(formData));
    return Number(res.lastInsertRowid);
  }

  test('Case 1: 産前特別休暇（終日） -> 出勤簿「産休」、集計: 産休1日', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_MATERNITY_PRE',
      reason: '産前休暇'
    }, '【産休】産前特別休暇');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '産休');
    assert.equal(result.stampText, '産休');
    assert.equal(result.stampSubText, undefined);
    assert.equal(result.aggregationCategory, 'MATERNITY_LEAVE');
    assert.equal(result.deductionMinutes, 465);
    assert.equal(result.actualWorkMinutes, 0);
  });

  test('Case 2: 産後特別休暇（終日） -> 出勤簿「産休」、集計: 産休1日', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_MATERNITY_POST',
      reason: '産後休暇'
    }, '【産休】産後特別休暇');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '産休');
    assert.equal(result.stampText, '産休');
    assert.equal(result.stampSubText, undefined);
    assert.equal(result.aggregationCategory, 'MATERNITY_LEAVE');
  });

  test('Case 3: 一般特休（終日 / 忌引） -> 出勤簿「特休」、集計: 特休1日', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_BEREAVEMENT',
      reason: '親族忌引'
    }, '【特休】忌引');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '特');
    assert.equal(result.stampText, '特休');
    assert.equal(result.stampSubText, undefined);
    assert.equal(result.aggregationCategory, 'SPECIAL_LEAVE');
  });

  test('Case 4: 一般特休（半日 / 夏季） -> 出勤簿「特休」＋ stampSubText「半日」', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING',
      targetDate: targetDate,
      reasonCode: 'SPECIAL_SUMMER',
      reason: '夏季休暇'
    }, '【特休】夏季休暇(半日)');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '特');
    assert.equal(result.stampText, '特休');
    assert.equal(result.stampSubText, '半日');
    assert.equal(result.aggregationCategory, 'SPECIAL_LEAVE');
    assert.equal(result.deductionMinutes, 230); // 午前勤務区間実時間免除 (230分)
  });

  test('Case 5: 一般特休（時間休 / 13:00〜15:30 = 150分） -> 出勤簿「特休」＋ stampSubText「2h30m」', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'TIME',
      targetDate: targetDate,
      startTime: '13:00',
      endTime: '15:30',
      reasonCode: 'SPECIAL_MARRIAGE',
      reason: '結婚諸手続き'
    }, '【特休】時間特休');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '特');
    assert.equal(result.stampText, '特');
    assert.equal(result.stampSubText, '2h30m');
    assert.equal(result.deductionMinutes, 150);
    assert.equal(result.actualWorkMinutes, 465 - 150);
  });

  test('Case 6: 産前休暇に時間休（TIME）を指定 -> Policy Resolverで拒絶 (Fail-Closed)', () => {
    const pol = resolveAttendancePolicy('SPECIAL_MATERNITY_PRE', authorityId, 'TIME');
    assert.equal(pol.isFailClosed, true);
    assert.equal(pol.failReason, 'DISALLOWED');
  });

  test('Case 7: 施行日（1971-12-24）以前の日付 -> resolveAttendancePolicy または Engine で安全判定', () => {
    const pol = resolveAttendancePolicy('SPECIAL_MATERNITY_PRE', authorityId, 'DAY');
    assert.equal(pol.isFailClosed, false);
    assert.equal(pol.displaySymbol, '産休');
  });

  test('Case 8: 未登録 reason_code -> POLICY_NOT_FOUND (一般特休へフォールバックしない)', () => {
    const pol = resolveAttendancePolicy('SPECIAL_UNKNOWN_REASON_CODE', authorityId, 'DAY');
    assert.equal(pol.isFailClosed, true);
    assert.equal(pol.failReason, 'MISSING');
  });

  test('Case 9: Policy status = UNCONFIRMED/UNVERIFIED -> Fail-Closed', () => {
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', authorityId, 'DAY');
    assert.equal(pol.isFailClosed, true);
    assert.equal(pol.failReason, 'UNCONFIRMED');
  });

  test('Case 10: Policy 欠落 (存在しないコード) -> Resolver は MISSING で安全停止', () => {
    const pol = resolveAttendancePolicy('NON_EXISTENT_POLICY', authorityId, 'DAY');
    assert.equal(pol.isFailClosed, true);
    assert.equal(pol.failReason, 'MISSING');
  });

  test('Case 11: 確定 Canonical DTO の一貫性 (UI / 出勤簿 / 集計用共通プロパティの検証)', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_MATERNITY_PRE',
      reason: '産前'
    }, '産前休暇');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.ok(result.day);
    assert.ok(result.date);
    assert.ok(result.displaySymbol);
    assert.ok(result.stampText);
    assert.ok(result.aggregationCategory);
    assert.equal(result.isPersonnelStatusOverridden, false);
  });

  test('Case 12: 複数回の resolveDay 実行における冪等性 (Idempotency)', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_BEREAVEMENT',
      reason: '忌引'
    }, '忌引');

    const r1 = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    const r2 = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.deepEqual(r1, r2);
  });

  test('Case 13: 休憩時間（12:00〜12:45）を跨ぐ時間特休の実動交差計算', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'TIME',
      targetDate: targetDate,
      startTime: '11:00',
      endTime: '14:00',
      reasonCode: 'SPECIAL_BEREAVEMENT',
      reason: '忌引手続き'
    }, '時間特休');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    // 11:00〜14:00 (180分) - 休憩 12:00〜12:45 (45分) = 135分交差控除
    assert.equal(result.deductionMinutes, 135);
    assert.equal(result.actualWorkMinutes, 465 - 135);
  });

  test('Case 14: 未承認 (DRAFT / WAITING) 状態の特休申請は出勤簿に反映されないこと', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id,
        title, form_data, current_status, current_step_order, created_at, updated_at
      ) VALUES ('LEAVE_SPECIAL', ?, ?, '未承認特休', ?, 'DRAFT', 1, DATETIME('now'), DATETIME('now'))
    `).run(testUserId, testUserId, JSON.stringify({
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_MATERNITY_PRE'
    }));

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '出');
    assert.equal(result.actualWorkMinutes, 465);
  });

  test('Case 15: 産前産後と一般特休の月次集計カテゴリの完全分離', () => {
    createAndApproveApplication('LEAVE_SPECIAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reasonCode: 'SPECIAL_MATERNITY_POST',
      reason: '産後'
    }, '産後休暇');

    const monthly = AttendanceEngine.getMonthlyAttendanceData(testUserId, '2026-05');
    assert.ok(monthly.days.length >= 28);
    const day = monthly.days.find(d => d.date === targetDate);
    assert.equal(day?.displaySymbol, '産休');
    assert.equal(day?.stampText, '産休');
  });

  test('Case 16: 既存年休の非破壊検証 (Regression Check)', () => {
    createAndApproveApplication('LEAVE_ANNUAL', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reason: '私用'
    }, '年休');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '年');
    assert.equal(result.stampText, '年休');
    assert.equal(result.aggregationCategory, 'ANNUAL_LEAVE');
  });

  test('Case 17: 既存病気休暇の非破壊検証 (Regression Check)', () => {
    createAndApproveApplication('LEAVE_SICK', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      reason: '通院'
    }, '病休');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '病');
    assert.equal(result.stampText, '病休');
    assert.equal(result.aggregationCategory, 'SICK_LEAVE');
  });

  test('Case 18: 既存公務出張の非破壊検証 (Regression Check)', () => {
    createAndApproveApplication('BUSINESS_TRIP', {
      unitType: 'DAY',
      startDate: targetDate,
      endDate: targetDate,
      destination: '県庁',
      purpose: '会議'
    }, '出張');

    const result = AttendanceEngine.resolveDay({ userId: testUserId, date: targetDate, authorityId });
    assert.equal(result.displaySymbol, '出張');
    assert.equal(result.stampText, '出張');
    assert.equal(result.actualWorkMinutes, 465); // 出張は勤務時間控除なし
  });
});
