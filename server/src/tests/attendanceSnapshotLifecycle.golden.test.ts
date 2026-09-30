import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { SnapshotService } from '../services/snapshotService';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { WorkflowEngine } from '../workflow/engine';
import { UserContext } from '../types';

function makeWeeklySchedule(intervals: { startTime: string; endTime: string }[], workMinutes: number) {
  const obj: Record<string, any> = {};
  for (let d = 0; d < 7; d++) {
    if (d === 0 || d === 6) {
      obj[String(d)] = { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null, intervals: [] };
    } else {
      obj[String(d)] = {
        isWorkDay: true,
        workMinutes,
        startTime: intervals.length > 0 ? intervals[0].startTime : '08:15',
        endTime: intervals.length > 0 ? intervals[intervals.length - 1].endTime : '16:45',
        intervals,
      };
    }
  }
  return JSON.stringify(obj);
}

describe('Golden Test Suite: Attendance Snapshot Unlock -> Reconfirm Lifecycle (GT-SNAP-LC-01〜09)', () => {
  let db: any;
  const now = new Date().toISOString();

  const principalActor: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 一朗',
    roles: ['PRINCIPAL', 'USER'],
    permissions: [],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent'
  };

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM absences').run();
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();

    // デフォルトの基本勤務パターン (465分, 8:15-12:00, 12:45-16:45) を設定
    const defaultSchedule = makeWeeklySchedule([
      { startTime: '08:15', endTime: '12:00' },
      { startTime: '12:45', endTime: '16:45' }
    ], 465);

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '標準フルタイム465', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(defaultSchedule);
  });

  // GT-SNAP-LC-01: DRAFT -> Live Evaluator
  it('GT-SNAP-LC-01: 初月未確定 (DRAFT) 時の投影 - スナップショットなしで Live Evaluator が実行されること', () => {
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-10');
    assert.strictEqual(projection.days.length, 31);
    // 2026-10-01 (木) は平日勤務日
    const d1 = projection.days.find(d => d.date === '2026-10-01')!;
    assert.strictEqual(d1.isWorkDay, true);
    assert.strictEqual(d1.scheduledWorkMinutes, 465);
    assert.strictEqual(d1.displaySymbol, '出');

    const snap = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ?').get('2026-10');
    assert.strictEqual(snap, undefined, 'Snapshot が存在しないこと');
  });

  // GT-SNAP-LC-02: CONFIRM -> Approval CONFIRMED & Snapshot v1 LOCKED
  it('GT-SNAP-LC-02: 初回月次確定 (CONFIRM) - Approval CONFIRMED かつ Snapshot v1 LOCKED が生成され投影権威となること', () => {
    const res = WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '初回月次確定'
    });
    assert.strictEqual(res.success, true);

    const approval = db.prepare('SELECT * FROM monthly_attendance_approvals WHERE user_id = 1 AND year_month = ?').get('2026-10') as any;
    assert.strictEqual(approval.status, 'CONFIRMED');

    const snapshot = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ?').get('2026-10') as any;
    assert.ok(snapshot);
    assert.strictEqual(snapshot.status, 'LOCKED');
    assert.strictEqual(snapshot.version, 1);

    // 確定後の勤務パターン変更 (短縮時間 240分)
    const newSchedule = makeWeeklySchedule([
      { startTime: '09:00', endTime: '13:00' }
    ], 240);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '新勤務時間短縮', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(newSchedule);

    // 確定済みのため、Snapshot Days が投影され、新勤務パターンは反映されない (不変性維持: 465分)
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-10');
    const d1 = projection.days.find(d => d.date === '2026-10-01')!;
    assert.strictEqual(d1.scheduledWorkMinutes, 465, '確定済みスナップショットの465分が不変維持されること');
  });

  // GT-SNAP-LC-03: UNLOCK -> Approval UNLOCKED_FOR_CORRECTION & Snapshot v1 NEEDS_RECONFIRMATION
  it('GT-SNAP-LC-03: 月次確定解除 (UNLOCK) - Approval が UNLOCKED_FOR_CORRECTION、Snapshot が NEEDS_RECONFIRMATION に遷移すること', () => {
    WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '初回確定'
    });

    const unlockRes = WorkflowEngine.unlockMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      reason: '10/27 年休追記のため'
    });
    assert.strictEqual(unlockRes.success, true);

    const approval = db.prepare('SELECT * FROM monthly_attendance_approvals WHERE user_id = 1 AND year_month = ?').get('2026-10') as any;
    assert.strictEqual(approval.status, 'UNLOCKED_FOR_CORRECTION');
    assert.strictEqual(approval.unlocked_reason, '10/27 年休追記のため');

    const snapshot = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ?').get('2026-10') as any;
    assert.strictEqual(snapshot.status, 'NEEDS_RECONFIRMATION', 'Snapshot status は NEEDS_RECONFIRMATION に遷移していること');
    assert.ok(snapshot.reconfirmation_reason?.includes('10/27 年休追記のため'));
  });

  // GT-SNAP-LC-04: UNLOCKED -> Live Evaluator
  it('GT-SNAP-LC-04: 解除中 (UNLOCKED) の投影 - Live Evaluator へフォールスルーし動的再計算されること', () => {
    WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '初回確定'
    });

    WorkflowEngine.unlockMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      reason: '勤務時間変更反映のため'
    });

    // 新勤務パターン登録 (短縮時間 240分)
    const newSchedule = makeWeeklySchedule([
      { startTime: '09:00', endTime: '13:00' }
    ], 240);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '新勤務時間短縮', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(newSchedule);

    // 解除中なので動的に新勤務時間 (240分) が反映されること
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-10');
    const d1 = projection.days.find(d => d.date === '2026-10-01')!;
    assert.strictEqual(d1.scheduledWorkMinutes, 240, '解除中は動的計算により240分が反映されること');
  });

  // GT-SNAP-LC-05: 防壁検証 (Snapshot LOCKED かつ Approval non-CONFIRMED)
  it('GT-SNAP-LC-05: 防壁検証 - 仮に Snapshot が LOCKED であっても Approval が non-CONFIRMED なら Live Evaluator にフォールスルーすること', () => {
    WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '初回確定'
    });

    // 疑似不整合状態 (Hybrid State): Approval は UNLOCKED_FOR_CORRECTION だが Snapshot は LOCKED のまま
    db.prepare(`
      UPDATE monthly_attendance_approvals
      SET status = 'UNLOCKED_FOR_CORRECTION', unlocked_reason = 'テスト用解除'
      WHERE user_id = 1 AND year_month = '2026-10'
    `).run();

    const snapshotBefore = db.prepare('SELECT status FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ?').get('2026-10') as any;
    assert.strictEqual(snapshotBefore.status, 'LOCKED');

    // 新勤務パターン登録 (短縮時間 240分)
    const newSchedule = makeWeeklySchedule([
      { startTime: '09:00', endTime: '13:00' }
    ], 240);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '新勤務時間短縮', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(newSchedule);

    // 防壁により、Approval が CONFIRMED でないため Snapshot は採用されず Live Evaluator が走り 240分となること
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-10');
    const d1 = projection.days.find(d => d.date === '2026-10-01')!;
    assert.strictEqual(d1.scheduledWorkMinutes, 240, 'Approval が non-CONFIRMED のため Live Evaluator が採用され240分となること');
  });

  // GT-SNAP-LC-06: RECONFIRM -> v1 SUPERSEDED & v2 LOCKED & Approval CONFIRMED
  it('GT-SNAP-LC-06: 月次再確定 (RECONFIRM) - v1 が SUPERSEDED となり v2 LOCKED が生成され Approval が CONFIRMED となること', () => {
    WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '初回確定'
    });

    WorkflowEngine.unlockMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      reason: '訂正のため'
    });

    // 再確定
    const reconfirmRes = WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '訂正後再確定'
    });
    assert.strictEqual(reconfirmRes.success, true);

    const approval = db.prepare('SELECT * FROM monthly_attendance_approvals WHERE user_id = 1 AND year_month = ?').get('2026-10') as any;
    assert.strictEqual(approval.status, 'CONFIRMED');

    const snapshots = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ? ORDER BY version ASC').all('2026-10') as any[];
    assert.strictEqual(snapshots.length, 2);

    const v1 = snapshots[0];
    const v2 = snapshots[1];

    assert.strictEqual(v1.version, 1);
    assert.strictEqual(v1.status, 'SUPERSEDED');

    assert.strictEqual(v2.version, 2);
    assert.strictEqual(v2.status, 'LOCKED');
    assert.strictEqual(v2.supersedes_snapshot_id, v1.id);
  });

  // GT-SNAP-LC-07: RECONFIRM後 -> Snapshot v2 Authority
  it('GT-SNAP-LC-07: 再確定後の投影 - Snapshot v2 が権威となり不変保持されること', () => {
    WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '初回確定'
    });

    WorkflowEngine.unlockMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      reason: '勤務時間変更'
    });

    // 新勤務パターン登録 (短縮 240分)
    const newSchedule = makeWeeklySchedule([
      { startTime: '09:00', endTime: '13:00' }
    ], 240);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '新勤務時間短縮', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,6', ?, 1200, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(newSchedule);

    WorkflowEngine.confirmMonthlyAttendance(principalActor, {
      userId: 1,
      yearMonth: '2026-10',
      comment: '短縮時間で再確定'
    });

    // さらにその後パターンを変更しても (300分)、v2 は影響を受けない
    const v3Schedule = makeWeeklySchedule([
      { startTime: '09:00', endTime: '14:00' }
    ], 300);
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, created_by_user_id, created_at, updated_at
      ) VALUES (1, '再変更時間300', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,6', ?, 1500, 'ADMIN_CONFIGURED', 1, datetime('now'), datetime('now'))
    `).run(v3Schedule);

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-10');
    const d1 = projection.days.find(d => d.date === '2026-10-01')!;
    assert.strictEqual(d1.scheduledWorkMinutes, 240, 'v2スナップショットの240分が不変保持されること');
  });

  // GT-SNAP-LC-08: 再解除 -> 再々確定 - 複数回のサイクルが破綻なく循環し v3 が生成されること
  it('GT-SNAP-LC-08: 再解除 -> 再々確定 - 複数回のサイクルが破綻なく循環し v3 が生成されること', () => {
    // v1 確定
    WorkflowEngine.confirmMonthlyAttendance(principalActor, { userId: 1, yearMonth: '2026-10', comment: 'v1' });
    // v1 解除
    WorkflowEngine.unlockMonthlyAttendance(principalActor, { userId: 1, yearMonth: '2026-10', reason: 'r1' });
    // v2 確定
    WorkflowEngine.confirmMonthlyAttendance(principalActor, { userId: 1, yearMonth: '2026-10', comment: 'v2' });
    // v2 解除
    WorkflowEngine.unlockMonthlyAttendance(principalActor, { userId: 1, yearMonth: '2026-10', reason: 'r2' });
    // v3 確定
    const res3 = WorkflowEngine.confirmMonthlyAttendance(principalActor, { userId: 1, yearMonth: '2026-10', comment: 'v3' });
    assert.strictEqual(res3.success, true);

    const snapshots = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ? ORDER BY version ASC').all('2026-10') as any[];
    assert.strictEqual(snapshots.length, 3);
    assert.strictEqual(snapshots[0].status, 'SUPERSEDED');
    assert.strictEqual(snapshots[0].version, 1);
    assert.strictEqual(snapshots[1].status, 'SUPERSEDED');
    assert.strictEqual(snapshots[1].version, 2);
    assert.strictEqual(snapshots[2].status, 'LOCKED');
    assert.strictEqual(snapshots[2].version, 3);
    assert.strictEqual(snapshots[2].supersedes_snapshot_id, snapshots[1].id);
  });

  // GT-SNAP-LC-09: Synthetic Hybrid State Repair (Semantic Fail-Closed Repair Contract)
  it('GT-SNAP-LC-09: Synthetic Hybrid State Repair - 合成不整合データの安全修復と Fail-Closed 検証', () => {
    // 1. 合成 Fixture の作成: Approval = UNLOCKED_FOR_CORRECTION かつ Snapshot = LOCKED
    WorkflowEngine.confirmMonthlyAttendance(principalActor, { userId: 1, yearMonth: '2026-10', comment: 'v1' });

    db.prepare(`
      UPDATE monthly_attendance_approvals
      SET status = 'UNLOCKED_FOR_CORRECTION', unlocked_reason = '合成テスト解除理由'
      WHERE user_id = 1 AND year_month = '2026-10'
    `).run();

    // 既存スナップショット状態を記録 (Historical Evidence)
    const snapBefore = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = 1 AND year_month = ? AND status = ?').get('2026-10', 'LOCKED') as any;
    assert.ok(snapBefore);
    assert.strictEqual(snapBefore.status, 'LOCKED');
    const beforeDays = db.prepare('SELECT * FROM monthly_attendance_snapshot_days WHERE snapshot_id = ? ORDER BY date ASC').all(snapBefore.id) as any[];

    // 2. Fail-Closed 修復ロジック (Semantic Precondition Check)
    function executeFailClosedRepair(targetUserId: number, targetYearMonth: string) {
      return db.transaction(() => {
        // Precondition 1: Approval が UNLOCKED_FOR_CORRECTION
        const app = db.prepare('SELECT status, unlocked_reason FROM monthly_attendance_approvals WHERE user_id = ? AND year_month = ?').get(targetUserId, targetYearMonth) as any;
        if (!app || app.status !== 'UNLOCKED_FOR_CORRECTION') {
          throw new Error('FAIL_CLOSED: Approval is not UNLOCKED_FOR_CORRECTION');
        }

        // Precondition 2 & 3: Current LOCKED Snapshot が一意に1件
        const lockedSnaps = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = ? AND status = ?').all(targetUserId, targetYearMonth, 'LOCKED') as any[];
        if (lockedSnaps.length !== 1) {
          throw new Error(`FAIL_CLOSED: Expected exactly 1 LOCKED snapshot, found ${lockedSnaps.length}`);
        }

        const reason = `月次確定解除 (理由: ${app.unlocked_reason || '理由なし'})`;

        // Semantic UPDATE (Physical ID 依存なし)
        const updateResult = db.prepare(`
          UPDATE monthly_attendance_snapshots
          SET status = 'NEEDS_RECONFIRMATION',
              reconfirmation_reason = ?
          WHERE user_id = ? AND year_month = ? AND status = 'LOCKED'
        `).run(reason, targetUserId, targetYearMonth);

        if (updateResult.changes !== 1) {
          throw new Error(`FAIL_CLOSED: Expected 1 row updated, got ${updateResult.changes}`);
        }

        return true;
      })();
    }

    // 3. 正常系修復実行
    const repairResult = executeFailClosedRepair(1, '2026-10');
    assert.strictEqual(repairResult, true);

    // 4. Postcondition Verification
    const snapAfter = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = ?').get(snapBefore.id) as any;
    assert.strictEqual(snapAfter.status, 'NEEDS_RECONFIRMATION');
    assert.strictEqual(snapAfter.id, snapBefore.id, 'ID unchanged');
    assert.strictEqual(snapAfter.version, snapBefore.version, 'version unchanged');
    assert.strictEqual(snapAfter.confirmed_at, snapBefore.confirmed_at, 'confirmed_at unchanged');
    assert.strictEqual(snapAfter.monthly_summary_json, snapBefore.monthly_summary_json, 'summaryJson unchanged');
    assert.strictEqual(snapAfter.reconfirmation_reason, '月次確定解除 (理由: 合成テスト解除理由)');

    const afterDays = db.prepare('SELECT * FROM monthly_attendance_snapshot_days WHERE snapshot_id = ? ORDER BY date ASC').all(snapAfter.id) as any[];
    assert.strictEqual(afterDays.length, beforeDays.length, 'Days count unchanged');
    assert.deepStrictEqual(afterDays, beforeDays, 'Snapshot days content unchanged');

    // 5. Fail-Closed 拒絶検証: Precondition 不成立時に例外スローされること
    assert.throws(() => {
      // 既に NEEDS_RECONFIRMATION なので LOCKED Snapshot が 0 件
      executeFailClosedRepair(1, '2026-10');
    }, /FAIL_CLOSED: Expected exactly 1 LOCKED snapshot, found 0/);
  });
});
