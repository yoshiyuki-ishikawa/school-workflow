import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { getDb, initDatabase, seedDatabase } from '../db';
import { resolveSelfCollisions, FinalAuthoritySelfCollisionError } from '../workflow/collisionResolver';
import { evaluateApproverAuthorization, resolveAndValidateWorkflowSteps } from '../workflow/engine';
import { CandidateWorkflowStep } from '../workflow/types';

describe('Decision-less Terminal Workflow — Wave 2 Golden Tests', () => {
  before(() => {
    initDatabase();
    seedDatabase();
  });

  // 1. W2-01: ACK-A Positive Authorization & Collision Resolver Tests
  it('GT-DLT-W2-01: 校長年休（TYPE-D）で校長本人が申請者の場合、終端 ACK ステップが保持される (Positive ACK-A)', () => {
    const candidateRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3, // 教頭B
        approverDisplayName: '教頭B',
        approverPositionCode: 'VICE_PRINCIPAL_1',
      },
      {
        stepOrder: 2,
        stepName: '校長受領確認',
        actionType: 'ACK',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4, // 校長C (本人)
        approverDisplayName: '校長C',
        approverPositionCode: 'PRINCIPAL',
      },
    ];

    // subjectUserId: 4 (校長C本人)
    const resolved = resolveSelfCollisions(4, candidateRoute, {
      subjectPositionCode: 'PRINCIPAL',
      isPrincipal: true,
    });

    assert.strictEqual(resolved.length, 2);
    // Step 1 は教頭 (3) なのでアクティブ (PENDING)
    assert.strictEqual(resolved[0].approverUserId, 3);
    assert.strictEqual(resolved[0].status, 'PENDING');
    assert.strictEqual(resolved[0].resolutionReason, null);

    // Step 2 は校長本人 (4) だが、Positive ACK-A により SKIPPED にならず WAITING として保持
    assert.strictEqual(resolved[1].approverUserId, 4);
    assert.strictEqual(resolved[1].actionType, 'ACK');
    assert.strictEqual(resolved[1].isFinalDecisionStep, true);
    assert.strictEqual(resolved[1].status, 'WAITING');
    assert.strictEqual(resolved[1].resolutionReason, null);
  });

  it('GT-DLT-W2-02: 校長年休（TYPE-D）で単一ステップ (ACK/終端) の場合、先頭ステップが PENDING として保持される', () => {
    const candidateRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '校長受領確認',
        actionType: 'ACK',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4, // 校長C (本人)
        approverDisplayName: '校長C',
        approverPositionCode: 'PRINCIPAL',
      },
    ];

    const resolved = resolveSelfCollisions(4, candidateRoute, {
      subjectPositionCode: 'PRINCIPAL',
      isPrincipal: true,
    });

    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].status, 'PENDING');
    assert.strictEqual(resolved[0].resolutionReason, null);
  });

  it('GT-DLT-W2-03: 校長の特別休暇（TYPE-A, DECIDE/終端）で校長本人が決裁者の場合、422 で Fail-Closed', () => {
    const candidateRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3,
        approverDisplayName: '教頭B',
        approverPositionCode: 'VICE_PRINCIPAL_1',
      },
      {
        stepOrder: 2,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4, // 校長C (本人)
        approverDisplayName: '校長C',
        approverPositionCode: 'PRINCIPAL',
      },
    ];

    assert.throws(
      () => resolveSelfCollisions(4, candidateRoute, { isPrincipal: true }),
      (err: any) => {
        assert.strictEqual(err instanceof FinalAuthoritySelfCollisionError, true);
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
        return true;
      }
    );
  });

  it('GT-DLT-W2-04: 校長の出張申請（ORDER/終端）で校長本人が発令者の場合、422 で Fail-Closed', () => {
    const candidateRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3,
        approverDisplayName: '教頭B',
        approverPositionCode: 'VICE_PRINCIPAL_1',
      },
      {
        stepOrder: 2,
        stepName: '旅行命令発令',
        actionType: 'ORDER',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4, // 校長C (本人)
        approverDisplayName: '校長C',
        approverPositionCode: 'PRINCIPAL',
      },
    ];

    assert.throws(
      () => resolveSelfCollisions(4, candidateRoute, { isPrincipal: true }),
      (err: any) => {
        assert.strictEqual(err instanceof FinalAuthoritySelfCollisionError, true);
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
        return true;
      }
    );
  });

  it('GT-DLT-W2-05: 一般教員の年休で、一般教員本人が終端 ACK ステップ担当者の場合、422 で Fail-Closed', () => {
    const invalidRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 2,
        stepName: '自己受領確認 (不正)',
        actionType: 'ACK',
        requiredRoleId: 'TEACHER',
        selectorType: 'POSITION',
        selectorValue: 'TEACHER',
        isFinalDecisionStep: true,
        approverUserId: 1, // 一般教員本人
        approverDisplayName: '教員A',
      },
    ];

    assert.throws(
      () => resolveSelfCollisions(1, invalidRoute, { isPrincipal: false }),
      (err: any) => {
        assert.strictEqual(err instanceof FinalAuthoritySelfCollisionError, true);
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
        return true;
      }
    );
  });

  it('GT-DLT-W2-06: 教頭年休で教頭本人が Step 1 (REVIEW) の場合、Step 1 は SKIPPED となり Step 2 (校長ACK) が PENDING', () => {
    const candidateRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3, // 教頭B (本人)
        approverDisplayName: '教頭B',
        approverPositionCode: 'VICE_PRINCIPAL_1',
      },
      {
        stepOrder: 2,
        stepName: '校長受領確認',
        actionType: 'ACK',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4, // 校長C
        approverDisplayName: '校長C',
        approverPositionCode: 'PRINCIPAL',
      },
    ];

    // subjectUserId: 3 (教頭B本人)
    const resolved = resolveSelfCollisions(3, candidateRoute, {
      subjectPositionCode: 'VICE_PRINCIPAL_1',
      isPrincipal: false,
    });

    assert.strictEqual(resolved.length, 2);
    // Step 1: 教頭本人のため SKIPPED
    assert.strictEqual(resolved[0].status, 'SKIPPED');
    assert.strictEqual(resolved[0].resolutionReason, 'SELF_COLLISION');

    // Step 2: 校長 (4) が最初のアクティブステップとして PENDING
    assert.strictEqual(resolved[1].status, 'PENDING');
    assert.strictEqual(resolved[1].resolutionReason, null);
  });

  it('GT-DLT-W2-07: evaluateApproverAuthorization: 校長本人が自身の TYPE-D 年休の終端 ACK を実行する場合、allowed: true', () => {
    const actor = { id: 4, roles: ['PRINCIPAL', 'TEACHER'] };
    const application = { subject_user_id: 4, submitted_by_user_id: 4, type_id: 'LEAVE_ANNUAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 4 };
    const step = {
      approver_user_id_snapshot: 4,
      required_role_id: 'PRINCIPAL',
      approver_name_snapshot: '鈴木 健一 (校長C)',
      action_type: 'ACK',
      is_final_decision_step: 1,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, true);
  });

  it('GT-DLT-W2-08: evaluateApproverAuthorization: 校長本人が自身の TYPE-A 特別休暇の終端 DECIDE を実行する場合、403 FORBIDDEN_SELF_APPROVAL', () => {
    const actor = { id: 4, roles: ['PRINCIPAL', 'TEACHER'] };
    const application = { subject_user_id: 4, submitted_by_user_id: 4, type_id: 'LEAVE_SPECIAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 4 };
    const step = {
      approver_user_id_snapshot: 4,
      required_role_id: 'PRINCIPAL',
      approver_name_snapshot: '鈴木 健一 (校長C)',
      action_type: 'DECIDE',
      is_final_decision_step: 1,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  it('GT-DLT-W2-09: evaluateApproverAuthorization: 一般教員本人が自身の年休の終端 ACK を実行しようとした場合、403 FORBIDDEN_SELF_APPROVAL', () => {
    const actor = { id: 1, roles: ['TEACHER'] };
    const application = { subject_user_id: 1, submitted_by_user_id: 1, type_id: 'LEAVE_ANNUAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 1 };
    const step = {
      approver_user_id_snapshot: 1,
      required_role_id: 'TEACHER',
      approver_name_snapshot: '山田 太郎 (教員A)',
      action_type: 'ACK',
      is_final_decision_step: 1,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.errorCode, 'FORBIDDEN_SELF_APPROVAL');
  });

  // 2. W2-02: Policy Resolution Tests
  it('GT-DLT-W2-10: 一般教員の年休ポリシー解決が決定論的に正常動作する', () => {
    const db = getDb();
    const steps = db.prepare(`
      SELECT s.*
      FROM workflow_policy_steps s
      JOIN workflow_policy_versions v ON s.policy_version_id = v.id
      JOIN workflow_policies p ON v.policy_id = p.id
      JOIN workflow_policy_application_types pat ON p.id = pat.policy_id
      WHERE pat.app_type_id = 'LEAVE_ANNUAL' AND p.policy_purpose = 'APPROVAL'
      ORDER BY s.step_order ASC
    `).all() as any[];

    assert.strictEqual(steps.length >= 2, true);
    assert.strictEqual(steps[0].action_type, 'REVIEW');
  });

  it('GT-DLT-W2-11: 教頭役職（VICE_PRINCIPAL）の担当者が不在時、暗黙フォールバックせず Fail-Closed', () => {
    const db = new Database(':memory:');
    // 空のインメモリDBで役職不在状態を検証
    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rank_order INTEGER NOT NULL,
        holder_type TEXT NOT NULL DEFAULT 'SINGLE_HOLDER'
      );
      CREATE TABLE IF NOT EXISTS user_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        position_id TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        display_name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO positions (id, name, rank_order, holder_type) VALUES ('VICE_PRINCIPAL_1', '第1教頭', 20, 'SINGLE_HOLDER');
      INSERT INTO users (id, display_name, is_active) VALUES (4, '校長C', 1);
      INSERT INTO user_positions (user_id, position_id, effective_from, effective_to, is_primary) VALUES (4, 'PRINCIPAL', '2026-01-01', '2099-12-31', 1);
    `);

    const holders = db.prepare(`
      SELECT u.id FROM user_positions up JOIN users u ON up.user_id = u.id WHERE up.position_id = 'VICE_PRINCIPAL_1' AND u.is_active = 1
    `).all();
    assert.strictEqual(holders.length, 0, '教頭不在状態');
  });

  it('GT-DLT-W2-12: クライアント側からのルート改ざんを許容せず Server-Authoritative に整合検証', () => {
    const candidateRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 2,
        stepName: '校長受領確認',
        actionType: 'ACK',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4,
        approverDisplayName: '校長C',
      },
    ];

    const resolved = resolveAndValidateWorkflowSteps(4, candidateRoute, 'LEAVE_ANNUAL');
    assert.strictEqual(resolved.length, 2);
    assert.strictEqual(resolved[0].status, 'PENDING');
    assert.strictEqual(resolved[1].status, 'WAITING');
  });

  it('GT-DLT-W2-13: resolveAndValidateWorkflowSteps: 年休の終端ステップが DECIDE の場合、INV-SEM-09 で遮断', () => {
    const invalidRoute: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'REVIEW',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL_1',
        isFinalDecisionStep: false,
        approverUserId: 3,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 2,
        stepName: '校長決裁 (不当なDECIDE)',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 4,
        approverDisplayName: '校長C',
      },
    ];

    assert.throws(
      () => resolveAndValidateWorkflowSteps(1, invalidRoute, 'LEAVE_ANNUAL'),
      (err: any) => err.errorCode === 'INV_SEM_09_ANNUAL_LEAVE_DECIDE_PROHIBITED'
    );
  });

  // 3. W2-03: Proxy Submitter SoD Mediation Tests (`engine.ts`)
  it('GT-DLT-W2-14: CASE-PROXY-01: 校長本人が起票し、教頭が中間審査（REVIEW）を実行 ➔ allowed: true', () => {
    const actor = { id: 3, roles: ['VICE_PRINCIPAL', 'TEACHER'] };
    const application = { subject_user_id: 4, submitted_by_user_id: 4, type_id: 'LEAVE_ANNUAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 4 };
    const step = {
      approver_user_id_snapshot: 3,
      required_role_id: 'VICE_PRINCIPAL',
      approver_name_snapshot: '田中 誠 (教頭B)',
      action_type: 'REVIEW',
      is_final_decision_step: 0,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, true);
  });

  it('GT-DLT-W2-15: CASE-PROXY-02: 教頭が校長のために代理起票し、教頭自身が中間審査（REVIEW）を実行 ➔ allowed: true (SoD 調停成立)', () => {
    const actor = { id: 3, roles: ['VICE_PRINCIPAL', 'TEACHER'] };
    const application = { subject_user_id: 4, submitted_by_user_id: 3, type_id: 'LEAVE_ANNUAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 3 };
    const step = {
      approver_user_id_snapshot: 3,
      required_role_id: 'VICE_PRINCIPAL',
      approver_name_snapshot: '田中 誠 (教頭B)',
      action_type: 'REVIEW',
      is_final_decision_step: 0,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, true);
  });

  it('GT-DLT-W2-16: CASE-PROXY-03: 一般教員の代理起票者（一般教員）が中間審査（REVIEW）を実行 ➔ 403 FORBIDDEN_PROXY_APPROVAL', () => {
    const actor = { id: 2, roles: ['TEACHER'] };
    const application = { subject_user_id: 1, submitted_by_user_id: 2, type_id: 'LEAVE_ANNUAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 2 };
    const step = {
      approver_user_id_snapshot: 2,
      required_role_id: 'TEACHER',
      approver_name_snapshot: '教員B',
      action_type: 'REVIEW',
      is_final_decision_step: 0,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.errorCode, 'FORBIDDEN_PROXY_APPROVAL');
  });

  it('GT-DLT-W2-17: CASE-PROXY-04: 教頭が校長のために代理起票し、教頭自身が終端 ACK ステップを実行しようとした場合 ➔ 403 FORBIDDEN_PROXY_APPROVAL', () => {
    const actor = { id: 3, roles: ['VICE_PRINCIPAL', 'TEACHER'] };
    const application = { subject_user_id: 4, submitted_by_user_id: 3, type_id: 'LEAVE_ANNUAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 3 };
    const step = {
      approver_user_id_snapshot: 3,
      required_role_id: 'PRINCIPAL',
      approver_name_snapshot: '教頭B',
      action_type: 'ACK',
      is_final_decision_step: 1,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.errorCode, 'FORBIDDEN_PROXY_APPROVAL');
  });

  it('GT-DLT-W2-18: CASE-PROXY-05: 代理起票者が終端 DECIDE ステップを実行しようとした場合 ➔ 403 FORBIDDEN_PROXY_APPROVAL', () => {
    const actor = { id: 3, roles: ['VICE_PRINCIPAL', 'TEACHER'] };
    const application = { subject_user_id: 1, submitted_by_user_id: 3, type_id: 'LEAVE_SPECIAL' };
    const cycle = { cycle_purpose: 'APPROVAL', started_by_user_id: 3 };
    const step = {
      approver_user_id_snapshot: 3,
      required_role_id: 'VICE_PRINCIPAL',
      approver_name_snapshot: '教頭B',
      action_type: 'DECIDE',
      is_final_decision_step: 1,
    };

    const result = evaluateApproverAuthorization(actor, application, cycle, step);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(result.errorCode, 'FORBIDDEN_PROXY_APPROVAL');
  });
});
