import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActionability, isProxySubmission } from '../utils/applicationActionabilityResolver';
import { Application, User } from '../types';

describe('Unified Workflow Action Semantic Reconciliation — Client Golden Tests', () => {
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

  const createTestApp = (overrides: Partial<Application> = {}): Application => ({
    id: 100,
    type_id: 'LEAVE_ANNUAL',
    subject_user_id: 1,
    applicant_id: 1,
    submitted_by_user_id: 1,
    submission_actor_type: 'SELF',
    title: 'テスト申請',
    form_data: { startDate: '2026-06-01', unitType: 'DAY' },
    current_status: 'SUBMITTED',
    current_step_order: 1,
    version: 1,
    created_at: '2026-06-01T08:00:00Z',
    updated_at: '2026-06-01T08:00:00Z',
    steps: [
      {
        id: 1,
        application_id: 100,
        approval_cycle: 1,
        step_order: 1,
        step_name: '教頭審査',
        action_type: 'REVIEW',
        required_role_id: 'VICE_PRINCIPAL',
        status: 'PENDING',
      },
      {
        id: 2,
        application_id: 100,
        approval_cycle: 1,
        step_order: 2,
        step_name: '校長受領確認',
        action_type: 'ACK',
        is_final_decision_step: 1,
        required_role_id: 'PRINCIPAL',
        status: 'WAITING',
      },
    ],
    ...overrides,
  });

  // GT-ACTION-01-CLIENT: REVIEW ステップにおいて canApprove = true (確認して進達)
  it('GT-ACTION-01-CLIENT: REVIEWステップにおいて教頭は canApprove = true (確認して進達可能)', () => {
    const app = createTestApp();
    const action = resolveActionability(app, vpUser);
    assert.equal(action.canApprove, true);
  });

  // GT-ACTION-02-CLIENT: REVIEW ステップにおいて canReturn = true (差戻し)
  it('GT-ACTION-02-CLIENT: REVIEWステップにおいて教頭は canReturn = true (差戻し可能)', () => {
    const app = createTestApp();
    const action = resolveActionability(app, vpUser);
    assert.equal(action.canReturn, true);
  });

  // GT-ACTION-03-CLIENT: REVIEW ステップにおいて canReject = false (却下ボタン非表示)
  it('GT-ACTION-03-CLIENT: REVIEWステップにおいて教頭は canReject = false (却下ボタン非表示・DECIDE-Only)', () => {
    const app = createTestApp();
    const action = resolveActionability(app, vpUser);
    assert.equal(action.canReject, false);
  });

  // GT-ACTION-04-CLIENT: DECIDE ステップにおいて canApprove = true (承認する)
  it('GT-ACTION-04-CLIENT: DECIDEステップにおいて校長は canApprove = true (決裁・承認可能)', () => {
    const app = createTestApp({
      type_id: 'LEAVE_SICK',
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長決裁', action_type: 'DECIDE', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canApprove, true);
  });

  // GT-ACTION-05-CLIENT: DECIDE ステップにおいて canReturn = true (差戻し)
  it('GT-ACTION-05-CLIENT: DECIDEステップにおいて校長は canReturn = true (差戻し可能)', () => {
    const app = createTestApp({
      type_id: 'LEAVE_SICK',
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長決裁', action_type: 'DECIDE', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canReturn, true);
  });

  // GT-ACTION-06-CLIENT: DECIDE ステップにおいて canReject = false (Universal RETURN Model: 却下ボタン非表示)
  it('GT-ACTION-06-CLIENT: DECIDEステップにおいて校長は canReject = false (Universal RETURN Model: 却下ボタン非表示)', () => {
    const app = createTestApp({
      type_id: 'LEAVE_SICK',
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長決裁', action_type: 'DECIDE', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canReject, false);
  });

  // GT-ACTION-07-CLIENT: ACK ステップにおいて canReturn = false (差戻しボタン非表示)
  it('GT-ACTION-07-CLIENT: ACKステップにおいて校長は canReturn = false (差戻しボタン非表示・非裁量)', () => {
    const app = createTestApp({
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長受領確認', action_type: 'ACK', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canReturn, false);
  });

  // GT-ACTION-08-CLIENT: ACK ステップにおいて canReject = false (却下ボタン非表示)
  it('GT-ACTION-08-CLIENT: ACKステップにおいて校長は canReject = false (却下ボタン非表示・非裁量)', () => {
    const app = createTestApp({
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長受領確認', action_type: 'ACK', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canReject, false);
  });

  // GT-ACTION-09-CLIENT: 第三者（校長）による年休 ACK ステップで canApprove = true (受領確認する)
  it('GT-ACTION-09-CLIENT: 一般教員の年休届出のACKステップにおいて校長は canApprove = true (受領確認可能)', () => {
    const app = createTestApp({
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長受領確認', action_type: 'ACK', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canApprove, true);
    assert.equal(action.canReturn, false);
    assert.equal(action.canReject, false);
  });

  // GT-ACTION-10-CLIENT: 校長本人による年休 ACK ステップ (Positive ACK-A) で canApprove = true
  it('GT-ACTION-10-CLIENT: 校長本人届出の年休において、Positive ACK-A により校長本人は canApprove = true (受領確認ボタン表示)', () => {
    const app = createTestApp({
      subject_user_id: 4, // 校長C本人
      applicant_id: 4,
      submitted_by_user_id: 4,
      submission_actor_type: 'SELF',
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長受領確認', action_type: 'ACK', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', assigned_user_id: 4, status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canApprove, true, 'Positive ACK-A must allow principal to acknowledge own annual leave');
    assert.equal(action.canReturn, false);
    assert.equal(action.canReject, false);
  });

  // GT-ACTION-11-CLIENT: 校長本人による病休 DECIDE ステップ (SELF-DECISION) は canApprove = false
  it('GT-ACTION-11-CLIENT: 校長本人の病気休暇（DECIDE型）において、自己決裁は厳格禁止 (canApprove = false, canReject = false)', () => {
    const app = createTestApp({
      type_id: 'LEAVE_SICK',
      subject_user_id: 4, // 校長C本人
      applicant_id: 4,
      submitted_by_user_id: 4,
      submission_actor_type: 'SELF',
      current_step_order: 2,
      steps: [
        { id: 1, application_id: 100, approval_cycle: 1, step_order: 1, step_name: '教頭審査', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
        { id: 2, application_id: 100, approval_cycle: 1, step_order: 2, step_name: '校長決裁', action_type: 'DECIDE', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', assigned_user_id: 4, status: 'PENDING' },
      ],
    });
    const action = resolveActionability(app, principalUser);
    assert.equal(action.canApprove, false, 'Self decision must remain forbidden');
    assert.equal(action.canReturn, false);
    assert.equal(action.canReject, false);
  });

  // GT-ACTION-12-CLIENT: 本人申請の場合、isProxySubmission は false、isProxySubmitter は false
  it('GT-ACTION-12-CLIENT: 本人申請（submission_actor_type = SELF）の場合、proxySubmitterName が存在していても isProxySubmission は false', () => {
    const app = createTestApp({
      subject_user_id: 4,
      submitted_by_user_id: 4,
      submission_actor_type: 'SELF',
      proxy_user_name: '鈴木 健一 (校長C)', // サーバーが pu.display_name を誤って返した場合の防護
    });
    assert.equal(isProxySubmission(app), false, 'SELF application must not be proxy');

    const action = resolveActionability(app, principalUser);
    // 本人申請者自身が操作する場合でも、isProxySubmitter は false であること
    assert.equal(action.canEditDraft, false); // current_status is SUBMITTED
  });

  // GT-ACTION-13-CLIENT: 代理申請の場合、isProxySubmission は true
  it('GT-ACTION-13-CLIENT: 代理申請（submission_actor_type = PROXY）の場合、isProxySubmission は true', () => {
    const app = createTestApp({
      subject_user_id: 1,
      submitted_by_user_id: 3,
      submission_actor_type: 'PROXY',
      proxy_user_name: '田中 誠 (教頭B)',
    });
    assert.equal(isProxySubmission(app), true, 'PROXY application must be recognized as proxy');
  });
});
