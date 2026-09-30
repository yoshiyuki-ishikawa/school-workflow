import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';

describe('Large School Multi-Step Workflow (4-Step Approval)', () => {
  let db: any;

  const teacherCtx = { id: 1, username: 'teacher1', displayName: '山田 太郎 (教員A)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const vp1Ctx = { id: 3, username: 'vice_principal', displayName: '田中 誠 (教頭B)', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
  const prinCtx = { id: 4, username: 'principal', displayName: '鈴木 健一 (校長C)', roles: ['PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
  const chiefCtx = { id: 7, username: 'chief_teacher', displayName: '小林 繁 (教務主任)', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const vp2Ctx = { id: 8, username: 'vice_principal_2', displayName: '渡辺 洋子 (第2教頭)', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };

  before(() => {
    db = getDb();
    initDatabase();
    seedDatabase();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
  });

  it('4段階承認フロー (教務主任 -> 第1教頭 -> 第2教頭 -> 校長) が正常に完了すること', () => {
    // 1. 大規模校用4段階ルート（default_route_id: 3）に設定した申請種別を作成
    db.prepare(`
      INSERT OR REPLACE INTO application_types (id, name, description, default_route_id)
      VALUES ('LEAVE_LARGE_SCHOOL', '大規模校用休暇申請', '4段階承認テスト', 3)
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES ('LARGE_SCHOOL_STANDARD', 'LEAVE_LARGE_SCHOOL')
    `).run();

    // 2. 教員Aが申請提出
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: '大規模校テスト申請 (年休)',
      formData: {
        startDate: '2026-05-10',
        endDate: '2026-05-10',
        calculatedDays: 1,
        reason: '私事都合',
      },
    });

    if (!submitRes.success) {
      console.error('SUBMIT FAILURE IN TEST:', submitRes);
    }
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // ステップ構成とスナップショットの検証
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 4);
    assert.strictEqual(steps[0].step_name, '教務主任確認');
    assert.strictEqual(steps[0].status, 'PENDING');
    assert.strictEqual(steps[0].approver_user_id_snapshot, chiefCtx.id);
    assert.strictEqual(steps[1].step_name, '第1教頭確認');
    assert.strictEqual(steps[1].status, 'WAITING');
    assert.strictEqual(steps[1].approver_user_id_snapshot, vp1Ctx.id);
    assert.strictEqual(steps[2].step_name, '第2教頭確認');
    assert.strictEqual(steps[2].status, 'WAITING');
    assert.strictEqual(steps[2].approver_user_id_snapshot, vp2Ctx.id);
    assert.strictEqual(steps[3].step_name, '校長最終決裁');
    assert.strictEqual(steps[3].status, 'WAITING');
    assert.strictEqual(steps[3].approver_user_id_snapshot, prinCtx.id);

    // 3. 教務主任が承認
    const appAfterSubmit = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv1 = WorkflowEngine.approveApplication(chiefCtx, {
      applicationId: appId,
      expectedVersion: appAfterSubmit.version,
      comment: '教務確認完了',
    });
    assert.strictEqual(appv1.success, true);

    // 状態が IN_APPROVAL に遷移し、Step 2 が PENDING になること
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 2);

    // 4. 第1教頭が承認
    const appv2 = WorkflowEngine.approveApplication(vp1Ctx, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '第1教頭確認完了',
    });
    assert.strictEqual(appv2.success, true);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 3);

    // 5. 第2教頭が承認
    const appv3 = WorkflowEngine.approveApplication(vp2Ctx, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '第2教頭確認完了',
    });
    assert.strictEqual(appv3.success, true);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 4);

    // 6. 校長が最終承認
    const appv4 = WorkflowEngine.approveApplication(prinCtx, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '校長決裁完了',
    });
    assert.strictEqual(appv4.success, true);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
    assert.notStrictEqual(app.organization_snapshot, null);
  });

  it('自己承認禁止: 教務主任が自身を申請対象者とする申請において、教務主任ステップを自己承認できないこと', () => {
    const submitRes = WorkflowEngine.submitApplication(chiefCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: '教務主任本人の申請',
      formData: {
        startDate: '2026-05-15',
        endDate: '2026-05-15',
        calculatedDays: 1,
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv = WorkflowEngine.approveApplication(chiefCtx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(appv.success, false);
    assert.strictEqual(appv.statusCode, 403);
    assert.match(appv.message, /自己承認は禁止/);
  });

  it('非割当者・権限外ユーザーによるスキップ承認が拒絶されること', () => {
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: 'スキップテスト申請',
      formData: { startDate: '2026-05-20', endDate: '2026-05-20', calculatedDays: 1 },
    });
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // Step 1 は教務主任 (chiefCtx) であるが、校長 (prinCtx) が承認を試みる
    const appv = WorkflowEngine.approveApplication(prinCtx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(appv.success, false);
    assert.strictEqual(appv.statusCode, 403);
    assert.match(appv.message, /承認権限がありません/);
  });
});
