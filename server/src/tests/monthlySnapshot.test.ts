import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { initDatabase, seedDatabase, getDb } from '../db';
import { SnapshotService } from '../services/snapshotService';
import { SnapshotInvalidationService } from '../services/snapshotInvalidationService';
import { PersonnelService } from '../services/personnelService';

describe('Phase 4: Monthly Attendance Snapshot & Invalidation Engine Test Suite', () => {
  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM personnel_actions').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM user_job_titles').run();

    const teacher = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    if (teacher) {
      db.prepare(`
        INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
        VALUES (?, 'JOB_TITLE_TEACHER', '2026-04-01', '9999-12-31')
      `).run(teacher.id);
    }
  });

  it('1. 出勤簿の月次確定 (finalize) により親子テーブル (Snapshots / SnapshotDays) が完全作成されること', () => {
    const db = getDb();
    const teacher = db.prepare('SELECT * FROM users WHERE username = ?').get('teacher1') as any;
    const principal = db.prepare('SELECT * FROM users WHERE username = ?').get('principal') as any;

    const snapshotId = SnapshotService.finalizeMonth(teacher.id, '2026-10', {
      id: principal.id,
      username: principal.username,
      displayName: principal.display_name,
      stampName: principal.stamp_name || '鈴木'
    });

    assert.ok(snapshotId > 0);

    const snapshot = SnapshotService.getSnapshot(teacher.id, '2026-10');
    assert.ok(snapshot !== null);
    assert.strictEqual(snapshot.parent.status, 'LOCKED');
    assert.strictEqual(snapshot.parent.version, 1);
    assert.strictEqual(snapshot.days.length, 31); // 10月は31日
    assert.ok(snapshot.parent.checksum.length === 64);
  });

  it('2. 確定済み月の期間に対して人事発令が登録された場合、Snapshot が NEEDS_RECONFIRMATION に自動遷移すること', () => {
    const db = getDb();
    const teacher = db.prepare('SELECT * FROM users WHERE username = ?').get('teacher1') as any;
    const principal = db.prepare('SELECT * FROM users WHERE username = ?').get('principal') as any;

    // 10月確定
    SnapshotService.finalizeMonth(teacher.id, '2026-10', {
      id: principal.id,
      username: principal.username,
      displayName: principal.display_name,
      stampName: principal.stamp_name || '鈴木'
    });

    // 10月中旬に停職発令
    PersonnelService.createStatus({
      userId: teacher.id,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-15',
      effectiveTo: '2026-10-20',
      reasonCode: 'DISCIPLINARY_ACTION',
      actorUserId: principal.id
    });

    // Snapshot状態の検証
    const snapshot = SnapshotService.getSnapshot(teacher.id, '2026-10');
    assert.ok(snapshot !== null);
    assert.strictEqual(snapshot.parent.status, 'NEEDS_RECONFIRMATION');
    assert.ok(snapshot.parent.reconfirmation_reason?.includes('人事発令登録'));
  });
});
