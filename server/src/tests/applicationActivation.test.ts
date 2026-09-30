import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { initDatabase, seedDatabase, getDb } from '../db';
import { ActivationService } from '../services/activationService';

describe('Phase 2: Application Activation & Idempotency Test Suite', () => {
  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM personnel_actions').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM applications').run();
  });

  it('1. 育児休業 (LEAVE_CHILDCARE) 承認時に PersonnelStatus が自動生成され、重複実行でも冪等であること', () => {
    const db = getDb();
    const teacher2 = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher2') as any;
    const principal = db.prepare('SELECT id FROM users WHERE username = ?').get('principal') as any;

    const insertApp = db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
        title, form_data, current_status, current_step_order, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'SELF', 'SINGLE', ?, ?, 'FINAL_APPROVED', 2, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
    `);

    const formData = JSON.stringify({
      startDate: '2026-11-01',
      endDate: '2027-03-31',
      reasonCode: 'CHILDCARE_BIRTH'
    });

    const res = insertApp.run('LEAVE_CHILDCARE', teacher2.id, teacher2.id, '【育休】育児休業請求', formData);
    const appId = Number(res.lastInsertRowid);

    // 1回目発効
    const act1 = ActivationService.activateApplication(db, appId, principal.id);
    assert.strictEqual(act1.success, true);
    assert.strictEqual(act1.generatedType, 'PERSONNEL_STATUS');
    assert.ok(Number(act1.id) > 0);

    const status1 = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(act1.id) as any;
    assert.strictEqual(status1.status_type, 'CHILDCARE_LEAVE');
    assert.strictEqual(status1.effective_from, '2026-11-01');
    assert.strictEqual(status1.effective_to, '2027-03-31');

    // 2回目発効 (冪等性検証: 二重作成されず同一IDが返ること)
    const act2 = ActivationService.activateApplication(db, appId, principal.id);
    assert.strictEqual(act2.success, true);
    assert.strictEqual(act2.id, act1.id);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM personnel_statuses WHERE source_application_id = ?').get(appId) as any;
    assert.strictEqual(count.cnt, 1, '二重作成されていないこと');
  });
});
