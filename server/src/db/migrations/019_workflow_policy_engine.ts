import { Migration } from './migrator';
import { Database } from 'better-sqlite3';

/**
 * Migration 019: 完全 Policy-Driven 承認フロー基盤 ＆ Canonical Workflow Cycle 導入
 * 
 * 1. workflow_policies: 論理ポリシー定義テーブル (N:M対応)
 * 2. workflow_policy_application_types: 申請種別とポリシーの N:M 関連テーブル
 * 3. workflow_policy_versions: イミュータブルなポリシーバージョン
 * 4. workflow_policy_steps: バージョン所属ステップ定義 (POSITION / ROLE のみ, is_final_decision_step制約)
 * 5. application_workflow_cycles: 承認世代正本テーブル (CHECK制約: NEW_POLICY_ENGINE vs LEGACY_SNAPSHOT)
 * 6. application_approval_steps への workflow_cycle_id 追加
 * 7. 既存 approval_routes / approval_route_steps / application_types の機械的・決定論的昇格 (推測なし)
 * 8. 既存 applications / approval_steps の LEGACY_SNAPSHOT 化 (推測による過去Policy Version紐付け禁止)
 * 9. 件数整合性検証 (不一致時はFail-Closed例外)
 */
export const migration019: Migration = {
  version: 19,
  name: 'workflow_policy_engine_and_canonical_cycles',
  up: (db: Database) => {
    // 1. workflow_policies テーブル作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_policies (
        id TEXT PRIMARY KEY,
        policy_key TEXT NOT NULL UNIQUE,
        policy_name TEXT NOT NULL,
        description TEXT,
        policy_source TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (policy_source IN ('LEGACY_MIGRATED', 'TEMPLATE', 'CUSTOM', 'SYSTEM')),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        created_by_user_id INTEGER REFERENCES users(id)
      );
    `);

    // 2. workflow_policy_application_types 関連テーブル作成 (N:M)
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_policy_application_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_id TEXT NOT NULL REFERENCES workflow_policies(id) ON DELETE CASCADE,
        app_type_id TEXT NOT NULL REFERENCES application_types(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(policy_id, app_type_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wpat_app_type ON workflow_policy_application_types(app_type_id);
    `);

    // 3. workflow_policy_versions テーブル作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_policy_versions (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL REFERENCES workflow_policies(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
        priority INTEGER NOT NULL DEFAULT 100,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL DEFAULT '9999-12-31',
        conditions_json TEXT NOT NULL DEFAULT '{}',
        is_used INTEGER NOT NULL DEFAULT 0,
        retired_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        created_by_user_id INTEGER REFERENCES users(id),
        UNIQUE(policy_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_wpv_policy_status ON workflow_policy_versions(policy_id, status);
    `);

    // 4. workflow_policy_steps テーブル作成
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_policy_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_version_id TEXT NOT NULL REFERENCES workflow_policy_versions(id) ON DELETE RESTRICT,
        step_order INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        step_key TEXT NOT NULL,
        action_type TEXT NOT NULL DEFAULT 'APPROVE' CHECK (action_type IN ('REVIEW', 'APPROVE', 'DECIDE', 'ORDER', 'CHECK')),
        required_role_id TEXT NOT NULL REFERENCES roles(id),
        selector_type TEXT NOT NULL DEFAULT 'POSITION' CHECK (selector_type IN ('POSITION', 'ROLE')),
        selector_value TEXT NOT NULL,
        is_final_decision_step INTEGER NOT NULL DEFAULT 0 CHECK (is_final_decision_step IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(policy_version_id, step_order),
        UNIQUE(policy_version_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS idx_wps_version ON workflow_policy_steps(policy_version_id);
    `);

    // 5. application_workflow_cycles テーブル作成 (CHECK制約付き)
    db.exec(`
      CREATE TABLE IF NOT EXISTS application_workflow_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        approval_cycle INTEGER NOT NULL,
        workflow_source TEXT NOT NULL DEFAULT 'NEW_POLICY_ENGINE' CHECK (workflow_source IN ('NEW_POLICY_ENGINE', 'LEGACY_SNAPSHOT')),
        workflow_policy_version_id TEXT REFERENCES workflow_policy_versions(id),
        policy_evaluation_at TEXT,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN')),
        started_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        started_by_user_id INTEGER REFERENCES users(id),
        ended_at TEXT,
        return_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now')),
        UNIQUE(application_id, approval_cycle),
        CHECK (
          (workflow_source = 'NEW_POLICY_ENGINE' AND workflow_policy_version_id IS NOT NULL AND policy_evaluation_at IS NOT NULL AND started_by_user_id IS NOT NULL)
          OR
          (workflow_source = 'LEGACY_SNAPSHOT')
        )
      );
      CREATE INDEX IF NOT EXISTS idx_awc_app_cycle ON application_workflow_cycles(application_id, approval_cycle);
    `);

    // 6. application_approval_steps への workflow_cycle_id 追加
    const stepCols = db.prepare('PRAGMA table_info(application_approval_steps)').all() as { name: string }[];
    const stepColNames = new Set(stepCols.map((c) => c.name));
    if (!stepColNames.has('workflow_cycle_id')) {
      db.exec('ALTER TABLE application_approval_steps ADD COLUMN workflow_cycle_id INTEGER REFERENCES application_workflow_cycles(id)');
    }

    // 7. 既存 approval_routes / approval_route_steps の機械的・決定論的昇格 (業務意味推測なし)
    const legacyRoutes = db.prepare('SELECT * FROM approval_routes ORDER BY id ASC').all() as any[];
    const legacyRouteSteps = db.prepare('SELECT * FROM approval_route_steps ORDER BY route_id ASC, step_order ASC').all() as any[];
    const legacyAppTypes = db.prepare('SELECT id, default_route_id FROM application_types WHERE default_route_id IS NOT NULL').all() as any[];

    const insertPolicy = db.prepare(`
      INSERT OR IGNORE INTO workflow_policies (id, policy_key, policy_name, description, policy_source)
      VALUES (?, ?, ?, ?, 'LEGACY_MIGRATED')
    `);

    const insertVersion = db.prepare(`
      INSERT OR IGNORE INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES (?, ?, 1, 'ACTIVE', 100, '2000-01-01', '9999-12-31', '{}')
    `);

    const insertStep = db.prepare(`
      INSERT OR IGNORE INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertNtoM = db.prepare(`
      INSERT OR IGNORE INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES (?, ?)
    `);

    // 各 route の最大 step_order を算出
    const maxStepMap = new Map<number, number>();
    for (const rs of legacyRouteSteps) {
      const curMax = maxStepMap.get(rs.route_id) || 0;
      if (rs.step_order > curMax) {
        maxStepMap.set(rs.route_id, rs.step_order);
      }
    }

    for (const r of legacyRoutes) {
      const policyId = `LEGACY_ROUTE_${r.id}`;
      const policyKey = `LEGACY_ROUTE_${r.id}`;
      const policyName = r.name || `旧承認ルート ${r.id}`;
      const desc = r.description || '移行された承認ルート';
      const versionId = `LEGACY_ROUTE_${r.id}_V1`;

      insertPolicy.run(policyId, policyKey, policyName, desc);
      insertVersion.run(versionId, policyId);
    }

    for (const rs of legacyRouteSteps) {
      const versionId = `LEGACY_ROUTE_${rs.route_id}_V1`;
      const isMax = rs.step_order === (maxStepMap.get(rs.route_id) || 1);
      const selType = rs.selector_type === 'POSITION' ? 'POSITION' : 'ROLE';
      const selVal = rs.selector_value || rs.required_role_id;
      const stepKey = rs.step_key || `STEP_${rs.step_order}`;
      const actionType = isMax ? 'DECIDE' : 'APPROVE';

      insertStep.run(
        versionId,
        rs.step_order,
        rs.step_name,
        stepKey,
        actionType,
        rs.required_role_id,
        selType,
        selVal,
        isMax ? 1 : 0
      );
    }

    // application_types の default_route_id 関連を決定論的に N:M テーブルへ登録
    for (const at of legacyAppTypes) {
      const policyId = `LEGACY_ROUTE_${at.default_route_id}`;
      insertNtoM.run(policyId, at.id);
    }

    // 8. 既存の applications & application_approval_steps の LEGACY_SNAPSHOT 化
    // ※ 過去の適用ルート・開始日時は推測せず NULL (LEGACY_SNAPSHOT) として Canonical Fact を保護
    const existingApps = db.prepare('SELECT id, subject_user_id, submitted_by_user_id, current_status, created_at FROM applications').all() as any[];
    const insertCycle = db.prepare(`
      INSERT OR IGNORE INTO application_workflow_cycles (
        application_id, approval_cycle, workflow_source, workflow_policy_version_id,
        policy_evaluation_at, status, started_at, started_by_user_id
      ) VALUES (?, ?, 'LEGACY_SNAPSHOT', NULL, NULL, ?, ?, ?)
    `);

    const updateStepCycleId = db.prepare(`
      UPDATE application_approval_steps
      SET workflow_cycle_id = ?
      WHERE application_id = ? AND approval_cycle = ?
    `);

    for (const app of existingApps) {
      const distinctCycles = db.prepare(`
        SELECT DISTINCT COALESCE(approval_cycle, 1) as cycle_num
        FROM application_approval_steps
        WHERE application_id = ?
        ORDER BY cycle_num ASC
      `).all(app.id) as { cycle_num: number }[];

      const cycles = distinctCycles.length > 0 ? distinctCycles.map((c) => c.cycle_num) : [1];

      for (const cNum of cycles) {
        const isLatest = cNum === Math.max(...cycles);
        const cycleStatus = isLatest ? (app.current_status === 'FINAL_APPROVED' ? 'APPROVED' : app.current_status === 'RETURNED' ? 'RETURNED' : 'IN_PROGRESS') : 'RETURNED';
        const startedBy = app.submitted_by_user_id || null;
        const startedAt = app.created_at || new Date().toISOString();

        const cycleRes = insertCycle.run(app.id, cNum, cycleStatus, startedAt, startedBy);
        let cycleId = Number(cycleRes.lastInsertRowid);
        if (cycleId === 0) {
          const existingCycleRow = db.prepare('SELECT id FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = ?').get(app.id, cNum) as { id: number };
          cycleId = existingCycleRow.id;
        }

        updateStepCycleId.run(cycleId, app.id, cNum);
      }
    }

    // 9. 件数整合性検証 (Fail-Closed Check)
    const postPolicyCount = db.prepare("SELECT COUNT(*) as count FROM workflow_policies WHERE policy_source = 'LEGACY_MIGRATED'").get() as { count: number };
    const postStepCount = db.prepare("SELECT COUNT(*) as count FROM workflow_policy_steps WHERE policy_version_id LIKE 'LEGACY_ROUTE_%'").get() as { count: number };
    const postNtoMCount = db.prepare('SELECT COUNT(*) as count FROM workflow_policy_application_types').get() as { count: number };

    if (postPolicyCount.count !== legacyRoutes.length) {
      throw new Error(`[Migration019 Error] Policy migration count mismatch. Expected ${legacyRoutes.length}, got ${postPolicyCount.count}`);
    }
    if (postStepCount.count !== legacyRouteSteps.length) {
      throw new Error(`[Migration019 Error] Step migration count mismatch. Expected ${legacyRouteSteps.length}, got ${postStepCount.count}`);
    }
    if (postNtoMCount.count !== legacyAppTypes.length) {
      throw new Error(`[Migration019 Error] N:M ApplicationType mapping count mismatch. Expected ${legacyAppTypes.length}, got ${postNtoMCount.count}`);
    }
  }
};
