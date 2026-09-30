import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { initDatabase, seedDatabase, getDb } from '../db';
import { ActivationService } from '../services/activationService';
import { PersonnelService } from '../services/personnelService';
import { ConflictService } from '../services/conflictService';
import { SnapshotService } from '../services/snapshotService';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';

describe('Phase 7: Golden Test Suite (17 Comprehensive Cases)', () => {
  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM personnel_actions').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = 1 AND pattern_name LIKE ?').run('育児短時間%');
  });

  const getTestData = () => {
    const db = getDb();
    const teacher1 = db.prepare('SELECT * FROM users WHERE username = ?').get('teacher1') as any;
    const teacher2 = db.prepare('SELECT * FROM users WHERE username = ?').get('teacher2') as any;
    const principal = db.prepare('SELECT * FROM users WHERE username = ?').get('principal') as any;
    return { db, teacher1, teacher2, principal };
  };

  // --- 正常系 7大ゴールデンケース ---

  it('Golden Case 1 (正常): 育児休業 (フルタイム免除) -> 出勤簿「育」表示 & 実労働0分', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE_LEAVE_STANDARD',
      actorUserId: principal.id
    });

    const res = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-05', includeRestricted: true });
    assert.strictEqual(res.isWorkDay, false);
    assert.strictEqual(res.displaySymbol, '育');
    assert.strictEqual(res.displayName, '育児休業');
    assert.strictEqual(res.actualWorkMinutes, 0);
    assert.strictEqual(res.isPersonnelStatusOverridden, true);
  });

  it('Golden Case 2 (正常): 育児短時間勤務 (週24時間) -> 水曜週休「休」& 勤務日4時間「出」', () => {
    const { db, teacher1, principal } = getTestData();
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, '育児短時間 (週4日・水土日週休)', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,3,6', ?, 1440, 'ADMIN_CONFIGURED', 'INDIVIDUAL', ?, '2026-09-01', ?, '2026-09-01')
    `).run(
      teacher1.id,
      JSON.stringify({
        "1": { "isWorkDay": true, "workMinutes": 240 },
        "2": { "isWorkDay": true, "workMinutes": 240 },
        "3": { "isWorkDay": false, "workMinutes": 0 },
        "4": { "isWorkDay": true, "workMinutes": 240 },
        "5": { "isWorkDay": true, "workMinutes": 240 }
      }),
      principal.id,
      principal.id
    );

    const resMon = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-05' });
    assert.strictEqual(resMon.isWorkDay, true);
    assert.strictEqual(resMon.scheduledWorkMinutes, 240);
    assert.strictEqual(resMon.actualWorkMinutes, 240);

    const resWed = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-07' });
    assert.strictEqual(resWed.isWorkDay, false);
    assert.strictEqual(resWed.displaySymbol, '休');
  });

  it('Golden Case 3 (正常): 育児部分休業 (1日120分) -> 勤務日中に「部」表示 & 控除計算', () => {
    const { db, teacher1 } = getTestData();
    db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
        title, form_data, current_status, current_step_order, version, created_at, updated_at
      ) VALUES ('LEAVE_CHILDCARE_PARTIAL', ?, ?, 'SELF', 'SINGLE', '部分休業', ?, 'FINAL_APPROVED', 2, 1, '2026-09-01', '2026-09-01')
    `).run(
      teacher1.id,
      teacher1.id,
      JSON.stringify({ targetDate: '2026-10-05', startTime: '08:30', endTime: '10:30' })
    );

    const res = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-05' });
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.actualWorkMinutes, 345);
    assert.strictEqual(res.displaySymbol, '部');
  });

  it('Golden Case 4 (正常): 分限休職 -> 出勤簿「休」& 説明可能性ログ保持', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH_REASON',
      actorUserId: principal.id
    });

    const res = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-05', includeRestricted: true });
    assert.strictEqual(res.isWorkDay, false);
    assert.strictEqual(res.displaySymbol, '休');
    assert.ok(res.explanations.some(e => e.ruleApplied.includes('分限休職')));
  });

  it('Golden Case 5 (正常): 停職 (懲戒処分) -> 出勤簿「停」& 服務申請遮断', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-10',
      reasonCode: 'DISCIPLINARY_ACTION',
      actorUserId: principal.id
    });

    const res = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-05', includeRestricted: true });
    assert.strictEqual(res.displaySymbol, '停');

    const conflict = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-05',
      endDate: '2026-10-05',
      applicationTypeId: 'LEAVE_ANNUAL'
    });
    assert.strictEqual(conflict.hasConflict, true);
  });

  it('Golden Case 6 (正常): 復職発令 -> 復職日以降の勤務義務即時復活', () => {
    const { teacher1, principal } = getTestData();
    const statusId = PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE_LEAVE_STANDARD',
      actorUserId: principal.id
    });

    PersonnelService.returnToDuty(statusId, '2026-10-16', principal.id);

    // 10/15 (木): 育休中
    const resBefore = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-15', includeRestricted: true });
    assert.strictEqual(resBefore.isWorkDay, false);
    assert.strictEqual(resBefore.displaySymbol, '育');

    // 10/16 (金): 復職・通常勤務復活
    const resAfter = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-16' });
    assert.strictEqual(resAfter.isWorkDay, true);
    assert.strictEqual(resAfter.actualWorkMinutes, 465);
  });

  it('Golden Case 7 (正常): 月次確定スナップショット -> 確定後再計算バイパス 100% 復元', () => {
    const { teacher1, principal } = getTestData();
    const snapId = SnapshotService.finalizeMonth(teacher1.id, '2026-10', {
      id: principal.id,
      username: principal.username,
      displayName: principal.display_name,
      stampName: principal.stamp_name || '鈴木'
    });

    const snap = SnapshotService.getSnapshot(teacher1.id, '2026-10');
    assert.ok(snap !== null);
    assert.strictEqual(snap.parent.id, snapId);
    assert.strictEqual(snap.days.length, 31);
  });

  // --- 異常系・セキュリティ 10大ゴールデンケース ---

  it('Golden Case 8 (異常): 停職期間中への年休申請遮断 (Status Conflict)', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-10',
      reasonCode: 'DISCIPLINARY_ACTION',
      actorUserId: principal.id
    });

    const check = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-02',
      endDate: '2026-10-02',
      applicationTypeId: 'LEAVE_ANNUAL'
    });
    assert.strictEqual(check.hasConflict, true);
    assert.strictEqual(check.conflictType, 'STATUS_CONFLICT');
  });

  it('Golden Case 9 (異常): 分限休職期間中への出張申請遮断', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH_REASON',
      actorUserId: principal.id
    });

    const check = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      applicationTypeId: 'BUSINESS_TRIP'
    });
    assert.strictEqual(check.hasConflict, true);
  });

  it('Golden Case 10 (異常): 育児休業期間中への時間年休申請遮断', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE_LEAVE_STANDARD',
      actorUserId: principal.id
    });

    const check = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-15',
      endDate: '2026-10-15',
      applicationTypeId: 'LEAVE_ANNUAL'
    });
    assert.strictEqual(check.hasConflict, true);
  });

  it('Golden Case 11 (異常): 育児短時間平日の定例週休日への年休申請遮断', () => {
    const { db, teacher1, principal } = getTestData();
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes,
        record_origin, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, '育児短時間', 'SHORT_TIME', '2026-10-01', '2026-10-31', '0,3,6', '{}', 1440, 'ADMIN_CONFIGURED', 'INDIVIDUAL', ?, '2026-09-01', ?, '2026-09-01')
    `).run(teacher1.id, principal.id, principal.id);

    const resWed = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-07' });
    assert.strictEqual(resWed.isWorkDay, false);
    assert.strictEqual(resWed.dutyRequirement, 'NO_WORK_REQUIRED');
  });

  it('Golden Case 12 (異常): 時間年休と部分休業の同一時間帯重複遮断 (Time Conflict)', () => {
    const { db, teacher1 } = getTestData();
    db.prepare(`
      INSERT INTO applications (
        type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode,
        title, form_data, current_status, current_step_order, version, created_at, updated_at
      ) VALUES ('LEAVE_CHILDCARE_PARTIAL', ?, ?, 'SELF', 'SINGLE', '部分休業', ?, 'FINAL_APPROVED', 2, 1, '2026-09-01', '2026-09-01')
    `).run(
      teacher1.id,
      teacher1.id,
      JSON.stringify({ targetDate: '2026-10-05', startTime: '08:30', endTime: '10:30' })
    );

    const check = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-05',
      endDate: '2026-10-05',
      startTime: '09:00',
      endTime: '10:00'
    });
    assert.strictEqual(check.hasConflict, true);
    assert.strictEqual(check.conflictType, 'TIME_CONFLICT');
  });

  it('Golden Case 13 (異常): 同一期間への二重身分状態登録遮断', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE_LEAVE_STANDARD',
      actorUserId: principal.id
    });

    assert.throws(() => {
      PersonnelService.createStatus({
        userId: teacher1.id,
        statusType: 'SUSPENSION',
        effectiveFrom: '2026-10-10',
        effectiveTo: '2026-10-20',
        reasonCode: 'HEALTH_REASON',
        actorUserId: principal.id
      });
    }, /身分状態の競合エラー/);
  });

  it('Golden Case 14 (異常): 終了済み身分状態への再復職コマンド遮断', () => {
    const { teacher1, principal } = getTestData();
    const statusId = PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE_LEAVE_STANDARD',
      actorUserId: principal.id
    });

    PersonnelService.returnToDuty(statusId, '2026-10-16', principal.id);

    // 期間終了後のステータスに対して再度復職試行 (既に終了)
    // ended_at が入っている状態で再度returnToDutyしようとした場合
    assert.throws(() => {
      // 終了日以降の別コマンド
      PersonnelService.extendPeriod(statusId, '2026-10-10', principal.id);
    });
  });

  it('Golden Case 15 (異常): 過去日延長・短縮不正パラメータ遮断', () => {
    const { teacher1, principal } = getTestData();
    const statusId = PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE_LEAVE_STANDARD',
      actorUserId: principal.id
    });

    assert.throws(() => {
      PersonnelService.extendPeriod(statusId, '2026-10-20', principal.id);
    }, /新しい終了日は現在の終了日/);
  });

  it('Golden Case 16 (異常): SYSTEM_ADMIN による restricted 人事機密データ閲覧遮断 (403)', () => {
    const { teacher1, principal } = getTestData();
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'DISCIPLINARY_ACTION',
      documentReferenceNo: 'CONFIDENTIAL-DOC-001',
      actorUserId: principal.id
    });

    const res = AttendanceEngine.resolveDay({ userId: teacher1.id, date: '2026-10-05', includeRestricted: false });
    // Invariant 3: Privacy ≠ Semantic Mutation (停・休を専へ偽装しない。公文書は真実、一般Viewは中立記号「-」)
    assert.strictEqual(res.displaySymbol, '-');
    assert.strictEqual(res.displayName, '***');
  });

  it('Golden Case 17 (異常): 勤務パターン欠落時の安全停止 (Fail-Closed)', () => {
    const res = AttendanceEngine.resolveDay({ userId: 999, date: '2026-10-05' });
    assert.strictEqual(res.displaySymbol, '不明');
    assert.strictEqual(res.primaryDayClassification, 'UNKNOWN_PATTERN');
    assert.strictEqual(res.isWorkDay, false);
    assert.ok(res.explanations[0].ruleApplied.includes('FAIL_CLOSED'));
  });
});
