import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { getDb, setDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import applicationsRouter from '../routes/applications';
import { UserContext } from '../types';

describe('Batch Trip Production Path Retirement Golden Suite (GT-RETIRE-BATCH-01〜05)', () => {
  let app: express.Express;
  let originalDb: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher2: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '佐藤 花子 (教員B)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  function callApi(
    method: string,
    path: string,
    body?: any,
    userMock?: UserContext
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      const socket = new Socket();
      (socket as any).remoteAddress = '127.0.0.1';
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

      const effectiveUser = userMock || teacher1;
      const db = getDb();
      const dbUser = db.prepare('SELECT auth_version FROM users WHERE id = ?').get(effectiveUser.id) as any;
      const currentAuthVersion = dbUser ? (dbUser.auth_version || 1) : 1;

      (req as any).user = effectiveUser;
      (req as any).session = {
        user: { ...effectiveUser, authVersion: currentAuthVersion },
        destroy: (cb?: (err?: any) => void) => {
          if (cb) cb();
        },
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
    initDatabase();
    seedDatabase();

    app = express();
    app.use(express.json());
    app.use('/api/applications', applicationsRouter);
  });

  after(() => {
    if (originalDb) {
      setDb(originalDb);
    }
  });

  beforeEach(() => {
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM personnel_actions').run();
    db.prepare('DELETE FROM personnel_statuses').run();
  });

  // GT-RETIRE-BATCH-01: HTTP POST /api/applications/batch-trip returns 404 Not Found
  it('GT-RETIRE-BATCH-01: HTTP POST /api/applications/batch-trip returns 404 (Route completely retired from production API)', async () => {
    const res = await callApi('POST', '/api/applications/batch-trip', {
      title: '一括出張テスト',
      purpose: '合同研修',
      destination: '県教育センター',
      startAt: '2026-10-01T09:00:00',
      endAt: '2026-10-01T17:00:00',
      transport: '公用車',
      participantUserIds: [1, 2],
    });

    assert.strictEqual(res.status, 404, 'POST /api/applications/batch-trip must return 404 Not Found');
  });

  // GT-RETIRE-BATCH-02: Canonical Single Trip creation (POST /api/applications/submit) functions completely
  it('GT-RETIRE-BATCH-02: Canonical Single Trip creation via POST /api/applications/submit succeeds with all canonical fields preserved', async () => {
    const tripPayload = {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請（単体）',
      formData: {
        destination: '県教育センター',
        purpose: '情報教育研修会',
        departurePlace: '本校',
        arrivalPlace: '本校',
        transport: '自家用車',
        transportOther: undefined,
        privateCarReason: '公用車出払のため',
        fundingSource: '市費',
        isOralOrder: true,
        oralOrderIssuedAt: '2026-09-20',
        startDate: '2026-10-05',
        endDate: '2026-10-05',
        startAt: '2026-10-05T08:10:00',
        endAt: '2026-10-05T16:40:00',
        unitType: 'DAY',
        isExpenseClaimed: false,
      },
    };

    const res = await callApi('POST', '/api/applications/submit', tripPayload, teacher1);

    assert.strictEqual(res.status, 200, `Expected 200 OK but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data?.id, 'Application ID should be returned');

    const db = getDb();
    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(res.body.data.id) as any;
    assert.ok(appRow, 'Application must exist in database');
    assert.strictEqual(appRow.type_id, 'BUSINESS_TRIP');
    assert.strictEqual(appRow.subject_user_id, teacher1.id);

    const savedFormData = JSON.parse(appRow.form_data);
    assert.strictEqual(savedFormData.destination, '県教育センター');
    assert.strictEqual(savedFormData.purpose, '情報教育研修会');
    assert.strictEqual(savedFormData.transport, '自家用車');
    assert.strictEqual(savedFormData.fundingSource, '市費');
    assert.strictEqual(savedFormData.isOralOrder, true);
    assert.strictEqual(savedFormData.oralOrderIssuedAt, '2026-09-20');
  });

  // GT-RETIRE-BATCH-03: WorkflowEngine.submitBatchTrip remains callable for Legacy / Test fixture compatibility
  it('GT-RETIRE-BATCH-03: WorkflowEngine.submitBatchTrip remains directly callable for Legacy / Test compatibility', () => {
    const result = WorkflowEngine.submitBatchTrip(teacher1, {
      title: 'テスト用一括出張',
      purpose: '研究授業視察',
      destination: '附属小学校',
      startAt: '2026-06-15T09:00:00',
      endAt: '2026-06-15T16:00:00',
      transport: '公用車',
      notes: 'テスト用',
      participantUserIds: [teacher1.id, teacher2.id],
    });

    assert.strictEqual(result.success, true, `submitBatchTrip failed: ${JSON.stringify(result)}`);
    assert.strictEqual(result.statusCode, 201);
    assert.ok(result.data?.tripEventId, 'tripEventId should be returned');
    assert.strictEqual(result.data?.generatedAppIds?.length, 2, '2 applications should be generated');

    const db = getDb();
    const eventRow = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(result.data.tripEventId) as any;
    assert.ok(eventRow, 'trip_event record must exist');
    assert.strictEqual(eventRow.title, 'テスト用一括出張');

    const members = db.prepare('SELECT * FROM trip_event_members WHERE trip_event_id = ?').all(result.data.tripEventId) as any[];
    assert.strictEqual(members.length, 2, 'trip_event_members must have 2 records');
  });

  // GT-RETIRE-BATCH-04: Historical records linked to trip_events and trip_event_members remain queryable
  it('GT-RETIRE-BATCH-04: Historical records linked to trip_events and trip_event_members remain queryable and readable', () => {
    const db = getDb();

    // 過去の一括出張データをシミュレートして挿入
    const eventRes = db.prepare(`
      INSERT INTO trip_events (
        title, purpose, destination, start_at, end_at, transport, notes,
        created_by_user_id, created_at, updated_at
      ) VALUES (
        '過年度一括出張アーカイブ', '合同研修', '県庁本庁舎', '2025-05-10 09:00:00', '2025-05-10 17:00:00', '公用車', '特記事項なし',
        ?, '2025-05-01 10:00:00', '2025-05-01 10:00:00'
      )
    `).run(teacher1.id);
    const tripEventId = Number(eventRes.lastInsertRowid);

    // 参加者1
    const app1Res = db.prepare(`
      INSERT INTO applications (
        type_id, title, subject_user_id, submitted_by_user_id, current_status, form_data, created_at, updated_at
      ) VALUES (
        'BUSINESS_TRIP', '過年度一括出張アーカイブ (山田)', ?, ?, 'APPROVED', '{"destination":"県庁本庁舎","transport":"公用車"}', '2025-05-01 10:00:00', '2025-05-01 10:00:00'
      )
    `).run(teacher1.id, teacher1.id);
    const appId1 = Number(app1Res.lastInsertRowid);

    db.prepare(`
      INSERT INTO trip_event_members (trip_event_id, user_id, application_id, individual_notes, created_at)
      VALUES (?, ?, ?, '引率責任者', '2025-05-01 10:00:00')
    `).run(tripEventId, teacher1.id, appId1);

    // 参加者2
    const app2Res = db.prepare(`
      INSERT INTO applications (
        type_id, title, subject_user_id, submitted_by_user_id, current_status, form_data, created_at, updated_at
      ) VALUES (
        'BUSINESS_TRIP', '過年度一括出張アーカイブ (佐藤)', ?, ?, 'APPROVED', '{"destination":"県庁本庁舎","transport":"公用車"}', '2025-05-01 10:00:00', '2025-05-01 10:00:00'
      )
    `).run(teacher2.id, teacher1.id);
    const appId2 = Number(app2Res.lastInsertRowid);

    db.prepare(`
      INSERT INTO trip_event_members (trip_event_id, user_id, application_id, individual_notes, created_at)
      VALUES (?, ?, ?, '記録担当', '2025-05-01 10:00:00')
    `).run(tripEventId, teacher2.id, appId2);

    // 監査クエリの実行
    const auditQuery = `
      SELECT te.id as trip_event_id, te.title as event_title, tem.user_id, u.display_name, a.id as application_id, a.current_status as app_status, tem.individual_notes
      FROM trip_events te
      JOIN trip_event_members tem ON te.id = tem.trip_event_id
      JOIN users u ON tem.user_id = u.id
      JOIN applications a ON tem.application_id = a.id
      WHERE te.id = ?
      ORDER BY tem.user_id ASC
    `;
    const historicalRows = db.prepare(auditQuery).all(tripEventId) as any[];

    assert.strictEqual(historicalRows.length, 2, 'Must successfully query both members of the historical trip event');
    assert.strictEqual(historicalRows[0].user_id, teacher1.id);
    assert.strictEqual(historicalRows[0].individual_notes, '引率責任者');
    assert.strictEqual(historicalRows[1].user_id, teacher2.id);
    assert.strictEqual(historicalRows[1].individual_notes, '記録担当');
  });

  // GT-RETIRE-BATCH-05: Single Trip properly creates and links trip_events / trip_event_members
  it('GT-RETIRE-BATCH-05: Single Trip submission properly creates and links trip_events and trip_event_members (Shared Model Integrity)', () => {
    const singleTripResult = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '単体公務出張',
      formData: {
        destination: '市立総合教育センター',
        purpose: '教育課程研究発表会',
        departurePlace: '本校',
        arrivalPlace: '本校',
        transport: '公用車',
        fundingSource: '県費',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        startAt: '2026-10-15T08:10:00',
        endAt: '2026-10-15T16:40:00',
        unitType: 'DAY',
        isExpenseClaimed: false,
        calculatedDays: 1,
      },
    });

    assert.strictEqual(singleTripResult.success, true, `Submission failed: ${JSON.stringify(singleTripResult)}`);
    const appId = singleTripResult.data?.id;
    assert.ok(appId, 'Application ID should exist');

    const db = getDb();
    // 単体出張提出によって trip_events と trip_event_members が作成・リンクされていること
    const memberRow = db.prepare('SELECT * FROM trip_event_members WHERE application_id = ?').get(appId) as any;
    assert.ok(memberRow, 'trip_event_members record must be created for single trip application');
    assert.strictEqual(memberRow.user_id, teacher1.id);

    const tripEventRow = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(memberRow.trip_event_id) as any;
    assert.ok(tripEventRow, 'trip_events record must be linked');
    assert.strictEqual(tripEventRow.destination, '市立総合教育センター');
    assert.strictEqual(tripEventRow.purpose, '教育課程研究発表会');
  });
});
