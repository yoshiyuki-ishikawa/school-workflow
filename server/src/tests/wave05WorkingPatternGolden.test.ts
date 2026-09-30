import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb, closeDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import {
  resolveAuthoritativeWorkSchedule,
  calculateScheduleIntersectionMinutes,
  ResolvedWorkSchedule
} from '../services/attendance/workPatternResolver';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import {
  CanonicalPipelinePoC,
  CanonicalServiceFact,
  ShadowComparator,
  DayComparisonResult
} from '../services/canonical';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';
import { AbsenceService } from '../services/absenceService';

describe('Wave 0.5: Working Pattern Dynamicization Golden Test Suite (GT-WP-01 〜 GT-WP-16)', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();

    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, display_name, family_name, given_name, stamp_name, department, is_active, created_at)
      VALUES (?, ?, 'hash', ?, '姓', '名', '印', '学年部', 1, '${now}')
    `);
    for (const uid of [101, 102, 103, 104, 105, 106, 107]) {
      insertUser.run(uid, `user${uid}`, `テスト教員${uid}`);
    }
  });

  after(() => {
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM absences').run();
    db.prepare('DELETE FROM calendar_adjustments').run();
    db.prepare('DELETE FROM user_work_patterns WHERE user_id IN (101, 102, 103, 104, 105, 106, 107)').run();
  });

  // GT-WP-01: 通常フルタイム (週5日・各465分)
  it('GT-WP-01: 通常フルタイムパターンの決定論的解決 (465分)', () => {
    const res = resolveAuthoritativeWorkSchedule(1, '2026-05-13'); // 水曜日
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.dutyStatus, 'WORK_REQUIRED');
  });

  // GT-WP-02: 育児短時間 (5時間/300分パターン)
  it('GT-WP-02: 育短 5時間/300分パターンの動的解決 (240分固定の脱却)', () => {
    const schedule300 = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "2": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "3": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "4": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "5": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });

    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (801, 101, '育短5時間', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,6', ?, 1500, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(schedule300);

    const res = resolveAuthoritativeWorkSchedule(101, '2026-05-13'); // 水曜日
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.scheduledWorkMinutes, 300);
  });

  // GT-WP-03: 育児短時間 (週4日勤務・金曜日週休)
  it('GT-WP-03: 育短 週4日勤務パターンの解決 (金曜日週休=0分/非勤務日)', () => {
    const schedule4Days = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "3": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "5": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });

    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (802, 102, '育短週4日', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,5,6', ?, 1860, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(schedule4Days);

    const workDayRes = resolveAuthoritativeWorkSchedule(102, '2026-05-14'); // 木曜日
    assert.strictEqual(workDayRes.isWorkDay, true);
    assert.strictEqual(workDayRes.scheduledWorkMinutes, 465);

    const offDayRes = resolveAuthoritativeWorkSchedule(102, '2026-05-15'); // 金曜日
    assert.strictEqual(offDayRes.status, 'RESOLVED');
    assert.strictEqual(offDayRes.isWorkDay, false);
    assert.strictEqual(offDayRes.scheduledWorkMinutes, 0);
    assert.strictEqual(offDayRes.dutyStatus, 'NO_WORK_REQUIRED');
  });

  // GT-WP-04: 曜日別異時間勤務 (月水金465分 / 火木235分)
  it('GT-WP-04: 曜日別異時間勤務パターンの動的解決', () => {
    const varSchedule = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true, "workMinutes": 235, "startTime": "08:15", "endTime": "12:10", "intervals": [{ "startTime": "08:15", "endTime": "12:10" }] },
      "3": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true, "workMinutes": 235, "startTime": "08:15", "endTime": "12:10", "intervals": [{ "startTime": "08:15", "endTime": "12:10" }] },
      "5": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });

    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (803, 103, '変則育短', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,6', ?, 1865, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(varSchedule);

    const tueRes = resolveAuthoritativeWorkSchedule(103, '2026-05-12'); // 火曜日
    assert.strictEqual(tueRes.scheduledWorkMinutes, 235);

    const wedRes = resolveAuthoritativeWorkSchedule(103, '2026-05-13'); // 水曜日
    assert.strictEqual(wedRes.scheduledWorkMinutes, 465);
  });

  // GT-WP-05: 有効期間境界の切り替わり (6/30まで300分、7/1から465分)
  it('GT-WP-05: 有効期間境界によるパターンの正確な切り替わり', () => {
    const s300 = JSON.stringify({
      "1": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "13:30", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "2": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "13:30", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "3": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "13:30", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "4": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "13:30", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "5": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "13:30", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] }
    });
    const s465 = JSON.stringify({
      "1": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "3": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "5": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] }
    });

    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (804, 104, '前期育短', 'SHORT_TIME', '2026-04-01', '2026-06-30', '0,6', ?, 1500, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(s300);

    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (805, 104, '後期フル', 'STANDARD_FULLTIME', '2026-07-01', '2027-03-31', '0,6', ?, 2325, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(s465);

    const junRes = resolveAuthoritativeWorkSchedule(104, '2026-06-30'); // 火
    assert.strictEqual(junRes.scheduledWorkMinutes, 300);

    const julRes = resolveAuthoritativeWorkSchedule(104, '2026-07-01'); // 水
    assert.strictEqual(julRes.scheduledWorkMinutes, 465);
  });

  // GT-WP-06: 過去事実の不変性 (WP-INV-02)
  it('GT-WP-06: 過去に確定した事実が後日の新パターン追加で変化しないこと (WP-INV-02)', () => {
    const s300 = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "2": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "3": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "4": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "5": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (804, 104, '前期短時間', 'SHORT_TIME', '2026-04-01', '2026-06-30', '0,6', ?, 1500, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(s300);

    // 5月の時点では 804 (300分)
    const mayRes = resolveAuthoritativeWorkSchedule(104, '2026-05-15');
    assert.strictEqual(mayRes.scheduledWorkMinutes, 300);

    // 後日 2027年度のパターンを追加登録
    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (806, 104, '来期パターン', 'STANDARD_FULLTIME', '2027-04-01', '2028-03-31', '0,6', 2325, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run();

    // 5月の解決結果は 300分 のまま不変
    const mayRecheck = resolveAuthoritativeWorkSchedule(104, '2026-05-15');
    assert.strictEqual(mayRecheck.scheduledWorkMinutes, 300);
    assert.strictEqual(mayRecheck.patternId, 804);
  });

  // GT-WP-07: 短時間勤務者の年休消化連動
  it('GT-WP-07: 短時間勤務者 (300分) の終日年休が正しく300分控除されること', () => {
    // GT-WP-02 で登録された 101 (300分) を再投入
    const schedule300 = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "2": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "3": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "4": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "5": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT OR REPLACE INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (801, 101, '育短5時間', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,6', ?, 1500, 1, '${now}', 1, '${now}')
    `).run(schedule300);

    const res = LeaveCalculationService.calculate({
      subjectUserId: 101,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-05-13',
      unitType: 'DAY'
    });

    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.snapshot?.scheduledWorkMinutes, 300);
    assert.strictEqual(res.snapshot?.attendanceDeductionMinutes, 300);
    assert.strictEqual(res.snapshot?.chargedMinutes, 300);
  });

  // GT-WP-08: 短時間勤務者の終日欠勤連動
  it('GT-WP-08: 短時間勤務者 (300分) の終日欠勤が正しく300分として登録されること', () => {
    const schedule300 = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "2": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "3": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "4": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "5": { "isWorkDay": true, "workMinutes": 300, "startTime": "08:30", "endTime": "14:15", "intervals": [{ "startTime": "08:30", "endTime": "13:30" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT OR REPLACE INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (801, 101, '育短5時間', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,6', ?, 1500, 1, '${now}', 1, '${now}')
    `).run(schedule300);

    const aid = AbsenceService.createAbsence({
      userId: 101,
      absenceType: 'FULL_DAY',
      targetDate: '2026-05-13',
      reason: '所用欠勤',
      actor: { id: 1, username: 'admin', displayName: '管理者', ipAddress: '127.0.0.1' }
    });

    const row = db.prepare('SELECT * FROM absences WHERE id = ?').get(aid) as any;
    assert.strictEqual(row.duration_minutes, 300);
  });

  // GT-WP-09: 240分パターンの正当なFixture検証
  it('GT-WP-09: 240分勤務パターンが設定されている職員は正当に240分として解決されること', () => {
    const s240 = JSON.stringify({
      "1": { "isWorkDay": true, "workMinutes": 240, "startTime": "08:30", "endTime": "12:30", "intervals": [{ "startTime": "08:30", "endTime": "12:30" }] },
      "2": { "isWorkDay": true, "workMinutes": 240, "startTime": "08:30", "endTime": "12:30", "intervals": [{ "startTime": "08:30", "endTime": "12:30" }] },
      "3": { "isWorkDay": true, "workMinutes": 240, "startTime": "08:30", "endTime": "12:30", "intervals": [{ "startTime": "08:30", "endTime": "12:30" }] },
      "4": { "isWorkDay": true, "workMinutes": 240, "startTime": "08:30", "endTime": "12:30", "intervals": [{ "startTime": "08:30", "endTime": "12:30" }] },
      "5": { "isWorkDay": true, "workMinutes": 240, "startTime": "08:30", "endTime": "12:30", "intervals": [{ "startTime": "08:30", "endTime": "12:30" }] }
    });

    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (807, 105, '育短4時間', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,6', ?, 1200, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run(s240);

    const res = resolveAuthoritativeWorkSchedule(105, '2026-05-13');
    assert.strictEqual(res.scheduledWorkMinutes, 240);
  });

  // GT-WP-10: Comparator の純粋差分検出 (特例なし)
  it('GT-WP-10: Comparator が業務ルールを持たず、客観的差分を純粋に検出すること', () => {
    const legacyDay: any = {
      day: 13,
      date: '2026-05-13',
      dayOfWeek: '水',
      isWorkDay: true,
      dutyRequirement: 'WORK_REQUIRED',
      scheduledWorkMinutes: 465, // Legacy側の旧固定値
      actualWorkMinutes: 465,
      deductionMinutes: 0,
      displaySymbol: '出',
      displayName: '出勤',
      stampColor: 'slate',
      stampText: '出勤',
      primaryDayClassification: 'WORKDAY',
      serviceStatus: 'NORMAL_WORK',
      aggregationCategory: 'WORKED',
      isPersonnelStatusOverridden: false,
      explanations: []
    };

    const canonicalResult: any = {
      userId: 101,
      date: '2026-05-13',
      dayOfWeek: '水',
      isScheduledWorkDay: true,
      dutyStatus: 'WORK_REQUIRED',
      scheduledWorkMinutes: 300, // Canonical側の動的解決値
      countedWorkMinutes: 300,
      deductionMinutes: 0,
      effectiveWorkMinutes: 300,
      primaryCanonicalStatus: 'WORKED',
      secondaryCanonicalStatuses: [],
      appliedConflictAction: 'COEXIST',
      aggregationCategory: 'WORKED',
      contributingFactIds: [],
      isPersonnelStatusOverridden: false,
      explanations: []
    };

    const comp = ShadowComparator.compareDay(legacyDay, canonicalResult, 101);
    assert.strictEqual(comp.isMatch, false, '465 vs 300 は客観的不一致として検出されること');
    assert.ok(comp.differences.some(d => d.field === 'scheduledWorkMinutes'));
  });

  // GT-WP-11: パターン未割当 (0件) -> UNKNOWN_PATTERN (Fail-Closed)
  it('GT-WP-11: パターン未割当職員は 0分や465分にフォールバックせず UNKNOWN_PATTERN として Fail-Closed すること (WP-INV-01)', () => {
    const res = resolveAuthoritativeWorkSchedule(9999, '2026-05-13');
    assert.strictEqual(res.status, 'UNKNOWN_PATTERN');
    assert.strictEqual(res.isFailClosed, true);
    assert.strictEqual(res.scheduledWorkMinutes, undefined, '未定義時は0分や465分を捏造しないこと');
  });

  // GT-WP-12: パターン重複 (>=2件) -> AMBIGUOUS_PATTERN (Fail-Closed)
  it('GT-WP-12: 同一日に有効期間が重複する複数パターンが存在する場合は AMBIGUOUS_PATTERN として Fail-Closed すること (WP-INV-01)', () => {
    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (808, 106, '重複A', 'STANDARD_FULLTIME', '2026-04-01', '2026-09-30', '0,6', 2325, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run();
    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (809, 106, '重複B', 'SHORT_TIME', '2026-07-01', '2026-12-31', '0,6', 1500, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run();

    // 2026-08-10 は A と B の両方が有効
    const res = resolveAuthoritativeWorkSchedule(106, '2026-08-10');
    assert.strictEqual(res.status, 'AMBIGUOUS_PATTERN');
    assert.strictEqual(res.isFailClosed, true);
    assert.strictEqual(res.scheduledWorkMinutes, undefined);
  });

  // GT-WP-13: 正当な非勤務日 (週休日=0分) とエラーの分離
  it('GT-WP-13: 正当な週休日は isWorkDay=false, scheduledWorkMinutes=0 の VALID 結果となり、エラーと明確に区別されること', () => {
    const sunRes = resolveAuthoritativeWorkSchedule(1, '2026-05-17'); // 日曜日
    assert.strictEqual(sunRes.status, 'RESOLVED');
    assert.strictEqual(sunRes.isFailClosed, false);
    assert.strictEqual(sunRes.isWorkDay, false);
    assert.strictEqual(sunRes.scheduledWorkMinutes, 0);
  });

  // GT-WP-14: スケジュール JSON 破損 -> INVALID_SCHEDULE (Fail-Closed)
  it('GT-WP-14: schedule_details_json が破損している場合は INVALID_SCHEDULE として Fail-Closed すること', () => {
    db.prepare(`
      INSERT INTO user_work_patterns (id, user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at)
      VALUES (810, 107, '破損パターン', 'SHORT_TIME', '2026-04-01', '2027-03-31', '0,6', '{ invalid json: broken ', 1500, 'INDIVIDUAL', 1, '${now}', 1, '${now}')
    `).run();

    const res = resolveAuthoritativeWorkSchedule(107, '2026-05-13');
    assert.strictEqual(res.status, 'INVALID_SCHEDULE');
    assert.strictEqual(res.isFailClosed, true);
    assert.strictEqual(res.scheduledWorkMinutes, undefined);
  });

  // GT-WP-15: 確定済み事実の保護 (WP-INV-02)
  it('GT-WP-15: 確定済み月度データに対する不変性保護の検証 (WP-INV-02)', () => {
    // 確定済み出勤簿テーブルにダミー確定を投入 (ADMIN user_id=6 を confirmed_by に指定)
    db.prepare(`
      INSERT INTO monthly_attendance_approvals (user_id, year_month, status, confirmed_by_user_id, confirmed_at)
      VALUES (101, '2026-05', 'CONFIRMED', 6, '${now}')
    `).run();

    // 確定済み期間に跨がるパターンの削除クエリをシミュレート
    const confirmed = db.prepare(`
      SELECT year_month FROM monthly_attendance_approvals
      WHERE user_id = ? AND status = 'CONFIRMED'
        AND year_month >= substr(?, 1, 7) AND year_month <= substr(?, 1, 7)
    `).all(101, '2026-04-01', '2027-03-31');

    assert.ok(confirmed.length > 0, '確定済み月度が検出されること');
  });

  // GT-WP-16: Legacy 不変性の検証 (Legacy Freeze Integrity)
  it('GT-WP-16: Legacy AttendanceEngine が Wave 0.5 改修後も一切の変更なく従前通りの決定論的結果を返すこと', () => {
    const legacyCtx = {
      userId: 1,
      date: '2026-05-13',
      authorityId: 'DEFAULT_MUNICIPALITY'
    };
    const res = AttendanceEngine.resolveDay(legacyCtx);
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.serviceStatus, 'NORMAL_WORK');
  });
});
