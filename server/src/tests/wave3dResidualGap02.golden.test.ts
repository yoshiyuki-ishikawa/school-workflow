import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getDb, setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';
import { SickLeaveService } from '../services/sickLeaveService';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';

function makeWeeklySchedule(intervals: { startTime: string; endTime: string }[], workMinutes: number): string {
  const obj: Record<string, any> = {};
  for (let d = 0; d < 7; d++) {
    if (d === 0 || d === 6) {
      obj[String(d)] = { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null, intervals: [] };
    } else {
      obj[String(d)] = {
        isWorkDay: true,
        workMinutes,
        startTime: intervals.length > 0 ? intervals[0].startTime : '08:15',
        endTime: intervals.length > 0 ? intervals[intervals.length - 1].endTime : '16:45',
        intervals,
      };
    }
  }
  return JSON.stringify(obj);
}

describe('Wave 3D Residual GAP-02 Golden Tests: Non-Annual Leave Canonical Work Schedule Integration (GT-GAP02-01〜10)', () => {
  let testDb: any;
  let originalDb: any;
  let teacherId: number;
  let teacher2Id: number;
  let officeId: number;
  let adminId: number;

  before(async () => {
    originalDb = getDb();
    testDb = new Database(':memory:');
    setDb(testDb);
    testDb.exec(SCHEMA_SQL);
    migrator.runMigrations(testDb);
    seedDatabase();

    const teacher = testDb.prepare("SELECT id FROM users WHERE username = 'teacher1'").get();
    teacherId = teacher.id;
    const teacher2 = testDb.prepare("SELECT id FROM users WHERE username = 'teacher2'").get();
    teacher2Id = teacher2.id;
    const office = testDb.prepare("SELECT id FROM users WHERE username = 'office'").get();
    officeId = office.id;
    const admin = testDb.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    adminId = admin.id;

    // 1. 学校標準日課の登録 (08:10〜12:00 = 230分, 12:45〜16:40 = 235分 -> 計465分)
    testDb.prepare('DELETE FROM school_work_schedules').run();
    const schoolSchedJson = makeWeeklySchedule([
      { startTime: '08:10', endTime: '12:00' }, // 230分 (490 - 720)
      { startTime: '12:45', endTime: '16:40' }, // 235分 (765 - 1000)
    ], 465);

    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (1, '学校標準日課 (465分)', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 1, ?, '2026-04-01', ?, '2026-04-01')
    `).run(schoolSchedJson, adminId, adminId);

    // 2. 全ユーザーの既存パターンを整理し、決定論的に初期化
    testDb.prepare('DELETE FROM user_work_patterns').run();

    // teacher1: 学校標準フルタイム (08:10〜12:00, 12:45〜16:40, 465分)
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '標準勤務パターン', 'STANDARD_FULLTIME', 'SCHOOL_DEFAULT', '2026-04-01', '9999-12-31', '0,6', NULL, 2325, 'ADMIN_CONFIGURED', ?, datetime('now'), datetime('now'))
    `).run(teacherId, adminId);

    // teacher2: 短時間勤務パターン (4時間 = 240分: 08:30〜12:30, 休憩なし)
    const partTimeJson = makeWeeklySchedule([{ startTime: '08:30', endTime: '12:30' }], 240);
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '短時間勤務(4H)', 'SHORT_TIME', 'INDIVIDUAL', '2026-04-01', '9999-12-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', ?, datetime('now'), datetime('now'))
    `).run(teacher2Id, partTimeJson, adminId);

    // office: 単一区間フルタイムパターン (7時間45分 = 465分: 08:15〜16:00, 休憩未分割 intervals.length === 1)
    const singleIntervalJson = makeWeeklySchedule([{ startTime: '08:15', endTime: '16:00' }], 465);
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '単一区間パターン', 'STANDARD_FULLTIME', 'INDIVIDUAL', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', ?, datetime('now'), datetime('now'))
    `).run(officeId, singleIntervalJson, adminId);
  });

  after(() => {
    setDb(originalDb);
    if (testDb) {
      testDb.close();
    }
  });

  // GT-GAP02-01: フルタイム通常日（所定465分）における特別休暇・病気休暇（1日） -> calculatedMinutes = 465
  it('GT-GAP02-01: フルタイム通常日における非年休DAY申請はCanonical所定時間(465分)をServer-Authoritativeに算出する', () => {
    const specialCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SPECIAL',
      startDate: '2026-06-01', // 月曜日・平日通常日
      endDate: '2026-06-01',
      unitType: 'DAY',
      reasonCode: 'SUMMER_LEAVE'
    });
    assert.strictEqual(specialCalc.isValid, true);
    assert.strictEqual(specialCalc.totalChargedDays, 1);
    assert.strictEqual(specialCalc.totalChargedMinutes, 465);
    assert.strictEqual(specialCalc.snapshot?.scheduledWorkMinutes, 465);

    const sickCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SICK',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'DAY'
    });
    assert.strictEqual(sickCalc.isValid, true);
    assert.strictEqual(sickCalc.totalChargedDays, 1);
    assert.strictEqual(sickCalc.totalChargedMinutes, 465);

    // SickLeaveService.applySickLeave (FULL_DAY) の検証
    const sickApp = SickLeaveService.applySickLeave(
      { id: teacherId, username: 'teacher1', displayName: '山田', roles: ['TEACHER'], ipAddress: '127.0.0.1' },
      {
        targetDate: '2026-06-01',
        durationType: 'FULL_DAY',
        reason: '風邪'
      }
    );
    assert.strictEqual(sickApp.calculatedMinutes, 465);
  });

  // GT-GAP02-02: 短時間勤務職員（所定240分）における病気休暇（1日） -> calculatedMinutes = 240 (固定465分の排除)
  it('GT-GAP02-02: 短時間勤務職員における病気休暇DAY申請は固定465分ではなく所定240分を厳格に算出する', () => {
    const sickCalc = LeaveCalculationService.calculate({
      subjectUserId: teacher2Id,
      typeId: 'LEAVE_SICK',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'DAY'
    });
    assert.strictEqual(sickCalc.isValid, true);
    assert.strictEqual(sickCalc.totalChargedDays, 1);
    assert.strictEqual(sickCalc.totalChargedMinutes, 240); // 465ではない！
    assert.strictEqual(sickCalc.snapshot?.scheduledWorkMinutes, 240);

    const sickApp = SickLeaveService.applySickLeave(
      { id: teacher2Id, username: 'teacher2', displayName: '佐藤', roles: ['TEACHER'], ipAddress: '127.0.0.1' },
      {
        targetDate: '2026-06-01',
        durationType: 'FULL_DAY',
        reason: '体調不良'
      }
    );
    assert.strictEqual(sickApp.calculatedMinutes, 240); // 465ではない！
  });

  // GT-GAP02-03: 特定日日課オーバーライド日（所定300分）における特別休暇（1日） -> calculatedMinutes = 300 (日課追従)
  it('GT-GAP02-03: 特定日日課オーバーライド日(300分)における特別休暇DAY申請はオーバーライド日課(300分)に追従する', () => {
    // 2026-06-03 に 300分 (08:30〜14:00, 休憩 12:00〜12:30 -> 実働300分) の日課オーバーライドを設定
    testDb.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, event_name, reason,
        schedule_override_json, status, created_by_user_id, created_at, updated_at
      ) VALUES (
        'CAL_ADJ_GAP02', 'USER', ?, 'SINGLE_WORKDAY_OVERRIDE', 'SCHOOL_EVENT',
        '2026-06-03', 'WORK_REQUIRED', '短縮日課', '短縮日課設定',
        ?, 'ACTIVE', ?, datetime('now'), datetime('now')
      )
    `).run(
      teacherId,
      JSON.stringify({
        totalWorkMinutes: 300,
        workIntervals: [
          { start: 510, end: 720 }, // 08:30 - 12:00 = 210分
          { start: 750, end: 840 }  // 12:30 - 14:00 = 90分 (計300分)
        ]
      }),
      adminId
    );

    const specialCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SPECIAL',
      startDate: '2026-06-03',
      endDate: '2026-06-03',
      unitType: 'DAY',
      reasonCode: 'SUMMER_LEAVE'
    });
    assert.strictEqual(specialCalc.isValid, true);
    assert.strictEqual(specialCalc.totalChargedDays, 1);
    assert.strictEqual(specialCalc.totalChargedMinutes, 300); // 465ではなくオーバーライドの300分！
    assert.strictEqual(specialCalc.snapshot?.scheduledWorkMinutes, 300);
  });

  // GT-GAP02-04: フルタイム日課における特別休暇（午前半日 / 午後半日） -> 午前230分 / 午後235分 (一律232分の排除)
  it('GT-GAP02-04: フルタイム日課における半日特別休暇は実区間長(午前230分/午後235分)を算出し一律232分を排除する', () => {
    const amCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SPECIAL',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });
    assert.strictEqual(amCalc.isValid, true);
    assert.strictEqual(amCalc.totalChargedDays, 0.5);
    assert.strictEqual(amCalc.totalChargedMinutes, 230); // 08:10〜12:00 = 230分

    const pmCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SPECIAL',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'HALF_DAY',
      halfDayType: 'AFTERNOON'
    });
    assert.strictEqual(pmCalc.isValid, true);
    assert.strictEqual(pmCalc.totalChargedDays, 0.5);
    assert.strictEqual(pmCalc.totalChargedMinutes, 235); // 12:45〜16:40 = 235分
  });

  // GT-GAP02-05: 休憩（12:00〜12:45）を跨ぐ時間病休（11:00〜14:00） -> 正味交差分数 135分 (非年休CEIL_60禁止)
  it('GT-GAP02-05: 休憩を跨ぐ時間病休はCEIL_60切り上げを行わず正味交差分数(135分)を算出する', () => {
    const sickTimeCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SICK',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'TIME',
      startTime: '11:00',
      endTime: '14:00'
    });
    assert.strictEqual(sickTimeCalc.isValid, true);
    assert.strictEqual(sickTimeCalc.totalChargedDays, 0);
    assert.strictEqual(sickTimeCalc.totalChargedMinutes, 135); // 180分でもCEIL_60の180分でもなく135分！
    assert.strictEqual(sickTimeCalc.snapshot?.netWorkMinutes, 135);
    assert.strictEqual(sickTimeCalc.snapshot?.roundingRule, 'NONE');
    assert.strictEqual(sickTimeCalc.snapshot?.roundingAddedMinutes, 0);

    // 職免 (LEAVE_DUTY_EXEMPT) でも同様に正味交差分数
    const dutyExemptCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_DUTY_EXEMPT',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'TIME',
      startTime: '11:00',
      endTime: '14:00'
    });
    assert.strictEqual(dutyExemptCalc.isValid, true);
    assert.strictEqual(dutyExemptCalc.totalChargedMinutes, 135);
    assert.strictEqual(dutyExemptCalc.snapshot?.roundingRule, 'NONE');
  });

  // GT-GAP02-06: 勤務義務のない非勤務日（週休日・祝日）に対する申請 -> calculatedDays = 0, NO_CHARGEABLE_DAYS で Fail-Closed
  it('GT-GAP02-06: 非勤務日(日曜日)に対する非年休申請は NO_CHARGEABLE_DAYS で Fail-Closed 拒絶される', () => {
    const sundayCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_SPECIAL',
      startDate: '2026-06-07', // 日曜日 (非勤務日)
      endDate: '2026-06-07',
      unitType: 'DAY'
    });
    assert.strictEqual(sundayCalc.isValid, false);
    assert.strictEqual(sundayCalc.errorCode, 'NO_CHARGEABLE_DAYS');
  });

  // GT-GAP02-07: 勤務スケジュール未設定・解決不能時 -> 465分フォールバックせず WORKING_OBLIGATION_UNRESOLVED で Fail-Closed
  it('GT-GAP02-07: 勤務義務未解決ユーザーに対する非年休DAY申請は465フォールバックせず Fail-Closed 拒絶される', () => {
    // 存在しない架空ユーザーID 99999
    const unresolvedCalc = LeaveCalculationService.calculate({
      subjectUserId: 99999,
      typeId: 'LEAVE_SICK',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'DAY'
    });
    assert.strictEqual(unresolvedCalc.isValid, false);
    assert.strictEqual(unresolvedCalc.errorCode, 'WORKING_OBLIGATION_UNRESOLVED');
  });

  // GT-GAP02-08: 既存 LEAVE_ANNUAL（年休）の動的計算および CEIL_60 切上動作が一切回帰・変化していないことの完全保全
  it('GT-GAP02-08: 年次有給休暇(LEAVE_ANNUAL)のCEIL_60切上および所定動的計算契約が完全に保全されている', () => {
    // 年休 TIME 11:00〜14:00 (実不在135分 -> CEIL_60 で 180分 = 3時間)
    const annualTimeCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'TIME',
      startTime: '11:00',
      endTime: '14:00'
    });
    assert.strictEqual(annualTimeCalc.isValid, true);
    assert.strictEqual(annualTimeCalc.totalChargedHours, 3);
    assert.strictEqual(annualTimeCalc.totalChargedMinutes, 180); // CEIL_60 で 180分！
    assert.strictEqual(annualTimeCalc.snapshot?.netWorkMinutes, 135);
    assert.strictEqual(annualTimeCalc.snapshot?.roundingRule, 'CEIL_60');
    assert.strictEqual(annualTimeCalc.snapshot?.roundingAddedMinutes, 45);

    // 年休 DAY (465分)
    const annualDayCalc = LeaveCalculationService.calculate({
      subjectUserId: teacherId,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'DAY'
    });
    assert.strictEqual(annualDayCalc.isValid, true);
    assert.strictEqual(annualDayCalc.totalChargedDays, 1);
    assert.strictEqual(annualDayCalc.totalChargedMinutes, 465);
  });

  // GT-GAP02-09: No Legacy Fallback Contract (P0-01): Resolverが有効な scheduledWorkMinutes を返さない場合 465へ逃げない
  it('GT-GAP02-09: P0-01: SickLeaveService.applySickLeave で非勤務日指定時は465へ逃げずに例外スローされる', () => {
    assert.throws(
      () => {
        SickLeaveService.applySickLeave(
          { id: teacherId, username: 'teacher1', displayName: '山田', roles: ['TEACHER'], ipAddress: '127.0.0.1' },
          {
            targetDate: '2026-06-07', // 日曜日
            durationType: 'FULL_DAY',
            reason: '休日病休申請の異常系テスト'
          }
        );
      },
      (err: Error) => {
        return err.message.includes('指定日は勤務日ではないか');
      }
    );
  });

  // GT-GAP02-10: Single Interval HALF_DAY Fail-Closed Contract (P1-01): 単一区間日課での半日休申請は推測除算せず Fail-Closed
  it('GT-GAP02-10: P1-01: 休憩区分のない単一区間日課での半日休申請は SINGLE_INTERVAL_HALF_DAY_UNSUPPORTED で Fail-Closed 拒絶される', () => {
    const halfCalc = LeaveCalculationService.calculate({
      subjectUserId: officeId,
      typeId: 'LEAVE_SPECIAL',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING'
    });

    assert.strictEqual(halfCalc.isValid, false);
    assert.strictEqual(halfCalc.errorCode, 'SINGLE_INTERVAL_HALF_DAY_UNSUPPORTED');
    assert.ok(halfCalc.message?.includes('午前・午後の明確な区分が存在しない'));
  });
});
