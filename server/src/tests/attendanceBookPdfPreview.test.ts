import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import formsRouter from '../routes/forms';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { Request, Response } from 'express';

describe('Attendance Book A4 Preview Golden Tests (GT-BUG-AF)', () => {
  let db: any;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    setDb(db);
    seedDatabase();

    // 勤務パターン登録 (山田 太郎 / userId: 1)
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(1);
    const s465 = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
      "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
      "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
      "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:15", "endTime": "16:45" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, '通常フルタイム', 'STANDARD_FULLTIME', '2025-01-01', '9999-12-31', '0,6', ?, 2325, 1, '2026-01-01', 1, '2026-01-01')
    `).run(1, s465);
  });

  it('GT-BUG-AF-01: 出勤簿帳票データ取得 API が HTTP 200 を返し、template.template_definition が object として正常返却されること', async () => {
    let responseStatus: number = 200;
    let responseBody: any = null;

    const req = {
      params: { userId: '1', yearMonth: '2026-05' },
      session: {
        user: {
          id: 1,
          username: 'teacher1',
          displayName: '山田 太郎',
          roles: ['TEACHER'],
        },
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    const res = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;

    // forms.ts の GET /attendance/:userId/:yearMonth/pdf-data ルートハンドラを直接実行
    const route = formsRouter.stack.find((layer: any) =>
      layer.route && layer.route.path === '/attendance/:userId/:yearMonth/pdf-data' && layer.route.methods.get
    );

    assert.ok(route, '出勤簿 PDF データ取得ルートが定義されていること');

    for (const layer of route.route.stack) {
      let nextCalled = false;
      await layer.handle(req, res, () => { nextCalled = true; });
      if (!nextCalled && responseBody) break;
    }

    assert.strictEqual(responseStatus, 200, 'HTTP ステータスが 200 であること');
    assert.ok(responseBody, 'レスポンスボディが存在すること');
    assert.strictEqual(responseBody.success, true, 'success が true であること');
    assert.ok(responseBody.data, 'data が存在すること');
    assert.ok(responseBody.data.template, 'template が存在すること');
    
    // Type Contract 検証: template_definition は object であり、"[object Object]" パースエラーが発生しないこと
    assert.strictEqual(typeof responseBody.data.template.template_definition, 'object', 'template_definition が object であること');
    assert.strictEqual(responseBody.data.template.template_definition.title, '出 勤 簿');
    assert.strictEqual(responseBody.data.template.form_code, 'ATTENDANCE_BOOK');
  });

  it('GT-BUG-AF-02: CanonicalAttendanceProjectionEngine -> Route Handler -> API Response DTO の Runtime 結合境界で二重パースが発生しないこと', async () => {
    // 1. Engine 戻り値の型検証
    const docData = CanonicalAttendanceProjectionEngine.getDocumentProjection(1, '2026-05');
    assert.ok(docData.template);
    assert.strictEqual(typeof docData.template.template_definition, 'object', 'Engine は既に object を返却していること');

    // 2. Route レスポンス DTO の結合検証
    let responseBody: any = null;
    const req = {
      params: { userId: '1', yearMonth: '2026-05' },
      session: {
        user: {
          id: 4,
          username: 'principal',
          displayName: '佐藤 健一 (校長)',
          roles: ['PRINCIPAL'],
        },
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    const res = {
      status: () => res,
      json: (body: any) => { responseBody = body; return res; },
    } as unknown as Response;

    const route = formsRouter.stack.find((layer: any) =>
      layer.route && layer.route.path === '/attendance/:userId/:yearMonth/pdf-data' && layer.route.methods.get
    );

    for (const layer of route.route.stack) {
      let nextCalled = false;
      await layer.handle(req, res, () => { nextCalled = true; });
      if (!nextCalled && responseBody) break;
    }

    assert.ok(responseBody?.data?.template, 'Route から template が正常に返却されること');
    // Client側 (JSON.stringify / JSON.parse) シミュレーション
    const serializedForClient = JSON.stringify(responseBody);
    const clientReceived = JSON.parse(serializedForClient);

    assert.strictEqual(clientReceived.data.template.template_definition.title, '出 勤 簿');
    assert.ok(Array.isArray(clientReceived.data.template.template_definition.sections));
    assert.ok(Array.isArray(clientReceived.data.attendanceData.days));
    assert.strictEqual(clientReceived.data.attendanceData.days.length, 31);
  });

  it('GT-BUG-ANAME-01: 出勤簿 PDF Data API が data.user.displayName を含む CamelCase User DTO を正常に返却すること', async () => {
    let responseStatus: number = 200;
    let responseBody: any = null;

    const req = {
      params: { userId: '1', yearMonth: '2026-05' },
      session: {
        user: {
          id: 1,
          username: 'teacher1',
          displayName: '山田 太郎 (教員A)',
          roles: ['TEACHER'],
        },
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    const res = {
      status(code: number) {
        responseStatus = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;

    const route = formsRouter.stack.find((layer: any) =>
      layer.route && layer.route.path === '/attendance/:userId/:yearMonth/pdf-data' && layer.route.methods.get
    );

    for (const layer of route.route.stack) {
      let nextCalled = false;
      await layer.handle(req, res, () => { nextCalled = true; });
      if (!nextCalled && responseBody) break;
    }

    assert.strictEqual(responseStatus, 200);
    assert.ok(responseBody?.data?.user, 'data.user が存在すること');
    
    // User DTO CamelCase Contract 検証
    const userDto = responseBody.data.user;
    assert.strictEqual(userDto.id, 1);
    assert.strictEqual(userDto.username, 'teacher1');
    assert.strictEqual(userDto.displayName, '山田 太郎 (教員A)', 'displayName が空文字でなく DB display_name と完全一致すること');
    assert.strictEqual(userDto.stampName, '山田');
    assert.strictEqual(userDto.department, '1学年・国語科');
    assert.strictEqual(userDto.display_name, undefined, 'snake_case の display_name は直接公開されないこと');
  });

  it('GT-BUG-ANAME-03: ログインユーザーと対象職員が異なる場合 (校長が教員の出勤簿を出力) でも、帳票 DTO に対象職員の displayName が返却されること (Identity Separation)', async () => {
    let responseStatus: number = 200;
    let responseBody: any = null;

    // 校長 (id: 4) が教員山田 (id: 1) の出勤簿を取得
    const req = {
      params: { userId: '1', yearMonth: '2026-05' },
      session: {
        user: {
          id: 4,
          username: 'principal',
          displayName: '佐藤 健一 (校長C)',
          roles: ['PRINCIPAL'],
        },
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    const res = {
      status: () => res,
      json: (body: any) => { responseBody = body; return res; },
    } as unknown as Response;

    const route = formsRouter.stack.find((layer: any) =>
      layer.route && layer.route.path === '/attendance/:userId/:yearMonth/pdf-data' && layer.route.methods.get
    );

    for (const layer of route.route.stack) {
      let nextCalled = false;
      await layer.handle(req, res, () => { nextCalled = true; });
      if (!nextCalled && responseBody) break;
    }

    assert.strictEqual(responseBody.success, true);
    assert.strictEqual(responseBody.data.user.id, 1, '対象職員の ID であること');
    assert.strictEqual(responseBody.data.user.displayName, '山田 太郎 (教員A)', '校長の氏名ではなく対象教員の氏名が表示されること');
    assert.notStrictEqual(responseBody.data.user.displayName, '佐藤 健一 (校長C)', 'requester identity が混入しないこと');
  });
});
