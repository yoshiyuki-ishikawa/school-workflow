import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrator } from '../db/migrations';
import { validateResolvedRoute, WorkflowRouteValidationError } from '../workflow/routeValidator';
import { ResolvedWorkflowStep } from '../workflow/types';
import { migration031 } from '../db/migrations/031_workflow_policy_steps_ack_action_type';

describe('Decision-less Terminal Workflow — Wave 1 Golden Tests', () => {
  // 1. Migration 031 & DB Schema Tests
  it('GT-DLT-W1-01: Migration 031 後に ACK が workflow_policy_steps.action_type へ保存可能', () => {
    const db = new Database(':memory:');
    migrator.runMigrations(db);

    // policy_version と role を準備
    db.prepare(`
      INSERT INTO roles (id, name) VALUES ('TEST_ROLE', 'テストロール')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
      VALUES ('POL_TEST', 'KEY_TEST', 'テストポリシー', 'APPROVAL', 'SYSTEM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, effective_from, effective_to, priority, conditions_json)
      VALUES ('VER_TEST', 'POL_TEST', 1, 'ACTIVE', '2026-01-01', '2099-12-31', 10, '{}')
    `).run();

    // ACK アクションステップの挿入 (Migration 031 の CHECK 制約で許容されること)
    const stmt = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    assert.doesNotThrow(() => {
      stmt.run('VER_TEST', 1, '校長確認', 'PRIN_ACK', 'ACK', 'TEST_ROLE', 'POSITION', 'PRINCIPAL', 1);
    });

    const inserted = db.prepare("SELECT * FROM workflow_policy_steps WHERE action_type = 'ACK'").get() as any;
    assert.strictEqual(inserted.action_type, 'ACK');
    assert.strictEqual(inserted.step_name, '校長確認');
  });

  it('GT-DLT-W1-02: Legacy CHECK が Migration 031 後も保存・読込可能', () => {
    const db = new Database(':memory:');
    migrator.runMigrations(db);

    db.prepare(`
      INSERT INTO roles (id, name) VALUES ('TEST_ROLE', 'テストロール')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
      VALUES ('POL_TEST', 'KEY_TEST', 'テストポリシー', 'APPROVAL', 'SYSTEM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, effective_from, effective_to, priority, conditions_json)
      VALUES ('VER_TEST', 'POL_TEST', 1, 'ACTIVE', '2026-01-01', '2099-12-31', 10, '{}')
    `).run();

    const stmt = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    assert.doesNotThrow(() => {
      stmt.run('VER_TEST', 1, '事務係確認', 'OFFICE_CHECK', 'CHECK', 'TEST_ROLE', 'POSITION', 'OFFICE_HEAD', 0);
    });

    const inserted = db.prepare("SELECT * FROM workflow_policy_steps WHERE action_type = 'CHECK'").get() as any;
    assert.strictEqual(inserted.action_type, 'CHECK');
  });

  it('GT-DLT-W1-03: Migration 030 -> Migration 031 で row count が完全一致 (ゼロ行消失)', () => {
    const db = new Database(':memory:');
    migrator.runMigrations(db);

    db.prepare(`
      INSERT INTO roles (id, name) VALUES ('TEST_ROLE', 'テストロール')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
      VALUES ('POL_TEST', 'KEY_TEST', 'テストポリシー', 'APPROVAL', 'SYSTEM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, effective_from, effective_to, priority, conditions_json)
      VALUES ('VER_TEST', 'POL_TEST', 1, 'ACTIVE', '2026-01-01', '2099-12-31', 10, '{}')
    `).run();

    const stmt = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run('VER_TEST', 1, '教頭審査', 'VP_REV', 'REVIEW', 'TEST_ROLE', 'POSITION', 'VICE_PRINCIPAL', 0);
    stmt.run('VER_TEST', 2, '校長決裁', 'PRIN_DEC', 'DECIDE', 'TEST_ROLE', 'POSITION', 'PRINCIPAL', 1);
    stmt.run('VER_TEST', 3, '事務係確認', 'OFFICE_CHK', 'CHECK', 'TEST_ROLE', 'POSITION', 'OFFICE_HEAD', 0);

    const countBefore = (db.prepare('SELECT COUNT(*) as cnt FROM workflow_policy_steps').get() as any).cnt;

    // Migration 031 の up ロジックを再実行して安全性を検証
    migration031.up(db);

    const countAfter = (db.prepare('SELECT COUNT(*) as cnt FROM workflow_policy_steps').get() as any).cnt;
    assert.strictEqual(countAfter, countBefore, 'Row count must be 100% identical');
  });

  it('GT-DLT-W1-04: Migration 030 -> Migration 031 で既存 CHECK record が完全一致 (データ保全)', () => {
    const db = new Database(':memory:');
    migrator.runMigrations(db);

    db.prepare(`
      INSERT INTO roles (id, name) VALUES ('TEST_ROLE', 'テストロール')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, policy_purpose, policy_source)
      VALUES ('POL_TEST', 'KEY_TEST', 'テストポリシー', 'APPROVAL', 'SYSTEM')
    `).run();
    db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, effective_from, effective_to, priority, conditions_json)
      VALUES ('VER_TEST', 'POL_TEST', 1, 'ACTIVE', '2026-01-01', '2099-12-31', 10, '{}')
    `).run();

    const stmt = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run('VER_TEST', 1, '教頭審査', 'VP_REV', 'REVIEW', 'TEST_ROLE', 'POSITION', 'VICE_PRINCIPAL', 0);
    stmt.run('VER_TEST', 2, '校長決裁', 'PRIN_DEC', 'DECIDE', 'TEST_ROLE', 'POSITION', 'PRINCIPAL', 1);
    stmt.run('VER_TEST', 3, '事務係確認', 'OFFICE_CHK', 'CHECK', 'TEST_ROLE', 'POSITION', 'OFFICE_HEAD', 0);

    const checkBefore = (db.prepare("SELECT COUNT(*) as cnt FROM workflow_policy_steps WHERE action_type = 'CHECK'").get() as any).cnt;

    migration031.up(db);

    const checkAfter = (db.prepare("SELECT COUNT(*) as cnt FROM workflow_policy_steps WHERE action_type = 'CHECK'").get() as any).cnt;
    assert.strictEqual(checkAfter, checkBefore, 'CHECK record count must be 100% identical');
  });

  // 2. Route Validator Terminal Action Tests
  it('GT-DLT-W1-05: ACK terminal step route が Validator を通過', () => {
    const route: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長受領確認',
        actionType: 'ACK',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.doesNotThrow(() => {
      validateResolvedRoute(100, route, 'LEAVE_ANNUAL');
    });
  });

  it('GT-DLT-W1-06: ORDER terminal step route が Validator を通過', () => {
    const route: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '旅行命令発令',
        actionType: 'ORDER',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.doesNotThrow(() => {
      validateResolvedRoute(100, route, 'BUSINESS_TRIP');
    });
  });

  it('GT-DLT-W1-07: 既存 DECIDE terminal route が Validator を通過', () => {
    const route: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.doesNotThrow(() => {
      validateResolvedRoute(100, route, 'LEAVE_SICK');
    });
  });

  it('GT-DLT-W1-08: 一般年休通常ルートの DECIDE terminal 構成を INV-SEM-09 で拒否 (Fail-Closed)', () => {
    const invalidAnnualLeaveRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長決裁 (不当なDECIDE)',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.throws(
      () => validateResolvedRoute(100, invalidAnnualLeaveRoute, 'LEAVE_ANNUAL'),
      (err: any) => err.errorCode === 'INV_SEM_09_ANNUAL_LEAVE_DECIDE_PROHIBITED'
    );
  });

  it('GT-DLT-W1-09: 終端ステップの ActionType が REVIEW の不完全 Route を Fail-Closed', () => {
    const incompleteRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: true, // 終端なのに REVIEW
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
    ];

    assert.throws(
      () => validateResolvedRoute(100, incompleteRoute),
      (err: any) => err.errorCode === 'INV_FA_01_TERMINAL_ACTION_INVALID'
    );
  });

  it('GT-DLT-W1-10: 複数 Terminal Step フラグの不正 Route を Fail-Closed', () => {
    const invalidRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: true, // 1つ目
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長確認',
        actionType: 'ACK',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true, // 2つ目
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.throws(
      () => validateResolvedRoute(100, invalidRoute),
      (err: any) => err.errorCode === 'INV_FA_03_FINAL_FLAG_COUNT_INVALID'
    );
  });

  it('GT-DLT-W1-11: 既存 TYPE-A (特別休暇) DECIDE route が完全無影響で動作', () => {
    const specialLeaveRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.doesNotThrow(() => {
      validateResolvedRoute(100, specialLeaveRoute, 'LEAVE_SPECIAL');
    });
  });

  it('GT-DLT-W1-12: 既存出張の事後 CHECK を含む route が完全無影響で動作', () => {
    const tripRouteWithCheck: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
      {
        stepOrder: 3,
        stepName: '事務係確認',
        actionType: 'CHECK',
        requiredRoleId: 'OFFICE',
        selectorType: 'POSITION',
        selectorValue: 'OFFICE_HEAD',
        isFinalDecisionStep: false,
        approverUserId: 40,
        approverDisplayName: '事務長D',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.doesNotThrow(() => {
      validateResolvedRoute(100, tripRouteWithCheck, 'BUSINESS_TRIP');
    });
  });
});
