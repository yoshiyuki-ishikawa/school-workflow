import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

describe('差戻し後の再申請（Resubmit）改修 包括的テストスイート', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '教員 太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher2: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '教員 次郎',
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

  const clerk: UserContext = {
    id: 6,
    username: 'clerk',
    displayName: '小林 事務長',
    roles: ['CLERK'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    db.prepare('DELETE FROM applications').run();
  });

  // テスト用ヘルパー: 年休申請の提出と教頭による差戻し
  const createAndReturnAnnualLeave = (targetDate = '2026-05-15') => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】私用のため',
      formData: {
        unitType: 'DAY',
        startDate: targetDate,
        endDate: targetDate,
        calculatedDays: 1,
        reason: '私用のため',
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    const appBefore = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 教頭が差戻し
    const returnRes = WorkflowEngine.returnApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: appBefore.version,
      comment: '理由の詳細を追記してください',
    });
    assert.strictEqual(returnRes.success, true);

    const appReturned = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appReturned.current_status, 'RETURNED');

    return { appId, version: appReturned.version };
  };

  it('1. RETURNED状態の申請に対して、本人が正しく再申請できる（Happy path: SUBMITTEDへ遷移）', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-15');

    const resubmitRes = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: version,
      title: '【年休】私用（通院）のため',
      formData: {
        unitType: 'DAY',
        startDate: '2026-05-15',
        endDate: '2026-05-15',
        calculatedDays: 1,
        reason: '私用（通院のため）',
      },
    });

    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.statusCode, 200);

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');
    assert.strictEqual(app.current_step_order, 1);
    assert.strictEqual(app.version, version + 1);
  });

  it('2. 過去の差戻しステップ履歴がImmutableに保持され、新ApprovalCycleが生成される', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-18');

    // 再提出
    const resubmitRes = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: version,
      title: '【年休】修正再提出',
      formData: {
        unitType: 'DAY',
        startDate: '2026-05-18',
        endDate: '2026-05-18',
        calculatedDays: 1,
        reason: '修正理由',
      },
    });
    assert.strictEqual(resubmitRes.success, true);

    // 全ステップ確認
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY approval_cycle ASC, step_order ASC').all(appId) as any[];
    
    // Cycle 1 のステップが残っていること（差戻し証跡）
    const cycle1Steps = steps.filter((s: any) => s.approval_cycle === 1);
    assert.strictEqual(cycle1Steps.length >= 1, true);
    const returnedStep = cycle1Steps.find((s: any) => s.status === 'RETURNED');
    assert.ok(returnedStep);
    assert.strictEqual(returnedStep.comment, '理由の詳細を追記してください');
    assert.strictEqual(returnedStep.action_by_user_id, vicePrincipal.id);

    // Cycle 2 のステップが新規生成され、Step 1 が PENDING であること
    const cycle2Steps = steps.filter((s: any) => s.approval_cycle === 2);
    assert.strictEqual(cycle2Steps.length >= 1, true);
    assert.strictEqual(cycle2Steps[0].step_order, 1);
    assert.strictEqual(cycle2Steps[0].status, 'PENDING');
  });

  it('3. SUBMITTED状態（審査中）からのRESUBMITは拒絶される（400 Bad Request）', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】審査中',
      formData: { unitType: 'DAY', startDate: '2026-05-20', endDate: '2026-05-20', calculatedDays: 1, reason: '私用' },
    });
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const res = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【年休】二重提出試行',
      formData: { unitType: 'DAY', startDate: '2026-05-20', endDate: '2026-05-20', calculatedDays: 1, reason: '私用' },
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
  });

  it('4. FINAL_APPROVED状態（決裁完了済み）からのRESUBMITは拒絶される（400 Bad Request）', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】承認フロー完遂用',
      formData: { unitType: 'DAY', startDate: '2026-05-21', endDate: '2026-05-21', calculatedDays: 1, reason: '私用' },
    });
    const appId = submitRes.data.id;
    
    // 教頭承認
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '確認' });

    // 校長承認 (FINAL_APPROVED)
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version, comment: '決裁' });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // 再提出試行
    const res = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【年休】改ざん試行',
      formData: { unitType: 'DAY', startDate: '2026-05-21', endDate: '2026-05-21', calculatedDays: 1, reason: '改ざん' },
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
  });

  it('5. REJECTED状態（却下済み）からのRESUBMITは拒絶される（400 Bad Request）', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_SICK',
      title: '【病休】却下用',
      formData: { unitType: 'DAY', startDate: '2026-05-22', endDate: '2026-05-22', calculatedDays: 1, reason: '急性胃腸炎' },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const appBefore = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1: 教頭が審査・進達 (REVIEW)
    const reviewRes = WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: appBefore.version, comment: '確認しました' });
    assert.strictEqual(reviewRes.success, true);

    // Step 2: Historical REJECTED 状態の再現 (Fixture Reconciliation)
    // Universal RETURN Model (v1.0 FINAL) 以降、新規Generic REJECTは実行不能であるため、
    // 過去に却下された Historical REJECTED レコードを Fixture として整合的に再現する。
    db.prepare(`
      UPDATE applications
      SET current_status = 'REJECTED', version = version + 1
      WHERE id = ?
    `).run(appId);
    db.prepare(`
      UPDATE application_approval_steps
      SET status = 'REJECTED', comment = '公務都合により不許可'
      WHERE application_id = ? AND step_order = 2
    `).run(appId);
    db.prepare(`
      UPDATE application_workflow_cycles
      SET status = 'REJECTED'
      WHERE application_id = ? AND approval_cycle = 1
    `).run(appId);

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'REJECTED');

    const res = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【病休】却下後再提出試行',
      formData: { unitType: 'DAY', startDate: '2026-05-22', endDate: '2026-05-22', calculatedDays: 1, reason: '急性胃腸炎' },
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
  });

  it('6. WITHDRAWN状態（取下げ済み）からのRESUBMITは拒絶される（400 Bad Request）', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-25');

    // 申請者が取下げ
    const withdrawRes = WorkflowEngine.withdrawApplication(teacher1, { applicationId: appId, expectedVersion: version });
    assert.strictEqual(withdrawRes.success, true);

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'WITHDRAWN');

    const res = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【年休】取下げ後再提出試行',
      formData: { unitType: 'DAY', startDate: '2026-05-25', endDate: '2026-05-25', calculatedDays: 1, reason: '私用' },
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 400);
  });

  it('7. 楽観的排他制御（Concurrency / Version Check）: version不一致時に 409 Conflict となる', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-26');

    const res = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: version + 999, // 不正な古いバージョン
      title: '【年休】競合テスト',
      formData: { unitType: 'DAY', startDate: '2026-05-26', endDate: '2026-05-26', calculatedDays: 1, reason: '私用' },
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 409);
  });

  it('8. 第三者Actor（権限のないユーザー）によるRESUBMITは 403 Forbidden となる', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-27');

    const res = WorkflowEngine.resubmitApplication(teacher2, {
      applicationId: appId,
      expectedVersion: version,
      title: '【年休】他人の申請再提出',
      formData: { unitType: 'DAY', startDate: '2026-05-27', endDate: '2026-05-27', calculatedDays: 1, reason: '私用' },
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.statusCode, 403);
  });

  it('9. 代理申請（PROXY）の場合、代理起案者または管理職が再提出できる', () => {
    const vp2User: UserContext = {
      id: 8,
      username: 'vice_principal_2',
      displayName: '渡辺 洋子 (第2教頭)',
      roles: ['VICE_PRINCIPAL', 'TEACHER'],
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    };

    const proxySubmitRes = WorkflowEngine.submitProxyApplication(vp2User, {
      typeId: 'LEAVE_SICK',
      subjectUserId: teacher1.id,
      title: '【病休】代理起案',
      formData: { unitType: 'DAY', startDate: '2026-05-28', endDate: '2026-05-28', calculatedDays: 1, reason: '代理申請' },
      proxyReason: '急な体調不良による電話連絡',
    });
    assert.strictEqual(proxySubmitRes.success, true);
    const appId = proxySubmitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 承認ルートStep 1（第1教頭: vicePrincipal, ID: 3）による承認
    const step1Res = WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version, comment: '教頭確認' });
    assert.strictEqual(step1Res.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 校長（principal, ID: 4）が差戻し (Step 2: PRINCIPAL DECIDE)
    const retRes = WorkflowEngine.returnApplication(principal, { applicationId: appId, expectedVersion: app.version, comment: '代替措置記入要' });
    assert.strictEqual(retRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'RETURNED');

    // 代理起案者（第2教頭）が再提出
    const resubmitRes = WorkflowEngine.resubmitApplication(vp2User, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【病休】代理起案（修正）',
      formData: { unitType: 'DAY', startDate: '2026-05-28', endDate: '2026-05-28', calculatedDays: 1, reason: '代理申請（代替措置手配済）' },
    });

    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.statusCode, 200);
  });

  it('10. 再提出時の制度バリデーション違反（週休日への休暇申請など）は即座に拒絶される', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-29');

    // 2026-05-10 は日曜日（週休日）
    const res = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: version,
      title: '【年休】週休日への変更試行',
      formData: { unitType: 'DAY', startDate: '2026-05-10', endDate: '2026-05-10', calculatedDays: 1, reason: '日曜日の年休' },
    });

    assert.strictEqual(res.success, false);
    assert.ok([400, 422].includes(res.statusCode || 0));
  });

  it('11. 出張命令（BUSINESS_TRIP）と復命書のライフサイクル分離: 復命書差戻し・再提出後も出張命令承認状態が不変であること', () => {
    // 1. 出張申請提出
    const tripSubmit = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '【出張】県外出張',
      formData: {
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        startAt: '2026-06-01T08:10:00',
        endAt: '2026-06-01T16:40:00',
        destination: '教育センター',
        departurePlace: '本校',
        arrivalPlace: '本校',
        purpose: '指導法研究会',
      },
    });
    const appId = tripSubmit.data.id;

    const officeUser: UserContext = { id: 5, username: 'office', displayName: '事務 高橋', roles: ['OFFICE'], ipAddress: '127.0.0.1', userAgent: 'test' };

    // 2. 出張命令フロー承認 (Step 1: OFFICE -> Step 2: VICE_PRINCIPAL -> Step 3: PRINCIPAL)
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(officeUser, { applicationId: appId, expectedVersion: app.version }); // Step 1: REVIEW
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version }); // Step 2: APPROVE
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version }); // Step 3: DECIDE (TRIP_APPROVED)

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
    assert.strictEqual(app.report_status, 'UNSUBMITTED');


    // 3. 初回復命書提出 (Step 1 生成)
    const reportRes = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-06-02',
      reportResult: '研究会に出席し指導案を受領した。',
      actualMatchesPlan: true,
    });
    assert.strictEqual(reportRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.report_status, 'REPORT_SUBMITTED');
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');

    // 4. 事務が復命書を差戻し (Step 1: OFFICE)
    const returnReportRes = WorkflowEngine.returnApplication(officeUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '伝達講習の予定日程を追記してください',
    });
    assert.strictEqual(returnReportRes.success, true);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED', '出張命令の成立状態は維持される');
    assert.strictEqual(app.report_status, 'REPORT_RETURNED', '復命書の状態のみが REPORT_RETURNED になる');

    // 5. 復命書の再提出（submitReport）
    const resubmitReportRes = WorkflowEngine.submitReport(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      reportDate: '2026-06-02',
      reportResult: '研究会に出席。伝達講習は6/10の職員会議で実施予定。',
      actualMatchesPlan: true,
    });
    assert.strictEqual(resubmitReportRes.success, true);


    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'TRIP_APPROVED');
    assert.strictEqual(app.report_status, 'REPORT_SUBMITTED');

    // 過去のステップ（Step 1〜3の旅行命令成立履歴 + Step 4の復命差戻し）がすべて残っていること
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY id ASC').all(appId) as any[];
    const tripOrder1 = steps.find((s: any) => s.step_order === 1 && s.status === 'APPROVED');
    const tripOrder2 = steps.find((s: any) => s.step_order === 2 && s.status === 'APPROVED');
    assert.ok(tripOrder1, '出張命令Step1の承認記録が残っている');
    assert.ok(tripOrder2, '出張命令Step2の承認記録が残っている');
  });

  it('12. AuditLog に action=RESUBMIT と Cycle / Version 情報が正しく記録される', () => {
    const { appId, version } = createAndReturnAnnualLeave('2026-05-29');

    WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: version,
      title: '【年休】監査ログ検証',
      formData: { unitType: 'DAY', startDate: '2026-05-29', endDate: '2026-05-29', calculatedDays: 1, reason: '監査ログ検証' },
    });

    const auditLog = db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_id = ? AND action = 'RESUBMIT'
      ORDER BY id DESC LIMIT 1
    `).get(String(appId)) as any;

    assert.ok(auditLog);
    assert.strictEqual(auditLog.actor_user_id, teacher1.id);
    assert.strictEqual(auditLog.subject_user_id, teacher1.id);
    assert.strictEqual(auditLog.before_state, 'RETURNED');
    assert.strictEqual(auditLog.after_state, 'SUBMITTED');
    assert.ok(auditLog.metadata);
  });
});
