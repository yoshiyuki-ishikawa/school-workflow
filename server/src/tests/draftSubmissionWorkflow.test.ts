import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

describe('下書き申請の正式提出・編集（Draft Submission）包括的テストスイート', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '教員 太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher2: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '教員 次郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  describe('Lifecycle & State Transitions', () => {
    it('DRAFT-TEST-001: 本人申請: 下書き作成 → 下書き編集・更新 → 正式提出 → Cycle 1 & Step生成 → 通常承認フロー完遂', () => {
      // 1. 下書き作成 (DRAFT, version=1, Cycle/Stepなし)
      const createRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】下書き1',
        formData: {
          unitType: 'DAY',
          startDate: '2026-10-10',
          endDate: '2026-10-10',
          calculatedDays: 1,
          reason: '私用のため',
        },
      });
      assert.equal(createRes.success, true);
      assert.equal(createRes.statusCode, 201);
      const appId = createRes.data?.id!;
      assert.ok(appId > 0);

      // DB検証: DRAFT, version=1, cycles=0, steps=0
      let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'DRAFT');
      assert.equal(app.version, 1);
      assert.equal(app.submission_actor_type, 'SELF');
      let cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId);
      assert.equal(cycles.length, 0);
      let steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ?').all(appId);
      assert.equal(steps.length, 0);

      // 2. 下書き更新 (expectedVersion=1 -> version=2)
      const updateRes = WorkflowEngine.saveDraft(teacher1, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】下書き1（更新済み）',
        formData: {
          unitType: 'DAY',
          startDate: '2026-10-12',
          endDate: '2026-10-12',
          calculatedDays: 1,
          reason: '私用のため（更新）',
        },
      });
      assert.equal(updateRes.success, true);
      assert.equal(updateRes.statusCode, 200);

      app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.title, '【年休】下書き1（更新済み）');
      assert.equal(app.version, 2);
      assert.equal(app.current_status, 'DRAFT');

      // 3. 正式提出 (expectedVersion=2 -> SUBMITTED, version=3, Cycle 1 & Steps生成)
      const submitRes = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 2,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】正式提出版',
        formData: {
          unitType: 'DAY',
          startDate: '2026-10-14',
          endDate: '2026-10-14',
          calculatedDays: 1,
          reason: '私用のため（正式提出）',
        },
      });
      assert.equal(submitRes.success, true);
      assert.equal(submitRes.statusCode, 200);
      assert.equal(submitRes.data?.id, appId); // ID同一性

      // DB検証: SUBMITTED, version=3, active Cycle Exactly 1
      app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'SUBMITTED');
      assert.equal(app.version, 3);
      assert.equal(app.current_step_order, 1);

      cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId) as any[];
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].approval_cycle, 1);
      assert.equal(cycles[0].status, 'IN_PROGRESS');

      steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
      assert.ok(steps.length > 0);
      assert.equal(steps[0].status, 'PENDING');
      const finalSteps = steps.filter((s: any) => s.step_order === steps.length);
      assert.equal(finalSteps.length, 1);

      // 4. 教頭による第1段階承認 (IN_APPROVAL)
      const approveRes1 = WorkflowEngine.approveApplication(vicePrincipal, {
        applicationId: appId,
        expectedVersion: 3,
        comment: '教頭確認OK',
      });
      assert.equal(approveRes1.success, true);

      app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'IN_APPROVAL');
      assert.equal(app.version, 4);

      // 5. 校長による最終決裁 (FINAL_APPROVED)
      const approveRes2 = WorkflowEngine.approveApplication(principal, {
        applicationId: appId,
        expectedVersion: 4,
        comment: '校長決裁完了',
      });
      assert.equal(approveRes2.success, true);

      app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'FINAL_APPROVED');
      assert.equal(app.version, 5);
    });

    it('DRAFT-TEST-002: 代理申請: 下書き作成 → 正式提出 → 代理スナップショット・Cycle 1固定', () => {
      // 教頭が teacher1 の代理下書きを作成
      const draftRes = WorkflowEngine.saveDraft(vicePrincipal, {
        typeId: 'LEAVE_ANNUAL',
        subjectUserId: teacher1.id,
        title: '【年休】代理下書き',
        formData: {
          unitType: 'DAY',
          startDate: '2026-10-15',
          endDate: '2026-10-15',
          calculatedDays: 1,
        },
      });
      assert.equal(draftRes.success, true);
      const appId = draftRes.data?.id!;

      let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.submission_actor_type, 'PROXY');
      assert.equal(app.subject_user_id, teacher1.id);
      assert.equal(app.submitted_by_user_id, vicePrincipal.id);
      assert.equal(app.current_status, 'DRAFT');

      // 代理提出実行
      const submitRes = WorkflowEngine.submitProxyApplication(vicePrincipal, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        subjectUserId: teacher1.id,
        title: '【年休】代理提出版',
        formData: {
          unitType: 'DAY',
          startDate: '2026-10-15',
          endDate: '2026-10-15',
          calculatedDays: 1,
        },
        proxyReason: '急用のため教頭代理起案',
      });
      assert.equal(submitRes.success, true);

      app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'SUBMITTED');
      assert.equal(app.submission_actor_type, 'PROXY');
      assert.equal(app.version, 2);

      const cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId);
      assert.equal(cycles.length, 1);
    });

    it('DRAFT-TEST-003: SUBMITTED 以降の申請を Draft Submit 経路で送信した場合は 400 で拒絶', () => {
      const submitRes1 = WorkflowEngine.submitApplication(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】初回直接提出',
        formData: { unitType: 'DAY', startDate: '2026-10-20', endDate: '2026-10-20', calculatedDays: 1 },
      });
      const appId = submitRes1.data?.id!;

      // 既に SUBMITTED の申請に対して Draft Submit を試行
      const reSubmitRes = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】再提出試行',
        formData: { unitType: 'DAY', startDate: '2026-10-20', endDate: '2026-10-20', calculatedDays: 1 },
      });
      assert.equal(reSubmitRes.success, false);
      assert.equal(reSubmitRes.statusCode, 400);
      assert.equal(reSubmitRes.errorCode, 'INVALID_STATUS_FOR_DRAFT_SUBMIT');
    });

    it('DRAFT-TEST-004: RETURNED 状態の申請を Draft Submit 経路で送信した場合は 400 で拒絶（resubmit専用APIを強制）', () => {
      const submitRes = WorkflowEngine.submitApplication(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】提出後差戻しテスト',
        formData: { unitType: 'DAY', startDate: '2026-10-22', endDate: '2026-10-22', calculatedDays: 1 },
      });
      const appId = submitRes.data?.id!;

      // 教頭が差戻し
      WorkflowEngine.returnApplication(vicePrincipal, { applicationId: appId, expectedVersion: 1, comment: '修正願います' });

      let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'RETURNED');
      assert.equal(app.version, 2);

      // Draft Submit 経路で再提出を試みる -> 拒絶
      const draftSubmitRes = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 2,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】差戻しをドラフト提出しようとする',
        formData: { unitType: 'DAY', startDate: '2026-10-22', endDate: '2026-10-22', calculatedDays: 1 },
      });
      assert.equal(draftSubmitRes.success, false);
      assert.equal(draftSubmitRes.statusCode, 400);
      assert.equal(draftSubmitRes.errorCode, 'INVALID_STATUS_FOR_DRAFT_SUBMIT');
    });

    it('DRAFT-TEST-005: FINAL_APPROVED の完了済み申請を Draft Submit 経路で送信した場合は 400 または 409 で拒絶', () => {
      const submitRes = WorkflowEngine.submitApplication(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】完了済みテスト',
        formData: { unitType: 'DAY', startDate: '2026-10-25', endDate: '2026-10-25', calculatedDays: 1 },
      });
      const appId = submitRes.data?.id!;
      WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: 1, comment: 'OK' });
      WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: 2, comment: '承認' });

      const reSubmitRes = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 3,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】完了済みの再提出試行',
        formData: { unitType: 'DAY', startDate: '2026-10-25', endDate: '2026-10-25', calculatedDays: 1 },
      });
      assert.equal(reSubmitRes.success, false);
      assert.ok([400, 409].includes(reSubmitRes.statusCode));
    });
  });

  describe('Idempotency & Concurrency Control', () => {
    it('DRAFT-TEST-006: 同一DRAFTに対する連続2回Submit（重複リクエスト）で2回目は 409 Conflict となりCycle/Stepが増殖しない', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】重複提出テスト',
        formData: { unitType: 'DAY', startDate: '2026-10-28', endDate: '2026-10-28', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      // 1回目の提出 (version=1 -> version=2, SUBMITTED)
      const submit1 = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】重複提出テスト',
        formData: { unitType: 'DAY', startDate: '2026-10-28', endDate: '2026-10-28', calculatedDays: 1 },
      });
      assert.equal(submit1.success, true);
      assert.equal(submit1.statusCode, 200);

      // 2回目の提出（重複送信: expectedVersion=1 のまま）
      const submit2 = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】重複提出テスト',
        formData: { unitType: 'DAY', startDate: '2026-10-28', endDate: '2026-10-28', calculatedDays: 1 },
      });
      assert.equal(submit2.success, false);
      assert.equal(submit2.statusCode, 409);
      assert.equal(submit2.errorCode, 'CONFLICT_DETECTED');

      // Cycle / Step が Exactly 1 であることの検証
      const cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId);
      assert.equal(cycles.length, 1);
      const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ?').all(appId);
      assert.equal(steps.length, 2); // 教頭、校長の2ステップ
    });

    it('DRAFT-TEST-007: expectedVersion 不一致による下書き更新は 409 Conflict', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】不整合テスト',
        formData: { unitType: 'DAY', startDate: '2026-11-01', endDate: '2026-11-01', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      // version=1 に対し expectedVersion=99 で更新試行
      const updateRes = WorkflowEngine.saveDraft(teacher1, {
        id: appId,
        expectedVersion: 99,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】不正バージョン更新',
        formData: { unitType: 'DAY', startDate: '2026-11-01', endDate: '2026-11-01', calculatedDays: 1 },
      });
      assert.equal(updateRes.success, false);
      assert.equal(updateRes.statusCode, 409);
      assert.equal(updateRes.errorCode, 'CONFLICT_DETECTED');

      // DBが変更されていないこと
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.version, 1);
      assert.equal(app.title, '【年休】不整合テスト');
    });

    it('DRAFT-TEST-008: expectedVersion 不一致による正式提出は 409 Conflict で DRAFT 維持', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】不整合提出テスト',
        formData: { unitType: 'DAY', startDate: '2026-11-02', endDate: '2026-11-02', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      const submitRes = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 99,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】不正バージョン提出',
        formData: { unitType: 'DAY', startDate: '2026-11-02', endDate: '2026-11-02', calculatedDays: 1 },
      });
      assert.equal(submitRes.success, false);
      assert.equal(submitRes.statusCode, 409);
      assert.equal(submitRes.errorCode, 'CONFLICT_DETECTED');

      // DRAFT のまま、Cycle/Step 未生成
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'DRAFT');
      assert.equal(app.version, 1);

      const cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId);
      assert.equal(cycles.length, 0);
    });

    it('DRAFT-TEST-008B: expectedVersion 未指定での既存DRAFT提出・更新は 400 Bad Request (VERSION_REQUIRED)', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】必須チェックテスト',
        formData: { unitType: 'DAY', startDate: '2026-11-03', endDate: '2026-11-03', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      const submitRes = WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        // expectedVersion 省略
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】バージョン省略提出',
        formData: { unitType: 'DAY', startDate: '2026-11-03', endDate: '2026-11-03', calculatedDays: 1 },
      });
      assert.equal(submitRes.success, false);
      assert.equal(submitRes.statusCode, 400);
      assert.equal(submitRes.errorCode, 'VERSION_REQUIRED');
    });
  });

  describe('Authorization & Server-Owned Identity', () => {
    it('DRAFT-TEST-009: 他人の SELF DRAFT を別教員が正式提出しようとすると 403 Forbidden', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】教員1の下書き',
        formData: { unitType: 'DAY', startDate: '2026-11-05', endDate: '2026-11-05', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      // teacher2 が teacher1 の下書きを勝手に提出
      const submitRes = WorkflowEngine.submitApplication(teacher2, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】乗っ取り提出',
        formData: { unitType: 'DAY', startDate: '2026-11-05', endDate: '2026-11-05', calculatedDays: 1 },
      });
      assert.equal(submitRes.success, false);
      assert.equal(submitRes.statusCode, 403);
      assert.equal(submitRes.errorCode, 'FORBIDDEN_SELF_SUBMIT');

      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.equal(app.current_status, 'DRAFT');
    });

    it('DRAFT-TEST-010: 他人の下書きを別教員が更新しようとすると 403 Forbidden', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】教員1の下書き',
        formData: { unitType: 'DAY', startDate: '2026-11-06', endDate: '2026-11-06', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      const updateRes = WorkflowEngine.saveDraft(teacher2, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】乗っ取り更新',
        formData: { unitType: 'DAY', startDate: '2026-11-06', endDate: '2026-11-06', calculatedDays: 1 },
      });
      assert.equal(updateRes.success, false);
      assert.equal(updateRes.statusCode, 403);
    });

    it('DRAFT-TEST-011: 一般教員による代理下書き作成は 403 Forbidden で遮断', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        subjectUserId: teacher2.id, // teacher2の代理
        title: '【年休】不正代理下書き',
        formData: { unitType: 'DAY', startDate: '2026-11-07', endDate: '2026-11-07', calculatedDays: 1 },
      });
      assert.equal(draftRes.success, false);
      assert.equal(draftRes.statusCode, 403);
    });
  });

  describe('Forensic Audit Trail & Rollback Integrity', () => {
    it('DRAFT-TEST-012: ポリシー未解決エラー時、Application は DRAFT のまま完全ロールバックされる', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】ロールバックテスト',
        formData: { unitType: 'DAY', startDate: '2026-11-10', endDate: '2026-11-10', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      try {
        // 該当ポリシーを非アクティブにして解決不能にする
        db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE policy_id = 'LEAVE_ANNUAL_STANDARD'").run();

        const submitRes = WorkflowEngine.submitApplication(teacher1, {
          id: appId,
          expectedVersion: 1,
          typeId: 'LEAVE_ANNUAL',
          title: '【年休】ロールバックテスト提出',
          formData: { unitType: 'DAY', startDate: '2026-11-10', endDate: '2026-11-10', calculatedDays: 1 },
        });
        assert.equal(submitRes.success, false);
        assert.ok([400, 422, 500].includes(submitRes.statusCode));

        // Rollback検証: Application は DRAFT のまま、Cycles 0件、Steps 0件
        const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
        assert.equal(app.current_status, 'DRAFT');
        assert.equal(app.version, 1);

        const cycles = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ?').all(appId);
        assert.equal(cycles.length, 0);
        const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ?').all(appId);
        assert.equal(steps.length, 0);
      } finally {
        // 後続のテストスイートに影響を与えないようACTIVEに復旧
        db.prepare("UPDATE workflow_policy_versions SET status = 'ACTIVE' WHERE policy_id = 'LEAVE_STANDARD'").run();
      }
    });

    it('DRAFT-TEST-014: DRAFT作成・更新・提出の監査ログチェーン整合性検証', () => {
      const draftRes = WorkflowEngine.saveDraft(teacher1, {
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】Auditテスト',
        formData: { unitType: 'DAY', startDate: '2026-11-12', endDate: '2026-11-12', calculatedDays: 1 },
      });
      const appId = draftRes.data?.id!;

      WorkflowEngine.saveDraft(teacher1, {
        id: appId,
        expectedVersion: 1,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】Auditテスト更新',
        formData: { unitType: 'DAY', startDate: '2026-11-12', endDate: '2026-11-12', calculatedDays: 1 },
      });

      WorkflowEngine.submitApplication(teacher1, {
        id: appId,
        expectedVersion: 2,
        typeId: 'LEAVE_ANNUAL',
        title: '【年休】Auditテスト提出',
        formData: { unitType: 'DAY', startDate: '2026-11-12', endDate: '2026-11-12', calculatedDays: 1 },
      });

      const auditLogs = db.prepare('SELECT * FROM audit_logs WHERE entity_id = ? ORDER BY id ASC').all(String(appId)) as any[];
      assert.ok(auditLogs.length >= 3);

      const actions = auditLogs.map((l) => l.action);
      assert.ok(actions.includes('CREATE_DRAFT'));
      assert.ok(actions.includes('UPDATE_DRAFT'));
      assert.ok(actions.includes('SELF_SUBMIT'));

      // ハッシュチェーンが形成されていること
      for (let i = 1; i < auditLogs.length; i++) {
        assert.ok(auditLogs[i].event_hash.length === 64); // SHA-256
        assert.ok(auditLogs[i].prev_hash.length > 0);
      }
    });
  });
});
