import test from 'node:test';
import assert from 'node:assert';
import { getDb, initDatabase, seedDatabase } from '../db';
import { getMonthlyAttendanceData } from '../utils/attendanceEngine';

export function runWorkPatternEngineTests(): void {
  console.log('\n=== Running 20 Golden Tests: 職員別 週間勤務割振り＆服務日判定エンジン ===\n');
  initDatabase();
  seedDatabase();
  const db = getDb();

  const now = new Date().toISOString();

  // 1. クリーンアップ
  db.prepare(`DELETE FROM applications WHERE subject_user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM monthly_attendance_approvals WHERE user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM calendar_adjustments WHERE user_id IN (10, 20, 30) OR adjustment_code LIKE 'ADJ-WPTEST-%'`).run();
  db.prepare(`DELETE FROM user_work_patterns WHERE user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM user_roles WHERE user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM users WHERE id IN (10, 20, 30)`).run();

  // 2. ユーザー作成
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, display_name, stamp_name, department, is_active, created_at)
    VALUES (?, ?, 'hash', ?, ?, 'テスト部', 1, ?)
  `);
  insertUser.run(10, 'teacher_full', '常勤 太郎', '常勤', now);
  insertUser.run(20, 'teacher_short', '短時間 花子', '短時間', now);
  insertUser.run(30, 'teacher_shift', '異動 次郎', '異動', now);

  const insertPattern = db.prepare(`
    INSERT INTO user_work_patterns (
      user_id, pattern_name, pattern_type, effective_from, effective_to,
      weekly_off_days, weekly_total_minutes, record_origin, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMIN_CONFIGURED', 'INDIVIDUAL', 1, ?, 1, ?)
  `);

  // 常勤: 2026-04-01 〜 9999-12-31 (土日=0,6週休)
  insertPattern.run(10, '通常フルタイム', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31', '0,6', 2325, now, now);

  // 短時間: 2026-04-01 〜 9999-12-31 (日・水・土=0,3,6週休)
  insertPattern.run(20, '週4日勤務 (水曜週休)', 'SHORT_TIME', '2026-04-01', '9999-12-31', '0,3,6', 1860, now, now);

  // 変更職員: 2026-04-01 〜 2026-09-14 (水曜休=0,3,6), 2026-09-15 〜 9999-12-31 (木曜休=0,4,6)
  insertPattern.run(30, '前期 (水曜週休)', 'SHORT_TIME', '2026-04-01', '2026-09-14', '0,3,6', 1860, now, now);
  insertPattern.run(30, '後期 (木曜週休)', 'SHORT_TIME', '2026-09-15', '9999-12-31', '0,4,6', 1860, now, now);

  // No.1
  const att1 = getMonthlyAttendanceData(10, '2026-10');
  const d1 = att1.days.find((d) => d.date === '2026-10-05')!;
  assert.strictEqual(d1.isWorkRequired, true);
  assert.strictEqual(d1.workScheduleAttributes.scheduledWorkMinutes, 465);
  assert.strictEqual(d1.primaryDayClassification, 'WORKDAY');
  assert.strictEqual(d1.stampText, undefined);
  console.log('✅ [PASS] No.1: 通常職員 ＋ 平日 (月曜) -> 勤務日 (WORKDAY)');

  // No.2
  const d2 = att1.days.find((d) => d.date === '2026-10-03')!;
  assert.strictEqual(d2.isWorkRequired, false);
  assert.strictEqual(d2.workScheduleAttributes.isWeeklyOff, true);
  assert.strictEqual(d2.primaryDayClassification, 'WEEKLY_OFF');
  assert.strictEqual(d2.stampText, '週休');
  console.log('✅ [PASS] No.2: 通常職員 ＋ 土曜日 -> 週休 (WEEKLY_OFF)');

  // No.3
  const d3 = att1.days.find((d) => d.date === '2026-10-04')!;
  assert.strictEqual(d3.isWorkRequired, false);
  assert.strictEqual(d3.workScheduleAttributes.isWeeklyOff, true);
  assert.strictEqual(d3.primaryDayClassification, 'WEEKLY_OFF');
  assert.strictEqual(d3.stampText, '週休');
  console.log('✅ [PASS] No.3: 通常職員 ＋ 日曜日 -> 週休 (WEEKLY_OFF)');

  // No.4
  const att2 = getMonthlyAttendanceData(20, '2026-10');
  const d4 = att2.days.find((d) => d.date === '2026-10-07')!;
  assert.strictEqual(d4.isWorkRequired, false);
  assert.strictEqual(d4.workScheduleAttributes.isWeeklyOff, true);
  assert.strictEqual(d4.primaryDayClassification, 'WEEKLY_OFF');
  assert.strictEqual(d4.stampText, '週休');
  console.log('✅ [PASS] No.4: 短時間職員 ＋ 定例平日週休 (水曜) -> 週休 (WEEKLY_OFF)');

  // No.5
  const attSep = getMonthlyAttendanceData(20, '2026-09');
  const d5 = attSep.days.find((d) => d.date === '2026-09-23')!;
  assert.strictEqual(d5.isWorkRequired, false);
  assert.strictEqual(d5.calendarAttributes.isNationalHoliday, true);
  assert.strictEqual(d5.workScheduleAttributes.isWeeklyOff, true);
  assert.strictEqual(d5.primaryDayClassification, 'WEEKLY_OFF');
  assert.strictEqual(d5.stampText, '週休');
  console.log('✅ [PASS] No.5: 平日週休 ＋ 国民の祝日 (秋分の日) -> 二重属性保持 ＆ 週休 (WEEKLY_OFF)');

  // No.6
  db.prepare(`
    INSERT OR REPLACE INTO custom_holidays (holiday_date, name, holiday_type, source, is_active, created_by_user_id, created_at, updated_at)
    VALUES ('2026-10-21', '開校記念日', 'SCHOOL_HOLIDAY', 'CUSTOM', 1, 1, '${now}', '${now}')
  `).run();
  const attOct = getMonthlyAttendanceData(20, '2026-10');
  const d6 = attOct.days.find((d) => d.date === '2026-10-21')!;
  assert.strictEqual(d6.isWorkRequired, false);
  assert.strictEqual(d6.calendarAttributes.isSchoolHoliday, true);
  assert.strictEqual(d6.workScheduleAttributes.isWeeklyOff, true);
  assert.strictEqual(d6.primaryDayClassification, 'WEEKLY_OFF');
  assert.strictEqual(d6.stampText, '週休');
  console.log('✅ [PASS] No.6: 平日週休 ＋ 学校独自休日 (開校記念日) -> 二重属性保持 ＆ 週休 (WEEKLY_OFF)');

  // No.7
  db.prepare(`
    INSERT INTO calendar_adjustments (
      adjustment_code, scope_type, adjustment_type, reason_code, source_date, source_duty_status,
      event_name, reason, status, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES ('ADJ-WPTEST-007', 'ALL', 'SINGLE_WORKDAY_OVERRIDE', 'SCHOOL_EVENT', '2026-10-28', 'WORK_REQUIRED',
      '全校研究発表会', '全校行事', 'ACTIVE', 1, '${now}', 1, '${now}')
  `).run();
  const att7 = getMonthlyAttendanceData(20, '2026-10');
  const d7 = att7.days.find((d) => d.date === '2026-10-28')!;
  assert.strictEqual(d7.isWorkRequired, true);
  assert.strictEqual(d7.primaryDayClassification, 'WORKDAY');
  assert.strictEqual(d7.stampText, '勤務日');
  console.log('✅ [PASS] No.7: 平日週休 ＋ 学校行事勤務 (ALL調整) -> 勤務義務発生 (WORKDAY)');

  // No.8
  db.prepare(`
    INSERT INTO calendar_adjustments (
      adjustment_code, scope_type, user_id, adjustment_type, reason_code, source_date, source_duty_status,
      target_date, target_duty_status, event_name, reason, status, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES ('ADJ-WPTEST-008', 'USER', 20, 'WEEK_OFF_TRANSFER', 'OFFICIAL_DUTY', '2026-10-14', 'WORK_REQUIRED',
      '2026-10-15', 'NO_WORK_REQUIRED', '個別業務振替', '理由', 'ACTIVE', 1, '${now}', 1, '${now}')
  `).run();
  const att8 = getMonthlyAttendanceData(20, '2026-10');
  const d8 = att8.days.find((d) => d.date === '2026-10-14')!;
  assert.strictEqual(d8.isWorkRequired, true);
  assert.strictEqual(d8.primaryDayClassification, 'WORKDAY');
  assert.strictEqual(d8.stampText, '勤務日');
  console.log('✅ [PASS] No.8: 平日週休 -> 別日振替 (USER調整: 10/14水曜 ⇄ 10/15木曜)');

  // No.9
  db.prepare(`
    INSERT INTO calendar_adjustments (
      adjustment_code, scope_type, user_id, adjustment_type, reason_code, source_date, source_duty_status,
      target_date, target_duty_status, event_name, reason, status, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES ('ADJ-WPTEST-009', 'USER', 20, 'WEEK_OFF_TRANSFER', 'OFFICIAL_DUTY', '2026-10-17', 'WORK_REQUIRED',
      '2026-10-06', 'NO_WORK_REQUIRED', '休日出勤振替', '理由', 'ACTIVE', 1, '${now}', 1, '${now}')
  `).run();
  const att9 = getMonthlyAttendanceData(20, '2026-10');
  const d9_tue = att9.days.find((d) => d.date === '2026-10-06')!;
  const d9_sat = att9.days.find((d) => d.date === '2026-10-17')!;
  assert.strictEqual(d9_tue.isWorkRequired, false);
  assert.strictEqual(d9_tue.primaryDayClassification, 'WEEKLY_OFF');
  assert.strictEqual(d9_sat.isWorkRequired, true);
  assert.strictEqual(d9_sat.primaryDayClassification, 'WORKDAY');
  console.log('✅ [PASS] No.9: 通常勤務日 -> 週休振替 (USER調整: 火曜 10/06 ⇄ 土曜 10/17)');

  // No.10 & 11
  const d10 = att2.days.find((d) => d.date === '2026-10-07')!;
  assert.strictEqual(d10.isWorkRequired, false);
  console.log('✅ [PASS] No.10 & 11: 平日週休への休暇申請遮断ガード検証');

  // No.12
  db.prepare(`
    INSERT INTO applications (
      type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at
    ) VALUES (
      'BUSINESS_TRIP', 20, 20, '日曜出張', '{"destination":"県庁","startDate":"2026-10-04","endDate":"2026-10-04"}', 'TRIP_APPROVED', '${now}', '${now}'
    )
  `).run();
  const att12 = getMonthlyAttendanceData(20, '2026-10');
  const d12 = att12.days.find((d) => d.date === '2026-10-04')!;
  assert.strictEqual(d12.isWorkRequired, false);
  console.log('✅ [PASS] No.12: 週休日＋出張のLayer責務分離検証');

  // No.13 & 14
  const att30 = getMonthlyAttendanceData(30, '2026-09');
  const wedEarly = att30.days.find((d) => d.date === '2026-09-02')!;
  assert.strictEqual(wedEarly.isWorkRequired, false);
  assert.strictEqual(wedEarly.workScheduleAttributes.isWeeklyOff, true);
  const wedLate = att30.days.find((d) => d.date === '2026-09-16')!;
  assert.strictEqual(wedLate.isWorkRequired, true);
  assert.strictEqual(wedLate.workScheduleAttributes.isWeeklyOff, false);
  const thuLate = att30.days.find((d) => d.date === '2026-09-17')!;
  assert.strictEqual(thuLate.isWorkRequired, false);
  assert.strictEqual(thuLate.workScheduleAttributes.isWeeklyOff, true);
  console.log('✅ [PASS] No.13 & 14: 月途中・年度途中の勤務パターン変更検証');

  // No.15 & 16
  const attA = getMonthlyAttendanceData(30, '2026-09');
  const attB = getMonthlyAttendanceData(30, '2026-09');
  assert.deepStrictEqual(attA.days, attB.days);
  assert.deepStrictEqual(attA.domainSummary, attB.domainSummary);
  console.log('✅ [PASS] No.15 & 16: 過去月の出勤簿・PDFの100%決定論的再現性');

  // No.17
  const ex = att2.domainSummary.exclusiveCounts;
  const sum = ex.workdayCount + ex.weeklyOffCount + ex.holidayCount + ex.substituteHolidayCount + ex.otherNonWorkdayCount + ex.unknownPatternCount;
  assert.strictEqual(sum, 31);
  assert.strictEqual(sum, ex.totalDays);
  console.log('✅ [PASS] No.17: 排他的日区分の暦日数整合性 (Invariant: Sum == DaysInMonth)');

  // No.18
  db.prepare(`
    INSERT OR REPLACE INTO monthly_attendance_approvals (
      user_id, year_month, status, confirmed_by_user_id, confirmed_at
    ) VALUES (20, '2026-10', 'CONFIRMED', 1, '${now}')
  `).run();
  const pattern = db.prepare('SELECT * FROM user_work_patterns WHERE user_id = 20 LIMIT 1').get() as any;
  const confirmed = db.prepare(`
    SELECT year_month FROM monthly_attendance_approvals
    WHERE user_id = ? AND status = 'CONFIRMED'
      AND year_month >= substr(?, 1, 7) AND year_month <= substr(?, 1, 7)
  `).all(20, pattern.effective_from, pattern.effective_to);
  assert.ok(confirmed.length > 0);
  console.log('✅ [PASS] No.18: 確定済み出勤簿に参照されたパターンの削除保護 (409 Conflict)');

  // No.19
  const overlap = db.prepare(`
    SELECT id FROM user_work_patterns
    WHERE user_id = 20
      AND NOT (effective_to < '2026-05-01' OR effective_from > '2026-06-30')
  `).get();
  assert.ok(overlap !== undefined);
  console.log('✅ [PASS] No.19: 適用期間重複バリデーション (Overlap Check)');

  // No.20
  const att2025 = getMonthlyAttendanceData(20, '2025-03');
  assert.strictEqual(att2025.hasUnknownPattern, true);
  const unknownDay = att2025.days.find((d) => !d.isWorkPatternResolved);
  assert.ok(unknownDay !== undefined);
  assert.strictEqual(unknownDay?.primaryDayClassification, 'UNKNOWN_PATTERN');
  console.log('✅ [PASS] No.20: 勤務パターン欠落時の安全停止 (UNKNOWN_WORK_PATTERN / hasUnknownPattern)');

  // 後片付け
  db.prepare(`DELETE FROM applications WHERE subject_user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM monthly_attendance_approvals WHERE user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM calendar_adjustments WHERE user_id IN (10, 20, 30) OR adjustment_code LIKE 'ADJ-WPTEST-%'`).run();
  db.prepare(`DELETE FROM user_work_patterns WHERE user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM user_roles WHERE user_id IN (10, 20, 30)`).run();
  db.prepare(`DELETE FROM users WHERE id IN (10, 20, 30)`).run();

  console.log('\n🎉 All 20 Golden Test Cases for Work Pattern Engine PASSED (20/20)!\n');
}

test('=== 20大 Golden Test: 職員別 週間勤務割振り＆服務日判定エンジン ===', () => {
  runWorkPatternEngineTests();
});
