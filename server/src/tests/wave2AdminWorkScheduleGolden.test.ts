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
import { resolveAuthoritativeWorkSchedule } from '../services/attendance/workPatternResolver';

describe('Wave 2 Golden Tests: Admin API & Atomic Versioning Gate (GT-W2-ADMIN-01〜12)', () => {
  let testDb: any;
  let originalDb: any;
  let app: express.Express;

  function callApi(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const req = new http.IncomingMessage(socket);
      const bodyStr = body !== undefined ? JSON.stringify(body) : '';
      req.method = method;
      req.url = '/api/admin' + path;
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

      app(req as any, res as any);
      if (bodyStr) {
        req.push(bodyStr);
      }
      req.push(null);
    });
  }

  function makeStandardScheduleDetails(dailyMinutes = 465): Record<string, any> {
    const intervals = dailyMinutes === 465
      ? [
          { startTime: '08:15', endTime: '12:00' }, // 225分
          { startTime: '12:45', endTime: '16:45' }, // 240分 => 計465分
        ]
      : [
          { startTime: '08:15', endTime: '12:00' }, // 225分
          { startTime: '12:45', endTime: '16:40' }, // 235分 => 計460分 (合計2300分)
        ];

    const details: Record<string, any> = {};
    for (let d = 0; d < 7; d++) {
      if (d === 0 || d === 6) {
        details[String(d)] = { isWorkDay: false, workMinutes: 0, intervals: [] };
      } else {
        details[String(d)] = {
          isWorkDay: true,
          workMinutes: dailyMinutes,
          intervals,
        };
      }
    }
    return details;
  }

  before(() => {
    originalDb = getDb();
    // 完全独立したインメモリDBで検証 (本番DBへの副作用完全防止)
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    setDb(testDb);

    testDb.exec(SCHEMA_SQL);
    migrator.runMigrations(testDb);
    seedDatabase();

    // Express アプリの構築 (ADMIN権限モック付き、TCPソケットなしのインメモリディスパッチ)
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as any).session = {
        user: {
          id: 1,
          username: 'admin',
          displayName: '管理者 太郎',
          roles: ['ADMIN'],
        },
      };
      next();
    });
    app.use('/api/admin', adminRouter);
  });

  after(() => {
    setDb(originalDb);
    testDb.close();
  });

  // GT-W2-ADMIN-01: 未登録時 GET → []
  it('GT-W2-ADMIN-01: 未登録時の学校標準日課一覧は空配列であること', async () => {
    const res = await callApi('GET', '/school-work-schedules');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.deepStrictEqual(res.body.schedules, []);
  });

  // GT-W2-ADMIN-02: 初期 School Default 正常登録 (2026-04-01〜9999-12-31, 週2325分)
  it('GT-W2-ADMIN-02: 初期学校標準日課の正常登録 (2,325分, 開区間 9999-12-31)', async () => {
    const payload = {
      scheduleName: '令和8年度 標準日課',
      effectiveFrom: '2026-04-01',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    };

    const res = await callApi('POST', '/school-work-schedules', payload);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.createdScheduleId > 0);
    assert.strictEqual(res.body.effectiveFrom, '2026-04-01');
    assert.strictEqual(res.body.effectiveTo, '9999-12-31');

    // DB確認
    const row = testDb.prepare('SELECT * FROM school_work_schedules WHERE id = ?').get(res.body.createdScheduleId) as any;
    assert.strictEqual(row.schedule_name, '令和8年度 標準日課');
    assert.strictEqual(row.effective_from, '2026-04-01');
    assert.strictEqual(row.effective_to, '9999-12-31');
    assert.strictEqual(row.weekly_total_minutes, 2325);
  });

  // GT-W2-ADMIN-03: 2325分不一致 → HTTP 400 (INV-DWS-WEEKLY-SUM)
  it('GT-W2-ADMIN-03: 週総実働時間が2,325分と不一致の場合は HTTP 400 で即座拒絶されること', async () => {
    const payload = {
      scheduleName: '不正時間日課',
      effectiveFrom: '2027-04-01',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(460), // 計2300分 (2325分不一致)
    };

    const res = await callApi('POST', '/school-work-schedules', payload);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errorCode, 'INVALID_WEEKLY_TOTAL_MINUTES');
    assert.strictEqual(res.body.expected, 2325);
    assert.strictEqual(res.body.actual, 2300);
  });

  // GT-W2-ADMIN-04: 不正 interval → HTTP 400 (start >= end, 重複)
  it('GT-W2-ADMIN-04: 不正なインターバル(start >= end または重複)は HTTP 400 で拒絶されること', async () => {
    const invalidDetails = makeStandardScheduleDetails(465);
    // 月曜日のインターバルを不正にする
    invalidDetails['1'] = {
      isWorkDay: true,
      workMinutes: 465,
      intervals: [
        { startTime: '12:00', endTime: '08:15' }, // start > end
      ],
    };

    const res = await callApi('POST', '/school-work-schedules', {
      scheduleName: '不正インターバル日課',
      effectiveFrom: '2027-04-01',
      weeklyOffDays: '0,6',
      scheduleDetails: invalidDetails,
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errorCode, 'INVALID_SCHEDULE_INTERVALS');
  });

  // GT-W2-ADMIN-05: Atomic Versioning 正常改定 (2026-10-01〜新日課登録で前日課が2026-09-30に短縮)
  it('GT-W2-ADMIN-05: Append-Only Effective-Dated Versioning による正常改定と開区間短縮', async () => {
    const payload = {
      scheduleName: '令和8年度 冬季改定日課',
      effectiveFrom: '2026-10-01',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    };

    const res = await callApi('POST', '/school-work-schedules', payload);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.previousScheduleId);

    // 既存日課 A が 2026-09-30 に短縮されたことを検証
    const prevRow = testDb.prepare('SELECT * FROM school_work_schedules WHERE id = ?').get(res.body.previousScheduleId) as any;
    assert.strictEqual(prevRow.effective_to, '2026-09-30');

    // 新日課 B が 2026-10-01 〜 9999-12-31 で作成されたことを検証
    const newRow = testDb.prepare('SELECT * FROM school_work_schedules WHERE id = ?').get(res.body.createdScheduleId) as any;
    assert.strictEqual(newRow.effective_from, '2026-10-01');
    assert.strictEqual(newRow.effective_to, '9999-12-31');
  });

  // GT-W2-ADMIN-06: 同日 Version 衝突 → HTTP 409 Conflict
  it('GT-W2-ADMIN-06: 最新開区間と同一開始日の登録は HTTP 409 Conflict で拒絶されること', async () => {
    const payload = {
      scheduleName: '同日衝突日課',
      effectiveFrom: '2026-10-01', // 既に登録済みの新日課と同一開始日
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    };

    const res = await callApi('POST', '/school-work-schedules', payload);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errorCode, 'SCHOOL_SCHEDULE_PERIOD_CONFLICT');
  });

  // GT-W2-ADMIN-07: 過去・割込み Version → HTTP 409 Conflict
  it('GT-W2-ADMIN-07: 最新開区間より前の過去日付・割込み登録は HTTP 409 Conflict で拒絶されること', async () => {
    const payload = {
      scheduleName: '過去割込み日課',
      effectiveFrom: '2026-07-01', // 既存 2026-10-01 より前への割込み
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    };

    const res = await callApi('POST', '/school-work-schedules', payload);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errorCode, 'SCHOOL_SCHEDULE_PERIOD_CONFLICT');
  });

  // GT-W2-ADMIN-08: INSERT 失敗時の完全 ROLLBACK (トランザクション整合性)
  it('GT-W2-ADMIN-08: INSERT 失敗時は既存レコードの短縮も完全 ROLLBACK されること', async () => {
    // 現在の開区間日課（ID確認）
    const currentOpenBefore = testDb.prepare("SELECT * FROM school_work_schedules WHERE effective_to = '9999-12-31'").get() as any;
    assert.ok(currentOpenBefore);

    // 一時的に INSERT トリガーでエラーを強制発生させる
    testDb.exec(`
      CREATE TRIGGER temp_force_insert_fail
      BEFORE INSERT ON school_work_schedules
      BEGIN
        SELECT RAISE(ABORT, 'FORCED_TEST_INSERT_FAILURE');
      END;
    `);

    try {
      const res = await callApi('POST', '/school-work-schedules', {
        scheduleName: 'ロールバック検証日課',
        effectiveFrom: '2027-04-01',
        weeklyOffDays: '0,6',
        scheduleDetails: makeStandardScheduleDetails(465),
      });

      assert.strictEqual(res.status, 500);

      // ロールバック確認: 既存日課の effective_to が '9999-12-31' のままであること
      const currentOpenAfter = testDb.prepare('SELECT * FROM school_work_schedules WHERE id = ?').get(currentOpenBefore.id) as any;
      assert.strictEqual(currentOpenAfter.effective_to, '9999-12-31');
    } finally {
      testDb.exec('DROP TRIGGER IF EXISTS temp_force_insert_fail');
    }
  });

  // GT-W2-ADMIN-09: 教職員への SCHOOL_DEFAULT 正常割当
  it('GT-W2-ADMIN-09: 教職員へ scheduleSource = "SCHOOL_DEFAULT" が正常に登録されること', async () => {
    // 期間重複を防止するためユーザー1の既存パターンをクリア
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();

    const payload = {
      patternName: '全校標準適用パターン',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'SCHOOL_DEFAULT',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
    };

    const res = await callApi('POST', '/users/1/work-patterns', payload);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.patternId > 0);

    // DB確認
    const row = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(res.body.patternId) as any;
    assert.strictEqual(row.schedule_source, 'SCHOOL_DEFAULT');
    assert.strictEqual(row.weekly_total_minutes, 2325);
    assert.strictEqual(row.schedule_details_json, null);

    // Resolver で正しく解決されることを確認 (Point-in-Time Effective-Dated Resolution)
    const resolved = resolveAuthoritativeWorkSchedule(1, '2026-05-15');
    assert.strictEqual(resolved.status, 'RESOLVED');
    assert.strictEqual(resolved.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(resolved.scheduledWorkMinutes, 465);
  });

  // GT-W2-ADMIN-10: effectiveFrom 時点に有効な School Default が存在しない場合の拒絶
  it('GT-W2-ADMIN-10: 勤務開始日時点で有効な学校標準日課が存在しない場合 (0件および過去閉区間のみ) は拒絶されること', async () => {
    // Case 1: 過去の日付 (学校日課開始 2026-04-01 より前) で SCHOOL_DEFAULT を登録試行
    const resPast = await callApi('POST', '/users/2/work-patterns', {
      patternName: '過去日課適用試行',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'SCHOOL_DEFAULT',
      effectiveFrom: '2025-04-01', // 2026-04-01より前
      effectiveTo: '2026-03-31',
      weeklyOffDays: '0,6',
    });

    assert.strictEqual(resPast.status, 400);
    assert.strictEqual(resPast.body.success, false);
    assert.strictEqual(resPast.body.errorCode, 'SCHOOL_DEFAULT_NOT_CONFIGURED');

    // Case 2: 新規インメモリDB (学校日課0件) での試行
    const emptyDb = new Database(':memory:');
    emptyDb.exec(SCHEMA_SQL);
    migrator.runMigrations(emptyDb);
    setDb(emptyDb);

    try {
      // ユーザーを作成
      emptyDb.prepare("INSERT INTO users (id, username, password_hash, display_name, department, created_at) VALUES (99, 'test', 'hash', 'テスト', '小学部', '2026-04-01')").run();

      const resZero = await callApi('POST', '/users/99/work-patterns', {
        patternName: '0件時SCHOOL_DEFAULT試行',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-04-01',
        effectiveTo: '2027-03-31',
        weeklyOffDays: '0,6',
      });

      assert.strictEqual(resZero.status, 400);
      assert.strictEqual(resZero.body.success, false);
      assert.strictEqual(resZero.body.errorCode, 'SCHOOL_DEFAULT_NOT_CONFIGURED');
    } finally {
      setDb(testDb);
      emptyDb.close();
    }
  });

  // GT-W2-ADMIN-11: PUT による scheduleSource 切替 (INDIVIDUAL ⇄ SCHOOL_DEFAULT)
  it('GT-W2-ADMIN-11: PUT による scheduleSource の更新・切替が正しく動作すること', async () => {
    // 期間重複を防止するためユーザー2の既存パターンをクリア
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id = 2').run();

    // まず INDIVIDUAL で登録 (ユーザー2)
    const indPayload = {
      patternName: '教諭2 個別日課',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'INDIVIDUAL',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    };

    const createRes = await callApi('POST', '/users/2/work-patterns', indPayload);
    assert.strictEqual(createRes.status, 201);
    const created = createRes.body;

    // PUT で SCHOOL_DEFAULT へ切り替え
    const putRes = await callApi('PUT', '/users/2/work-patterns/' + created.patternId, {
      patternName: '教諭2 学校標準切替後',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'SCHOOL_DEFAULT',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
    });

    assert.strictEqual(putRes.status, 200);
    assert.strictEqual(putRes.body.success, true);

    // DB確認
    const row = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(created.patternId) as any;
    assert.strictEqual(row.schedule_source, 'SCHOOL_DEFAULT');
    assert.strictEqual(row.schedule_details_json, null);
  });

  // GT-W2-ADMIN-12: INDIVIDUAL + scheduleDetails missing → HTTP 400 (固定08:10 Silent Fallback撤廃検証)
  it('GT-W2-ADMIN-12: INDIVIDUAL パターンで scheduleDetails が省略された場合は HTTP 400 で拒絶されること (08:10 推測撤廃)', async () => {
    const res = await callApi('POST', '/users/3/work-patterns', {
      patternName: '推測期待パターン',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'INDIVIDUAL',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
      // scheduleDetails を意図的に省略
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errorCode, 'SCHEDULE_DETAILS_REQUIRED');
  });

  // GT-W2-ADMIN-13: scheduleSource 明示必須検証 (Explicit Source Contract: 省略・null・空文字は HTTP 400 SCHEDULE_SOURCE_REQUIRED)
  it('GT-W2-ADMIN-13: POST 時に scheduleSource が省略・null・空文字の場合は HTTP 400 (SCHEDULE_SOURCE_REQUIRED) で即座拒絶されること', async () => {
    const countBefore = (testDb.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns').get() as any).cnt;

    // Subcase A: scheduleSource 省略 (omitted / undefined)
    const resOmitted = await callApi('POST', '/users/3/work-patterns', {
      patternName: 'ソース省略パターン',
      patternType: 'STANDARD_FULLTIME',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    });

    assert.strictEqual(resOmitted.status, 400);
    assert.strictEqual(resOmitted.body.success, false);
    assert.strictEqual(resOmitted.body.errorCode, 'SCHEDULE_SOURCE_REQUIRED');

    // Subcase B: scheduleSource = null
    const resNull = await callApi('POST', '/users/3/work-patterns', {
      patternName: 'ソースnullパターン',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: null,
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    });

    assert.strictEqual(resNull.status, 400);
    assert.strictEqual(resNull.body.success, false);
    assert.strictEqual(resNull.body.errorCode, 'SCHEDULE_SOURCE_REQUIRED');

    // Subcase C: scheduleSource = '' (空文字)
    const resEmpty = await callApi('POST', '/users/3/work-patterns', {
      patternName: 'ソース空文字パターン',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: '',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      weeklyOffDays: '0,6',
      scheduleDetails: makeStandardScheduleDetails(465),
    });

    assert.strictEqual(resEmpty.status, 400);
    assert.strictEqual(resEmpty.body.success, false);
    assert.strictEqual(resEmpty.body.errorCode, 'SCHEDULE_SOURCE_REQUIRED');

    // Zero Persistence 検証
    const countAfter = (testDb.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns').get() as any).cnt;
    assert.strictEqual(countAfter, countBefore, 'scheduleSource 欠落による拒絶時はレコードが一切挿入されないこと (Zero Persistence)');
  });
});
