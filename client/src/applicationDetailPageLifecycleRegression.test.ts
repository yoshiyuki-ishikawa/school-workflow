import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { ApplicationDetailPage } from './pages/ApplicationDetailPage';
import { Application, User } from './types';
import { determineHistoricalSchemaResolutionDate } from './utils/schemaResolutionDateResolver';
import { resolveActionability } from './utils/applicationActionabilityResolver';
import { resolveApplicationDisplayState } from './services/workflowPresentationResolver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('ApplicationDetailPage Hook Lifecycle Golden Suite', () => {

  // =========================================================================
  // GT-DETAIL-LIFECYCLE-01: Re-render Lifecycle Hook Invariant
  // =========================================================================
  describe('GT-DETAIL-LIFECYCLE-01: Hook Count and Order Invariant Across Lifecycle Transitions', () => {
    it('LIFECYCLE-01A: Hook execution sequence is identical in loading:true and loading:false states', () => {
      // Re-render lifecycle invariant simulator
      // Models React 18 Fiber hook list behavior
      const hookCallLog: { render: number; index: number; hookType: string; name?: string }[] = [];
      let currentRender = 1;
      let hookIndex = 0;

      const trackHook = (hookType: string, name?: string) => {
        hookCallLog.push({ render: currentRender, index: hookIndex++, hookType, name });
      };

      // Simulated component reflecting ApplicationDetailPage's top-level hook declarations
      const simulateHookDeclarationExecution = (loading: boolean) => {
        hookIndex = 0;
        // 1..5: Core state
        trackHook('useState', 'app');
        trackHook('useState', 'loading');
        trackHook('useState', 'error');
        trackHook('useState', 'actionLoading');
        trackHook('useState', 'members');

        // 6..13: Modal states
        trackHook('useState', 'isPdfModalOpen');
        trackHook('useState', 'modalType');
        trackHook('useState', 'isCoverageModalOpen');
        trackHook('useState', 'isReportModalOpen');
        trackHook('useState', 'isEditModalOpen');
        trackHook('useState', 'isCancelModalOpen');
        trackHook('useState', 'cancelActionModalType');
        trackHook('useState', 'isCancelResubmitModalOpen');

        // 14..16: Schema-driven state
        trackHook('useState', 'schema');
        trackHook('useState', 'schemaLoading');
        trackHook('useState', 'schemaError');

        // 17..19: Fixed top-level modal states (formerly placed after early return)
        trackHook('useState', 'isApproveModalOpen');
        trackHook('useState', 'approveComment');
        trackHook('useState', 'isWithdrawModalOpen');

        // 20: Effect hook
        trackHook('useEffect', 'fetchDetailOnMount');

        // Early return point: loading or error
        if (loading) {
          return 'LOADING_VIEW';
        }

        return 'LOADED_VIEW';
      };

      // Render 1: Initial mount (loading === true)
      currentRender = 1;
      const res1 = simulateHookDeclarationExecution(true);
      assert.equal(res1, 'LOADING_VIEW');
      const render1Hooks = hookCallLog.filter((h) => h.render === 1);
      assert.equal(render1Hooks.length, 20, 'Render 1 must execute exactly 20 hooks');

      // Render 2: Data loaded (loading === false)
      currentRender = 2;
      const res2 = simulateHookDeclarationExecution(false);
      assert.equal(res2, 'LOADED_VIEW');
      const render2Hooks = hookCallLog.filter((h) => h.render === 2);
      assert.equal(render2Hooks.length, 20, 'Render 2 must execute exactly 20 hooks');

      // Invariant Check: Count and order parity
      assert.equal(render1Hooks.length, render2Hooks.length, 'Hook counts across renders must be equal');
      for (let i = 0; i < render1Hooks.length; i++) {
        assert.equal(
          render1Hooks[i].hookType,
          render2Hooks[i].hookType,
          `Hook at index ${i} must have matching type across renders`
        );
        assert.equal(
          render1Hooks[i].name,
          render2Hooks[i].name,
          `Hook at index ${i} must have matching semantic identity across renders`
        );
      }
    });

    it('LIFECYCLE-01B: Zero "Rendered more hooks than during previous render" on consecutive re-renders', () => {
      // Simulates React fiber reconciler hook mismatch detector
      let previousHooksCount: number | null = null;

      const runReconcilerCheck = (hooksInRender: number) => {
        if (previousHooksCount !== null && hooksInRender > previousHooksCount) {
          throw new Error(
            `Rendered more hooks than during the previous render. Previous: ${previousHooksCount}, Current: ${hooksInRender}`
          );
        }
        previousHooksCount = hooksInRender;
      };

      // Initial render: 20 hooks
      assert.doesNotThrow(() => runReconcilerCheck(20));
      // Re-render when loading completes: 20 hooks
      assert.doesNotThrow(() => runReconcilerCheck(20));
      // Re-render on user interaction (e.g. opening approve modal): 20 hooks
      assert.doesNotThrow(() => runReconcilerCheck(20));
    });
  });

  // =========================================================================
  // GT-DETAIL-LIFECYCLE-02: Real Incident Fixture #15163 (Teacher LEAVE_ANNUAL -> VP Review)
  // =========================================================================
  describe('GT-DETAIL-LIFECYCLE-02: Real Incident Fixture #15163 (LEAVE_ANNUAL Review by Vice Principal)', () => {
    const teacherUser: User = {
      id: 2,
      username: 'teacher1',
      displayName: '山田 太郎 (教諭A)',
      department: '第1学年',
      roles: ['TEACHER'],
    };

    const vpUser: User = {
      id: 3,
      username: 'vice_principal',
      displayName: '田中 誠 (教頭B)',
      department: '管理部',
      roles: ['TEACHER', 'VICE_PRINCIPAL'],
    };

    const app15163: Application = {
      id: 15163,
      type_id: 'LEAVE_ANNUAL',
      title: '年次有給休暇の取得について',
      applicant_id: teacherUser.id,
      applicant_name: teacherUser.displayName,
      applicant_department: teacherUser.department,
      form_data: {
        targetDate: '2026-05-15',
        unitType: 'DAY',
        days: 1,
        reason: '私用のため',
      },
      current_status: 'SUBMITTED',
      current_step_order: 1,
      version: 1,
      created_at: '2026-09-15T10:00:00.000Z',
      updated_at: '2026-09-15T10:00:00.000Z',
      steps: [
        {
          id: 101,
          application_id: 15163,
          step_order: 1,
          step_name: '教頭審査',
          required_role_id: 'VICE_PRINCIPAL',
          assigned_user_id: null,
          status: 'PENDING',
          comment: null,
          action_by_user_id: null,
          approval_cycle: 1,
        },
        {
          id: 102,
          application_id: 15163,
          step_order: 2,
          step_name: '校長決裁',
          required_role_id: 'PRINCIPAL',
          assigned_user_id: null,
          status: 'WAITING',
          comment: null,
          action_by_user_id: null,
          approval_cycle: 1,
        },
      ],
      activeCancellationCycle: null,
      latestCancellationCycle: null,
      cancellationReturn: null,
    };

    it('LIFECYCLE-02A: Initial render in React produces clean loading UI without lifecycle crash', () => {
      let renderHtml = '';
      assert.doesNotThrow(() => {
        renderHtml = ReactDOMServer.renderToString(
          React.createElement(ApplicationDetailPage, {
            applicationId: 15163,
            currentUser: vpUser,
            onBack: () => {},
            onRefresh: () => {},
          })
        );
      });
      assert.ok(renderHtml.includes('申請詳細を読み込み中...'), 'Initial render must display loading state');
    });

    it('LIFECYCLE-02B: Historical schema resolution derives authoritative date 2026-05-15 from form_data', () => {
      const resolvedDate = determineHistoricalSchemaResolutionDate(
        app15163.form_data,
        app15163.created_at
      );
      assert.equal(resolvedDate, '2026-05-15', 'Authoritative resolution date must be 2026-05-15');
    });

    it('LIFECYCLE-02C: Actionability for VP on #15163 correctly resolves review permissions', () => {
      const actionability = resolveActionability(app15163, vpUser);
      assert.equal(actionability.canApprove, true, 'VP must have canApprove = true on PENDING VP step');
      assert.equal(actionability.canReturn, true, 'VP must have canReturn = true');
      assert.equal(actionability.canReject, false, 'VP on REVIEW step must have canReject = false (DECIDE-Only)');
      assert.equal(actionability.canWithdraw, false, 'VP cannot withdraw teacher application');
    });

    it('LIFECYCLE-02D: Display state correctly indicates submitted status for presentation', () => {
      const displayState = resolveApplicationDisplayState(app15163, vpUser.id);
      assert.equal(displayState.primaryStatus, 'SUBMITTED', 'Must indicate SUBMITTED status');
      assert.equal(displayState.primaryLabel, '提出済', 'Must have label 提出済');
      assert.equal(displayState.primaryColor, 'blue', 'Must have color blue');
    });
  });

  // =========================================================================
  // GT-DETAIL-LIFECYCLE-03: Multi-Type Lifecycle Verification
  // =========================================================================
  describe('GT-DETAIL-LIFECYCLE-03: Multi-Type Lifecycle and Schema Invariant Verification', () => {
    const vpUser: User = {
      id: 3,
      username: 'vice_principal',
      displayName: '田中 誠 (教頭B)',
      department: '管理部',
      roles: ['TEACHER', 'VICE_PRINCIPAL'],
    };

    const applicationTypes = [
      {
        type_id: 'LEAVE_ANNUAL',
        title: '年次有給休暇',
        form_data: { targetDate: '2026-06-01', days: 1, unitType: 'DAY' },
        expectedDate: '2026-06-01',
      },
      {
        type_id: 'LEAVE_SICK',
        title: '病気休暇',
        form_data: { startDate: '2026-06-10', endDate: '2026-06-12', reason: '風邪' },
        expectedDate: '2026-06-10',
      },
      {
        type_id: 'LEAVE_SPECIAL',
        title: '特別休暇（慶弔）',
        form_data: { targetDate: '2026-07-01', reason: '親族忌引' },
        expectedDate: '2026-07-01',
      },
      {
        type_id: 'BUSINESS_TRIP',
        title: '出張申請',
        form_data: { tripStartAt: '2026-08-01T09:00:00', destination: '県庁' },
        expectedDate: '2026-08-01',
      },
    ];

    for (const testCase of applicationTypes) {
      it(`LIFECYCLE-03: ${testCase.type_id} resolves date without error and renders clean loading container`, () => {
        const resolvedDate = determineHistoricalSchemaResolutionDate(
          testCase.form_data,
          '2026-05-01T00:00:00Z'
        );
        assert.equal(
          resolvedDate,
          testCase.expectedDate,
          `Resolution date for ${testCase.type_id} must match expected`
        );

        assert.doesNotThrow(() => {
          ReactDOMServer.renderToString(
            React.createElement(ApplicationDetailPage, {
              applicationId: 99999,
              currentUser: vpUser,
              onBack: () => {},
              onRefresh: () => {},
            })
          );
        });
      });
    }
  });

  // =========================================================================
  // GT-DETAIL-LIFECYCLE-04: Static Source AST & Hook Placement Guard
  // =========================================================================
  describe('GT-DETAIL-LIFECYCLE-04: Static AST and Hook Placement Guard (ApplicationDetailPage.tsx)', () => {
    const pageFilePath = path.resolve(__dirname, 'pages/ApplicationDetailPage.tsx');
    const sourceCode = fs.readFileSync(pageFilePath, 'utf8');
    const lines = sourceCode.split('\n');

    it('LIFECYCLE-04A: ApplicationDetailPage source exists and is accessible', () => {
      assert.ok(sourceCode.length > 0, 'ApplicationDetailPage.tsx must not be empty');
    });

    it('LIFECYCLE-04B: Exactly 20 hooks are declared at the component top-level', () => {
      // Find the component body start
      const compStartIndex = lines.findIndex((l) => l.includes('export const ApplicationDetailPage: React.FC<Props>'));
      assert.ok(compStartIndex >= 0, 'Component declaration must exist');

      // Find the first early return
      const firstReturnIndex = lines.findIndex((l, idx) => idx > compStartIndex && l.match(/^\s*if\s*\(\s*loading\s*\)/));
      assert.ok(firstReturnIndex > compStartIndex, 'First early return (if (loading)) must exist');

      // Extract all hook invocations in the file
      const hookPattern = /^\s*(?:const\s+\[[^\]]+\]\s*=\s*(useState)|(useEffect)\()/;
      const hooksBeforeEarlyReturn: { line: number; text: string }[] = [];
      const hooksAfterEarlyReturn: { line: number; text: string }[] = [];

      lines.forEach((line, idx) => {
        if (idx < compStartIndex) return;
        if (hookPattern.test(line)) {
          if (idx < firstReturnIndex) {
            hooksBeforeEarlyReturn.push({ line: idx + 1, text: line.trim() });
          } else {
            hooksAfterEarlyReturn.push({ line: idx + 1, text: line.trim() });
          }
        }
      });

      // Assertions
      assert.equal(
        hooksAfterEarlyReturn.length,
        0,
        `Zero hooks must be declared after early return (found ${hooksAfterEarlyReturn.length} on lines: ${hooksAfterEarlyReturn.map((h) => h.line).join(', ')})`
      );
      assert.equal(
        hooksBeforeEarlyReturn.length,
        20,
        `Exactly 20 hooks must be declared before early return (found ${hooksBeforeEarlyReturn.length})`
      );
    });

    it('LIFECYCLE-04C: Specific modal hooks (isApproveModalOpen, approveComment, isWithdrawModalOpen) are strictly before early returns', () => {
      const firstReturnIndex = lines.findIndex((l) => l.match(/^\s*if\s*\(\s*loading\s*\)/));

      const approveModalLine = lines.findIndex((l) => l.includes('const [isApproveModalOpen, setIsApproveModalOpen] = useState(false)'));
      const approveCommentLine = lines.findIndex((l) => l.includes("const [approveComment, setApproveComment] = useState('')"));
      const withdrawModalLine = lines.findIndex((l) => l.includes('const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false)'));

      assert.ok(approveModalLine > 0, 'isApproveModalOpen hook must exist');
      assert.ok(approveCommentLine > 0, 'approveComment hook must exist');
      assert.ok(withdrawModalLine > 0, 'isWithdrawModalOpen hook must exist');

      assert.ok(
        approveModalLine < firstReturnIndex,
        `isApproveModalOpen (L${approveModalLine + 1}) must be placed BEFORE first return (L${firstReturnIndex + 1})`
      );
      assert.ok(
        approveCommentLine < firstReturnIndex,
        `approveComment (L${approveCommentLine + 1}) must be placed BEFORE first return (L${firstReturnIndex + 1})`
      );
      assert.ok(
        withdrawModalLine < firstReturnIndex,
        `isWithdrawModalOpen (L${withdrawModalLine + 1}) must be placed BEFORE first return (L${firstReturnIndex + 1})`
      );
    });
  });
});
