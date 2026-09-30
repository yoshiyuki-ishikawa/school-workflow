import { describe, it, before, after, beforeEach } from 'node:test';
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

describe('Wave WPOA: Work Pattern Overlap Server-Side Atomic Resolution Golden Suite (GT-WPOA-01〜14)', () => {
  let testDb: any;
  let originalDb: any;
  let app: express.Express;

  function callApi(
    method: string,
    path: string,
    body?: any,
    sessionUser?: any
  ): Promise<{ status: number; body: any }> {
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

      if (sessionUser !== undefined) {
        (req as any).session = sessionUser ? { user: sessionUser } : {};
      }

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

  before(() => {
    originalDb = getDb();
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    setDb(testDb);

    testDb.exec(SCHEMA_SQL);
    migrator.runMigrations(testDb);
    seedDatabase();

    // 学校標準日課の登録 (2024-01-01〜9999-12-31 有効)
    const schoolScheduleDetails = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null, "intervals": [] },
      "1": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:00"},{"startTime":"12:45","endTime":"16:45"}] },
      "2": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:00"},{"startTime":"12:45","endTime":"16:45"}] },
      "3": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:00"},{"startTime":"12:45","endTime":"16:45"}] },
      "4": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:00"},{"startTime":"12:45","endTime":"16:45"}] },
      "5": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:15","endTime":"12:00"},{"startTime":"12:45","endTime":"16:45"}] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null, "intervals": [] }
    });
    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id,
        created_at, updated_at
      ) VALUES (
        1, '標準日課', '2024-01-01', '9999-12-31', '0,6',
        ?, 2325, 1, 1,
        '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'
      )
    `).run(schoolScheduleDetails);

    app = express();
    app.use(express.json());
    // Default session: ADMIN user
    app.use((req, res, next) => {
      if (!(req as any).session) {
        (req as any).session = {
          user: {
            id: 1,
            username: 'admin',
            displayName: '管理者 太郎',
            roles: ['ADMIN'],
          },
        };
      }
      next();
    });
    app.use('/api/admin', adminRouter);
  });

  after(() => {
    setDb(originalDb);
    testDb.close();
  });

  function resetTestUserPatterns(userId = 1): number {
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(userId);
    const result = testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, statutory_pattern_code,
        memo, record_origin, created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
      ) VALUES (?, '標準フルタイム', 'STANDARD_FULLTIME', '2025-01-01', '2027-12-31',
        '0,6', NULL, 2325, NULL,
        '初期設定', 'ADMIN_CONFIGURED', 1, '2025-01-01T00:00:00.000Z', 1, '2025-01-01T00:00:00.000Z', 'SCHOOL_DEFAULT'
      )
    `).run(userId);
    return Number(result.lastInsertRowid);
  }

  // GT-WPOA-01: Atomic Success
  it('GT-WPOA-01: Atomic Success — 短縮と新規登録が1つのトランザクションで確定しGap・Overlapなし', async () => {
    const existingId = resetTestUserPatterns(1);

    const payload = {
      targetPatternId: existingId,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '週4日勤務（水曜週休）',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
        memo: '短縮登録テスト',
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.shortenedPattern);
    assert.strictEqual(res.body.shortenedPattern.id, existingId);
    assert.strictEqual(res.body.shortenedPattern.effectiveTo, '2026-09-30');
    assert.ok(res.body.createdPattern);
    assert.strictEqual(res.body.createdPattern.effectiveFrom, '2026-10-01');

    // DB検証
    const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(oldRow.effective_to, '2026-09-30', 'Old pattern must end on 2026-09-30');

    const newRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(res.body.createdPattern.id) as any;
    assert.strictEqual(newRow.effective_from, '2026-10-01');
    assert.strictEqual(newRow.effective_to, '9999-12-31');

    // 監査ログ検証 (同一 request_id)
    const logs = testDb.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_type = 'USER_WORK_PATTERN' AND (entity_id = ? OR entity_id = ?)
      ORDER BY id ASC
    `).all(String(existingId), String(res.body.createdPattern.id)) as any[];
    assert.strictEqual(logs.length, 2, '2 audit logs must be recorded');
    assert.strictEqual(logs[0].action, 'UPDATE_WORK_PATTERN');
    assert.strictEqual(logs[1].action, 'CREATE_WORK_PATTERN');
    assert.ok(logs[0].request_id, 'request_id must not be empty');
    assert.strictEqual(logs[0].request_id, logs[1].request_id, 'Both logs must share the same request_id');
  });

  // GT-WPOA-02: Insert Failure Rollback
  it('GT-WPOA-02: Insert Failure Rollback — INSERT失敗時にUPDATEを含め全ロールバック (Zero Mutation)', async () => {
    const existingId = resetTestUserPatterns(1);

    // SQLite TEMP TRIGGER: newPattern の INSERT 時に強制例外発生
    testDb.exec(`
      CREATE TEMP TRIGGER fail_atomic_insert_test
      BEFORE INSERT ON user_work_patterns
      FOR EACH ROW
      WHEN NEW.memo = 'INJECT_TRIGGER_FAIL_INSERT'
      BEGIN
        SELECT RAISE(FAIL, 'SIMULATED_INSERT_FAILURE');
      END;
    `);

    try {
      const payload = {
        targetPatternId: existingId,
        expectedCurrentEffectiveTo: '2027-12-31',
        newPattern: {
          patternName: '失敗する新パターン',
          patternType: 'SHORT_TIME',
          scheduleSource: 'SCHOOL_DEFAULT',
          effectiveFrom: '2026-10-01',
          effectiveTo: '9999-12-31',
          weeklyOffDays: [0, 3, 6],
          memo: 'INJECT_TRIGGER_FAIL_INSERT',
        },
      };

      const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
      assert.strictEqual(res.status, 500, 'Expected 500 on transaction failure');

      // DB検証: 既存パターンは短縮されず元の 2027-12-31 のままであること
      const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
      assert.strictEqual(oldRow.effective_to, '2027-12-31', 'Old pattern must be ROLLED BACK to 2027-12-31');

      // 新パターンは未作成
      const count = testDb.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns WHERE user_id = 1').get() as any;
      assert.strictEqual(count.cnt, 1, 'Only 1 pattern must remain');
    } finally {
      testDb.exec('DROP TRIGGER IF EXISTS fail_atomic_insert_test;');
    }
  });

  // GT-WPOA-03: Update Failure Zero-Mutation
  it('GT-WPOA-03: Update Failure Zero-Mutation — UPDATE失敗時に後続処理が走らずZero Mutation', async () => {
    const existingId = resetTestUserPatterns(1);

    testDb.exec(`
      CREATE TEMP TRIGGER fail_atomic_update_test
      BEFORE UPDATE ON user_work_patterns
      FOR EACH ROW
      WHEN OLD.id = ${existingId}
      BEGIN
        SELECT RAISE(FAIL, 'SIMULATED_UPDATE_FAILURE');
      END;
    `);

    try {
      const payload = {
        targetPatternId: existingId,
        expectedCurrentEffectiveTo: '2027-12-31',
        newPattern: {
          patternName: '新パターン',
          patternType: 'SHORT_TIME',
          scheduleSource: 'SCHOOL_DEFAULT',
          effectiveFrom: '2026-10-01',
          effectiveTo: '9999-12-31',
          weeklyOffDays: [0, 3, 6],
        },
      };

      const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
      assert.strictEqual(res.status, 500, 'Expected 500 on update failure');

      const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
      assert.strictEqual(oldRow.effective_to, '2027-12-31', 'Old pattern must remain untouched');

      const count = testDb.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns WHERE user_id = 1').get() as any;
      assert.strictEqual(count.cnt, 1, 'Zero new patterns must exist');
    } finally {
      testDb.exec('DROP TRIGGER IF EXISTS fail_atomic_update_test;');
    }
  });

  // GT-WPOA-04: Unauthorized
  it('GT-WPOA-04: Unauthorized — 一般教員 (TEACHER) は 403 Forbidden で遮断 (Zero Mutation)', async () => {
    const existingId = resetTestUserPatterns(1);

    const nonAdminUser = {
      id: 2,
      username: 'teacher1',
      displayName: '一般 教員',
      roles: ['TEACHER'],
    };

    const payload = {
      targetPatternId: existingId,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '新パターン',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload, nonAdminUser);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);

    const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(oldRow.effective_to, '2027-12-31');
  });

  // GT-WPOA-05: Cross-User IDOR
  it('GT-WPOA-05: Cross-User IDOR — 他ユーザーの patternId 指定時は 404 Not Found で遮断', async () => {
    const user1PatternId = resetTestUserPatterns(1);
    const user2PatternId = resetTestUserPatterns(2);

    // ユーザー1のAPIを叩くが、targetPatternId はユーザー2のID
    const payload = {
      targetPatternId: user2PatternId,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: 'IDOR攻撃パターン',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 404);

    // ユーザー2のパターンは変更されていないこと
    const u2Row = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(user2PatternId) as any;
    assert.strictEqual(u2Row.effective_to, '2027-12-31');
  });

  // GT-WPOA-06: Missing Pattern
  it('GT-WPOA-06: Missing Pattern — 存在しない patternId は 404 Not Found で遮断', async () => {
    resetTestUserPatterns(1);

    const payload = {
      targetPatternId: 999999,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '新パターン',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 404);
  });

  // GT-WPOA-07: Stale State Conflict
  it('GT-WPOA-07: Stale State Conflict — 期待終了日が現DBと不一致の場合 409 Conflict で遮断', async () => {
    const existingId = resetTestUserPatterns(1);

    const payload = {
      targetPatternId: existingId,
      expectedCurrentEffectiveTo: '2026-12-31', // 現DBは 2027-12-31
      newPattern: {
        patternName: '新パターン',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.errorCode, 'STALE_STATE_CONFLICT');

    const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(oldRow.effective_to, '2027-12-31', 'DB must remain unchanged');
  });

  // GT-WPOA-08: Third Pattern Conflict
  it('GT-WPOA-08: Third Pattern Conflict — 新パターンが第3のパターンと重複する場合は 409 遮断 (Zero Mutation)', async () => {
    const existingId = resetTestUserPatterns(1);

    // 第3のパターンを 2027-01-01〜2027-03-31 に作成したいが、既存と重なるので一旦既存を 2025-01-01〜2026-12-31 にし、
    // 第3パターンを 2027-01-01〜2027-03-31 に配置
    testDb.prepare('UPDATE user_work_patterns SET effective_to = ? WHERE id = ?').run('2026-12-31', existingId);
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
      ) VALUES (1, '第3パターン', 'STANDARD_FULLTIME', '2027-01-01', '2027-03-31', '0,6', 2325, 1, '2025-01-01', 1, '2025-01-01', 'SCHOOL_DEFAULT')
    `).run();

    // 新パターン 2026-10-01〜9999-12-31 は、第3パターン (2027-01-01〜2027-03-31) と重複する
    const payload = {
      targetPatternId: existingId,
      expectedCurrentEffectiveTo: '2026-12-31',
      newPattern: {
        patternName: '重複新パターン',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.errorCode, 'WORK_PATTERN_PERIOD_OVERLAP');

    // 既存パターンも短縮されず元のまま
    const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(oldRow.effective_to, '2026-12-31');
  });

  // GT-WPOA-09: Invalid New Pattern
  it('GT-WPOA-09: Invalid New Pattern — 入力不正 (scheduleSource欠落等) は 400 Bad Request で遮断', async () => {
    const existingId = resetTestUserPatterns(1);

    const payload = {
      targetPatternId: existingId,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '不正新パターン',
        patternType: 'SHORT_TIME',
        // scheduleSource 欠落
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 400);

    const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(oldRow.effective_to, '2027-12-31');
  });

  // GT-WPOA-10: Boundary Continuity / LocalDate
  it('GT-WPOA-10: Boundary Continuity / LocalDate — 暦日境界 (月末・年末・閏年・平年) の厳格連続性', async () => {
    // 1. 月末境界: 2026-10-01 -> 2026-09-30 (GT-WPOA-01 で検証済)
    // 2. 年末境界: 2026-01-01 -> 2025-12-31
    const p1Id = resetTestUserPatterns(1);
    const payloadYear = {
      targetPatternId: p1Id,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '新年パターン',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-01-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 6],
      },
    };
    const resYear = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payloadYear);
    assert.strictEqual(resYear.status, 200);
    assert.strictEqual(resYear.body.shortenedPattern.effectiveTo, '2025-12-31');

    // 3. 不正日付形式バリデーション: 2026-02-31 は 400 で遮断
    const p2Id = resetTestUserPatterns(1);
    const payloadInvalidDate = {
      targetPatternId: p2Id,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '実在しない日付',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-02-31',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 6],
      },
    };
    const resInvalid = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payloadInvalidDate);
    assert.strictEqual(resInvalid.status, 400);
  });

  // GT-WPOA-11: Same-Date Boundary Rejected
  it('GT-WPOA-11: Same-Date Boundary Rejected — 同日開始 (短縮後終了日 < 開始日) は 400 で遮断', async () => {
    const existingId = resetTestUserPatterns(1);
    // 既存開始日は 2025-01-01。新パターン開始日も 2025-01-01 にすると、前日 2024-12-31 は既存開始日より前になる
    const payload = {
      targetPatternId: existingId,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '同日パターン',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2025-01-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 6],
      },
    };

    const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
    assert.strictEqual(res.status, 400);

    const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(oldRow.effective_to, '2027-12-31');
  });

  // GT-WPOA-12: Audit Atomicity & Correlation
  it('GT-WPOA-12: Audit Atomicity — 監査ログ書き込み失敗時にトランザクション全体がロールバックされること', async () => {
    const existingId = resetTestUserPatterns(1);

    testDb.exec(`
      CREATE TEMP TRIGGER fail_atomic_audit_test
      BEFORE INSERT ON audit_logs
      FOR EACH ROW
      WHEN NEW.action = 'CREATE_WORK_PATTERN'
      BEGIN
        SELECT RAISE(FAIL, 'SIMULATED_AUDIT_FAILURE');
      END;
    `);

    try {
      const payload = {
        targetPatternId: existingId,
        expectedCurrentEffectiveTo: '2027-12-31',
        newPattern: {
          patternName: '監査失敗パターン',
          patternType: 'SHORT_TIME',
          scheduleSource: 'SCHOOL_DEFAULT',
          effectiveFrom: '2026-10-01',
          effectiveTo: '9999-12-31',
          weeklyOffDays: [0, 3, 6],
        },
      };

      const res = await callApi('POST', '/users/1/work-patterns/resolve-overlap', payload);
      assert.strictEqual(res.status, 500);

      // ロールバック検証: 既存パターンは短縮されていないこと
      const oldRow = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
      assert.strictEqual(oldRow.effective_to, '2027-12-31', 'Must be rolled back on audit failure');

      // 新パターンも未作成
      const count = testDb.prepare('SELECT COUNT(*) as cnt FROM user_work_patterns WHERE user_id = 1').get() as any;
      assert.strictEqual(count.cnt, 1);
    } finally {
      testDb.exec('DROP TRIGGER IF EXISTS fail_atomic_audit_test;');
    }
  });

  // GT-WPOA-13: Existing Normal POST Unchanged
  it('GT-WPOA-13: Existing Normal POST Unchanged — 既存通常登録ルートが従来通り動作すること', async () => {
    testDb.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();

    const payload = {
      patternName: '通常登録パターン',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'SCHOOL_DEFAULT',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
      weeklyOffDays: [0, 6],
    };

    const res = await callApi('POST', '/users/1/work-patterns', payload);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.patternId);
  });

  // GT-WPOA-14: Existing Normal PUT Unchanged
  it('GT-WPOA-14: Existing Normal PUT Unchanged — 既存通常更新ルートが従来通り動作すること', async () => {
    const existingId = resetTestUserPatterns(1);

    const payload = {
      patternName: '更新後パターン名',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'SCHOOL_DEFAULT',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2027-12-31',
      weeklyOffDays: [0, 6],
      weeklyTotalMinutes: 2325,
    };

    const res = await callApi('PUT', `/users/1/work-patterns/${existingId}`, payload);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    const row = testDb.prepare('SELECT * FROM user_work_patterns WHERE id = ?').get(existingId) as any;
    assert.strictEqual(row.pattern_name, '更新後パターン名');
  });
});
