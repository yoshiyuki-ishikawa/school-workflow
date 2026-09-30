import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getDb, setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import {
  resolveAuthoritativeWorkSchedule,
  validateWorkIntervals,
  deriveBreakIntervals,
  timeToMinutes,
  minutesToTime,
} from '../services/attendance/workPatternResolver';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';
import { SickLeaveService } from '../services/sickLeaveService';
import { calculateWorkIntersectionMinutes } from '../services/attendance/resolvers';
import adminRouter from '../routes/admin';

function makeWeeklySchedule(intervals: { startTime: string; endTime: string }[], workMinutes: number) {
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

describe('Daily Work Schedule Golden Test Suite (GT-DWS-01 〜 GT-DWS-15)', () => {
  let testDb: any;
  let originalDb: any;

  before(() => {
    originalDb = getDb();
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    setDb(testDb);
    testDb.exec(SCHEMA_SQL);
    migrator.runMigrations(testDb);
    seedDatabase();
  });

  after(() => {
    setDb(originalDb);
    testDb.close();
  });

  beforeEach(() => {
    // Clean test state
    testDb.prepare('DELETE FROM calendar_adjustments').run();
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id IN (1, 2, 3)').run();
  });

  // GT-DWS-01: 明示的標準フルタイム (08:10-12:00, 12:45-16:40 -> 465分)
  it('GT-DWS-01: 明示的標準フルタイムの解決 (465分、2区間、休憩45分)', () => {
    const db = getDb();
    const scheduleJson = makeWeeklySchedule(
      [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      465
    );

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '標準フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(scheduleJson);

    // 2026-09-15 is Tuesday (work day)
    const res = resolveAuthoritativeWorkSchedule(1, '2026-09-15');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.dutyStatus, 'WORK_REQUIRED');
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.effectiveIntervals?.length, 2);
    assert.deepStrictEqual(res.effectiveIntervals, [
      { start: 490, end: 720 },
      { start: 765, end: 1000 },
    ]);
    assert.strictEqual(res.breakMinutes, 45);
    assert.deepStrictEqual(res.breakIntervals, [{ start: 720, end: 765 }]);
  });

  // GT-DWS-02: 既知の移行データ (Migration 006 初期レコード) の決定論的解決
  it('GT-DWS-02: Migration 006 初期レコードの決定論的解決 (RESOLVED_LEGACY_COMPATIBLE, 465分)', () => {
    const db = getDb();
    const legacyObj: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      if (d === 0 || d === 6) {
        legacyObj[String(d)] = { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null };
      } else {
        legacyObj[String(d)] = { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45' };
      }
    }
    const legacyScheduleJson = JSON.stringify(legacyObj);

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '初期設定フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'MIGRATION_INITIAL', 1, datetime('now'), datetime('now'))
    `).run(legacyScheduleJson);

    const res = resolveAuthoritativeWorkSchedule(1, '2026-09-15');
    assert.strictEqual(res.status, 'RESOLVED_LEGACY_COMPATIBLE');
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    // Deterministic mapping: 08:15-12:15 (495-735) and 13:00-16:45 (780-1005)
    assert.deepStrictEqual(res.effectiveIntervals, [
      { start: 495, end: 735 },
      { start: 780, end: 1005 },
    ]);
    assert.strictEqual(res.breakMinutes, 45);
    assert.deepStrictEqual(res.breakIntervals, [{ start: 735, end: 780 }]);
  });

  // GT-DWS-03: 未知の不正/NULLスケジュール -> Fail-Closed
  it('GT-DWS-03: 未知の不正/NULLスケジュールは Fail-Closed (INVALID_SCHEDULE)', () => {
    const db = getDb();
    // ADMIN_CONFIGURED but without intervals and arbitrary time (not migration initial)
    const unknownObj: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      unknownObj[String(d)] = { isWorkDay: true, workMinutes: 465, startTime: '09:00', endTime: '17:00' };
    }
    const unknownScheduleJson = JSON.stringify(unknownObj);

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '不正パターン', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(unknownScheduleJson);

    const res = resolveAuthoritativeWorkSchedule(1, '2026-09-15');
    assert.strictEqual(res.status, 'INVALID_SCHEDULE');
    assert.strictEqual(res.isFailClosed, true);
    assert.match(res.failReason || '', /明示的実働インターバル/);
  });

  // GT-DWS-04: 育児短時間勤務 (CST) の日課明示性と法令コードの独立性
  it('GT-DWS-04: 育児短時間勤務の日課明示性・計算の正確性・法定コード独立性', () => {
    const db = getDb();
    // 300分 (5時間: 08:30-14:00, 休憩 12:00-12:30 -> 210分 + 90分 = 300分)
    const cstScheduleJson = makeWeeklySchedule(
      [
        { startTime: '08:30', endTime: '12:00' }, // 210分 (510-720)
        { startTime: '12:30', endTime: '14:00' }, // 90分 (750-840)
      ],
      300
    );

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, statutory_pattern_code,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '育児短時間 (週25h)', 'SHORT_TIME', 'CST_01', '2026-01-01', '9999-12-31', '0,6', ?, 1500, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(cstScheduleJson);

    const res = resolveAuthoritativeWorkSchedule(1, '2026-09-15');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.statutoryPatternCode, 'CST_01');
    assert.strictEqual(res.scheduledWorkMinutes, 300);
    assert.deepStrictEqual(res.effectiveIntervals, [
      { start: 510, end: 720 },
      { start: 750, end: 840 },
    ]);
    assert.strictEqual(res.breakMinutes, 30);
    assert.deepStrictEqual(res.breakIntervals, [{ start: 720, end: 750 }]);
  });

  // GT-DWS-05: calendar_adjustments の日付個別オーバーライド優先
  it('GT-DWS-05: 日付個別オーバーライド (calendar_adjustments.schedule_override_json) の優先解決', () => {
    const db = getDb();
    const standardSchedule = makeWeeklySchedule(
      [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      465
    );
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '標準フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(standardSchedule);

    // Override for 2026-09-15: 午前のみ短縮日課 (08:30-12:30 -> 240分)
    const overrideJson = JSON.stringify({
      workIntervals: [{ start: 510, end: 750 }],
    });
    db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, event_name, reason,
        schedule_override_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        'CAL_ADJ_GT05', 'ALL', NULL, 'SINGLE_WORKDAY_OVERRIDE', 'SCHOOL_EVENT',
        '2026-09-15', 'WORK_REQUIRED', '午前授業日課', '学校行事',
        ?, 1, datetime('now'), datetime('now')
      )
    `).run(overrideJson);

    const obligation = WorkingObligationResolver.resolve(1, '2026-09-15');
    assert.strictEqual(obligation.status, 'WORKING');
    assert.strictEqual(obligation.isFailClosed, false);
    assert.strictEqual(obligation.sourceType, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(obligation.workSchedule?.scheduledWorkMinutes, 240);
    assert.strictEqual(obligation.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');
    assert.deepStrictEqual(obligation.workSchedule?.effectiveIntervals, [{ start: 510, end: 750 }]);
  });

  // GT-DWS-06: 週休日・非勤務日の空情報性 (isWorkDay=false, 0分, NO_WORK_REQUIRED)
  it('GT-DWS-06: 週休日・非勤務日は 0分 かつ NO_WORK_REQUIRED', () => {
    const db = getDb();
    const standardSchedule = makeWeeklySchedule(
      [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      465
    );
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '標準フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(standardSchedule);

    // 2026-09-20 is Sunday (off day 0)
    const res = resolveAuthoritativeWorkSchedule(1, '2026-09-20');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.isWorkDay, false);
    assert.strictEqual(res.dutyStatus, 'NO_WORK_REQUIRED');
    assert.strictEqual(res.scheduledWorkMinutes, 0);
    assert.deepStrictEqual(res.effectiveIntervals, []);
  });

  // GT-DWS-07: 年休・時間休のインターバル重複計算 (休憩時間を跨ぐ場合の正確な控除)
  it('GT-DWS-07: 休憩時間を跨ぐ時間休申請の重複時間計算 (12:00-13:00 -> 実働30分のみ重複)', () => {
    // Effective work intervals: 08:10-12:00 (490-720), 12:45-16:40 (765-1000)
    // Break time: 12:00-12:45 (720-765)
    // Leave time: 11:30 - 13:00 (690 - 780)
    // Overlap with 1st interval (490-720): max(690,490) to min(780,720) = 690 to 720 = 30分
    // Overlap with 2nd interval (765-1000): max(690,765) to min(780,1000) = 765 to 780 = 15分
    // Total intersection = 45分 (12:00〜12:45の45分休憩は自動的に除外)
    const schedule = {
      isWorkDay: true,
      schedule: {
        intervals: [
          { startTime: '08:10', endTime: '12:00' },
          { startTime: '12:45', endTime: '16:40' },
        ],
      },
    };

    const mins = calculateWorkIntersectionMinutes('11:30', '13:00', schedule);
    assert.strictEqual(mins, 45);
  });

  // GT-DWS-08: 非勤務日に対する WORK_REQUIRED 指定で overrideJson 欠落時は Fail-Closed
  it('GT-DWS-08: 非勤務日へのWORK_REQUIRED指定で個別日課欠落時は Fail-Closed', () => {
    const db = getDb();
    const standardSchedule = makeWeeklySchedule(
      [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      465
    );
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '標準フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(standardSchedule);

    // 2026-09-20 is Sunday. calendar_adjustments sets SINGLE_WORKDAY_OVERRIDE with NO schedule_override_json
    db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, event_name, reason,
        schedule_override_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        'CAL_ADJ_GT08', 'ALL', NULL, 'SINGLE_WORKDAY_OVERRIDE', 'SCHOOL_EVENT',
        '2026-09-20', 'WORK_REQUIRED', '運動会', '学校行事',
        NULL, 1, datetime('now'), datetime('now')
      )
    `).run();

    const obligation = WorkingObligationResolver.resolve(1, '2026-09-20');
    assert.strictEqual(obligation.status, 'UNRESOLVED');
    assert.strictEqual(obligation.isFailClosed, true);
    assert.match(obligation.failReason || '', /INV-DWS-WORK-REQUIRED Fail-Closed/);
  });

  // Helper to invoke adminRouter for work-patterns persistence boundary
  async function invokeAdminWorkPatternApi(params: {
    method: 'POST' | 'PUT';
    userId: number;
    patternId?: number;
    body: any;
  }): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = params.method === 'POST'
        ? `/users/${params.userId}/work-patterns`
        : `/users/${params.userId}/work-patterns/${params.patternId}`;

      const req: any = {
        method: params.method,
        url,
        params: params.method === 'POST' ? { id: String(params.userId) } : { id: String(params.userId), patternId: String(params.patternId) },
        body: params.body,
        session: {
          user: {
            id: 6,
            username: 'admin',
            displayName: '管理者',
            department: 'ICT情報管理室',
            roles: ['ADMIN'],
          },
        },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      };

      const res: any = {
        _status: 200,
        status(code: number) {
          this._status = code;
          return this;
        },
        json(body: any) {
          resolve({ status: this._status, body });
        },
      };

      adminRouter.handle(req, res, (err: any) => {
        if (err) reject(err);
        else reject(new Error('Admin route did not handle request'));
      });
    });
  }

  // GT-DWS-09: Admin API 不変条件 - 週間合計分数が合致する場合は正常登録 (Persistence Boundary PROVEN)
  it('GT-DWS-09: 週間合計分数の整合性検証 - 合致時は正常永続化されること (INV-DWS-WEEKLY-SUM Match)', async () => {
    const db = getDb();
    const targetUserId = 1;

    const beforeCount = (db.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns WHERE user_id = ?').get(targetUserId) as any).cnt;

    const scheduleDetails: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      if (d === 0 || d === 6) {
        scheduleDetails[String(d)] = { isWorkDay: false };
      } else {
        scheduleDetails[String(d)] = {
          isWorkDay: true,
          workIntervals: [
            { start: 490, end: 720 },  // 230分
            { start: 765, end: 1000 }, // 235分 (日計465分)
          ],
        };
      }
    }

    // 465 * 5 = 2325 分。クライアント指定と一致。
    const postRes = await invokeAdminWorkPatternApi({
      method: 'POST',
      userId: targetUserId,
      body: {
        patternName: '整合フルタイム',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'INDIVIDUAL',
        effectiveFrom: '2026-04-01',
        effectiveTo: '2027-03-31',
        weeklyOffDays: [0, 6],
        weeklyTotalMinutes: 2325,
        scheduleDetails,
        statutoryPatternCode: 'CST_01',
      },
    });

    // 1. HTTP Status & Response
    assert.strictEqual(postRes.status, 201, 'HTTP 201 Created であること');
    assert.strictEqual(postRes.body.success, true, 'success: true であること');
    assert.ok(postRes.body.patternId > 0, '新パターンのIDが返却されること');

    // 2. DB Row Count
    const afterCount = (db.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns WHERE user_id = ?').get(targetUserId) as any).cnt;
    assert.strictEqual(afterCount, beforeCount + 1, 'レコードが正確に1件増加していること');

    // 3. Persisted Row Integrity
    const created = db.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(postRes.body.patternId) as any;
    assert.strictEqual(created.weekly_total_minutes, 2325, 'weekly_total_minutes が 2325 で永続化されていること');
    assert.strictEqual(created.statutory_pattern_code, 'CST_01', 'statutory_pattern_code が永続化されていること');

    const parsedJson = JSON.parse(created.schedule_details_json);
    assert.strictEqual(parsedJson['1'].workMinutes, 465, '月曜日の workMinutes が 465 であること');
    assert.strictEqual(parsedJson['1'].startTime, '08:10');
    assert.strictEqual(parsedJson['1'].endTime, '16:40');
    assert.strictEqual(parsedJson['0'].isWorkDay, false);
  });

  // GT-DWS-10: Admin API 不変条件 - 週間合計分数が不一致の場合は登録拒否 (POST & PUT Mismatch Fail-Closed, Zero Persistence PROVEN)
  it('GT-DWS-10: 週間合計不一致時の不変条件検証 (INV-DWS-WEEKLY-SUM POST/PUT Mismatch -> HTTP 400 + Zero Persistence)', async () => {
    const db = getDb();
    const targetUserId = 2;

    const baseScheduleDetails: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      if (d === 0 || d === 6) {
        baseScheduleDetails[String(d)] = { isWorkDay: false };
      } else {
        baseScheduleDetails[String(d)] = {
          isWorkDay: true,
          workIntervals: [
            { start: 490, end: 720 },
            { start: 765, end: 1000 },
          ],
        };
      }
    }

    // 事前レコード準備 (既存レコード1件作成)
    const initRes = await invokeAdminWorkPatternApi({
      method: 'POST',
      userId: targetUserId,
      body: {
        patternName: '基準パターン',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'INDIVIDUAL',
        effectiveFrom: '2026-04-01',
        effectiveTo: '2026-09-30',
        weeklyOffDays: [0, 6],
        weeklyTotalMinutes: 2325,
        scheduleDetails: baseScheduleDetails,
      },
    });
    assert.strictEqual(initRes.status, 201);
    const existingPatternId = initRes.body.patternId;

    // 既存行のスナップショット保存
    const snapshotBefore = db.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingPatternId) as any;
    const countBefore = (db.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns').get() as any).cnt;

    // ==========================================
    // Subcase 1: POST 不一致 (新規登録での不整合拒絶)
    // ==========================================
    const scheduleDetails: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      if (d === 0 || d === 6) {
        scheduleDetails[String(d)] = { isWorkDay: false };
      } else {
        scheduleDetails[String(d)] = {
          isWorkDay: true,
          workIntervals: [
            { start: 490, end: 720 },  // 230分
            { start: 765, end: 1000 }, // 235分 (日計465分)
          ],
        };
      }
    }

    // 計算値は 2325分 だが、クライアントが 2000分 を送信 (Mismatch)
    const postMismatchRes = await invokeAdminWorkPatternApi({
      method: 'POST',
      userId: targetUserId,
      body: {
        patternName: '不正週合計POST',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'INDIVIDUAL',
        effectiveFrom: '2026-10-01',
        effectiveTo: '2027-03-31',
        weeklyOffDays: [0, 6],
        weeklyTotalMinutes: 2000, // mismatch!
        scheduleDetails,
      },
    });

    // 1. HTTP 400 & エラーコード検証
    assert.strictEqual(postMismatchRes.status, 400, 'POST不一致で HTTP 400 が返却されること');
    assert.strictEqual(postMismatchRes.body.errorCode, 'INVALID_WEEKLY_TOTAL_MINUTES', 'errorCode が INVALID_WEEKLY_TOTAL_MINUTES であること');
    assert.match(postMismatchRes.body.message, /INV-DWS-WEEKLY-SUM 違反/);
    assert.strictEqual(postMismatchRes.body.expected, 2325);
    assert.strictEqual(postMismatchRes.body.supplied, 2000);

    // 2. Zero INSERT 検証 (行数変化ゼロ)
    const countAfterPost = (db.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns').get() as any).cnt;
    assert.strictEqual(countAfterPost, countBefore, 'POST拒絶後にテーブル総行数が一切変化していないこと (Zero INSERT)');

    // 3. 既存行不変検証
    const snapshotAfterPost = db.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingPatternId) as any;
    assert.deepStrictEqual(snapshotAfterPost, snapshotBefore, '既存レコードが何一つ改変されていないこと');

    // ==========================================
    // Subcase 2: PUT 不一致 (更新での不整合拒絶 & Zero UPDATE)
    // ==========================================
    const putMismatchRes = await invokeAdminWorkPatternApi({
      method: 'PUT',
      userId: targetUserId,
      patternId: existingPatternId,
      body: {
        patternName: '更新試行パターン',
        patternType: 'STANDARD_FULLTIME',
        effectiveFrom: '2026-04-01',
        effectiveTo: '2026-09-30',
        weeklyOffDays: [0, 6],
        weeklyTotalMinutes: 1500, // mismatch!
        scheduleDetails,
      },
    });

    // 1. HTTP 400 & エラーコード検証
    assert.strictEqual(putMismatchRes.status, 400, 'PUT不一致で HTTP 400 が返却されること');
    assert.strictEqual(putMismatchRes.body.errorCode, 'INVALID_WEEKLY_TOTAL_MINUTES', 'errorCode が INVALID_WEEKLY_TOTAL_MINUTES であること');
    assert.match(putMismatchRes.body.message, /INV-DWS-WEEKLY-SUM 違反/);

    // 2. Zero UPDATE 検証 (既存行不変)
    const snapshotAfterPut = db.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingPatternId) as any;
    assert.deepStrictEqual(snapshotAfterPut, snapshotBefore, 'PUT拒絶後も既存レコードが完全不変であること (Zero UPDATE)');
    assert.strictEqual(snapshotAfterPut.pattern_name, '基準パターン', 'パターン名が更新されていないこと');
    assert.strictEqual(snapshotAfterPut.weekly_total_minutes, 2325, 'weekly_total_minutes が更新されていないこと');
  });

  // GT-DWS-11: 病気休暇サービス (sickLeaveService) の SSOT 収束検証
  it('GT-DWS-11: sickLeaveService が resolveAuthoritativeWorkSchedule を通じて正しく計算すること', () => {
    const db = getDb();
    const standardSchedule = makeWeeklySchedule(
      [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      465
    );
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '標準フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(standardSchedule);

    const userCtx = {
      id: 1,
      username: 'teacher1',
      displayName: '教員 太郎',
      roles: ['TEACHER'],
      ipAddress: '127.0.0.1',
    };

    // 2026-09-15 is Tuesday. Sick leave: 09:00 to 11:00 (120 min)
    const res = SickLeaveService.applySickLeave(userCtx, {
      targetDate: '2026-09-15',
      durationType: 'TIME',
      startAt: '09:00',
      endAt: '11:00',
      reason: '発熱のため診察',
    });

    assert.strictEqual(res.calculatedMinutes, 120);
    assert.match(res.id, /^SICK_1_/);
  });

  // GT-DWS-12: start >= end のインターバルはバリデーション拒絶 (Fail-Closed)
  it('GT-DWS-12: start >= end の不正インターバルは拒絶されること', () => {
    const invalid1 = [{ start: 500, end: 500 }];
    const val1 = validateWorkIntervals(invalid1);
    assert.strictEqual(val1.isValid, false);
    assert.match(val1.error || '', /start \(\d+\) >= end \(\d+\)/);

    const invalid2 = [{ start: 600, end: 500 }];
    const val2 = validateWorkIntervals(invalid2);
    assert.strictEqual(val2.isValid, false);
    assert.match(val2.error || '', /start \(\d+\) >= end \(\d+\)/);
  });

  // GT-DWS-13: 重複するインターバルはバリデーション拒絶 (Fail-Closed)
  it('GT-DWS-13: 前の区間と重複するインターバルは拒絶されること', () => {
    const overlapping = [
      { start: 500, end: 700 },
      { start: 650, end: 800 },
    ];
    const val = validateWorkIntervals(overlapping);
    assert.strictEqual(val.isValid, false);
    assert.match(val.error || '', /Overlapping intervals detected/);
  });

  // GT-DWS-14: 日課詳細の往復等価性 (JSON文字列化・パースでインターバルと休憩が完全に保存されること)
  it('GT-DWS-14: schedule_details_json の往復等価性検証', () => {
    const originalIntervals = [
      { start: 510, end: 720 },
      { start: 765, end: 900 },
    ];
    const { breakIntervals, breakMinutes } = deriveBreakIntervals(originalIntervals);
    assert.strictEqual(breakMinutes, 45);
    assert.deepStrictEqual(breakIntervals, [{ start: 720, end: 765 }]);

    const jsonStr = JSON.stringify({
      isWorkDay: true,
      workMinutes: 345,
      intervals: originalIntervals.map((inv) => ({
        startTime: minutesToTime(inv.start),
        endTime: minutesToTime(inv.end),
      })),
    });

    const parsed = JSON.parse(jsonStr);
    const restoredIntervals = parsed.intervals.map((inv: any) => ({
      start: timeToMinutes(inv.startTime),
      end: timeToMinutes(inv.endTime),
    }));

    assert.deepStrictEqual(restoredIntervals, originalIntervals);
  });

  // GT-DWS-15: statutory_pattern_code の正規性・制約・リゾルバ独立性
  it('GT-DWS-15: statutory_pattern_code のCHECK制約とリゾルバでの独立性検証', () => {
    const db = getDb();
    const validSchedule = makeWeeklySchedule(
      [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      465
    );

    // 正常値 CST_01 〜 CST_04 及び NULL が許容されること (user_id=2 を使用)
    const allowedCodes = ['CST_01', 'CST_02', 'CST_03', 'CST_04', null];
    for (const code of allowedCodes) {
      db.prepare('DELETE FROM user_work_patterns WHERE user_id = 2').run();
      db.prepare(`
        INSERT INTO user_work_patterns (
          user_id, pattern_name, pattern_type, statutory_pattern_code,
          effective_from, effective_to, weekly_off_days, schedule_details_json,
          weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
        ) VALUES (2, 'テストパターン', 'SHORT_TIME', ?, '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
      `).run(code, validSchedule);

      const res = resolveAuthoritativeWorkSchedule(2, '2026-09-15');
      assert.strictEqual(res.statutoryPatternCode, code);
    }

    // 不正値（例: INVALID_CODE）は SQLite CHECK 制約で拒絶されること
    assert.throws(() => {
      db.prepare(`
        INSERT INTO user_work_patterns (
          user_id, pattern_name, pattern_type, statutory_pattern_code,
          effective_from, effective_to, weekly_off_days, schedule_details_json,
          weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
        ) VALUES (2, '不正コード', 'SHORT_TIME', 'INVALID_CODE', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
      `).run(validSchedule);
    }, /CHECK constraint failed/);
  });
});
