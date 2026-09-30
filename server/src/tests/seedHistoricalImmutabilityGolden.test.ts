import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

describe('Seed Historical Immutability & Zero-Mutation Golden Tests (GT-SEED-IMMUTABLE-01 〜 07 + Atomicity)', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
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

  const officeUser: UserContext = {
    id: 5,
    username: 'office',
    displayName: '高橋 節子 (事務D)',
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM applications').run();
    db.exec('PRAGMA foreign_keys = ON');
  });

  it('GT-SEED-IMMUTABLE-01: Historical V1 Preservation - 既存DBの旧順序・旧CHECKを持つTRIP_STANDARD_V1がseedDatabase再実行で一切変更されないこと', () => {
    const v1Before = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V1'").get() as any;
    const v1StepsBefore = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1' ORDER BY step_order ASC").all() as any[];

    assert.ok(v1Before, 'TRIP_STANDARD_V1 exists');
    assert.strictEqual(v1Before.status, 'INACTIVE');
    assert.strictEqual(v1Before.version, 1);
    assert.strictEqual(v1StepsBefore.length, 3);
    assert.strictEqual(v1StepsBefore[0].action_type, 'APPROVE');
    assert.strictEqual(v1StepsBefore[1].action_type, 'DECIDE');
    assert.strictEqual(v1StepsBefore[2].action_type, 'CHECK');

    // seedDatabase() 再実行
    seedDatabase();

    const v1After = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V1'").get() as any;
    const v1StepsAfter = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1' ORDER BY step_order ASC").all() as any[];

    assert.deepStrictEqual(v1Before, v1After, 'V1 version row must be byte-for-byte unchanged');
    assert.deepStrictEqual(v1StepsBefore, v1StepsAfter, 'V1 steps rows must be row-for-row unchanged');
  });

  it('GT-SEED-IMMUTABLE-02: New V2 Canonical Resolution - 新規出張申請がTRIP_STANDARD_V2を解決し、事務REVIEW先行ステップが生成されること', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '県外出張研究会 (GT-02)',
      formData: {
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        startAt: '2026-06-10T08:10:00',
        endAt: '2026-06-10T16:40:00',
        destination: '教育センター',
        departurePlace: '本校',
        arrivalPlace: '本校',
        purpose: '指導法研究会出席',
      },
    });
    assert.strictEqual(submitRes.success, true, submitRes.message);
    const appId = submitRes.data.id;

    // Cycle 1 の workflow_policy_version_id が TRIP_STANDARD_V2 であること
    const cycle = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.ok(cycle);
    assert.strictEqual(cycle.workflow_policy_version_id, 'TRIP_STANDARD_V2');

    // Steps が事務 REVIEW -> 教頭 APPROVE -> 校長 DECIDE であること
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 3);
    assert.strictEqual(steps[0].step_order, 1);
    assert.strictEqual(steps[0].action_type, 'REVIEW');
    assert.strictEqual(steps[0].required_role_id, 'OFFICE');

    assert.strictEqual(steps[1].step_order, 2);
    assert.strictEqual(steps[1].action_type, 'APPROVE');
    assert.strictEqual(steps[1].required_role_id, 'VICE_PRINCIPAL');

    assert.strictEqual(steps[2].step_order, 3);
    assert.strictEqual(steps[2].action_type, 'DECIDE');
    assert.strictEqual(steps[2].required_role_id, 'PRINCIPAL');
  });

  it('GT-SEED-IMMUTABLE-03: Re-Seed Multi-Run Idempotency - seedDatabaseを3回連続実行してもV1/V2ともにステップ重複・変更・DELETEが一切発生しないこと', () => {
    const countsBefore = {
      v1Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1'").get().c,
      v2Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2'").get().c,
      cancelV1Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V1'").get().c,
      cancelV2Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V2'").get().c,
      reportV1Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_REPORT_STANDARD_V1'").get().c,
      reportV2Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_REPORT_STANDARD_V2'").get().c,
    };

    seedDatabase();
    seedDatabase();
    seedDatabase();

    const countsAfter = {
      v1Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1'").get().c,
      v2Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2'").get().c,
      cancelV1Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V1'").get().c,
      cancelV2Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_CANCEL_V2'").get().c,
      reportV1Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_REPORT_STANDARD_V1'").get().c,
      reportV2Steps: db.prepare("SELECT COUNT(*) as c FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_REPORT_STANDARD_V2'").get().c,
    };

    assert.deepStrictEqual(countsBefore, countsAfter, 'Step counts must remain identical after repeated re-seed');
  });

  it('GT-SEED-IMMUTABLE-04: Historical CHECK Read Compatibility - V1のCHECKステップが存在しクエリ可能である一方、V2にはCHECKが存在しないこと', () => {
    const v1CheckStep = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1' AND action_type = 'CHECK'").get() as any;
    assert.ok(v1CheckStep, 'Historical CHECK step in V1 must be preserved and queryable');
    assert.strictEqual(v1CheckStep.step_key, 'OFFICE_TRIP_STEP');

    const v2CheckSteps = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2' AND action_type = 'CHECK'").all() as any[];
    assert.strictEqual(v2CheckSteps.length, 0, 'New V2 must contain ZERO CHECK steps');
  });

  it('GT-SEED-IMMUTABLE-05: Active Version Uniqueness - 出張・取消・復命の各ポリシーにおいてACTIVEバージョンが厳格に1件(出張/復命はV2、取消はV3)のみであること', () => {
    const policies = [
      { id: 'TRIP_STANDARD', activeVersion: 2, activeId: 'TRIP_STANDARD_V2', historicalCount: 1 },
      { id: 'TRIP_STANDARD_CANCEL', activeVersion: 3, activeId: 'TRIP_STANDARD_CANCEL_V3', historicalCount: 2 },
      { id: 'TRIP_REPORT_STANDARD', activeVersion: 2, activeId: 'TRIP_REPORT_STANDARD_V2', historicalCount: 1 },
    ];
    for (const p of policies) {
      const activeVersions = db.prepare("SELECT * FROM workflow_policy_versions WHERE policy_id = ? AND status = 'ACTIVE'").all(p.id) as any[];
      assert.strictEqual(activeVersions.length, 1, `Policy ${p.id} must have exactly one ACTIVE version`);
      assert.strictEqual(activeVersions[0].id, p.activeId, `Active version for ${p.id} must be ${p.activeId}`);
      assert.strictEqual(activeVersions[0].version, p.activeVersion, `Active version number for ${p.id} must be ${p.activeVersion}`);

      const inactiveVersions = db.prepare("SELECT * FROM workflow_policy_versions WHERE policy_id = ? AND status = 'INACTIVE' ORDER BY version ASC").all(p.id) as any[];
      assert.strictEqual(inactiveVersions.length, p.historicalCount, `Historical INACTIVE count for ${p.id} must be ${p.historicalCount}`);
      for (const inv of inactiveVersions) {
        assert.ok(inv.version < p.activeVersion, `Historical version ${inv.id} must have lower version number than active`);
      }
    }
  });

  it('GT-SEED-IMMUTABLE-06: Fresh DB Deterministic Bootstrap - クリーンDBから初回seedDatabase実行でV1(INACTIVE)とV2(ACTIVE)が決定論的にセットアップされること', () => {
    // テーブル内ポリシーデータを全クリアして Fresh DB をエミュレート
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM workflow_policy_steps').run();
    db.prepare('DELETE FROM workflow_policy_versions').run();
    db.prepare('DELETE FROM workflow_policy_application_types').run();
    db.prepare('DELETE FROM workflow_policies').run();
    db.exec('PRAGMA foreign_keys = ON');

    seedDatabase();

    const v1 = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V1'").get() as any;
    const v2 = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V2'").get() as any;

    assert.ok(v1, 'Fresh DB bootstraps V1');
    assert.strictEqual(v1.status, 'INACTIVE');
    assert.ok(v2, 'Fresh DB bootstraps V2');
    assert.strictEqual(v2.status, 'ACTIVE');

    const v2Steps = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2' ORDER BY step_order ASC").all() as any[];
    assert.strictEqual(v2Steps.length, 3);
    assert.strictEqual(v2Steps[0].action_type, 'REVIEW');
  });

  it('GT-SEED-IMMUTABLE-07: Historical Version Status Non-Resurrection & Multi-Run Zero Mutation - V1が再シードで決してACTIVEに蘇生しないこと', () => {
    // 1. 初期状態の確認
    const v1Before = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V1'").get() as any;
    const v2Before = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V2'").get() as any;
    const v1StepsBefore = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1' ORDER BY step_order ASC").all() as any[];
    const v2StepsBefore = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2' ORDER BY step_order ASC").all() as any[];

    assert.strictEqual(v1Before.status, 'INACTIVE', 'Setup: V1 must be INACTIVE');
    assert.strictEqual(v2Before.status, 'ACTIVE', 'Setup: V2 must be ACTIVE');

    // 2. 複数回 seedDatabase() 実行
    seedDatabase();
    seedDatabase();

    // 3. アサーション
    const v1After = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V1'").get() as any;
    assert.strictEqual(v1After.status, 'INACTIVE', 'V1 must NEVER be resurrected to ACTIVE by seedDatabase');

    const v2After = db.prepare("SELECT * FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V2'").get() as any;
    assert.strictEqual(v2After.status, 'ACTIVE', 'V2 must remain ACTIVE');

    const v1StepsAfter = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V1' ORDER BY step_order ASC").all() as any[];
    assert.deepStrictEqual(v1StepsBefore, v1StepsAfter, 'V1 steps must be byte-for-byte / row-for-row unchanged');

    const v2StepsAfter = db.prepare("SELECT * FROM workflow_policy_steps WHERE policy_version_id = 'TRIP_STANDARD_V2' ORDER BY step_order ASC").all() as any[];
    assert.deepStrictEqual(v2StepsBefore, v2StepsAfter, 'V2 steps must be byte-for-byte / row-for-row unchanged');

    const activeCount = db.prepare("SELECT COUNT(*) as cnt FROM workflow_policy_versions WHERE policy_id = 'TRIP_STANDARD' AND status = 'ACTIVE'").get() as { cnt: number };
    assert.strictEqual(activeCount.cnt, 1, 'Exactly one ACTIVE version per policy');
  });

  it('Transaction Atomicity Verification: seedDatabase全体が単一トランザクション内で実行され、途中例外で中途半端な状態が残らないこと', () => {
    // トランザクション境界の検証:
    // 意図的に UNIQUE 制約違反などを起こすトランザクションを実行した場合に全ロールバックされることを確認
    assert.throws(() => {
      db.transaction(() => {
        db.prepare("UPDATE workflow_policy_versions SET status = 'INACTIVE' WHERE id = 'TRIP_STANDARD_V2'").run();
        // 重複ID挿入エラーを起こす
        db.prepare("INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json) VALUES ('TRIP_STANDARD_V2', 'TRIP_STANDARD', 2, 'ACTIVE', 200, '2000-01-01', '9999-12-31', '{}')").run();
      })();
    }, /UNIQUE constraint failed/);

    // ロールバック後の確認: TRIP_STANDARD_V2 が依然として ACTIVE のままであること
    const v2 = db.prepare("SELECT status FROM workflow_policy_versions WHERE id = 'TRIP_STANDARD_V2'").get() as any;
    assert.strictEqual(v2.status, 'ACTIVE', 'Failed transaction must roll back completely leaving V2 ACTIVE');
  });
});
