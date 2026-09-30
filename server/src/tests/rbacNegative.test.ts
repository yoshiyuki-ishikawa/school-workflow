import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine, UserContext } from '../workflow/engine';

/**
 * C. RBAC Negative Test
 * セキュリティ・認可境界の完全遮断を検証 (403 Forbidden)
 */
export function runRbacNegativeTest(): boolean {
  console.log('--- [Test C: RBAC Negative Test] 開始 ---');
  initDatabase();
  seedDatabase();
  const db = getDb();

  // テスト実行前の承認ロック解除
  db.prepare(`DELETE FROM monthly_attendance_approvals WHERE user_id IN (1, 2, 3, 4)`).run();

  // ユーザーコンテキストの準備
  const teacherA: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const teacherB: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '佐藤 花子 (教員B)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  // Case 1: 一般教員が他教員の代理申請を試行 -> 403
  const proxyAttempt = WorkflowEngine.submitProxyApplication(teacherA, {
    typeId: 'LEAVE_ANNUAL',
    subjectUserId: 2, // 教員B
    title: '【不正代理】他人の年休',
    formData: { startDate: '2026-09-01', endDate: '2026-09-01', unitType: 'DAY' },
  });
  if (proxyAttempt.statusCode !== 403) {
    throw new Error(`Case 1 失敗: 一般教員の代理申請が403で遮断されませんでした (status: ${proxyAttempt.statusCode})`);
  }
  console.log('✔ Case 1: 一般教員による代理申請試行が 403 で確実に遮断されました');

  // Case 2: 一般教員が他教員の下書きを更新試行 -> 403
  const draftRes = WorkflowEngine.saveDraft(teacherA, {
    typeId: 'LEAVE_ANNUAL',
    title: '教員Aの下書き',
    formData: { startDate: '2026-09-01' },
  });
  const draftAppId = draftRes.data.id;

  const forbiddenDraftUpdate = WorkflowEngine.saveDraft(teacherB, {
    id: draftAppId,
    typeId: 'LEAVE_ANNUAL',
    title: '教員Bによる改ざん試行',
    formData: { startDate: '2026-09-02' },
  });
  if (forbiddenDraftUpdate.statusCode !== 403) {
    throw new Error(`Case 2 失敗: 他人の下書き更新が403で遮断されませんでした (status: ${forbiddenDraftUpdate.statusCode})`);
  }
  console.log('✔ Case 2: 他人の下書き更新試行が 403 で確実に遮断されました');

  // Case 3: 代理申請を作成した教頭による同一申請の自己承認試行 -> 403
  const validProxySubmit = WorkflowEngine.submitProxyApplication(vicePrincipal, {
    typeId: 'LEAVE_ANNUAL',
    subjectUserId: 1, // 教員A
    title: '【代理年休】教頭による教員Aの代行提出',
    formData: { startDate: '2026-09-08', endDate: '2026-09-08', unitType: 'DAY', calculatedDays: 1 },
    proxyReason: '急病による本人連絡代行',
  });
  if (!validProxySubmit.success) {
    throw new Error(`教頭の正規代理申請提出に失敗しました: ${validProxySubmit.message}`);
  }
  const proxyAppId = validProxySubmit.data.id;

  // 教頭（代理申請者）自身がStep 1（教頭確認）を承認しようとする -> 403
  const proxySelfApprove = WorkflowEngine.approveApplication(vicePrincipal, {
    applicationId: proxyAppId,
    expectedVersion: 1,
    comment: '代理者が自分で承認試行',
  });
  if (proxySelfApprove.statusCode !== 403) {
    throw new Error(`Case 3 失敗: 代理申請者による自己承認が403で遮断されませんでした (status: ${proxySelfApprove.statusCode})`);
  }
  console.log('✔ Case 3: 代理申請者（教頭）による自己承認が 403 で確実に遮断されました');

  // Case 4: 業務対象本人（Subject）による自己承認試行 -> 403
  const selfAppSubmit = WorkflowEngine.submitApplication(vicePrincipal, {
    typeId: 'LEAVE_ANNUAL',
    title: '【教頭自身の年休】',
    formData: { startDate: '2026-09-10', endDate: '2026-09-10', unitType: 'DAY', calculatedDays: 1 },
  });
  const vpOwnAppId = selfAppSubmit.data.id;

  const vpSelfApproveOwn = WorkflowEngine.approveApplication(vicePrincipal, {
    applicationId: vpOwnAppId,
    expectedVersion: 1,
    comment: '教頭本人が自分の申請を承認試行',
  });
  if (vpSelfApproveOwn.statusCode !== 403) {
    throw new Error(`Case 4 失敗: 業務対象本人による自己承認が403で遮断されませんでした (status: ${vpSelfApproveOwn.statusCode})`);
  }
  console.log('✔ Case 4: 業務対象本人（教頭）による自己承認が 403 で確実に遮断されました');

  // Case 5: 権限を持たないユーザーによる承認試行 -> 403
  const normalSubmit = WorkflowEngine.submitApplication(teacherA, {
    typeId: 'LEAVE_ANNUAL',
    title: '教員Aの年休',
    formData: { startDate: '2026-09-15', endDate: '2026-09-15', unitType: 'DAY', calculatedDays: 1 },
  });
  const normalAppId = normalSubmit.data.id;

  const teacherBApproveAttempt = WorkflowEngine.approveApplication(teacherB, {
    applicationId: normalAppId,
    expectedVersion: 1,
    comment: '教員B（権限なし）が承認試行',
  });
  if (teacherBApproveAttempt.statusCode !== 403) {
    throw new Error(`Case 5 失敗: 権限なし教員による承認試行が403で遮断されませんでした (status: ${teacherBApproveAttempt.statusCode})`);
  }
  console.log('✔ Case 5: 権限を持たないユーザーによる承認試行が 403 で確実に遮断されました');

  // Case 6: ADMIN（システム管理者）による月次確定試行 -> 403 (校長本人のみ可能)
  const admin: UserContext = {
    id: 6,
    username: 'admin',
    displayName: 'システム管理者E',
    roles: ['ADMIN'],
    ipAddress: '127.0.0.1',
  };

  const adminConfirmAttempt = WorkflowEngine.confirmMonthlyAttendance(admin, {
    userId: teacherA.id,
    yearMonth: '2026-09',
    comment: '管理者による代行確定試行',
  });
  if (adminConfirmAttempt.statusCode !== 403) {
    throw new Error(`Case 6 失敗: ADMINによる月次確定試行が403で遮断されませんでした (status: ${adminConfirmAttempt.statusCode})`);
  }
  console.log('✔ Case 6: ADMIN（システム管理者）による月次確定試行が 403 で確実に遮断されました (System ≠ Business)');

  // Case 7: ADMIN（システム管理者）による月次確定解除試行 -> 403 (校長本人のみ可能)
  // まず校長が確定
  WorkflowEngine.confirmMonthlyAttendance(principal, {
    userId: teacherA.id,
    yearMonth: '2026-09',
    comment: '校長確定',
  });

  const adminUnlockAttempt = WorkflowEngine.unlockMonthlyAttendance(admin, {
    userId: teacherA.id,
    yearMonth: '2026-09',
    reason: '管理者による確定解除試行',
  });
  if (adminUnlockAttempt.statusCode !== 403) {
    throw new Error(`Case 7 失敗: ADMINによる月次確定解除試行が403で遮断されませんでした (status: ${adminUnlockAttempt.statusCode})`);
  }
  console.log('✔ Case 7: ADMIN（システム管理者）による月次確定解除試行が 403 で確実に遮断されました');

  // Case 8: ADMIN（システム管理者）による業務承認試行 -> 403 (System Admin ≠ Business Approver)
  const adminApproveAttempt = WorkflowEngine.approveApplication(admin, {
    applicationId: normalAppId,
    expectedVersion: 1,
    comment: '管理者による教頭ステップ承認試行',
  });
  if (adminApproveAttempt.statusCode !== 403) {
    throw new Error(`Case 8 失敗: ADMINによる業務承認試行が403で遮断されませんでした (status: ${adminApproveAttempt.statusCode})`);
  }
  console.log('✔ Case 8: ADMIN（システム管理者）による業務承認試行が 403 で確実に遮断されました (System ≠ Approver)');

  console.log('--- [Test C: RBAC Negative Test] 合格 (PASS) ---\n');
  return true;
}

if (require.main === module) {
  runRbacNegativeTest();
}
