import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActionability } from '../utils/applicationActionabilityResolver';
import { Application, User } from '../types';

describe('Cancellation Actionability Projection Golden Tests (GT-UI-CANCEL-APPROVE-01〜05)', () => {
  const teacherUser: User = {
    id: 1,
    username: 'teacher1',
    displayName: '教員 太郎',
    roles: ['TEACHER'],
    department: '教務部',
  };

  const vpUser: User = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    department: '管理部',
  };

  const principalUser: User = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    department: '管理部',
  };

  const officeUser: User = {
    id: 5,
    username: 'office',
    displayName: '高橋 節子 (事務D)',
    roles: ['OFFICE'],
    department: '事務部',
  };

  const createCancellationApp = (overrides: Partial<Application> = {}): Application => ({
    id: 100,
    type_id: 'BUSINESS_TRIP',
    subject_user_id: 1,
    applicant_id: 1,
    submitted_by_user_id: 1,
    submission_actor_type: 'SELF',
    title: '教員研究研修出張',
    form_data: { startDate: '2026-10-20', destination: '教育センター' },
    current_status: 'TRIP_APPROVED',
    current_step_order: 1,
    version: 2,
    created_at: '2026-10-20T08:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
    activeCancellationCycle: {
      id: 2,
      application_id: 100,
      approval_cycle: 2,
      cycle_purpose: 'CANCELLATION',
      workflow_source: 'TRIP_STANDARD_CANCEL_V3',
      status: 'IN_PROGRESS',
      started_by_user_id: 1,
      started_at: '2026-10-20T09:00:00Z',
    },
    steps: [
      {
        id: 1,
        application_id: 100,
        approval_cycle: 2,
        step_order: 1,
        step_name: '事務係審査 (出張・旅費係)',
        action_type: 'REVIEW',
        required_role_id: 'OFFICE',
        status: 'APPROVED',
      },
      {
        id: 2,
        application_id: 100,
        approval_cycle: 2,
        step_order: 2,
        step_name: '教頭取消確認',
        action_type: 'APPROVE',
        is_final_decision_step: 0,
        required_role_id: 'VICE_PRINCIPAL',
        status: 'PENDING',
      },
      {
        id: 3,
        application_id: 100,
        approval_cycle: 2,
        step_order: 3,
        step_name: '校長取消決裁',
        action_type: 'DECIDE',
        is_final_decision_step: 1,
        required_role_id: 'PRINCIPAL',
        status: 'WAITING',
      },
    ],
    ...overrides,
  });

  // ============================================================================
  // GT-UI-CANCEL-APPROVE-01: APPROVE && !isFinal 中間ステップ (教頭) の正方向進達
  // ============================================================================
  it('GT-UI-CANCEL-APPROVE-01: 取消ステップが APPROVE && !isFinal の場合、教頭に対して正方向進達および差戻しが許可される', () => {
    const app = createCancellationApp();
    const action = resolveActionability(app, vpUser);

    assert.strictEqual(action.canApproveCancellation, true, 'canApproveCancellation must be true');
    assert.strictEqual(action.canAdvanceCancellationReview, true, 'canAdvanceCancellationReview must be true');
    assert.strictEqual(action.canDeclineCancellation, false, 'canDeclineCancellation must be false (no intermediate reject)');
    assert.strictEqual(action.canReturnCancellation, true, 'canReturnCancellation must be true (remand allowed)');
    assert.strictEqual(action.canAcceptCancellation, false, 'canAcceptCancellation must be false (not final decision)');
  });

  // ============================================================================
  // GT-UI-CANCEL-APPROVE-02: REVIEW 中間ステップ (事務) の既存非回帰
  // ============================================================================
  it('GT-UI-CANCEL-APPROVE-02: 取消ステップが REVIEW の場合、事務に対して従来どおり正方向進達および差戻しが許可される', () => {
    const app = createCancellationApp({
      steps: [
        {
          id: 1,
          application_id: 100,
          approval_cycle: 2,
          step_order: 1,
          step_name: '事務係審査 (出張・旅費係)',
          action_type: 'REVIEW',
          is_final_decision_step: 0,
          required_role_id: 'OFFICE',
          status: 'PENDING',
        },
        {
          id: 2,
          application_id: 100,
          approval_cycle: 2,
          step_order: 2,
          step_name: '教頭取消確認',
          action_type: 'APPROVE',
          is_final_decision_step: 0,
          required_role_id: 'VICE_PRINCIPAL',
          status: 'WAITING',
        },
      ],
    });
    const action = resolveActionability(app, officeUser);

    assert.strictEqual(action.canApproveCancellation, true);
    assert.strictEqual(action.canAdvanceCancellationReview, true);
    assert.strictEqual(action.canDeclineCancellation, false);
    assert.strictEqual(action.canReturnCancellation, true);
  });

  // ============================================================================
  // GT-UI-CANCEL-APPROVE-03: DECIDE && isFinal 終端ステップ (校長) の決裁権限
  // ============================================================================
  it('GT-UI-CANCEL-APPROVE-03: 取消ステップが DECIDE && isFinal の場合、校長に対して取消同意・差戻しが許可され不同意はUI抑制される (Unified Two-Action v1.0 FINAL)', () => {
    const app = createCancellationApp({
      steps: [
        {
          id: 1,
          application_id: 100,
          approval_cycle: 2,
          step_order: 1,
          step_name: '事務係審査',
          action_type: 'REVIEW',
          status: 'APPROVED',
          required_role_id: 'OFFICE',
        },
        {
          id: 2,
          application_id: 100,
          approval_cycle: 2,
          step_order: 2,
          step_name: '教頭取消確認',
          action_type: 'APPROVE',
          status: 'APPROVED',
          required_role_id: 'VICE_PRINCIPAL',
        },
        {
          id: 3,
          application_id: 100,
          approval_cycle: 2,
          step_order: 3,
          step_name: '校長取消決裁',
          action_type: 'DECIDE',
          is_final_decision_step: 1,
          required_role_id: 'PRINCIPAL',
          status: 'PENDING',
        },
      ],
    });
    const action = resolveActionability(app, principalUser);

    assert.strictEqual(action.canApproveCancellation, true);
    assert.strictEqual(action.canAdvanceCancellationReview, false);
    assert.strictEqual(action.canAcceptCancellation, true);
    assert.strictEqual(action.canDeclineCancellation, false, 'Final DECIDE suppresses DECLINE_CANCELLATION in UI projection');
    assert.strictEqual(action.canReturnCancellation, true);
  });

  // ============================================================================
  // GT-UI-CANCEL-APPROVE-04: ACK ステップにおける非裁量契約の維持
  // ============================================================================
  it('GT-UI-CANCEL-APPROVE-04: 取消ステップが ACK の場合、不同意 (reject) および差戻し (return) は許可されない', () => {
    const app = createCancellationApp({
      steps: [
        {
          id: 3,
          application_id: 100,
          approval_cycle: 2,
          step_order: 3,
          step_name: '校長受領確認',
          action_type: 'ACK',
          is_final_decision_step: 1,
          required_role_id: 'PRINCIPAL',
          status: 'PENDING',
        },
      ],
    });
    const action = resolveActionability(app, principalUser);

    assert.strictEqual(action.canDeclineCancellation, false, 'ACK step cannot decline');
    assert.strictEqual(action.canReturnCancellation, false, 'ACK step cannot return');
  });

  // ============================================================================
  // GT-UI-CANCEL-APPROVE-05: 申請者本人による中間 APPROVE の自己承認遮断
  // ============================================================================
  it('GT-UI-CANCEL-APPROVE-05: 申請対象本人は中間 APPROVE ステップであっても自己承認および差戻しが厳格遮断される', () => {
    // 申請対象本人が教頭であるケース（教頭が自身の出張取消を見る）
    const app = createCancellationApp({
      subject_user_id: vpUser.id,
      applicant_id: vpUser.id,
      submitted_by_user_id: vpUser.id,
      activeCancellationCycle: {
        id: 2,
        application_id: 100,
        approval_cycle: 2,
        cycle_purpose: 'CANCELLATION',
        workflow_source: 'TRIP_STANDARD_CANCEL_V3',
        status: 'IN_PROGRESS',
        started_by_user_id: vpUser.id,
        started_at: '2026-10-20T09:00:00Z',
      },
      steps: [
        {
          id: 2,
          application_id: 100,
          approval_cycle: 2,
          step_order: 2,
          step_name: '教頭取消確認',
          action_type: 'APPROVE',
          is_final_decision_step: 0,
          required_role_id: 'VICE_PRINCIPAL',
          status: 'PENDING',
        },
      ],
    });
    const action = resolveActionability(app, vpUser);

    assert.strictEqual(action.canApproveCancellation, false, 'Subject cannot self-approve cancellation');
    assert.strictEqual(action.canAdvanceCancellationReview, false);
    assert.strictEqual(action.canReturnCancellation, false, 'Subject cannot return their own cancellation');
  });
});
