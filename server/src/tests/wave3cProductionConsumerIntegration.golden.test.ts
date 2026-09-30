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
import adminRouter from '../routes/admin';
import applicationsRouter from '../routes/applications';
import { resolveAuthoritativeWorkSchedule } from '../services/attendance/workPatternResolver';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { projectLeaveLedgerPages } from '../services/reportProjectionService';
import { WorkflowEngine } from '../workflow/engine';

describe('Wave 3C Golden Tests: Production Consumer Integration & Canonical Calculation (GT-W3C-01〜08)', () => {
  let testDb: any;
  let originalDb: any;
  let app: express.Express;

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

      (req as any).user = userMock || {
        id: 1,
        username: 'admin',
        displayName: '管理者 太郎',
        roles: ['ADMIN'],
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      };
      (req as any).session = { user: (req as any).user };

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

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (!(req as any).session && (req as any).user) {
        (req as any).session = { user: (req as any).user };
      }
      next();
    });
    app.use('/api/admin', adminRouter);
    app.use('/api/applications', applicationsRouter);
  });

  after(() => {
    setDb(originalDb);
    testDb.close();
  });

  // GT-W3C-01: School Default → Runtime Resolution (DELTA-01 & DELTA-02 検証)
  it('GT-W3C-01: 新規教職員登録時に SCHOOL_DEFAULT が設定され、有効日課存在下で正常解決、日課未登録下で 400 遮断されること', async () => {
    const currentFiscalYear = new Date().getFullYear();
    const baseDate = `${currentFiscalYear}-04-01`;

    // 1. 有効な学校標準日課をセットアップ (8:15〜16:45, 465分)
    testDb.prepare('DELETE FROM school_work_schedules').run();
    const schedDetails = makeScheduleDetailsJson([
      { startTime: '08:15', endTime: '12:00' }, // 225分
      { startTime: '12:45', endTime: '16:45' }, // 240分 => 465分
    ], 465);

    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (1, '標準フルタイム日課', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 1, 1, '2026-04-01', 1, '2026-04-01')
    `).run(schedDetails);

    // 2. 新規教職員の作成 (POST /api/admin/users)
    const createRes = await callApi('POST', '/api/admin/users', {
      username: 'w3c_new_teacher',
      password: 'password123',
      displayName: '新任 太郎',
      department: '小学部',
      roles: ['TEACHER'],
    });

    assert.strictEqual(createRes.status, 201);
    const newUserId = createRes.body.data?.id || createRes.body.userId;
    assert.ok(newUserId);

    // 3. user_work_patterns の検証 (DELTA-01: schedule_source === 'SCHOOL_DEFAULT')
    const patternRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE user_id = ?').get(newUserId) as any;
    assert.ok(patternRow);
    assert.strictEqual(patternRow.schedule_source, 'SCHOOL_DEFAULT');
    assert.strictEqual(patternRow.schedule_details_json, null);
    assert.strictEqual(patternRow.weekly_total_minutes, 2325);

    // 4. Runtime Resolution の検証 (RESOLVED かつ 学校標準日課と一致)
    const resolved = resolveAuthoritativeWorkSchedule(newUserId, `${currentFiscalYear}-05-15`);
    assert.strictEqual(resolved.status, 'RESOLVED');
    assert.strictEqual(resolved.isWorkDay, true);
    assert.strictEqual(resolved.scheduledWorkMinutes, 465);
    assert.strictEqual(resolved.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(resolved.schoolScheduleId, 1);

    // 5. DELTA-02 検証: 学校標準日課を全削除した状態で新規登録を試みると 400 SCHOOL_DEFAULT_NOT_CONFIGURED となること
    testDb.prepare('DELETE FROM school_work_schedules').run();

    const failRes = await callApi('POST', '/api/admin/users', {
      username: 'w3c_fail_teacher',
      password: 'password123',
      displayName: '遮断 花子',
      department: '小学部',
      roles: ['TEACHER'],
    });

    assert.strictEqual(failRes.status, 400);
    assert.strictEqual(failRes.body.errorCode, 'SCHOOL_DEFAULT_NOT_CONFIGURED');

    // 6. Partial Mutation がないことの確認 (ユーザーも作成されていないこと)
    const orphanUser = testDb.prepare('SELECT * FROM users WHERE username = ?').get('w3c_fail_teacher');
    assert.strictEqual(orphanUser, undefined);
  });

  // GT-W3C-02: Effective-Date Boundary Resolution
  it('GT-W3C-02: 日課改定の境界日前後で旧日課・新日課が決定論的に解決されること', () => {
    testDb.prepare('DELETE FROM school_work_schedules').run();

    // 旧日課: 〜2026-09-30 (08:15〜16:45, 465分)
    const oldDetails = makeScheduleDetailsJson([
      { startTime: '08:15', endTime: '12:00' }, // 225分
      { startTime: '12:45', endTime: '16:45' }, // 240分 => 465分
    ], 465);
    // 新日課: 2026-10-01〜 (08:10〜16:40, 465分: 230分 + 235分)
    const newDetails = makeScheduleDetailsJson([
      { startTime: '08:10', endTime: '12:00' }, // 230分
      { startTime: '12:45', endTime: '16:40' }, // 235分 => 465分
    ], 465);

    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active,
        created_by_user_id, created_at, updated_by_user_id, updated_at
      )
      VALUES 
        (10, '旧日課', '2026-04-01', '2026-09-30', '0,6', ?, 2325, 1, 1, '2026-04-01', 1, '2026-04-01'),
        (11, '新日課', '2026-10-01', '9999-12-31', '0,6', ?, 2325, 1, 1, '2026-04-01', 1, '2026-04-01')
    `).run(oldDetails, newDetails);

    // テスト教職員のパターンを SCHOOL_DEFAULT で設定
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, schedule_source,
        record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at
      )
      VALUES (
        1, '標準勤務', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31',
        '0,6', 2325, 'SCHOOL_DEFAULT',
        'ADMIN_CONFIGURED', 1, '2026-04-01', 1, '2026-04-01'
      )
    `).run();

    // 境界日前日: 2026-09-30 (水) -> 旧日課 (08:15〜16:45)
    const resOld = resolveAuthoritativeWorkSchedule(1, '2026-09-30');
    assert.strictEqual(resOld.status, 'RESOLVED');
    assert.strictEqual(resOld.schoolScheduleId, 10);
    assert.strictEqual(resOld.schedule?.startTime, '08:15');
    assert.strictEqual(resOld.schedule?.endTime, '16:45');
    assert.deepStrictEqual(resOld.effectiveIntervals, [
      { start: 495, end: 720 },  // 08:15-12:00
      { start: 765, end: 1005 } // 12:45-16:45
    ]);

    // 境界日当日: 2026-10-01 (木) -> 新日課 (08:10〜16:40)
    const resNew = resolveAuthoritativeWorkSchedule(1, '2026-10-01');
    assert.strictEqual(resNew.status, 'RESOLVED');
    assert.strictEqual(resNew.schoolScheduleId, 11);
    assert.strictEqual(resNew.schedule?.startTime, '08:10');
    assert.strictEqual(resNew.schedule?.endTime, '16:40');
    assert.deepStrictEqual(resNew.effectiveIntervals, [
      { start: 490, end: 720 },  // 08:10-12:00
      { start: 765, end: 1000 } // 12:45-16:40
    ]);
  });

  // GT-W3C-03: Historical Immutability
  it('GT-W3C-03: 日課改定後も過去日付（改定前）の承認済み休暇・出勤簿・帳票が新日課で再計算されず完全保全されること', () => {
    // 過去日: 2026-09-15 (旧日課期間中) の出勤簿を取得
    const attOld = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-09');
    const day15 = attOld.days.find((d: any) => d.date === '2026-09-15');
    assert.ok(day15);
    assert.strictEqual(day15.scheduledWorkMinutes, 465);

    // 承認済み年休申請レコードの投入
    testDb.prepare('DELETE FROM applications WHERE id = 901').run();
    testDb.prepare(`
      INSERT INTO applications (
        id, type_id, subject_user_id, submitted_by_user_id,
        title, current_status, form_data, final_calculation_snapshot,
        version, created_at, updated_at
      ) VALUES (
        901, 'LEAVE_ANNUAL', 1, 1,
        '年休申請', 'FINAL_APPROVED',
        '{"startDate":"2026-09-15","endDate":"2026-09-15","unitType":"FULL_DAY","calculatedDays":1,"calculatedMinutes":465,"reason":"私事都合"}',
        '{"scheduledWorkMinutes":465,"chargedMinutes":465,"chargedDays":1}',
        1, '2026-09-10', '2026-09-10'
      )
    `).run();

    // 2026年の休暇簿帳票（projectLeaveLedgerPages）を投影
    const ledger = projectLeaveLedgerPages(1, 2026);
    const record901 = ledger.pages[0]?.records.find((r: any) => r.applicationId === 901);
    assert.ok(record901);
    assert.strictEqual(record901.daysCount, 1);
    assert.strictEqual(record901.minutesCount, 465);
  });

  // GT-W3C-04: Individual Override Priority
  it('GT-W3C-04: 育短教職員（schedule_source = INDIVIDUAL）は学校標準日課改定の影響を受けず個別日課が最優先されること', () => {
    // 育短教職員 (id = 2) の作成
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id = 2').run();
    const shortDetails = makeScheduleDetailsJson([
      { startTime: '08:30', endTime: '12:30' } // 240分 (4時間)
    ], 240);

    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, schedule_source, schedule_details_json,
        record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at
      )
      VALUES (
        2, '育短勤務', 'SHORT_TIME', '2026-04-01', '9999-12-31',
        '0,6', 1200, 'INDIVIDUAL', ?,
        'ADMIN_CONFIGURED', 1, '2026-04-01', 1, '2026-04-01'
      )
    `).run(shortDetails);

    // 新日課期間（2026-10-05）の日課解決
    const res = resolveAuthoritativeWorkSchedule(2, '2026-10-05');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.scheduleSource, 'INDIVIDUAL');
    assert.strictEqual(res.scheduledWorkMinutes, 240);
    assert.strictEqual(res.schedule?.startTime, '08:30');
    assert.strictEqual(res.schedule?.endTime, '12:30');
  });

  // GT-W3C-05: Date Override Priority
  it('GT-W3C-05: calendar_adjustments に特定日日課が存在する場合、学校標準日課より特定日オーバーライドが最優先されること', () => {
    // 2026-10-15 に運動会振替勤務日 (schedule_override_json: 09:00〜13:00, 240分) を登録
    testDb.prepare("DELETE FROM calendar_adjustments WHERE adjustment_code = 'CAL_ADJ_W3C_05'").run();
    const overrideDetails = {
      workIntervals: [{ start: 540, end: 780 }], // 09:00 - 13:00 (240分)
      intervals: [{ startTime: '09:00', endTime: '13:00' }],
    };

    testDb.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, event_name, reason,
        schedule_override_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        'CAL_ADJ_W3C_05', 'ALL', NULL, 'SINGLE_WORKDAY_OVERRIDE', 'SCHOOL_EVENT',
        '2026-10-15', 'WORK_REQUIRED', '学校行事特別日課', '運動会振替',
        ?, 1, '2026-10-01', '2026-10-01'
      )
    `).run(JSON.stringify(overrideDetails));

    // WorkingObligationResolver で 2026-10-15 を解決
    const oblRes = WorkingObligationResolver.resolve(1, '2026-10-15');
    assert.strictEqual(oblRes.status, 'WORKING');
    assert.strictEqual(oblRes.sourceType, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(oblRes.workSchedule?.scheduledWorkMinutes, 240);
    assert.strictEqual(oblRes.workSchedule?.schedule?.startTime, '09:00');
    assert.strictEqual(oblRes.workSchedule?.schedule?.endTime, '13:00');
  });

  // GT-W3C-06: No Schedule Fail-Closed
  it('GT-W3C-06: 学校標準日課が登録されていない未来日（2035-04-01）は INVALID_SCHEDULE で Fail-Closed すること', () => {
    // 日課の期間外を模倣するため、有効期間外の日付で検証
    testDb.prepare("UPDATE school_work_schedules SET effective_to = '2030-12-31' WHERE id = 11").run();

    const failRes = resolveAuthoritativeWorkSchedule(1, '2035-04-01');
    assert.strictEqual(failRes.status, 'INVALID_SCHEDULE');
    assert.strictEqual(failRes.isFailClosed, true);
    assert.ok(failRes.failReason?.includes('有効な学校標準日課が登録されていません'));

    // 元に戻す
    testDb.prepare("UPDATE school_work_schedules SET effective_to = '9999-12-31' WHERE id = 11").run();
  });

  // GT-W3C-07: Half-Day Dynamic Adaptation
  it('GT-W3C-07: 新日課（08:10〜16:40: 午前230分, 午後235分）において、半日年休の免除分数が 230分/235分に動的追従すること（465/2 の完全排除）', () => {
    // 2026-10-05 (新日課適用日) の午前年休・午後年休を計算
    const amCalc = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-10-05',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING',
    });

    assert.strictEqual(amCalc.isValid, true);
    assert.strictEqual(amCalc.totalChargedDays, 0.5);
    // 前半区間: 08:10 - 12:00 -> 230分
    assert.strictEqual(amCalc.totalChargedMinutes, 230);
    assert.notStrictEqual(amCalc.totalChargedMinutes, Math.floor(465 / 2), '465/2 (232分) の固定値であってはならない');

    const pmCalc = LeaveCalculationService.calculate({
      subjectUserId: 1,
      typeId: 'LEAVE_ANNUAL',
      targetDate: '2026-10-05',
      unitType: 'HALF_DAY',
      halfDayType: 'AFTERNOON',
    });

    assert.strictEqual(pmCalc.isValid, true);
    assert.strictEqual(pmCalc.totalChargedDays, 0.5);
    // 後半区間: 12:45 - 16:40 -> 235分
    assert.strictEqual(pmCalc.totalChargedMinutes, 235);
    assert.notStrictEqual(pmCalc.totalChargedMinutes, Math.floor(465 / 2), '465/2 (232分) の固定値であってはならない');
  });

  // GT-W3C-08: Server-Authoritative Leave Calculation & Snapshot Integrity (DELTA-03 検証)
  it('GT-W3C-08: クライアントから不正な calculatedMinutes: 999 を送信しても、提出時 form_data および Snapshot に正規値が保存され改ざん値が破棄されること', async () => {
    const user1 = testDb.prepare('SELECT * FROM users WHERE id = 1').get() as any;

    // 年休初期付与 (ユーザー 1: 2026年 20日)
    const { AnnualLeaveService } = require('../services/annualLeaveService');
    testDb.prepare('DELETE FROM leave_entitlements WHERE user_id = 1').run();
    AnnualLeaveService.grantEntitlement({
      userId: 1,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });

    // 1. 午前年休で calculatedMinutes: 999 を送信
    const submitRes = await callApi('POST', '/api/applications/submit', {
      typeId: 'LEAVE_ANNUAL',
      title: '午前半日年休申請',
      formData: {
        targetDate: '2026-10-05',
        unitType: 'HALF_DAY',
        halfDayType: 'MORNING',
        calculatedDays: 99,       // 改ざん値
        calculatedMinutes: 999,   // 改ざん値
        reason: '私事都合',
      },
    }, {
      id: 1,
      username: user1.username,
      displayName: user1.display_name,
      roles: ['TEACHER'],
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    });

    assert.strictEqual(submitRes.status, 200, JSON.stringify(submitRes.body));
    const createdAppId = submitRes.body.data?.id || submitRes.body.id;
    assert.ok(createdAppId);

    // 2. 提出時 applications.form_data の検証 (DELTA-03: 999 が破棄され、正規の 230分 / 0.5日 に置換されていること)
    const appRow = testDb.prepare('SELECT form_data FROM applications WHERE id = ?').get(createdAppId) as any;
    assert.ok(appRow);
    const persistedForm = JSON.parse(appRow.form_data);
    assert.strictEqual(persistedForm.calculatedDays, 0.5);
    assert.strictEqual(persistedForm.calculatedMinutes, 230);
    assert.notStrictEqual(persistedForm.calculatedMinutes, 999);

    // 3. 決裁完了の実行 (Final Approval)
    // ワークフローを進めて FINAL_APPROVED にする
    testDb.prepare("UPDATE applications SET current_status = 'FINAL_APPROVED' WHERE id = ?").run(createdAppId);
    AnnualLeaveService.finalizeUsage(createdAppId);

    // 4. final_calculation_snapshot の検証 (Canonical Authority 由来の 230分 / 0.5日が記録されていること)
    const finalizedApp = testDb.prepare('SELECT final_calculation_snapshot FROM applications WHERE id = ?').get(createdAppId) as any;
    assert.ok(finalizedApp.final_calculation_snapshot);
    const snapshot = JSON.parse(finalizedApp.final_calculation_snapshot);
    assert.strictEqual(snapshot.chargedMinutes, 230);
    assert.strictEqual(snapshot.chargedDays, 0.5);
    assert.notStrictEqual(snapshot.chargedMinutes, 999);
  });
});
