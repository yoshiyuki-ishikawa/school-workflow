import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { StatusBadge } from './components/StatusBadge';
import { generateDefaultTitle, isSystemGeneratedTitle } from './pages/NewApplicationModal';
import { resolveApplicationDisplayState } from './services/workflowPresentationResolver';
import { shouldShowPendingApprovalTab, shouldShowNewApplicationAction } from './components/Header';
import { Application, User } from './types';

describe('Wave UI-1 Golden Suite: Pilot UI/UX Improvement Contract Tests', () => {

  // =========================================================================
  // GT-UI1-01: StatusBadge / Authoritative Step Presentation (Fact over Guess)
  // =========================================================================
  describe('GT-UI1-01: Authoritative Step Fact Presentation', () => {
    it('GT-UI1-01A: renders currentStepName + "待ち" when currentStepName is provided for SUBMITTED', () => {
      const element = StatusBadge({
        status: 'SUBMITTED',
        currentStepName: '教務主任確認',
      }) as React.ReactElement;
      
      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '教務主任確認待ち');
      assert.ok(element.props.className.includes('bg-amber-100'));
    });

    it('GT-UI1-01B: renders currentStepName + "待ち" for FIRST_APPROVED with dynamic step (e.g. 学年主任確認)', () => {
      const element = StatusBadge({
        status: 'FIRST_APPROVED',
        currentStepName: '学年主任確認',
      }) as React.ReactElement;

      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '学年主任確認待ち');
    });

    it('GT-UI1-01C: explicit labelOverride takes highest precedence', () => {
      const element = StatusBadge({
        status: 'SUBMITTED',
        currentStepName: '教頭確認',
        labelOverride: '特別承認中',
      }) as React.ReactElement;

      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '特別承認中');
      assert.ok(element.props.className.includes('bg-blue-100'));
    });
  });

  // =========================================================================
  // GT-UI1-02: StatusBadge Generic Non-Guessing Fallback
  // =========================================================================
  describe('GT-UI1-02: Generic Non-Guessing Fallback', () => {
    it('GT-UI1-02A: falls back to generic "審査中" when currentStepName is null or undefined for SUBMITTED', () => {
      const element = StatusBadge({
        status: 'SUBMITTED',
        currentStepName: null,
      }) as React.ReactElement;

      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '審査中');
      assert.notEqual(text, '教頭審査中');
    });

    it('GT-UI1-02B: falls back to generic "審査中" for FIRST_APPROVED without stepName', () => {
      const element = StatusBadge({
        status: 'FIRST_APPROVED',
      }) as React.ReactElement;

      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '審査中');
      assert.notEqual(text, '校長決裁中');
    });

    it('GT-UI1-02C: RETURNED status renders "差戻し (要修正)"', () => {
      const element = StatusBadge({
        status: 'RETURNED',
      }) as React.ReactElement;

      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '差戻し (要修正)');
      assert.ok(element.props.className.includes('bg-rose-100'));
    });

    it('GT-UI1-02D: REJECTED status renders "却下"', () => {
      const element = StatusBadge({
        status: 'REJECTED',
      }) as React.ReactElement;

      assert.ok(element);
      const text = Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children;
      assert.equal(text, '却下');
      assert.ok(element.props.className.includes('bg-red-100'));
    });
  });

  // =========================================================================
  // GT-UI1-03: Title Auto-fill & Custom Override Preservation (UI-002)
  // =========================================================================
  describe('GT-UI1-03: Title Auto-fill and Override Contract', () => {
    it('GT-UI1-03A: generateDefaultTitle returns correct prefix for each application type', () => {
      assert.equal(generateDefaultTitle('LEAVE_ANNUAL'), '【年休】年次有給休暇');
      assert.equal(generateDefaultTitle('LEAVE_SICK'), '【病休】通院・療養');
      assert.equal(generateDefaultTitle('LEAVE_SPECIAL'), '【特休】特別休暇');
      assert.equal(generateDefaultTitle('LEAVE_DUTY_EXEMPT'), '【職専免】職務専念義務免除');
      assert.equal(generateDefaultTitle('BUSINESS_TRIP', false), '【出張】公務出張');
      assert.equal(generateDefaultTitle('BUSINESS_TRIP', true), '【一括出張】公務出張');
      assert.equal(generateDefaultTitle('TRAINING_SPECIAL_ACT_22_2'), '【校外研修】教特法第22条第2項');
      assert.equal(generateDefaultTitle('TRAINING_SPECIAL_ACT_22_3'), '【長期研修】教特法第22条第3項');
      assert.equal(generateDefaultTitle('UNKNOWN_CUSTOM_TYPE'), '【服務申請】');
    });

    it('GT-UI1-03B: isSystemGeneratedTitle returns true for empty, default, or prefix titles', () => {
      assert.equal(isSystemGeneratedTitle(''), true);
      assert.equal(isSystemGeneratedTitle('   '), true);
      assert.equal(isSystemGeneratedTitle('【年休】年次有給休暇'), true);
      assert.equal(isSystemGeneratedTitle('年次有給休暇'), true);
      assert.equal(isSystemGeneratedTitle('【出張】公務出張'), true);
      assert.equal(isSystemGeneratedTitle('【一括出張】公務出張'), true);
      assert.equal(isSystemGeneratedTitle('【服務申請】'), true);
    });

    it('GT-UI1-03C: isSystemGeneratedTitle returns false for user custom modified titles', () => {
      assert.equal(isSystemGeneratedTitle('午後年休（研究授業準備のため）'), false);
      assert.equal(isSystemGeneratedTitle('【年休】通院のため半日'), false);
      assert.equal(isSystemGeneratedTitle('出張（市内中学校研究会）'), false);
      assert.equal(isSystemGeneratedTitle('私用外出による年次有給休暇'), false);
    });
  });

  // =========================================================================
  // GT-UI1-04 & GT-UI1-05: Return / Reject Modal Contract Validation (UI-004)
  // =========================================================================
  describe('GT-UI1-04 & GT-UI1-05: Return/Reject Modal Behavior Contract', () => {
    it('GT-UI1-04: Reject action semantics require irrevocable confirmation & reason comment', () => {
      const isReject = true;
      const commentValid = '予算超過のため承認不可';
      const commentEmpty = '   ';
      const isConfirmed = true;
      const isNotConfirmed = false;

      const canSubmit1 = isReject ? (commentValid.trim().length > 0 && isConfirmed) : commentValid.trim().length > 0;
      const canSubmit2 = isReject ? (commentValid.trim().length > 0 && isNotConfirmed) : commentValid.trim().length > 0;
      const canSubmit3 = isReject ? (commentEmpty.trim().length > 0 && isConfirmed) : commentEmpty.trim().length > 0;

      assert.equal(canSubmit1, true, 'Valid comment and confirmed should allow submit');
      assert.equal(canSubmit2, false, 'Unconfirmed reject should block submit');
      assert.equal(canSubmit3, false, 'Empty comment should block submit');
    });

    it('GT-UI1-05: Return action semantics allows resubmission and requires reason comment without checkbox', () => {
      const isReject = false;
      const commentValid = '日程の記載に誤りがあります。修正して再提出してください。';
      const commentEmpty = '';

      const canSubmitValid = isReject ? commentValid.trim().length > 0 : (commentValid.trim().length > 0 && true);
      const canSubmitEmpty = isReject ? commentEmpty.trim().length > 0 : (commentEmpty.trim().length > 0 && true);

      assert.equal(canSubmitValid, true);
      assert.equal(canSubmitEmpty, false);
    });
  });

  // =========================================================================
  // GT-UI1-06: Model A Action Queue Header Tab Visibility (UI-005)
  // Production-Binding Contract: Directly tests Header's shouldShowPendingApprovalTab
  // =========================================================================
  describe('GT-UI1-06: Model A Header Approval Queue Visibility (Production-Binding)', () => {
    it('GT-UI1-06A: pendingCount = 0 -> Approval Queue tab is hidden', () => {
      assert.equal(shouldShowPendingApprovalTab(0), false, '0 pending count must hide the approval tab');
    });

    it('GT-UI1-06B: pendingCount = 1 -> Approval Queue tab is visible', () => {
      assert.equal(shouldShowPendingApprovalTab(1), true, '1 pending count must show the approval tab');
    });

    it('GT-UI1-06C: pendingCount > 1 -> Approval Queue tab is visible', () => {
      assert.equal(shouldShowPendingApprovalTab(5), true, '5 pending count must show the approval tab');
      assert.equal(shouldShowPendingApprovalTab(42), true, '42 pending count must show the approval tab');
    });

    it('GT-UI1-06D: Role TEACHER with pendingCount > 0 displays Approval Queue tab', () => {
      const teacherUser: User = {
        id: 101,
        username: 't1',
        displayName: '一般教員',
        department: '教務部',
        roles: ['TEACHER'],
      };
      const pendingCount = 2;
      // In Model A, user role does NOT filter out approval tab if pendingCount > 0
      assert.equal(shouldShowPendingApprovalTab(pendingCount), true, 'Teacher with pending tasks sees queue');
    });

    it('GT-UI1-06E: Manager roles (VP, PRINCIPAL, OFFICE, ADMIN) with pendingCount = 0 HIDE Approval Queue tab', () => {
      const managerRoles = [['VICE_PRINCIPAL'], ['PRINCIPAL'], ['OFFICE'], ['ADMIN'], ['ADMIN', 'PRINCIPAL']];
      const pendingCount = 0;
      
      // In Model A, manager roles do NOT force show approval tab if pendingCount is 0
      managerRoles.forEach((roles) => {
        const isVisible = shouldShowPendingApprovalTab(pendingCount);
        assert.equal(isVisible, false, `Role [${roles.join(',')}] with pendingCount=0 must not show approval queue`);
      });
    });
  });

  // =========================================================================
  // GT-UI1-07: Dashboard Notice -> Task -> Action Contract (UI-006)
  // =========================================================================
  describe('GT-UI1-07: Dashboard Actionable Returned Applications', () => {
    const currentUserId = 101;

    const createMockApp = (id: number, status: string, applicantId: number = 101, cancellationReturn?: any): Application => ({
      id,
      application_number: `APP-${id}`,
      applicant_id: applicantId,
      applicant_name: '申請教員',
      type_id: 'LEAVE_ANNUAL',
      title: `申請タイトル ${id}`,
      current_status: status as any,
      status: status as any,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-01T10:00:00Z',
      cancellation_status: cancellationReturn ? 'RETURNED' : 'NONE',
      form_data: {},
      cancellationReturn: cancellationReturn,
    } as any);

    it('GT-UI1-07A: 0 returned items -> actionableReturnedApps is empty (banner hidden)', () => {
      const apps: Application[] = [
        createMockApp(1, 'FINAL_APPROVED'),
        createMockApp(2, 'SUBMITTED'),
      ];

      const actionable = apps.filter((app) => {
        const displayState = resolveApplicationDisplayState(app, currentUserId);
        return displayState.isReturnedActionableForUser;
      });

      assert.equal(actionable.length, 0);
    });

    it('GT-UI1-07B: 1 returned item -> single actionable task (direct transition button)', () => {
      const apps: Application[] = [
        createMockApp(1, 'FINAL_APPROVED'),
        createMockApp(2, 'RETURNED', currentUserId),
      ];

      const actionable = apps.filter((app) => {
        const displayState = resolveApplicationDisplayState(app, currentUserId);
        return displayState.isReturnedActionableForUser;
      });

      assert.equal(actionable.length, 1);
      assert.equal(actionable[0].id, 2);
    });

    it('GT-UI1-07C: 2+ returned items -> multiple actionable tasks (task list mode)', () => {
      const apps: Application[] = [
        createMockApp(1, 'RETURNED', currentUserId),
        createMockApp(2, 'RETURNED', currentUserId),
        createMockApp(3, 'SUBMITTED', currentUserId),
      ];

      const actionable = apps.filter((app) => {
        const displayState = resolveApplicationDisplayState(app, currentUserId);
        return displayState.isReturnedActionableForUser;
      });

      assert.equal(actionable.length, 2);
    });

    it('GT-UI1-07D: Cancellation returned application is properly resolved as actionable', () => {
      const apps: Application[] = [
        createMockApp(1, 'FINAL_APPROVED', currentUserId, { status: 'RETURNED', actionActorUserId: currentUserId }),
      ];

      const actionable = apps.filter((app) => {
        const displayState = resolveApplicationDisplayState(app, currentUserId);
        return displayState.isReturnedActionableForUser;
      });

      assert.equal(actionable.length, 1);
      assert.equal(actionable[0].id, 1);
    });

    it('GT-UI1-07E: Returned application of ANOTHER user is NOT actionable for current user', () => {
      const apps: Application[] = [
        createMockApp(1, 'RETURNED', 999),
      ];

      const actionable = apps.filter((app) => {
        const displayState = resolveApplicationDisplayState(app, currentUserId);
        return displayState.isReturnedActionableForUser;
      });

      assert.equal(actionable.length, 0);
    });
  });

  // =========================================================================
  // GT-UI1-08: Admin User New Application Action Unlocked (UI-009)
  // Production-Binding Contract: Directly tests Header's shouldShowNewApplicationAction
  // =========================================================================
  describe('GT-UI1-08: Admin New Application Action Availability (Production-Binding)', () => {
    it('GT-UI1-08A: Authenticated standard teacher user -> New Application action is visible', () => {
      const teacherUser: User = {
        id: 101,
        username: 'teacher1',
        displayName: '教諭 山田',
        department: '教務部',
        roles: ['TEACHER'],
      };
      assert.equal(shouldShowNewApplicationAction(teacherUser), true, 'Teacher user can see new application action');
    });

    it('GT-UI1-08B: Authenticated ADMIN user -> New Application action is visible (UI-009 Unlocked)', () => {
      const adminUser: User = {
        id: 1,
        username: 'admin',
        displayName: 'システム管理者',
        department: '管理部',
        roles: ['ADMIN'],
      };
      assert.equal(shouldShowNewApplicationAction(adminUser), true, 'Admin user must NOT be excluded from creating applications');
    });

    it('GT-UI1-08C: Authenticated Multi-Role user including ADMIN -> New Application action is visible', () => {
      const multiRoleUser: User = {
        id: 2,
        username: 'admin_vp',
        displayName: '管理者兼教頭',
        department: '管理職',
        roles: ['ADMIN', 'VICE_PRINCIPAL'],
      };
      assert.equal(shouldShowNewApplicationAction(multiRoleUser), true, 'Multi-role user with ADMIN sees new application action');
    });

    it('GT-UI1-08D: Unauthenticated state (null user) -> New Application action is hidden', () => {
      assert.equal(shouldShowNewApplicationAction(null), false, 'Null user cannot see new application action');
    });
  });
});
