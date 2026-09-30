import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../db/database';

describe('Phase 0: Baseline Workflow & Attendance Regression Test Suite', () => {
  const db = getDb();

  it('1. 既存ユーザーとロール構成が期待通りに存在すること', () => {
    const users = db.prepare('SELECT id, username, display_name FROM users').all() as any[];
    assert.ok(users.length >= 6, '最低6名以上の初期ユーザーが存在すること');

    const teacher1 = users.find(u => u.username === 'teacher1');
    assert.ok(teacher1, 'teacher1 が存在すること');

    const roles = db.prepare(`
      SELECT r.id FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `).all(teacher1.id) as any[];
    assert.ok(roles.some(r => r.id === 'TEACHER'), 'teacher1 が TEACHER ロールを持つこと');
  });

  it('2. 年休 (LEAVE_ANNUAL) の申請・2段階決裁フローが正常に完了すること', () => {
    const teacher1 = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    const vp = db.prepare('SELECT id FROM users WHERE username = ?').get('vice_principal') as any;
    const principal = db.prepare('SELECT id FROM users WHERE username = ?').get('principal') as any;

    const now = '2026-09-01T00:00:00Z';
    const insertApp = db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
        title, form_data, current_status, current_step_order, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'SELF', 'SINGLE', ?, ?, 'SUBMITTED', 1, 1, ?, ?)
    `);

    const formData = JSON.stringify({
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      unitType: 'DAY',
      calculatedDays: 1,
      reason: '所用のため'
    });

    const result = insertApp.run('LEAVE_ANNUAL', teacher1.id, teacher1.id, '【年休】一日年休', formData, now, now);
    const appId = Number(result.lastInsertRowid);
    assert.ok(appId > 0);

    const insertStep1 = db.prepare(`
      INSERT INTO application_approval_steps (application_id, step_order, step_name, required_role_id, status)
      VALUES (?, 1, '教頭確認', 'VICE_PRINCIPAL', 'WAITING')
    `);
    const insertStep2 = db.prepare(`
      INSERT INTO application_approval_steps (application_id, step_order, step_name, required_role_id, status)
      VALUES (?, 2, '校長決裁', 'PRINCIPAL', 'WAITING')
    `);
    insertStep1.run(appId);
    insertStep2.run(appId);

    // 教頭承認
    db.prepare(`
      UPDATE application_approval_steps
      SET status = 'APPROVED', action_by_user_id = ?, acted_at = ?
      WHERE application_id = ? AND step_order = 1
    `).run(vp.id, now, appId);

    db.prepare(`
      UPDATE applications
      SET current_status = 'FIRST_APPROVED', current_step_order = 2, updated_at = ?
      WHERE id = ?
    `).run(now, appId);

    // 校長決裁
    db.prepare(`
      UPDATE application_approval_steps
      SET status = 'APPROVED', action_by_user_id = ?, acted_at = ?
      WHERE application_id = ? AND step_order = 2
    `).run(principal.id, now, appId);

    db.prepare(`
      UPDATE applications
      SET current_status = 'FINAL_APPROVED', updated_at = ?
      WHERE id = ?
    `).run(now, appId);

    const finalizedApp = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(finalizedApp.current_status, 'FINAL_APPROVED');
  });

  it('3. 出張 (BUSINESS_TRIP) の申請・3段階決裁・復命フローが正常に動作すること', () => {
    const teacher1 = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    const now = '2026-09-01T00:00:00Z';

    const insertApp = db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
        title, form_data, current_status, current_step_order, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'SELF', 'SINGLE', ?, ?, 'FINAL_APPROVED', 3, 1, ?, ?)
    `);

    const formData = JSON.stringify({
      startDate: '2026-09-15',
      endDate: '2026-09-15',
      destination: '県教育センター',
      purpose: '教科指導研修会',
      transport: '公用車'
    });

    const res = insertApp.run('BUSINESS_TRIP', teacher1.id, teacher1.id, '【出張】研修会出張', formData, now, now);
    assert.ok(res.lastInsertRowid > 0);
  });
});
