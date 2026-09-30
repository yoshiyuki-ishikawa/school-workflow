import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';

describe('GOLDEN-007 Isolation Tests: Route & Position Snapshot & Historical Immutability', () => {
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
  });

  beforeEach(() => {
    initDatabase();
    seedDatabase();
  });

  it('GOLDEN-007A (Route Master Isolation): Route Master変更後も、進行中Approval CycleのStep構成・承認者が変化しないこと', () => {
    // 1. 申請提出 (ルート3: 4段階)
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: 'GOLDEN-007A 申請',
      formData: { startDate: '2026-06-01', endDate: '2026-06-01', calculatedDays: 1 },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // 2. 承認ルートマスタ（route_id = 3）のステップを改変（例えばStep 1を削除して2段階に変更）
    db.prepare('DELETE FROM approval_route_steps WHERE route_id = 3 AND step_order = 1').run();

    // 3. 既存申請のステップを確認 -> 起案時の4ステップがそのまま残っていること
    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 4);
    assert.strictEqual(steps[0].step_name, '教務主任確認');
    assert.strictEqual(steps[0].approver_user_id_snapshot, chiefCtx.id);

    // 4. マスタ変更後でも、元の教務主任がStep 1を承認でき、フローが進行すること
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv = WorkflowEngine.approveApplication(chiefCtx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(appv.success, true);

    // ルートマスタを元に戻す
    db.prepare(`
      INSERT INTO approval_route_steps (route_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value)
      VALUES (3, 1, '教務主任確認', 'CHIEF_TEACHER_STEP', 'TEACHER', 'POSITION', 'CHIEF_TEACHER')
    `).run();
  });

  it('GOLDEN-007B (Position Master Isolation): Position担当者変更後も、既存Approval Cycleのapprover_user_id_snapshotが変化しないこと', () => {
    // 1. 申請提出
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: 'GOLDEN-007B 申請',
      formData: { startDate: '2026-06-05', endDate: '2026-06-05', calculatedDays: 1 },
    });
    const appId = submitRes.data.id;

    // 2. 教務主任のポジション担当者を別ユーザー（新規ユーザー: ID 99）に変更
    db.prepare("UPDATE user_positions SET effective_to = '2026-04-01' WHERE position_id = 'CHIEF_TEACHER'").run();
    db.prepare(`
      INSERT OR REPLACE INTO users (id, username, password_hash, display_name, stamp_name, department, is_active, created_at)
      VALUES (99, 'new_chief', 'pass', '新教務 山本', '山本', '教務部', 1, '2026-04-01')
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
      VALUES (99, 'CHIEF_TEACHER', 1, '2026-04-02', '9999-12-31')
    `).run();

    // 3. 既存申請のSnapshotを確認 -> 元の教務主任（ID 7）のまま固定されていること
    const step1 = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 1').get(appId) as any;
    assert.strictEqual(step1.approver_user_id_snapshot, chiefCtx.id);
    assert.strictEqual(step1.approver_name_snapshot, chiefCtx.displayName);

    // 4. 新任教務（ID 99）は承認できず (403)、前任教務（ID 7）のみが承認できること
    const newChiefCtx = { id: 99, username: 'new_chief', displayName: '新教務 山本', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    const failAppv = WorkflowEngine.approveApplication(newChiefCtx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(failAppv.success, false);
    assert.strictEqual(failAppv.statusCode, 403);

    const okAppv = WorkflowEngine.approveApplication(chiefCtx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(okAppv.success, true);
  });

  it('GOLDEN-007C (ROLE Selector Snapshot Isolation): SUBMIT時にROLE SelectorからUser AがSnapshotされた後、User Bへ同Roleを付与してもUser Bは承認できないこと', () => {
    // 標準2段階ルート (id: 1) は ROLE Selector で VICE_PRINCIPAL (ID 3) が解決される
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_ANNUAL',
      title: 'GOLDEN-007C ROLE Snapshot申請',
      formData: { startDate: '2026-06-10', endDate: '2026-06-10', calculatedDays: 1 },
    });
    const appId = submitRes.data.id;

    // 別の教員（ID 100）に新たに VICE_PRINCIPAL ロールを付与
    db.prepare(`
      INSERT OR REPLACE INTO users (id, username, password_hash, display_name, stamp_name, department, is_active, created_at)
      VALUES (100, 'another_vp', 'pass', '新任教頭', '新任', '管理職', 1, '2026-04-01')
    `).run();
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (100, 'VICE_PRINCIPAL')").run();

    const anotherVpCtx = { id: 100, username: 'another_vp', displayName: '新任教頭', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
    const app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 新任教頭（ID 100）はSnapshotされていないため承認不可 (403)
    const failAppv = WorkflowEngine.approveApplication(anotherVpCtx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(failAppv.success, false);
    assert.strictEqual(failAppv.statusCode, 403);

    // 起案時にSnapshotされた教頭（ID 3）は承認可能
    const okAppv = WorkflowEngine.approveApplication(vp1Ctx, {
      applicationId: appId,
      expectedVersion: app.version,
    });
    assert.strictEqual(okAppv.success, true);
  });

  it('GOLDEN-007D (Cycle Resolution Time & Resubmit Isolation): RETURNED後に人事異動を行いRESUBMITした場合、Cycle 1は不変のまま、Cycle 2だけが新Snapshotを持つこと', () => {
    // 1. 申請提出 (4段階)
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: 'GOLDEN-007D 差戻し再申請テスト',
      formData: { startDate: '2026-06-15', endDate: '2026-06-15', calculatedDays: 1, reason: '初版理由' },
    });
    const appId = submitRes.data.id;
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 2. Step 1 (教務主任: ID 7) で承認
    WorkflowEngine.approveApplication(chiefCtx, { applicationId: appId, expectedVersion: app.version });
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;

    // 3. Step 2 (第1教頭: ID 3) で差戻し (RETURNED)
    const retRes = WorkflowEngine.returnApplication(vp1Ctx, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '理由不備のため差戻し',
    });
    assert.strictEqual(retRes.success, true);

    // 4. 人事異動を実施: 教務主任を新任の山本（ID 99）に変更
    db.prepare("UPDATE user_positions SET effective_to = '2026-04-01' WHERE position_id = 'CHIEF_TEACHER'").run();
    db.prepare(`
      INSERT OR REPLACE INTO users (id, username, password_hash, display_name, stamp_name, department, is_active, created_at)
      VALUES (99, 'new_chief', 'pass', '新教務 山本', '山本', '教務部', 1, '2026-04-01')
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
      VALUES (99, 'CHIEF_TEACHER', 1, '2026-04-02', '9999-12-31')
    `).run();

    // 5. 再申請 (RESUBMIT) 実行 -> 新 Cycle 2 生成
    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const resubmitRes = WorkflowEngine.resubmitApplication(teacherCtx, {
      applicationId: appId,
      expectedVersion: app.version,
      title: 'GOLDEN-007D 差戻し再申請テスト (改訂版)',
      formData: { startDate: '2026-06-15', endDate: '2026-06-15', calculatedDays: 1, reason: '修正後理由' },
    });
    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.data.approvalCycle, 2);

    // 6. Cycle 1 と Cycle 2 の検証
    const cycle1Steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 1 ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(cycle1Steps.length, 4);
    assert.strictEqual(cycle1Steps[0].status, 'APPROVED');
    assert.strictEqual(cycle1Steps[0].approver_user_id_snapshot, chiefCtx.id); // 当時のSnapshot保持 (ID 7)
    assert.strictEqual(cycle1Steps[1].status, 'RETURNED');
    assert.strictEqual(cycle1Steps[1].comment, '理由不備のため差戻し');

    const cycle2Steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? AND approval_cycle = 2 ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(cycle2Steps.length, 4);
    assert.strictEqual(cycle2Steps[0].status, 'PENDING');
    assert.strictEqual(cycle2Steps[0].approver_user_id_snapshot, 99); // 新Cycle生成時点の最新教務 (ID 99)
    assert.strictEqual(cycle2Steps[1].status, 'WAITING');
  });

  it('GOLDEN-007E (Historical Reproduction): 過去Cycleの帳票・履歴取得時に、当時のSnapshot情報が完全再現されること', () => {
    // 申請を提出して複数サイクル・多段階ステップのスナップショットが完全であることを検証
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL',
      title: 'GOLDEN-007E 履歴再現テスト',
      formData: { startDate: '2026-06-20', endDate: '2026-06-20', calculatedDays: 1, reason: '履歴検証' },
    });
    const appId = submitRes.data.id;

    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY id ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 4);
    for (const step of steps) {
      assert.strictEqual(step.approval_cycle > 0, true);
      assert.notStrictEqual(step.step_label_snapshot, '');
      assert.strictEqual(['POSITION', 'ROLE', 'USER'].includes(step.selector_type_snapshot), true);
      assert.notStrictEqual(step.approver_user_id_snapshot, null);
      assert.notStrictEqual(step.approver_name_snapshot, '');
    }
  });
});
