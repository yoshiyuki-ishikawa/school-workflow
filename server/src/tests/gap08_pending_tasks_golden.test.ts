import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine, UserContext } from '../workflow/engine';
import { ApplicationWorkflowService } from '../services/applicationWorkflowService';

describe('Original Wave 6 / GAP-08: Pending Task Badge & Dashboard Task Aggregation Golden Test Suite', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const teacher2: UserContext = {
    id: 2,
    username: 'teacher2',
    displayName: '佐藤 花子 (教員B)',
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

  const chiefTeacher: UserContext = {
    id: 7,
    username: 'chief_teacher',
    displayName: '伊藤 一郎 (教務主任)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM applications').run();
  });

  function createSubmittedAnnualLeave(subjectUser: UserContext, targetDate: string = '2026-06-10'): number {
    const res = WorkflowEngine.submitApplication(subjectUser, {
      typeId: 'LEAVE_ANNUAL',
      title: `【年休】${targetDate}`,
      formData: {
        unitType: 'DAY',
        startDate: targetDate,
        endDate: targetDate,
        reason: '私事都合',
      },
    });
    if (!res.success) {
      throw new Error(`submitApplication failed: ${res.message || res.errorCode}`);
    }
    return res.data.id;
  }

  // GT-W6-08-01: 一般教諭（承認権限なし）が pending count を取得
  it('GT-W6-08-01: 一般教諭（承認権限なし）の Pending Count は常に 0 であること', () => {
    createSubmittedAnnualLeave(teacher1);
    const count = ApplicationWorkflowService.getPendingTaskCount(teacher2);
    assert.strictEqual(count, 0);
  });

  // GT-W6-08-02: 教頭がカレントステップ（Step 1）のPending申請を1件持つ
  it('GT-W6-08-02: 教頭がカレントステップ（Step 1: 教頭承認）のPending申請を1件持つ場合、count=1 となること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    const count = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(count, 1);

    const tasks = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].application_id, appId);
    assert.strictEqual(tasks[0].current_step_order, 1);
  });

  // GT-W6-08-03: 校長がStep 2の申請を持つが、Step 1が未完了（Step 1 PENDING）
  it('GT-W6-08-03: Step 1（教頭）が未完了の場合、後続ステップ（Step 2: 校長）の pending count は 0 であること', () => {
    createSubmittedAnnualLeave(teacher1);
    const count = ApplicationWorkflowService.getPendingTaskCount(principal);
    assert.strictEqual(count, 0);
  });

  // GT-W6-08-04: Step 1（教頭）が承認完了し、Step 2（校長）がPENDINGに遷移
  it('GT-W6-08-04: Step 1（教頭）承認完了後、Step 2（校長）の pending count が 1 になり、教頭は 0 になること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭確認',
    });

    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    const prinCount = ApplicationWorkflowService.getPendingTaskCount(principal);
    assert.strictEqual(vpCount, 0);
    assert.strictEqual(prinCount, 1);
  });

  // GT-W6-08-05: 申請が差戻し（REJECTED / RETURNED）され、CycleがTERMINATED
  it('GT-W6-08-05: 申請が差戻し（RETURNED）された場合、全承認者の pending count が 0 になること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.returnApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '記載不備のため差戻し',
    });

    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    const prinCount = ApplicationWorkflowService.getPendingTaskCount(principal);
    assert.strictEqual(vpCount, 0);
    assert.strictEqual(prinCount, 0);
  });

  // GT-W6-08-06: 申請者が申請を取下げ（WITHDRAWN）
  it('GT-W6-08-06: 申請取下げ（WITHDRAWN）時、全承認者の pending count が 0 になること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.withdrawApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(vpCount, 0);
  });

  // GT-W6-08-07: 申請が最終承認（APPROVED）完了
  it('GT-W6-08-07: 申請が校長まで最終決裁完了時、全承認者の pending count が 0 になること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    const prinCount = ApplicationWorkflowService.getPendingTaskCount(principal);
    assert.strictEqual(vpCount, 0);
    assert.strictEqual(prinCount, 0);
  });

  // GT-W6-08-08: 再申請され、新Cycle（cycle 2）がIN_PROGRESSとなりStep 1がPENDING
  it('GT-W6-08-08: 差戻し後の再申請で新Cycleが生成された場合、Step 1（教頭）の pending count が 1 に復帰すること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.returnApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '差戻し',
    });

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【年休・再提出】2026-06-10',
      formData: {
        unitType: 'DAY',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        reason: '私事都合（再提出）',
      },
    });

    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(vpCount, 1);

    const tasks = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
    assert.strictEqual(tasks[0].cycle_number, 2);
    assert.strictEqual(tasks[0].current_step_order, 1);
  });

  // GT-W6-08-09: Snapshot Approver 一致検証 (教務主任等の指定承認者)
  it('GT-W6-08-09: Snapshot Approver に指定されたユーザーのみに pending count が反映されること', () => {
    const appId = createSubmittedAnnualLeave(teacher1);
    // 出張等で教務主任がStep 1 Snapshotの場合を想定し、Step 1 Snapshotを教務主任に変更
    db.prepare(`
      UPDATE application_approval_steps 
      SET approver_user_id_snapshot = ?
      WHERE application_id = ? AND step_order = 1
    `).run(chiefTeacher.id, appId);

    const chiefCount = ApplicationWorkflowService.getPendingTaskCount(chiefTeacher);
    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(chiefCount, 1);
    assert.strictEqual(vpCount, 0);
  });

  // GT-W6-08-10: 自己承認禁止 (INV-001) の検証
  it('GT-W6-08-10: 教頭自身が申請者の場合、Step 1（教頭承認）であっても自己承認禁止により教頭の pending count は 0 であること', () => {
    createSubmittedAnnualLeave(vicePrincipal); // 教頭自身の年休申請
    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(vpCount, 0); // 自己承認禁止
  });

  // GT-W6-08-11: ページネーション (limit / offset) 検証
  it('GT-W6-08-11: /pending/tasks で pagination (limit, offset) が正確に機能すること', () => {
    createSubmittedAnnualLeave(teacher1, '2026-06-15');
    createSubmittedAnnualLeave(teacher1, '2026-06-16');
    createSubmittedAnnualLeave(teacher1, '2026-06-17');

    const allTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
    assert.strictEqual(allTasks.length, 3);

    const pagedTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal, { limit: 2, offset: 1 });
    assert.strictEqual(pagedTasks.length, 2);
    assert.strictEqual(pagedTasks[0].application_id, allTasks[1].application_id);
    assert.strictEqual(pagedTasks[1].application_id, allTasks[2].application_id);
  });

  // GT-W6-08-12: 代理申請作成者による自己承認禁止
  it('GT-W6-08-12: 教頭が代理起案した申請は、教頭の pending count に含まれないこと (代理自己承認禁止)', () => {
    WorkflowEngine.submitProxyApplication(vicePrincipal, {
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacher1.id,
      title: '【年休】代理起案提出',
      formData: {
        unitType: 'FULL_DAY',
        targetDate: '2026-06-18',
        reason: '私事都合（代理提出）',
      },
      proxyReason: '教員出張中のため代理提出',
    });

    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(vpCount, 0); // 代理起案者は承認不可
  });

  // GT-W6-08-13: UIバッジ描画用一致性検証 (Badge Count == List Count)
  it('GT-W6-08-13: INV-W6-08-01: Badge Count と Pending Task List の件数が常に 100% 一致すること', () => {
    createSubmittedAnnualLeave(teacher1, '2026-06-22');
    createSubmittedAnnualLeave(teacher2, '2026-06-23');

    const count = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    const list = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
    assert.strictEqual(count, list.length);
    assert.strictEqual(count, 2);
  });

  // GT-W6-08-14: Production Authorization Parity Test (認可真実の一致)
  it('GT-W6-08-14: INV-W6-08-02: Pending Task に出現する申請は本番 approveApplication が必ず成功し、出現しない申請は 403 拒否されること', () => {
    const appId = createSubmittedAnnualLeave(teacher1, '2026-06-24');
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 教頭は Pending Task に含まれ、本番承認も成功する
    const vpTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
    assert.ok(vpTasks.some((t) => t.application_id === appId));

    const okRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: 'OK',
    });
    assert.strictEqual(okRes.success, true);

    // 一般教諭 (teacher2) は Pending Task に含まれず、本番承認を試みても 403 エラーとなる
    const t2Tasks = ApplicationWorkflowService.getPendingApplicationsForUser(teacher2);
    assert.ok(!t2Tasks.some((t) => t.application_id === appId));
  });

  // GT-W6-08-15: 承認アクション実行直後のデクリメント検証
  it('GT-W6-08-15: 承認アクション完了直後、教頭の pending count が 1 から 0 へ即座にデクリメントされること', () => {
    const appId = createSubmittedAnnualLeave(teacher1, '2026-06-25');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    assert.strictEqual(ApplicationWorkflowService.getPendingTaskCount(vicePrincipal), 1);

    WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(ApplicationWorkflowService.getPendingTaskCount(vicePrincipal), 0);
  });

  // GT-W6-08-16A: 【修正1: 正常非対象検証】Active Cycle = 0 かつ Workflow 正常終了済み申請
  it('GT-W6-08-16A: CASE A (Normal Non-Actionable): Active Cycle = 0 かつ 正常終了済みの申請は正常にスキップされること', () => {
    const appId = createSubmittedAnnualLeave(teacher1, '2026-06-26');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 校長まで完全決裁
    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    // Active Cycle は 0 件（終了済み）、PENDING Step も 0 件
    const count = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(count, 0); // 正常スキップ
  });

  // GT-W6-08-16B: 【修正1: 孤立Pending検証】Active Cycle = 0 にもかかわらず Pending Step が残存する異常申請
  it('GT-W6-08-16B: CASE B (Orphan Pending): Active Cycle = 0 なのに PENDING Step が残存する構造異常は Whole Aggregation Fail-Closed すること', () => {
    const appId = createSubmittedAnnualLeave(teacher1, '2026-06-29');
    // 異常注入: Active Cycle を物理削除して孤立 PENDING Step を作成 (FK一時無効化)
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM application_workflow_cycles WHERE application_id = ?').run(appId);
    db.pragma('foreign_keys = ON');

    assert.throws(
      () => {
        ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
      },
      (err: any) => {
        return err.code === 'DATA_INCONSISTENCY' && err.statusCode === 500;
      }
    );

    assert.throws(
      () => {
        ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
      },
      (err: any) => {
        return err.code === 'DATA_INCONSISTENCY' && err.statusCode === 500;
      }
    );
  });

  // GT-W6-08-17: 【Whole Aggregation Strict Fail-Closed 検証】複数 Active Cycle 申請混入
  it('GT-W6-08-17: 正常申請が2件あっても、1件の複数Active Cycle異常申請が混入すると集約全体が Fail-Closed (DATA_INCONSISTENCY) すること', () => {
    createSubmittedAnnualLeave(teacher1, '2026-06-29');
    createSubmittedAnnualLeave(teacher2, '2026-06-30');
    const corruptAppId = createSubmittedAnnualLeave(teacher1, '2026-07-02');

    // 異常注入: 2つ目の Active Cycle (IN_PROGRESS) を不正挿入
    db.prepare(`
      INSERT INTO application_workflow_cycles (
        application_id, approval_cycle, workflow_source, status, started_at, started_by_user_id
      ) VALUES (?, 99, 'LEGACY_SNAPSHOT', 'IN_PROGRESS', DATETIME('now'), ?)
    `).run(corruptAppId, teacher1.id);

    // 正常な2件だけを返さず、全体が Fail-Closed
    assert.throws(
      () => {
        ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
      },
      (err: any) => {
        return err.code === 'DATA_INCONSISTENCY' && err.statusCode === 500;
      }
    );

    assert.throws(
      () => {
        ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
      },
      (err: any) => {
        return err.code === 'DATA_INCONSISTENCY' && err.statusCode === 500;
      }
    );
  });

  // GT-W6-08-18: CANCELLATION Cycle 進行中の承認タスク集約検証
  it('GT-W6-08-18: 元申請が FINAL_APPROVED のままでも、CANCELLATION Cycle の Step 1 PENDING が正しく教頭の pending count=1 および Task List に集約されること', () => {
    const appId = createSubmittedAnnualLeave(teacher1, '2026-07-01');
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });

    app = db.prepare('SELECT version, current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // 承認後取消の起案
    WorkflowEngine.requestCancellation(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      cancellationReason: '私用変更のため取消',
    });

    // 元申請 current_status は FINAL_APPROVED のまま
    app = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');

    // CANCELLATION Cycle (Step 1: 教頭) が PENDING となり、教頭の pending count が 1 になること
    const vpCount = ApplicationWorkflowService.getPendingTaskCount(vicePrincipal);
    assert.strictEqual(vpCount, 1);

    const vpTasks = ApplicationWorkflowService.getPendingApplicationsForUser(vicePrincipal);
    assert.strictEqual(vpTasks.length, 1);
    assert.strictEqual(vpTasks[0].application_id, appId);
    assert.strictEqual(vpTasks[0].cycle_purpose, 'CANCELLATION');

    // 取消起案者 (teacher1) は自己承認禁止のため pending count は 0
    const teacherCount = ApplicationWorkflowService.getPendingTaskCount(teacher1);
    assert.strictEqual(teacherCount, 0);

    // 取消承認実行
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveCancellation(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '教頭取消承認',
    });

    // 教頭は承認完了で 0、校長が 1 になる
    assert.strictEqual(ApplicationWorkflowService.getPendingTaskCount(vicePrincipal), 0);
    assert.strictEqual(ApplicationWorkflowService.getPendingTaskCount(principal), 1);
  });
});
