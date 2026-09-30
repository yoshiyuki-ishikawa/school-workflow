import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Socket } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { getDb, setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import attendanceRouter from '../routes/attendance';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';

describe('Wave 3D Golden Tests: Date Override Production Configuration Path (GT-W3D-01〜12)', () => {
  let testDb: any;
  let originalDb: any;
  let app: express.Express;
  let adminId: number;
  let teacherId: number;
  let vpId: number;

  function callApi(method: string, path: string, body?: any, userMock?: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const req = new http.IncomingMessage(socket);
      const bodyStr = body !== undefined ? JSON.stringify(body) : '';
      req.method = method;
      req.url = path;
      req.headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(bodyStr)),
      };

      const res = new http.ServerResponse(req);
      let out = '';
      res.write = (chunk: any) => {
        out += chunk;
        return true;
      };
      res.end = (chunk: any) => {
        if (chunk) out += chunk;
        let parsedBody: any = null;
        try {
          parsedBody = out ? JSON.parse(out) : null;
        } catch {
          parsedBody = out;
        }
        resolve({ status: res.statusCode, body: parsedBody });
      };

      const activeUser = userMock || {
        id: adminId,
        username: 'admin',
        displayName: 'システム管理者E',
        roles: ['ADMIN'],
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      };

      (req as any).user = activeUser;
      (req as any).session = {
        user: activeUser,
        destroy: (cb?: any) => { if (cb) cb(); },
      };

      app(req as any, res as any);
      if (bodyStr) {
        req.push(bodyStr);
      }
      req.push(null);
    });
  }

  function makeScheduleDetailsJson(intervals: Array<{ startTime: string; endTime: string }>, dailyMinutes: number): string {
    const details: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      if (d === 0 || d === 6) {
        details[String(d)] = { isWorkDay: false, workMinutes: 0, intervals: [], workIntervals: [] };
      } else {
        details[String(d)] = {
          isWorkDay: true,
          workMinutes: dailyMinutes,
          startTime: intervals[0].startTime,
          endTime: intervals[intervals.length - 1].endTime,
          intervals,
          workIntervals: intervals.map((inv) => {
            const [sh, sm] = inv.startTime.split(':').map(Number);
            const [eh, em] = inv.endTime.split(':').map(Number);
            return { start: sh * 60 + sm, end: eh * 60 + em };
          }),
        };
      }
    }
    return JSON.stringify(details);
  }

  before(() => {
    originalDb = getDb();
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    setDb(testDb);

    testDb.exec(SCHEMA_SQL);
    migrator.runMigrations(testDb);
    seedDatabase();

    const adminRow = testDb.prepare("SELECT id FROM users WHERE username = 'admin'").get() as any;
    adminId = adminRow.id;
    const teacherRow = testDb.prepare("SELECT id FROM users WHERE username = 'teacher1'").get() as any;
    teacherId = teacherRow.id;
    const vpRow = testDb.prepare("SELECT id FROM users WHERE username = 'vice_principal'").get() as any;
    vpId = vpRow.id;

    // Clean and setup School Work Schedule (08:10-12:15, 13:00-16:40 -> 465min)
    testDb.prepare('DELETE FROM school_work_schedules').run();
    const schoolSchedJson = makeScheduleDetailsJson([
      { startTime: '08:10', endTime: '12:15' }, // 245min
      { startTime: '13:00', endTime: '16:40' }, // 220min -> Total 465min
    ], 465);

    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (1, '学校標準日課 (465分)', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 1, ?, '2026-04-01', ?, '2026-04-01')
    `).run(schoolSchedJson, adminId, adminId);

    // Clean and ensure single deterministic work pattern per user (Avoid AMBIGUOUS_PATTERN)
    testDb.prepare('DELETE FROM user_work_patterns').run();
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '標準勤務パターン', 'STANDARD_FULLTIME', 'SCHOOL_DEFAULT', '2026-04-01', '9999-12-31', '0,6', NULL, 2325, 'ADMIN_CONFIGURED', ?, '2026-04-01', '2026-04-01')
    `).run(adminId, adminId);

    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '教頭標準勤務パターン', 'STANDARD_FULLTIME', 'SCHOOL_DEFAULT', '2026-04-01', '9999-12-31', '0,6', NULL, 2325, 'ADMIN_CONFIGURED', ?, '2026-04-01', '2026-04-01')
    `).run(vpId, adminId);

    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '教諭標準勤務パターン', 'STANDARD_FULLTIME', 'SCHOOL_DEFAULT', '2026-04-01', '9999-12-31', '0,6', NULL, 2325, 'ADMIN_CONFIGURED', ?, '2026-04-01', '2026-04-01')
    `).run(teacherId, adminId);

    app = express();
    app.use(express.json());
    app.use('/api/attendance', attendanceRouter);
  });

  after(() => {
    setDb(originalDb);
    if (testDb) {
      testDb.close();
    }
  });

  // GT-W3D-01: ALL scope Date Override registration
  it('GT-W3D-01: ALL scope Date Override registration persists Canonical workIntervals', async () => {
    const res = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-05',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '全校運動会準備 (全校短縮日課)',
      reason: '運動会準備に伴う特別日課設定',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:30',
        breakIntervals: [
          { startTime: '12:00', endTime: '12:45' },
        ],
      },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    // Verify DB persistence of schedule_override_json
    const row = testDb.prepare(`
      SELECT * FROM calendar_adjustments
      WHERE source_date = '2026-10-05' AND status = 'ACTIVE'
    `).get() as any;

    assert.ok(row);
    assert.ok(row.schedule_override_json);
    const parsed = JSON.parse(row.schedule_override_json);
    assert.deepStrictEqual(parsed.workIntervals, [
      { start: 480, end: 720 },
      { start: 765, end: 990 },
    ]);
    assert.strictEqual(parsed.totalWorkMinutes, 465);

    // Verify WorkingObligationResolver consumes it
    const resolved = WorkingObligationResolver.resolve(adminId, '2026-10-05');
    assert.strictEqual(resolved.status, 'WORKING');
    assert.strictEqual(resolved.isWorkDay, true);
    assert.strictEqual(resolved.workSchedule?.scheduledWorkMinutes, 465);
    assert.strictEqual(resolved.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');
    assert.deepStrictEqual(resolved.workSchedule?.effectiveIntervals, [
      { start: 480, end: 720 },
      { start: 765, end: 990 },
    ]);
  });

  // GT-W3D-02: USER scope Date Override isolation
  it('GT-W3D-02: USER scope Date Override applies only to targeted user', async () => {
    // Register individual override for adminId on 2026-10-06
    const res = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'USER',
      userId: adminId,
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'OFFICIAL_DUTY',
      sourceDate: '2026-10-06',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '校外引率特別日課',
      reason: '生徒引率業務に伴う時差出勤',
      scheduleOverride: {
        startTime: '07:30',
        endTime: '16:00',
        breakIntervals: [
          { startTime: '12:00', endTime: '12:45' },
        ],
      },
    });

    assert.strictEqual(res.status, 200);

    // Target user gets override
    const user1Res = WorkingObligationResolver.resolve(adminId, '2026-10-06');
    assert.strictEqual(user1Res.status, 'WORKING');
    assert.strictEqual(user1Res.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');
    assert.deepStrictEqual(user1Res.workSchedule?.effectiveIntervals, [
      { start: 450, end: 720 },
      { start: 765, end: 960 },
    ]);

    // Another user (vpId) does NOT get override, remains base schedule
    const user2Res = WorkingObligationResolver.resolve(vpId, '2026-10-06');
    assert.notStrictEqual(user2Res.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(user2Res.sourceType, 'WORKING_PATTERN');
  });

  // GT-W3D-03: Break 1 interval -> Canonical workIntervals projection
  it('GT-W3D-03: Break 1 interval projects into canonical 2 workIntervals', async () => {
    const res = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-07',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '標準休憩日課',
      reason: '標準休憩プロジェクション検証',
      scheduleOverride: {
        startTime: '08:10',
        endTime: '16:40',
        breakIntervals: [
          { startTime: '12:15', endTime: '13:00' },
        ],
      },
    });

    assert.strictEqual(res.status, 200);

    const row = testDb.prepare("SELECT schedule_override_json FROM calendar_adjustments WHERE source_date = '2026-10-07'").get() as any;
    const parsed = JSON.parse(row.schedule_override_json);
    // 08:10(490) - 12:15(735) = 245min, 13:00(780) - 16:40(1000) = 220min -> Total 465min
    assert.deepStrictEqual(parsed.workIntervals, [
      { start: 490, end: 735 },
      { start: 780, end: 1000 },
    ]);
    assert.strictEqual(parsed.totalWorkMinutes, 465);
  });

  // GT-W3D-04: No break -> Single workInterval
  it('GT-W3D-04: No break projects into single continuous workInterval', async () => {
    const res = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-08',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '午前半日勤務日課 (休憩なし)',
      reason: '短縮業務',
      scheduleOverride: {
        startTime: '08:30',
        endTime: '12:30',
        breakIntervals: [],
      },
    });

    assert.strictEqual(res.status, 200);

    const row = testDb.prepare("SELECT schedule_override_json FROM calendar_adjustments WHERE source_date = '2026-10-08'").get() as any;
    const parsed = JSON.parse(row.schedule_override_json);
    // 08:30(510) - 12:30(750) = 240min
    assert.deepStrictEqual(parsed.workIntervals, [
      { start: 510, end: 750 },
    ]);
    assert.strictEqual(parsed.totalWorkMinutes, 240);
  });

  // GT-W3D-05: Invalid schedule / break -> 400 Fail-Closed
  it('GT-W3D-05: Malformed and invalid inputs return 400 Fail-Closed', async () => {
    // (a) start >= end
    const resA = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '不正時刻A',
      reason: 'テスト',
      scheduleOverride: { startTime: '17:00', endTime: '08:00' },
    });
    assert.strictEqual(resA.status, 400);

    // (b) break start >= break end
    const resB = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '不正時刻B',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:00',
        breakIntervals: [{ startTime: '13:00', endTime: '12:00' }],
      },
    });
    assert.strictEqual(resB.status, 400);

    // (c) break outside work time
    const resC = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '不正時刻C',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:00',
        breakIntervals: [{ startTime: '16:00', endTime: '17:00' }],
      },
    });
    assert.strictEqual(resC.status, 400);

    // (d) overlapping breaks
    const resD = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '不正時刻D',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '17:00',
        breakIntervals: [
          { startTime: '12:00', endTime: '13:00' },
          { startTime: '12:30', endTime: '13:30' },
        ],
      },
    });
    assert.strictEqual(resD.status, 400);

    // (e) workIntervals vanish completely
    const resE = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '不正時刻E',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '09:00',
        endTime: '12:00',
        breakIntervals: [{ startTime: '09:00', endTime: '12:00' }],
      },
    });
    assert.strictEqual(resE.status, 400);

    // (f) malformed HH:mm string
    const resF = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '不正時刻F',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '25:99',
        endTime: '17:00',
      },
    });
    assert.strictEqual(resF.status, 400);

    // (g) scheduleOverride on NO_WORK_REQUIRED
    const resG = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'DESIGNATED_NON_WORKDAY',
      reasonCode: 'SCHOOL_DESIGNATED_HOLIDAY',
      sourceDate: '2026-10-09',
      sourceDutyStatus: 'NO_WORK_REQUIRED',
      eventName: '不正指定G',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:00',
      },
    });
    assert.strictEqual(resG.status, 400);
  });

  // GT-W3D-06: Override Cancellation -> Canonical Base Schedule Reversion (Critical Dual-Case)
  it('GT-W3D-06: Override Cancellation reverts to Canonical Base Schedule (NOT fixed 465)', async () => {
    // --- Case A: INDIVIDUAL user (Part-time / Short-time user: 240 minutes base) ---
    const shortUser = testDb.prepare(`
      INSERT INTO users (username, password_hash, display_name, department, is_active, created_at)
      VALUES ('short_user', 'hash', '短時間 花子', '小学部', 1, datetime('now'))
    `).run();
    const shortUserId = Number(shortUser.lastInsertRowid);

    // Weekday: 2026-10-13 (Tuesday)
    const individualDetailsJson = JSON.stringify({
      1: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', workIntervals: [{ start: 510, end: 750 }] },
      2: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', workIntervals: [{ start: 510, end: 750 }] },
      3: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', workIntervals: [{ start: 510, end: 750 }] },
      4: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', workIntervals: [{ start: 510, end: 750 }] },
      5: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', workIntervals: [{ start: 510, end: 750 }] },
    });

    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '個別短時間240分', 'SHORT_TIME', 'INDIVIDUAL', '2026-04-01', '9999-12-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', ?, datetime('now'), datetime('now'))
    `).run(shortUserId, individualDetailsJson, adminId);

    // 1. Check baseline: resolves to 240 minutes on 2026-10-13 (Tuesday)
    const baseShort = WorkingObligationResolver.resolve(shortUserId, '2026-10-13');
    assert.strictEqual(baseShort.workSchedule?.scheduledWorkMinutes, 240);

    // 2. Register USER override for this user on 2026-10-13 to 300 minutes (08:30 - 13:30)
    const regResShort = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'USER',
      userId: shortUserId,
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'OFFICIAL_DUTY',
      sourceDate: '2026-10-13',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '短縮延長日課',
      reason: '行事のため一時延長',
      scheduleOverride: {
        startTime: '08:30',
        endTime: '13:30',
        breakIntervals: [],
      },
    });
    assert.strictEqual(regResShort.status, 200);

    // Verify override is active: 300 minutes
    const overShort = WorkingObligationResolver.resolve(shortUserId, '2026-10-13');
    assert.strictEqual(overShort.workSchedule?.scheduledWorkMinutes, 300);
    assert.strictEqual(overShort.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');

    // 3. Cancel the override
    const adjShortRow = testDb.prepare("SELECT id FROM calendar_adjustments WHERE user_id = ? AND source_date = '2026-10-13'").get(shortUserId) as any;
    const cancelResShort = await callApi('POST', `/api/attendance/calendar-adjustments/${adjShortRow.id}/cancel`, {
      cancelReason: '行事中止に伴う解除',
    });
    assert.strictEqual(cancelResShort.status, 200);

    // 4. CRITICAL REVERSION VERIFICATION:
    // Must revert to INDIVIDUAL base schedule of 240 minutes, NOT 465 minutes!
    const revertedShort = WorkingObligationResolver.resolve(shortUserId, '2026-10-13');
    assert.strictEqual(revertedShort.workSchedule?.scheduledWorkMinutes, 240, '短時間職員の解除後は固定465分ではなく個別パターンの240分に復帰すること');
    assert.strictEqual(revertedShort.workSchedule?.scheduleSource, 'INDIVIDUAL');
    assert.notStrictEqual(revertedShort.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');

    // --- Case B: SCHOOL_DEFAULT user (Full-time: 465 minutes base) ---
    // User adminId uses school default schedule (465 min on 2026-10-14 Wednesday)
    const baseDefault = WorkingObligationResolver.resolve(adminId, '2026-10-14');
    assert.strictEqual(baseDefault.workSchedule?.scheduledWorkMinutes, 465);
    assert.strictEqual(baseDefault.workSchedule?.scheduleSource, 'SCHOOL_DEFAULT');

    // 1. Register override for adminId on 2026-10-14 to 360 minutes (08:30 - 15:00, break 12:00-12:30 -> 360min)
    const regResDef = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'USER',
      userId: adminId,
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-14',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '特別短縮日課',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:30',
        endTime: '15:00',
        breakIntervals: [{ startTime: '12:00', endTime: '12:30' }],
      },
    });
    assert.strictEqual(regResDef.status, 200);

    const overDef = WorkingObligationResolver.resolve(adminId, '2026-10-14');
    assert.strictEqual(overDef.workSchedule?.scheduledWorkMinutes, 360);

    // 2. Cancel the override
    const adjDefRow = testDb.prepare("SELECT id FROM calendar_adjustments WHERE user_id = ? AND source_date = '2026-10-14'").get(adminId) as any;
    const cancelResDef = await callApi('POST', `/api/attendance/calendar-adjustments/${adjDefRow.id}/cancel`, {
      cancelReason: '解除テスト',
    });
    assert.strictEqual(cancelResDef.status, 200);

    // 3. Reverts to SCHOOL_DEFAULT (465 min)
    const revertedDef = WorkingObligationResolver.resolve(adminId, '2026-10-14');
    assert.strictEqual(revertedDef.workSchedule?.scheduledWorkMinutes, 465);
    assert.strictEqual(revertedDef.workSchedule?.scheduleSource, 'SCHOOL_DEFAULT');
  });

  // GT-W3D-07: Existing attendance consumer follows override schedule
  it('GT-W3D-07: Existing attendance & leave consumer follows override schedule', async () => {
    // Register override on 2026-10-21 (Wednesday, 08:30 - 12:30, 240min, no break)
    const res = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'USER',
      userId: adminId,
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-21',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '午前短縮日課',
      reason: '既存コンシューマー連携検証',
      scheduleOverride: {
        startTime: '08:30',
        endTime: '12:30',
        breakIntervals: [],
      },
    });
    assert.strictEqual(res.status, 200);

    // 1. WorkingObligationResolver 直接検証 (オーバーライド日課が解決される)
    const directRes = WorkingObligationResolver.resolve(adminId, '2026-10-21');
    assert.strictEqual(directRes.status, 'WORKING');
    assert.strictEqual(directRes.workSchedule?.scheduledWorkMinutes, 240);
    assert.strictEqual(directRes.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');

    // 2. 既存の年休計算コンシューマー (LeaveCalculationService) 検証
    // 休暇計算サービスがオーバーライド日課の 240 分を所定勤務時間として参照すること
    const leaveCalc = LeaveCalculationService.calculate({
      subjectUserId: adminId,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-10-21',
      unitType: 'DAY',
    });
    assert.strictEqual(leaveCalc.isValid, true);
    assert.strictEqual(leaveCalc.chargeableDaysCount, 1);
    assert.strictEqual(leaveCalc.perDayResults[0].scheduledWorkMinutes, 240, 'LeaveCalculationService がオーバーライド日課の240分を正確に参照すること');
    assert.strictEqual(leaveCalc.totalChargedMinutes, 240);
  });

  // GT-W3D-08: Existing duplicate-prevention contract remains intact
  it('GT-W3D-08: Duplicate active adjustment rejection remains intact', async () => {
    // 2026-10-15 has an active adjustment registered first
    const res1 = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-15',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '初回登録',
      reason: 'テスト',
    });
    assert.strictEqual(res1.status, 200);

    // Attempt duplicate registration on same date and scope
    const res2 = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-15',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '重複登録試行',
      reason: 'テスト',
    });
    assert.strictEqual(res2.status, 400);
    assert.match(res2.body.message, /既に有効な調整/);
  });

  // GT-W3D-09: Unmodified dates / existing historical data remain unaffected
  it('GT-W3D-09: Unmodified dates remain strictly unaffected on base schedules', async () => {
    // 2026-10-16 (Friday) has an override registered
    await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-16',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '金曜オーバーライド',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:00',
        breakIntervals: [{ startTime: '12:00', endTime: '12:45' }],
      },
    });

    // Verify 2026-10-19 (the following Monday) is NOT affected
    const mondayRes = WorkingObligationResolver.resolve(adminId, '2026-10-19');
    assert.strictEqual(mondayRes.workSchedule?.scheduledWorkMinutes, 465);
    assert.strictEqual(mondayRes.workSchedule?.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(mondayRes.sourceType, 'WORKING_PATTERN');
    assert.strictEqual(mondayRes.workSchedule?.overrideSource, undefined);
  });

  // GT-W3D-10: RBAC Boundary
  it('GT-W3D-10: RBAC Boundary strictly enforced by requirePermission(calendar.manage)', async () => {
    // (a) User without calendar.manage (teacher1)
    const teacherDbUser = testDb.prepare('SELECT * FROM users WHERE id = ?').get(teacherId) as any;
    const teacherUser = {
      id: teacherDbUser.id,
      username: teacherDbUser.username,
      displayName: teacherDbUser.display_name,
      roles: ['TEACHER'],
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    };

    const resForbidden = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-22',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '一般教員による登録試行',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:00',
      },
    }, teacherUser);

    assert.strictEqual(resForbidden.status, 403);
    assert.strictEqual(resForbidden.body.success, false);

    // Cancel without permission is also 403
    const resCancelForbidden = await callApi('POST', '/api/attendance/calendar-adjustments/1/cancel', {
      cancelReason: '試行',
    }, teacherUser);
    assert.strictEqual(resCancelForbidden.status, 403);

    // (b) User with calendar.manage (vice_principal)
    const vpDbUser = testDb.prepare('SELECT * FROM users WHERE id = ?').get(vpId) as any;
    const vpUser = {
      id: vpDbUser.id,
      username: vpDbUser.username,
      displayName: vpDbUser.display_name,
      roles: ['VICE_PRINCIPAL'],
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    };

    const resAllowed = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: '2026-10-22',
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '教頭による登録',
      reason: 'テスト',
      scheduleOverride: {
        startTime: '08:00',
        endTime: '16:00',
        breakIntervals: [{ startTime: '12:00', endTime: '12:45' }],
      },
    }, vpUser);

    assert.strictEqual(resAllowed.status, 200);
    assert.strictEqual(resAllowed.body.success, true);
  });

  // GT-W3D-11: Cancellation Reversion — INDIVIDUAL
  it('GT-W3D-11: Cancellation Reversion — INDIVIDUAL (INV-W3D-CANCEL-01: Reverts to Individual 240min, NOT fixed 465)', async () => {
    // 1. Setup INDIVIDUAL user with 240-minute canonical work schedule (08:30-12:30)
    const userRow = testDb.prepare(`
      INSERT INTO users (username, password_hash, display_name, department, is_active, created_at)
      VALUES ('indiv_reversion_user', 'hash', '非常勤 個別花子', '小学部', 1, datetime('now'))
    `).run();
    const indivUserId = Number(userRow.lastInsertRowid);

    const individualDetailsJson = JSON.stringify({
      1: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', intervals: [{ startTime: '08:30', endTime: '12:30' }], workIntervals: [{ start: 510, end: 750 }] },
      2: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', intervals: [{ startTime: '08:30', endTime: '12:30' }], workIntervals: [{ start: 510, end: 750 }] },
      3: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', intervals: [{ startTime: '08:30', endTime: '12:30' }], workIntervals: [{ start: 510, end: 750 }] },
      4: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', intervals: [{ startTime: '08:30', endTime: '12:30' }], workIntervals: [{ start: 510, end: 750 }] },
      5: { isWorkDay: true, workMinutes: 240, startTime: '08:30', endTime: '12:30', intervals: [{ startTime: '08:30', endTime: '12:30' }], workIntervals: [{ start: 510, end: 750 }] },
    });

    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '個別短時間240分パターン', 'SHORT_TIME', 'INDIVIDUAL', '2026-04-01', '9999-12-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', ?, datetime('now'), datetime('now'))
    `).run(indivUserId, individualDetailsJson, adminId);

    // Target Date: 2026-10-27 (Tuesday, Weekday)
    const targetDate = '2026-10-27';

    // 2. Initial state verification: Resolves to 240-minute INDIVIDUAL pattern
    const initialResolved = WorkingObligationResolver.resolve(indivUserId, targetDate);
    assert.strictEqual(initialResolved.status, 'WORKING');
    assert.strictEqual(initialResolved.sourceType, 'WORKING_PATTERN');
    assert.strictEqual(initialResolved.workSchedule?.scheduleSource, 'INDIVIDUAL');
    assert.strictEqual(initialResolved.workSchedule?.scheduledWorkMinutes, 240);
    assert.deepStrictEqual(initialResolved.workSchedule?.effectiveIntervals, [{ start: 510, end: 750 }]);

    // 3. Register Date Override: 09:00-15:00 with 12:00-13:00 break (300 minutes total)
    const regRes = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'USER',
      userId: indivUserId,
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'OFFICIAL_DUTY',
      sourceDate: targetDate,
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '研修引率特別日課',
      reason: '終日研修引率業務に伴う時差出勤',
      scheduleOverride: {
        startTime: '09:00',
        endTime: '15:00',
        breakIntervals: [{ startTime: '12:00', endTime: '13:00' }],
      },
    });
    assert.strictEqual(regRes.status, 200);
    assert.strictEqual(regRes.body.success, true);

    // 4. Before Cancel verification: Override ACTIVE in DB and selected by Resolver
    const adjRow = testDb.prepare(`
      SELECT * FROM calendar_adjustments WHERE user_id = ? AND source_date = ?
    `).get(indivUserId, targetDate) as any;
    assert.ok(adjRow);
    assert.strictEqual(adjRow.status, 'ACTIVE');

    const beforeCancelResolved = WorkingObligationResolver.resolve(indivUserId, targetDate);
    assert.strictEqual(beforeCancelResolved.status, 'WORKING');
    assert.strictEqual(beforeCancelResolved.sourceType, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(beforeCancelResolved.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(beforeCancelResolved.workSchedule?.scheduledWorkMinutes, 300);
    assert.deepStrictEqual(beforeCancelResolved.workSchedule?.effectiveIntervals, [
      { start: 540, end: 720 },
      { start: 780, end: 900 },
    ]);

    // 5. Cancel API execution
    const cancelRes = await callApi('POST', `/api/attendance/calendar-adjustments/${adjRow.id}/cancel`, {
      cancelReason: '引率業務中止に伴う日課解除',
    });
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.body.success, true);

    // 6. DB status verification: Logical cancellation to 'CANCELLED'
    const cancelledRow = testDb.prepare(`
      SELECT * FROM calendar_adjustments WHERE id = ?
    `).get(adjRow.id) as any;
    assert.strictEqual(cancelledRow.status, 'CANCELLED');
    assert.strictEqual(cancelledRow.cancel_reason, '引率業務中止に伴う日課解除');
    assert.strictEqual(cancelledRow.cancelled_by_user_id, adminId);

    // 7. After Cancel verification: Resolver excludes cancelled override and reverts to Canonical INDIVIDUAL
    const afterCancelResolved = WorkingObligationResolver.resolve(indivUserId, targetDate);
    assert.strictEqual(afterCancelResolved.status, 'WORKING');
    assert.strictEqual(afterCancelResolved.isFailClosed, false);
    assert.strictEqual(afterCancelResolved.sourceType, 'WORKING_PATTERN');
    assert.strictEqual(afterCancelResolved.workSchedule?.overrideSource, undefined, 'Cancelled override must be excluded');
    assert.strictEqual(afterCancelResolved.workSchedule?.scheduleSource, 'INDIVIDUAL', 'Must revert to INDIVIDUAL');
    assert.strictEqual(afterCancelResolved.workSchedule?.scheduledWorkMinutes, 240, 'Must revert to canonical 240 minutes');
    assert.deepStrictEqual(afterCancelResolved.workSchedule?.effectiveIntervals, [{ start: 510, end: 750 }]);

    // 8. INV-W3D-CANCEL-01: Explicit Invariant Assert
    assert.notStrictEqual(
      afterCancelResolved.workSchedule?.scheduledWorkMinutes,
      465,
      'INV-W3D-CANCEL-01: Cancellation SHALL NOT restore a hardcoded 465-minute schedule'
    );
  });

  // GT-W3D-12: Cancellation Reversion — SCHOOL_DEFAULT
  it('GT-W3D-12: Cancellation Reversion — SCHOOL_DEFAULT (Reverts to Applicable School Default Schedule)', async () => {
    // 1. Setup user with SCHOOL_DEFAULT work pattern
    const defaultUser = testDb.prepare(`
      INSERT INTO users (username, password_hash, display_name, department, is_active, created_at)
      VALUES ('default_reversion_user', 'hash', '全校標準 太郎', '中学部', 1, datetime('now'))
    `).run();
    const defaultUserId = Number(defaultUser.lastInsertRowid);

    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, schedule_source,
        effective_from, effective_to, weekly_off_days, schedule_details_json,
        weekly_total_minutes, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (?, '全校標準パターン', 'STANDARD_FULLTIME', 'SCHOOL_DEFAULT', '2026-04-01', '9999-12-31', '0,6', NULL, 2325, 'ADMIN_CONFIGURED', ?, datetime('now'), datetime('now'))
    `).run(defaultUserId, adminId);

    // Target Date: 2026-10-28 (Wednesday, Weekday)
    const targetDate = '2026-10-28';

    // 2. Initial state verification: Resolves to School Default (465 minutes: 08:10-12:15, 13:00-16:40)
    const initialResolved = WorkingObligationResolver.resolve(defaultUserId, targetDate);
    assert.strictEqual(initialResolved.status, 'WORKING');
    assert.strictEqual(initialResolved.sourceType, 'WORKING_PATTERN');
    assert.strictEqual(initialResolved.workSchedule?.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(initialResolved.workSchedule?.scheduledWorkMinutes, 465);
    assert.deepStrictEqual(initialResolved.workSchedule?.effectiveIntervals, [
      { start: 490, end: 735 },
      { start: 780, end: 1000 },
    ]);

    // 3. Register School-wide Date Override: 08:30-14:30 with 12:00-12:45 break (315 minutes total)
    const regRes = await callApi('POST', '/api/attendance/calendar-adjustments', {
      scopeType: 'ALL',
      adjustmentType: 'SINGLE_WORKDAY_OVERRIDE',
      reasonCode: 'SCHOOL_EVENT',
      sourceDate: targetDate,
      sourceDutyStatus: 'WORK_REQUIRED',
      eventName: '合唱祭特別日課',
      reason: '合唱祭開催に伴う短縮日課',
      scheduleOverride: {
        startTime: '08:30',
        endTime: '14:30',
        breakIntervals: [{ startTime: '12:00', endTime: '12:45' }],
      },
    });
    assert.strictEqual(regRes.status, 200);
    assert.strictEqual(regRes.body.success, true);

    // 4. Before Cancel verification: Override ACTIVE in DB and selected by Resolver
    const adjRow = testDb.prepare(`
      SELECT * FROM calendar_adjustments WHERE scope_type = 'ALL' AND source_date = ? AND status = 'ACTIVE'
    `).get(targetDate) as any;
    assert.ok(adjRow);
    assert.strictEqual(adjRow.status, 'ACTIVE');

    const beforeCancelResolved = WorkingObligationResolver.resolve(defaultUserId, targetDate);
    assert.strictEqual(beforeCancelResolved.status, 'WORKING');
    assert.strictEqual(beforeCancelResolved.sourceType, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(beforeCancelResolved.workSchedule?.overrideSource, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(beforeCancelResolved.workSchedule?.scheduledWorkMinutes, 315);
    assert.deepStrictEqual(beforeCancelResolved.workSchedule?.effectiveIntervals, [
      { start: 510, end: 720 },
      { start: 765, end: 870 },
    ]);

    // 5. Cancel API execution
    const cancelRes = await callApi('POST', `/api/attendance/calendar-adjustments/${adjRow.id}/cancel`, {
      cancelReason: '合唱祭日程変更に伴う日課解除',
    });
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.body.success, true);

    // 6. DB status verification: Logical cancellation to 'CANCELLED'
    const cancelledRow = testDb.prepare(`
      SELECT * FROM calendar_adjustments WHERE id = ?
    `).get(adjRow.id) as any;
    assert.strictEqual(cancelledRow.status, 'CANCELLED');
    assert.strictEqual(cancelledRow.cancel_reason, '合唱祭日程変更に伴う日課解除');
    assert.strictEqual(cancelledRow.cancelled_by_user_id, adminId);

    // 7. After Cancel verification: Resolver excludes cancelled override and reverts to Applicable SCHOOL_DEFAULT
    const afterCancelResolved = WorkingObligationResolver.resolve(defaultUserId, targetDate);
    assert.strictEqual(afterCancelResolved.status, 'WORKING');
    assert.strictEqual(afterCancelResolved.isFailClosed, false);
    assert.strictEqual(afterCancelResolved.sourceType, 'WORKING_PATTERN');
    assert.strictEqual(afterCancelResolved.workSchedule?.overrideSource, undefined, 'Cancelled override must be excluded');
    assert.strictEqual(afterCancelResolved.workSchedule?.scheduleSource, 'SCHOOL_DEFAULT', 'Must revert to SCHOOL_DEFAULT');
    assert.strictEqual(afterCancelResolved.workSchedule?.scheduledWorkMinutes, 465, 'Must revert to School Default scheduled minutes');
    assert.deepStrictEqual(afterCancelResolved.workSchedule?.effectiveIntervals, [
      { start: 490, end: 735 },
      { start: 780, end: 1000 },
    ]);
  });
});
