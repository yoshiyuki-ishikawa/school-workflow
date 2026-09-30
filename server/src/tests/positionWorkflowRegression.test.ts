import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';

describe('Position Workflow Regression & Immutability Tests', () => {
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
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM applications').run();
  });

  it('1. 申請提出後に人事異動（Position変更）があっても、過去申請の承認者Snapshotは変更されないこと (Historical Record Immutability)', () => {
    // 申請種別を用意
    db.prepare(`
      INSERT OR REPLACE INTO application_types (id, name, description, default_route_id)
      VALUES ('LEAVE_LARGE_SCHOOL_TEST', '大規模校用休暇申請', '4段階承認テスト', 3)
    `).run();
    db.prepare(`
      INSERT OR REPLACE INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES ('LARGE_SCHOOL_STANDARD', 'LEAVE_LARGE_SCHOOL_TEST')
    `).run();

    // 教員Aが申請
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_LARGE_SCHOOL_TEST',
      title: '人事異動前の申請',
      formData: {
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        calculatedDays: 1,
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // 初期の第1教頭ステップ検証 (田中 誠: user_id=3)
    const step2Before = db.prepare(`
      SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 2
    `).get(appId) as any;
    assert.strictEqual(step2Before.approver_user_id_snapshot, 3);
    assert.strictEqual(step2Before.approver_name_snapshot, '田中 誠 (教頭B)');

    // === 人事異動発生: 田中 誠の第1教頭を終了し、新教頭 (user_id=2) を第1教頭に任命 ===
    db.prepare(`
      UPDATE user_positions SET effective_to = '2026-05-31' WHERE user_id = 3 AND position_id = 'VICE_PRINCIPAL_1'
    `).run();
    db.prepare(`
      INSERT INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
      VALUES (2, 'VICE_PRINCIPAL_1', 1, '2026-06-01', '9999-12-31')
    `).run();

    // 過去申請のステップスナップショットが変化していないことを検証
    const step2After = db.prepare(`
      SELECT * FROM application_approval_steps WHERE application_id = ? AND step_order = 2
    `).get(appId) as any;
    assert.strictEqual(step2After.approver_user_id_snapshot, 3);
    assert.strictEqual(step2After.approver_name_snapshot, '田中 誠 (教頭B)');
  });

  it('2. 既存2段階承認ルート（標準休暇）が100%完全動作すること（非破壊検証）', () => {
    const submitRes = WorkflowEngine.submitApplication(teacherCtx, {
      typeId: 'LEAVE_ANNUAL',
      title: '標準年休申請 (2段階)',
      formData: {
        startDate: '2026-07-15',
        endDate: '2026-07-15',
        calculatedDays: 1,
      },
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // Step 1: 教頭一次確認 (人事異動後により VICE_PRINCIPAL_1 に着任した佐藤教頭: user_id=2)
    const newVpCtx = { id: 2, username: 'teacher2', displayName: '佐藤 花子 (教員B)', roles: ['VICE_PRINCIPAL', 'TEACHER'], ipAddress: '127.0.0.1' };
    const app1 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv1 = WorkflowEngine.approveApplication(newVpCtx, {
      applicationId: appId,
      expectedVersion: app1.version,
    });
    assert.strictEqual(appv1.success, true);

    // Step 2: 校長決裁
    const app2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const appv2 = WorkflowEngine.approveApplication(prinCtx, {
      applicationId: appId,
      expectedVersion: app2.version,
    });
    assert.strictEqual(appv2.success, true);

    const finalApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalApp.current_status, 'FINAL_APPROVED');
  });
});
