import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrator } from '../db/migrations';
import { resolveSelfCollisions, FinalAuthoritySelfCollisionError } from '../workflow/collisionResolver';
import { validateResolvedRoute, WorkflowRouteValidationError } from '../workflow/routeValidator';
import { CandidateWorkflowStep, ResolvedWorkflowStep } from '../workflow/types';

describe('Self-Collision Resolution & Final Authority Golden & Negative Tests', () => {
  // 基本テストフィクスチャ生成ヘルパー
  function createStandardRoute(): CandidateWorkflowStep[] {
    return [
      {
        stepOrder: 1,
        stepName: '教務主任確認',
        stepKey: 'HEAD_TEACHER',
        actionType: 'APPROVE',
        requiredRoleId: 'TEACHER',
        selectorType: 'POSITION',
        selectorValue: 'HEAD_TEACHER',
        isFinalDecisionStep: false,
        approverUserId: 10,
        approverDisplayName: '教務主任A',
      },
      {
        stepOrder: 2,
        stepName: '教頭審査',
        stepKey: 'VICE_PRINCIPAL',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 3,
        stepName: '校長決裁',
        stepKey: 'PRINCIPAL',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
      },
    ];
  }

  it('GT-SC-01: 一般教員・中間自己衝突なし -> Step 1 PENDING, Step 2/3 WAITING', () => {
    const candidate = createStandardRoute();
    const resolved = resolveSelfCollisions(100, candidate); // 申請者: 一般教員 100
    validateResolvedRoute(100, resolved);

    assert.strictEqual(resolved[0].status, 'PENDING');
    assert.strictEqual(resolved[0].resolutionReason, null);
    assert.strictEqual(resolved[1].status, 'WAITING');
    assert.strictEqual(resolved[2].status, 'WAITING');
  });

  it('GT-SC-02: 主任申請・中間自己衝突 (Step 1) -> Step 1 SKIPPED, Step 2 PENDING, Step 3 WAITING', () => {
    const candidate = createStandardRoute();
    const resolved = resolveSelfCollisions(10, candidate); // 申請者: 教務主任 10
    validateResolvedRoute(10, resolved);

    assert.strictEqual(resolved[0].status, 'SKIPPED');
    assert.strictEqual(resolved[0].resolutionReason, 'SELF_COLLISION');
    assert.strictEqual(resolved[0].actionByUserId, null);
    assert.strictEqual(resolved[0].actedAt, null);

    assert.strictEqual(resolved[1].status, 'PENDING');
    assert.strictEqual(resolved[1].resolutionReason, null);

    assert.strictEqual(resolved[2].status, 'WAITING');
  });

  it('GT-SC-03: 教頭申請・中間自己衝突 (Step 2) -> Step 1 PENDING, Step 2 SKIPPED, Step 3 WAITING', () => {
    const candidate = createStandardRoute();
    const resolved = resolveSelfCollisions(20, candidate); // 申請者: 教頭 20
    validateResolvedRoute(20, resolved);

    assert.strictEqual(resolved[0].status, 'PENDING');
    assert.strictEqual(resolved[1].status, 'SKIPPED');
    assert.strictEqual(resolved[1].resolutionReason, 'SELF_COLLISION');
    assert.strictEqual(resolved[2].status, 'WAITING');
  });

  it('GT-SC-04: 複数中間自己衝突 (連続) -> Step 1, 2 SKIPPED, Step 3 PENDING, Step 4 WAITING', () => {
    const candidate: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教務主任確認',
        actionType: 'APPROVE',
        requiredRoleId: 'TEACHER',
        selectorType: 'POSITION',
        selectorValue: 'HEAD_TEACHER',
        isFinalDecisionStep: false,
        approverUserId: 10,
        approverDisplayName: '教務主任兼事務主幹A',
      },
      {
        stepOrder: 2,
        stepName: '事務主幹確認',
        actionType: 'APPROVE',
        requiredRoleId: 'OFFICE',
        selectorType: 'POSITION',
        selectorValue: 'OFFICE_HEAD',
        isFinalDecisionStep: false,
        approverUserId: 10,
        approverDisplayName: '教務主任兼事務主幹A',
      },
      {
        stepOrder: 3,
        stepName: '教頭審査',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VICE_PRINCIPAL',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 4,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
      },
    ];

    const resolved = resolveSelfCollisions(10, candidate);
    validateResolvedRoute(10, resolved);

    assert.strictEqual(resolved[0].status, 'SKIPPED');
    assert.strictEqual(resolved[0].resolutionReason, 'SELF_COLLISION');
    assert.strictEqual(resolved[1].status, 'SKIPPED');
    assert.strictEqual(resolved[1].resolutionReason, 'SELF_COLLISION');
    assert.strictEqual(resolved[2].status, 'PENDING');
    assert.strictEqual(resolved[3].status, 'WAITING');
  });

  it('GT-SC-11: 承認操作 Fact 非生成検証 (SKIPPED ステップの actionByUserId / actedAt は厳格に NULL)', () => {
    const candidate = createStandardRoute();
    const resolved = resolveSelfCollisions(10, candidate);

    const skipped = resolved.find((s) => s.status === 'SKIPPED')!;
    assert.strictEqual(skipped.actionByUserId, null);
    assert.strictEqual(skipped.actedAt, null);
  });

  it('GT-SC-14: Scenario B (Duplicate × SELF) -> B兼務申請時に各Stepが独立してSKIPPED', () => {
    const candidate: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '第1教頭審査',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP_1',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 2,
        stepName: '第2教頭審査',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP_2',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 3,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
      },
    ];

    const resolved = resolveSelfCollisions(20, candidate); // 申請者: 教頭B (20)
    validateResolvedRoute(20, resolved);

    assert.strictEqual(resolved[0].status, 'SKIPPED');
    assert.strictEqual(resolved[0].resolutionReason, 'SELF_COLLISION');
    assert.strictEqual(resolved[1].status, 'SKIPPED');
    assert.strictEqual(resolved[1].resolutionReason, 'SELF_COLLISION');
    assert.strictEqual(resolved[2].status, 'PENDING');
  });

  it('GT-SC-19: Duplicate / NOT SELF -> HD-03 原則 (Same User != Same Authority Semantic) で全ステップ維持', () => {
    const candidate: CandidateWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '第1教頭審査',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP_1',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 2,
        stepName: '第2教頭審査',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP_2',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
      },
      {
        stepOrder: 3,
        stepName: '校長決裁',
        actionType: 'DECIDE',
        requiredRoleId: 'PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'PRINCIPAL',
        isFinalDecisionStep: true,
        approverUserId: 30,
        approverDisplayName: '校長C',
      },
    ];

    const resolved = resolveSelfCollisions(100, candidate); // 申請者: 教員X (100)
    validateResolvedRoute(100, resolved);

    assert.strictEqual(resolved[0].status, 'PENDING');
    assert.strictEqual(resolved[0].resolutionReason, null);
    assert.strictEqual(resolved[1].status, 'WAITING');
    assert.strictEqual(resolved[1].resolutionReason, null);
    assert.strictEqual(resolved[2].status, 'WAITING');
    assert.strictEqual(resolved.length, 3, 'ステップ統合や自動SKIPが発生しないこと');
  });

  it('GT-FA-01: Valid DECIDE + Final Flag pair passes validation', () => {
    const candidate = createStandardRoute();
    const resolved = resolveSelfCollisions(100, candidate);
    assert.doesNotThrow(() => validateResolvedRoute(100, resolved));
  });

  it('NEG-06: Corrupted Resolver Output Catch (Resolver が誤って本人を PENDING にした場合に遮断)', () => {
    const corruptedSteps: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭承認',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING', // 誤って本人が PENDING
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

    assert.throws(
      () => validateResolvedRoute(20, corruptedSteps),
      (err: any) => err instanceof WorkflowRouteValidationError && err.errorCode === 'INV_SC_01_SELF_PENDING_PROHIBITED'
    );
  });

  it('NEG-08: No Active Approver (全員がスキップされて承認者が0名になった場合に遮断)', () => {
    const noActiveSteps: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭承認',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'SKIPPED',
        resolutionReason: 'SELF_COLLISION',
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
        status: 'WAITING', // PENDING が 0 件
        resolutionReason: null,
      },
    ];

    assert.throws(
      () => validateResolvedRoute(20, noActiveSteps),
      (err: any) => err instanceof WorkflowRouteValidationError && err.errorCode === 'INV_SC_06_PENDING_COUNT_INVALID'
    );
  });

  it('NEG-09: Final Authority SELF Fail-Closed (HTTP 422 FINAL_AUTHORITY_SELF_COLLISION)', () => {
    const candidate = createStandardRoute(); // Step 3 approver is 30 (校長C)

    assert.throws(
      () => resolveSelfCollisions(30, candidate), // 申請者: 校長C (30)
      (err: any) => {
        assert.strictEqual(err instanceof FinalAuthoritySelfCollisionError, true);
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.errorCode, 'FINAL_AUTHORITY_SELF_COLLISION');
        return true;
      }
    );
  });

  it('NEG-FA-01: DECIDE=true / isFinalDecisionStep=false (Semantic 不一致遮断)', () => {
    const invalidRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭承認',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP',
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
        isFinalDecisionStep: false, // 不一致！
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

  it('NEG-FA-03: Multiple DECIDE (最終決裁アクションが複数存在する場合に遮断)', () => {
    const invalidRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭決裁',
        actionType: 'DECIDE', // 1つ目
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP',
        isFinalDecisionStep: false,
        approverUserId: 20,
        approverDisplayName: '教頭B',
        status: 'PENDING',
        resolutionReason: null,
      },
      {
        stepOrder: 2,
        stepName: '校長決裁',
        actionType: 'DECIDE', // 2つ目
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
      () => validateResolvedRoute(100, invalidRoute),
      (err: any) =>
        err.errorCode === 'INV_FA_02_INTERMEDIATE_DECIDE_PROHIBITED' ||
        err.errorCode === 'INV_FA_02_DECIDE_COUNT_INVALID'
    );
  });

  it('NEG-FA-05 & NEG-FA-06: Non-Terminal Final Decision (Final Step より後ろに後続 Step がある場合に遮断)', () => {
    const nonTerminalRoute: ResolvedWorkflowStep[] = [
      {
        stepOrder: 1,
        stepName: '教頭審査',
        actionType: 'APPROVE',
        requiredRoleId: 'VICE_PRINCIPAL',
        selectorType: 'POSITION',
        selectorValue: 'VP',
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
        isFinalDecisionStep: true, // 末尾ではない！
        approverUserId: 30,
        approverDisplayName: '校長C',
        status: 'WAITING',
        resolutionReason: null,
      },
      {
        stepOrder: 3,
        stepName: '教育委員会報告',
        actionType: 'APPROVE',
        requiredRoleId: 'ADMIN',
        selectorType: 'ROLE',
        selectorValue: 'ADMIN',
        isFinalDecisionStep: false,
        approverUserId: 40,
        approverDisplayName: '管理者D',
        status: 'WAITING',
        resolutionReason: null,
      },
    ];

    assert.throws(
      () => validateResolvedRoute(100, nonTerminalRoute),
      (err: any) => err.errorCode === 'INV_FA_05_NON_TERMINAL_FINAL_STEP' || err.errorCode === 'INV_FA_06_POST_FINAL_STEPS_EXIST'
    );
  });
});
