import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApplicationDisplayState } from './services/workflowPresentationResolver';
import { Application } from './types';

describe('Client Presentation Resolver Golden Tests (CL-CAR)', () => {
  it('CL-CAR-01: Normal application returned → primaryStatus: RETURNED, isReturnedActionableForUser: true for applicant', () => {
    const app: Application = {
      id: 101,
      type_id: 'ANNUAL_LEAVE',
      applicant_id: 10,
      submitted_by_user_id: 10,
      subject_user_id: 10,
      title: '年休申請',
      form_data: {},
      current_status: 'RETURNED',
      current_step_order: 1,
      version: 1,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T10:30:00Z',
    };

    const stateApplicant = resolveApplicationDisplayState(app, 10);
    assert.equal(stateApplicant.primaryStatus, 'RETURNED');
    assert.equal(stateApplicant.primaryLabel, '差戻し');
    assert.equal(stateApplicant.hasSecondaryStatus, false);
    assert.equal(stateApplicant.isReturnedActionableForUser, true);
    assert.equal(stateApplicant.showCancellationReturnBanner, false);

    const stateOther = resolveApplicationDisplayState(app, 20);
    assert.equal(stateOther.isReturnedActionableForUser, false);
  });

  it('CL-CAR-02: Cancellation returned → primaryStatus: FINAL_APPROVED, secondaryLabel: 取消申請：差戻し (要修正), isReturnedActionableForUser: true for action actor', () => {
    const app: Application = {
      id: 102,
      type_id: 'ANNUAL_LEAVE',
      applicant_id: 10,
      submitted_by_user_id: 10,
      subject_user_id: 10,
      title: '年休申請',
      form_data: {},
      current_status: 'FINAL_APPROVED',
      current_step_order: 2,
      version: 2,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T11:30:00Z',
      cancellationReturn: {
        cycleId: 2,
        approvalCycle: 2,
        status: 'RETURNED',
        returnReason: '添付書類の再提出が必要です。',
        returnedAt: '2026-09-10T11:30:00Z',
        returnedByUserId: 20,
        returnedByUserName: '教頭',
        actionActorUserId: 10,
      },
    };

    const state = resolveApplicationDisplayState(app, 10);
    assert.equal(state.primaryStatus, 'FINAL_APPROVED');
    assert.equal(state.primaryLabel, '決裁完了');
    assert.equal(state.hasSecondaryStatus, true);
    assert.equal(state.secondaryLabel, '取消申請：差戻し (要修正)');
    assert.equal(state.secondaryColor, 'rose');
    assert.equal(state.isReturnedActionableForUser, true);
    assert.equal(state.showCancellationReturnBanner, true);
  });

  it('CL-CAR-03: Cancellation returned with proxy submitter → action actor is proxy submitter (User 15), subject (User 10) is non-actionable', () => {
    const app: Application = {
      id: 103,
      type_id: 'ANNUAL_LEAVE',
      applicant_id: 10,
      submitted_by_user_id: 10,
      subject_user_id: 10,
      title: '年休申請',
      form_data: {},
      current_status: 'FINAL_APPROVED',
      current_step_order: 2,
      version: 2,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T11:30:00Z',
      cancellationReturn: {
        cycleId: 2,
        approvalCycle: 2,
        status: 'RETURNED',
        returnReason: '代理取消理由の不備',
        returnedAt: '2026-09-10T11:30:00Z',
        returnedByUserId: 20,
        returnedByUserName: '教頭',
        actionActorUserId: 15, // 代理取消申請者
      },
    };

    const stateProxy = resolveApplicationDisplayState(app, 15);
    assert.equal(stateProxy.isReturnedActionableForUser, true);

    const stateSubject = resolveApplicationDisplayState(app, 10);
    assert.equal(stateSubject.isReturnedActionableForUser, false);
  });

  it('CL-CAR-04: Fail-closed when actionActorUserId is null → actionable is false for all users', () => {
    const app: Application = {
      id: 104,
      type_id: 'ANNUAL_LEAVE',
      applicant_id: 10,
      submitted_by_user_id: 10,
      subject_user_id: 10,
      title: '年休申請',
      form_data: {},
      current_status: 'FINAL_APPROVED',
      current_step_order: 2,
      version: 2,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T11:30:00Z',
      cancellationReturn: {
        cycleId: 2,
        approvalCycle: 2,
        status: 'RETURNED',
        returnReason: '不明な取消差戻し',
        returnedAt: '2026-09-10T11:30:00Z',
        returnedByUserId: 20,
        returnedByUserName: '教頭',
        actionActorUserId: null,
      },
    };

    const stateApplicant = resolveApplicationDisplayState(app, 10);
    assert.equal(stateApplicant.isReturnedActionableForUser, false);

    const stateAny = resolveApplicationDisplayState(app, 99);
    assert.equal(stateAny.isReturnedActionableForUser, false);
  });

  it('CL-CAR-05: Cancellation IN_PROGRESS → hasSecondaryStatus: true, secondaryLabel: 取消審査中, isReturnedActionableForUser: false', () => {
    const app: Application = {
      id: 105,
      type_id: 'ANNUAL_LEAVE',
      applicant_id: 10,
      submitted_by_user_id: 10,
      subject_user_id: 10,
      title: '年休申請',
      form_data: {},
      current_status: 'FINAL_APPROVED',
      current_step_order: 2,
      version: 2,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T11:00:00Z',
      activeCancellationCycle: {
        id: 2,
        application_id: 105,
        approval_cycle: 2,
        cycle_purpose: 'CANCELLATION',
        workflow_source: 'POLICY_SYSTEM',
        status: 'IN_PROGRESS',
        started_at: '2026-09-10T11:00:00Z',
        started_by_user_id: 10,
      },
    };

    const state = resolveApplicationDisplayState(app, 10);
    assert.equal(state.primaryStatus, 'FINAL_APPROVED');
    assert.equal(state.primaryLabel, '決裁完了');
    assert.equal(state.hasSecondaryStatus, true);
    assert.equal(state.secondaryLabel, '取消審査中');
    assert.equal(state.secondaryColor, 'amber');
    assert.equal(state.isReturnedActionableForUser, false);
    assert.equal(state.showCancellationReturnBanner, false);
  });

  describe('Phase 2 Cancellation Resubmit UI Projection Tests (CL-CRESUB)', () => {
    it('CL-CRESUB-01: Owner + RETURNED → isReturnedActionableForUser: true, showCancellationReturnBanner: true', () => {
      const app: Application = {
        id: 201,
        type_id: 'ANNUAL_LEAVE',
        applicant_id: 10,
        title: '年休申請',
        form_data: {},
        current_status: 'FINAL_APPROVED',
        current_step_order: 2,
        version: 3,
        created_at: '2026-09-10T10:00:00Z',
        updated_at: '2026-09-10T12:00:00Z',
        cancellationReturn: {
          cycleId: 2,
          approvalCycle: 2,
          status: 'RETURNED',
          returnReason: '理由不備',
          actionActorUserId: 10,
        },
      };

      const displayState = resolveApplicationDisplayState(app, 10);
      assert.equal(displayState.isReturnedActionableForUser, true);
      assert.equal(displayState.showCancellationReturnBanner, true);
      assert.equal(displayState.secondaryLabel, '取消申請：差戻し (要修正)');
    });

    it('CL-CRESUB-02: Non-Owner → isReturnedActionableForUser: false', () => {
      const app: Application = {
        id: 202,
        type_id: 'ANNUAL_LEAVE',
        applicant_id: 10, // 原申請本人
        title: '年休申請',
        form_data: {},
        current_status: 'FINAL_APPROVED',
        current_step_order: 2,
        version: 3,
        created_at: '2026-09-10T10:00:00Z',
        updated_at: '2026-09-10T12:00:00Z',
        cancellationReturn: {
          cycleId: 2,
          approvalCycle: 2,
          status: 'RETURNED',
          returnReason: '代理理由不備',
          actionActorUserId: 30, // 代理起案者
        },
      };

      // 原申請本人(10)は Action Owner ではないため false
      const displayStateSubject = resolveApplicationDisplayState(app, 10);
      assert.equal(displayStateSubject.isReturnedActionableForUser, false);

      // 第三者教員(99)も false
      const displayStateOther = resolveApplicationDisplayState(app, 99);
      assert.equal(displayStateOther.isReturnedActionableForUser, false);

      // 代理起案者(30)本人のみ true
      const displayStateActor = resolveApplicationDisplayState(app, 30);
      assert.equal(displayStateActor.isReturnedActionableForUser, true);
    });

    it('CL-CRESUB-03: Non-RETURNED status → isReturnedActionableForUser: false', () => {
      const app: Application = {
        id: 203,
        type_id: 'ANNUAL_LEAVE',
        applicant_id: 10,
        title: '年休申請',
        form_data: {},
        current_status: 'FINAL_APPROVED',
        current_step_order: 2,
        version: 3,
        created_at: '2026-09-10T10:00:00Z',
        updated_at: '2026-09-10T12:00:00Z',
      };

      const displayState = resolveApplicationDisplayState(app, 10);
      assert.equal(displayState.isReturnedActionableForUser, false);
    });

    it('CL-CRESUB-04: RESUBMIT 成功後の Projection (Cycle 3 IN_PROGRESS) → Actionable 消滅 & 取消審査中表示', () => {
      const appAfterResubmit: Application = {
        id: 204,
        type_id: 'ANNUAL_LEAVE',
        applicant_id: 10,
        title: '年休申請',
        form_data: {},
        current_status: 'FINAL_APPROVED',
        current_step_order: 2,
        version: 4,
        created_at: '2026-09-10T10:00:00Z',
        updated_at: '2026-09-10T13:00:00Z',
        activeCancellationCycle: {
          id: 3,
          application_id: 204,
          approval_cycle: 3,
          cycle_purpose: 'CANCELLATION',
          workflow_source: 'NEW_POLICY_ENGINE',
          status: 'IN_PROGRESS',
          started_at: '2026-09-10T13:00:00Z',
          started_by_user_id: 10,
          cancellation_reason: '修正後取消理由',
        },
        cancellationReturn: null, // 再提出成功により RETURNED は解消
      };

      const displayState = resolveApplicationDisplayState(appAfterResubmit, 10);
      assert.equal(displayState.isReturnedActionableForUser, false);
      assert.equal(displayState.showCancellationReturnBanner, false);
      assert.equal(displayState.hasSecondaryStatus, true);
      assert.equal(displayState.secondaryLabel, '取消審査中');
      assert.equal(displayState.secondaryColor, 'amber');
    });
  });
});
