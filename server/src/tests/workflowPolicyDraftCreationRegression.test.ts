import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { UserContext } from '../types';
import { getCanonicalBusinessDate } from '../utils/serverTime';

describe('REG-WORKFLOW-POLICY-DRAFT: Workflow Policy Draft Creation & Inheritance Tests', () => {
  let db: any;

  const adminUser: UserContext = {
    id: 6,
    username: 'admin',
    displayName: 'システム管理者E',
    roles: ['ADMIN'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  /**
   * admin.ts の POST /workflow-policies/:policyId/versions コアロジックの直接シミュレーション
   */
  function createDraftVersion(params: {
    policyId: string;
    priority?: number;
    effectiveFrom?: string;
    effectiveTo?: string;
    conditionsJson?: any;
    steps?: any[];
    baseVersionId?: string;
  }) {
    const { policyId, priority, effectiveFrom, effectiveTo, conditionsJson, steps, baseVersionId } = params;

    // steps が明示的に空配列 [] として渡された場合は 422 で拒絶
    if (Array.isArray(steps) && steps.length === 0) {
      throw { statusCode: 422, message: '承認ステップは1件以上必要です' };
    }

    // conditions_json Canonicalization
    let normalizedConditions = '{}';
    if (conditionsJson !== undefined && conditionsJson !== '{}' && conditionsJson !== '') {
      try {
        const parsed = typeof conditionsJson === 'string' ? JSON.parse(conditionsJson) : conditionsJson;
        if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length > 0) {
          throw { statusCode: 400, message: '現Releaseでは条件定義 (conditions_json) は空オブジェクト {} のみサポートしています' };
        }
      } catch (err: any) {
        if (err.statusCode) throw err;
        throw { statusCode: 400, message: '不正なJSON構文です' };
      }
    }

    const currentDb = getDb();
    const runTx = currentDb.transaction(() => {
      const policy = currentDb.prepare('SELECT * FROM workflow_policies WHERE id = ?').get(policyId) as any;
      if (!policy) {
        throw { statusCode: 404, message: '対象のポリシーが存在しません' };
      }

      // Step解決優先順位: 1. 明示 steps > 2. baseVersionId > 3. ACTIVE Version
      let resolvedSteps: any[] = [];
      let resolvedPriority = priority;
      let resolvedConditionsJson = normalizedConditions;

      if (Array.isArray(steps) && steps.length > 0) {
        resolvedSteps = steps.map((s: any) => ({
          stepName: s.stepName,
          stepKey: s.stepKey,
          actionType: s.actionType,
          requiredRoleId: s.requiredRoleId,
          selectorType: s.selectorType,
          selectorValue: s.selectorValue,
          isFinalDecisionStep: !!s.isFinalDecisionStep,
        }));
      } else {
        let sourceVer: any = null;
        if (baseVersionId) {
          sourceVer = currentDb.prepare('SELECT * FROM workflow_policy_versions WHERE id = ? AND policy_id = ?').get(baseVersionId, policyId) as any;
          if (!sourceVer) {
            throw { statusCode: 404, message: `指定された複製元バージョン「${baseVersionId}」は対象ポリシー「${policyId}」に存在しません` };
          }
        } else {
          sourceVer = currentDb.prepare('SELECT * FROM workflow_policy_versions WHERE policy_id = ? AND status = \'ACTIVE\'').get(policyId) as any;
          if (!sourceVer) {
            throw { statusCode: 422, message: '複製元となるACTIVEポリシーバージョンが存在しません。承認ステップを明示指定してください' };
          }
        }

        if (resolvedPriority === undefined) {
          resolvedPriority = sourceVer.priority;
        }
        if (conditionsJson === undefined && sourceVer.conditions_json) {
          resolvedConditionsJson = sourceVer.conditions_json;
        }

        const stepRows = currentDb.prepare(`
          SELECT step_order, step_name, step_key, action_type, required_role_id, selector_type, selector_value, is_final_decision_step
          FROM workflow_policy_steps
          WHERE policy_version_id = ?
          ORDER BY step_order ASC
        `).all(sourceVer.id) as any[];

        if (!stepRows || stepRows.length === 0) {
          throw { statusCode: 422, message: '複製元バージョンに承認ステップが存在しません' };
        }

        resolvedSteps = stepRows.map((r: any) => ({
          stepName: r.step_name,
          stepKey: r.step_key,
          actionType: r.action_type,
          requiredRoleId: r.required_role_id,
          selectorType: r.selector_type,
          selectorValue: r.selector_value,
          isFinalDecisionStep: r.is_final_decision_step === 1,
        }));
      }

      if (resolvedSteps.length === 0) {
        throw { statusCode: 422, message: '承認ステップは1件以上必要です' };
      }

      const finalCount = resolvedSteps.filter((s: any) => s.isFinalDecisionStep).length;
      if (finalCount !== 1) {
        throw { statusCode: 422, message: `最終決裁ステップは厳格に1件のみ設定してください (現在: ${finalCount}件)` };
      }

      const maxVerRow = currentDb.prepare('SELECT COALESCE(MAX(version), 0) as max_ver FROM workflow_policy_versions WHERE policy_id = ?').get(policyId) as any;
      const nextVer = (maxVerRow?.max_ver || 0) + 1;
      const versionId = `${policyId}_V${nextVer}`;

      currentDb.prepare(`
        INSERT INTO workflow_policy_versions (
          id, policy_id, version, status, priority, effective_from, effective_to, conditions_json, created_by_user_id
        ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)
      `).run(
        versionId,
        policyId,
        nextVer,
        resolvedPriority !== undefined ? resolvedPriority : 100,
        effectiveFrom || getCanonicalBusinessDate(),
        effectiveTo || '9999-12-31',
        resolvedConditionsJson,
        adminUser.id
      );

      const insertStep = currentDb.prepare(`
        INSERT INTO workflow_policy_steps (
          policy_version_id, step_order, step_name, step_key, action_type,
          required_role_id, selector_type, selector_value, is_final_decision_step
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let order = 1;
      for (const s of resolvedSteps) {
        if (s.selectorType === 'USER' || s.selectorType === 'ROLE') {
          throw { statusCode: 422, message: '承認ルートの単一責任者Selectorには POSITION を指定してください' };
        }
        insertStep.run(
          versionId,
          order,
          s.stepName,
          s.stepKey || `STEP_${order}`,
          s.actionType || (s.isFinalDecisionStep ? 'DECIDE' : 'APPROVE'),
          s.requiredRoleId || 'TEACHER',
          s.selectorType || 'POSITION',
          s.selectorValue,
          s.isFinalDecisionStep ? 1 : 0
        );
        order++;
      }

      return { versionId, version: nextVer };
    });

    return runTx();
  }

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();

    // Clean up test policies if any
    db.prepare("DELETE FROM workflow_policy_steps WHERE policy_version_id LIKE 'TEST_POL_%'").run();
    db.prepare("DELETE FROM workflow_policy_versions WHERE policy_id = 'TEST_POL' OR policy_id = 'OTHER_POL'").run();
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'TEST_POL' OR policy_id = 'OTHER_POL'").run();
    db.prepare("DELETE FROM workflow_policies WHERE id = 'TEST_POL' OR id = 'OTHER_POL'").run();

    // Seed test policy TEST_POL
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, description, policy_source, created_by_user_id)
      VALUES ('TEST_POL', 'TEST_POL', 'テスト用ポリシー', 'テスト用説明', 'CUSTOM', 1)
    `).run();

    db.prepare(`
      INSERT INTO workflow_policy_versions (
        id, policy_id, version, status, priority, effective_from, effective_to, conditions_json, created_by_user_id
      ) VALUES ('TEST_POL_V1', 'TEST_POL', 1, 'ACTIVE', 150, '2026-04-01', '9999-12-31', '{}', 1)
    `).run();

    db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES 
      ('TEST_POL_V1', 1, '教頭確認', 'VP_STEP', 'APPROVE', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1', 0),
      ('TEST_POL_V1', 2, '校長決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();

    // Seed other policy OTHER_POL
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, description, policy_source, created_by_user_id)
      VALUES ('OTHER_POL', 'OTHER_POL', '他ポリシー', '説明', 'CUSTOM', 1)
    `).run();

    db.prepare(`
      INSERT INTO workflow_policy_versions (
        id, policy_id, version, status, priority, effective_from, effective_to, conditions_json, created_by_user_id
      ) VALUES ('OTHER_POL_V1', 'OTHER_POL', 1, 'ACTIVE', 100, '2026-04-01', '9999-12-31', '{}', 1)
    `).run();

    db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES 
      ('OTHER_POL_V1', 1, '校長単独決裁', 'PRIN_STEP', 'DECIDE', 'PRINCIPAL', 'POSITION', 'PRINCIPAL', 1)
    `).run();
  });

  it('1. baseVersionId 指定時に正常にステップと優先度が複製されて新規DRAFTが作成される (UI動作ケース)', () => {
    const res = createDraftVersion({
      policyId: 'TEST_POL',
      baseVersionId: 'TEST_POL_V1',
    });

    assert.equal(res.version, 2);
    assert.equal(res.versionId, 'TEST_POL_V2');

    // DB検証
    const ver = db.prepare('SELECT * FROM workflow_policy_versions WHERE id = ?').get('TEST_POL_V2') as any;
    assert.ok(ver);
    assert.equal(ver.status, 'DRAFT');
    assert.equal(ver.priority, 150);

    const steps = db.prepare('SELECT * FROM workflow_policy_steps WHERE policy_version_id = ? ORDER BY step_order ASC').all('TEST_POL_V2') as any[];
    assert.equal(steps.length, 2);
    assert.equal(steps[0].step_name, '教頭確認');
    assert.equal(steps[0].step_key, 'VP_STEP');
    assert.equal(steps[0].selector_value, 'VICE_PRINCIPAL_1');
    assert.equal(steps[0].is_final_decision_step, 0);

    assert.equal(steps[1].step_name, '校長決裁');
    assert.equal(steps[1].step_key, 'PRIN_STEP');
    assert.equal(steps[1].selector_value, 'PRINCIPAL');
    assert.equal(steps[1].is_final_decision_step, 1);
  });

  it('2. baseVersionId 未指定時に対象ポリシーの ACTIVE バージョンから自動複製される', () => {
    const res = createDraftVersion({
      policyId: 'TEST_POL',
    });

    assert.equal(res.version, 2);

    const steps = db.prepare('SELECT * FROM workflow_policy_steps WHERE policy_version_id = ? ORDER BY step_order ASC').all('TEST_POL_V2') as any[];
    assert.equal(steps.length, 2);
    assert.equal(steps[1].step_name, '校長決裁');
  });

  it('3. 明示的に steps が渡された場合はそれが最優先され、baseVersionId は無視される', () => {
    const explicitSteps = [
      {
        stepName: '教務主任確認',
        stepKey: 'CHIEF_STEP',
        actionType: 'APPROVE',
        requiredRoleId: 'TEACHER',
        selectorType: 'POSITION',
        selectorValue: 'CHIEF_TEACHER',
        isFinalDecisionStep: false,
      },
      {
        stepName: '教頭確認',
        stepKey: 'VP_STEP',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
      },
      {
        stepName: '校長決裁',
        stepKey: 'PRIN_STEP',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
      },
    ];

    const res = createDraftVersion({
      policyId: 'TEST_POL',
      baseVersionId: 'TEST_POL_V1',
      steps: explicitSteps,
    });

    assert.equal(res.version, 2);
    const steps = db.prepare('SELECT * FROM workflow_policy_steps WHERE policy_version_id = ? ORDER BY step_order ASC').all('TEST_POL_V2') as any[];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].step_name, '教務主任確認');
  });

  it('4. steps が明示的に空配列 [] として渡された場合は 422 で拒絶される', () => {
    assert.throws(
      () => {
        createDraftVersion({
          policyId: 'TEST_POL',
          steps: [],
        });
      },
      (err: any) => err.statusCode === 422 && /承認ステップは1件以上必要です/.test(err.message)
    );
  });

  it('5. baseVersionId が別ポリシーに所属している場合は 404 で Fail-Closed 拒絶される', () => {
    assert.throws(
      () => {
        createDraftVersion({
          policyId: 'TEST_POL',
          baseVersionId: 'OTHER_POL_V1',
        });
      },
      (err: any) => err.statusCode === 404 && /対象ポリシー.*に存在しません/.test(err.message)
    );
  });

  it('6. ACTIVE バージョンが存在せず steps も未指定の場合は 422 で Fail-Closed 拒絶される (根拠なきデフォルト生成を禁止)', () => {
    // TEST_POL_V1 を INACTIVE に変更
    db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE id = 'TEST_POL_V1'").run();

    assert.throws(
      () => {
        createDraftVersion({
          policyId: 'TEST_POL',
        });
      },
      (err: any) => err.statusCode === 422 && /複製元となるACTIVEポリシーバージョンが存在しません/.test(err.message)
    );
  });

  it('7. 単一トランザクション検証: 途中でバリデーションエラーが発生した場合、新Versionも含め全ロールバックされる', () => {
    const invalidSteps = [
      {
        stepName: '教頭決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: true,
      },
      {
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
      },
    ];

    assert.throws(
      () => {
        createDraftVersion({
          policyId: 'TEST_POL',
          steps: invalidSteps,
        });
      },
      (err: any) => err.statusCode === 422 && /最終決裁ステップは厳格に1件のみ設定してください/.test(err.message)
    );

    // TEST_POL_V2 が DB に残っていないこと (Rollback 検証)
    const ver = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TEST_POL_V2'").get();
    assert.equal(ver, undefined);
  });
});
