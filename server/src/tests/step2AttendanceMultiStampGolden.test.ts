/**
 * Pilot Critical Path STEP 2: Dedicated Golden Test Suite (GT-PILOT-S2-01 〜 GT-PILOT-S2-10)
 * Official Report Job Title Dynamic Resolution & Attendance Multi-Stamp Projection
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { CanonicalAttendanceProjectionEngine } from '../services/canonical/projectionEngine';
import { SnapshotService } from '../services/snapshotService';

describe('Pilot Critical Path STEP 2: Official Report & Attendance Multi-Stamp Golden Suite (GT-PILOT-S2-01〜10)', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM absences').run();
    db.prepare('DELETE FROM calendar_adjustments').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
  });

  const actorPrincipal = {
    id: 2,
    username: 'principal',
    displayName: '校長 太郎',
    stampName: '校長',
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent'
  };

  it('GT-PILOT-S2-01: [Job Title Dynamic Resolution] 役職マスタから主務役職名が正しく動的解決されること', () => {
    // user_id: 1 に 'JOB_TITLE_VICE_PRINCIPAL' (教頭) を割り当て
    db.prepare(`
      INSERT OR REPLACE INTO user_job_titles (user_id, job_title_id, effective_from, effective_to, created_at)
      VALUES (1, 'JOB_TITLE_VICE_PRINCIPAL', '2026-04-01', '2027-03-31', ?)
    `).run(now);
    db.prepare(`
      INSERT OR REPLACE INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to, created_at, updated_at)
      VALUES (1, 'VICE_PRINCIPAL_1', 1, '2026-04-01', '2027-03-31', ?, ?)
    `).run(now, now);

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    assert.strictEqual(projection.userJobTitle, '教頭', '本務役職名が教頭として動的に解決されること');

    const doc = CanonicalAttendanceProjectionEngine.getDocumentProjection(1, '2026-05');
    assert.strictEqual(doc.attendanceData.userJobTitle, '教頭', '帳票Projection DTO に教頭が伝播していること');
  });

  it('GT-PILOT-S2-02: [Job Title Fallback Safety] 役職未設定ユーザーで「教諭」に安全にフォールバックすること', () => {
    // 役職割当を削除
    db.prepare('DELETE FROM user_positions WHERE user_id = 1').run();
    db.prepare('DELETE FROM user_job_titles WHERE user_id = 1').run();
    db.prepare(`
      INSERT OR REPLACE INTO user_job_titles (user_id, job_title_id, effective_from, effective_to, created_at)
      VALUES (1, 'JOB_TITLE_TEACHER', '2026-04-01', '2027-03-31', ?)
    `).run(now);

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    assert.strictEqual(projection.userJobTitle, '教諭', '役職未設定時は安全に教諭へフォールバックすること');
  });

  it('GT-PILOT-S2-03: [Job Title Snapshot Immutability] 月次確定ロック後はスナップショット保存された役職名が維持されること (INV-CUT-09)', () => {
    // 1. まず教頭で確定
    db.prepare(`
      INSERT OR REPLACE INTO user_job_titles (user_id, job_title_id, effective_from, effective_to, created_at)
      VALUES (1, 'JOB_TITLE_VICE_PRINCIPAL', '2026-04-01', '2027-03-31', ?)
    `).run(now);
    db.prepare(`
      INSERT OR REPLACE INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to, created_at, updated_at)
      VALUES (1, 'VICE_PRINCIPAL_1', 1, '2026-04-01', '2027-03-31', ?, ?)
    `).run(now, now);

    const snapshotId = SnapshotService.finalizeMonth(1, '2026-05', actorPrincipal, '点検完了');
    assert.ok(snapshotId > 0);

    // 2. 確定後に役職を「校長」に変更
    db.prepare(`
      INSERT OR REPLACE INTO user_job_titles (user_id, job_title_id, effective_from, effective_to, created_at)
      VALUES (1, 'JOB_TITLE_PRINCIPAL', '2026-04-01', '2027-03-31', ?)
    `).run(now);
    db.prepare(`
      INSERT OR REPLACE INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to, created_at, updated_at)
      VALUES (1, 'PRINCIPAL', 1, '2026-04-01', '2027-03-31', ?, ?)
    `).run(now, now);

    // 3. ロック済み月を取得 -> スナップショットの「教頭」が不変維持されること
    const lockedProjection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    assert.strictEqual(lockedProjection.userJobTitle, '教頭', '月次ロック後はスナップショット時の役職名が不変維持されること');
  });

  it('GT-PILOT-S2-04: [Multi-Stamp DTO Contract] 同一日複数服務（午前年休＋午後出張）で stamps 配列が2件格納されること', () => {
    // 2026-05-15: 午前 08:30〜12:30 年休 (4h = 240分) + 午後 13:30〜16:30 出張
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, version, created_at, updated_at)
      VALUES (201, 'LEAVE_ANNUAL', 1, 1, '時間単位年休', ?, ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', startTime: '08:30', endTime: '12:30', durationMinutes: 240, unitType: 'TIME', reasonCode: 'ANNUAL_LEAVE' }),
      JSON.stringify({ attendanceDeductionMinutes: 240 }),
      now, now
    );

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (202, 'BUSINESS_TRIP', 1, 1, '公務出張', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', startTime: '13:30', endTime: '16:30', durationMinutes: 180, destination: '県教育委員会' }),
      now, now
    );

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day15 = projection.days[14];

    assert.ok(day15.stamps, 'stamps 配列が存在すること');
    assert.strictEqual(day15.stamps.length, 2, '同一日に2件のスタンプが存在すること');
  });

  it('GT-PILOT-S2-05: [Multi-Stamp Deterministic Ordering] 時間指定イベント優先・カテゴリ優先度・FactID辞書順で安定ソートされること', () => {
    // 2026-05-15: 午前 08:30〜12:30 年休 + 午後 13:30〜16:30 出張
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, version, created_at, updated_at)
      VALUES (201, 'LEAVE_ANNUAL', 1, 1, '時間単位年休', ?, ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', startTime: '08:30', endTime: '12:30', durationMinutes: 240, unitType: 'TIME', reasonCode: 'ANNUAL_LEAVE' }),
      JSON.stringify({ attendanceDeductionMinutes: 240 }),
      now, now
    );

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (202, 'BUSINESS_TRIP', 1, 1, '公務出張', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', startTime: '13:30', endTime: '16:30', durationMinutes: 180, destination: '県教育委員会' }),
      now, now
    );

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day15 = projection.days[14];

    assert.strictEqual(day15.stamps![0].text, '年休', '08:30 開始の年休が第1スタンプ');
    assert.strictEqual(day15.stamps![0].subText, '4h');
    assert.strictEqual(day15.stamps![1].text, '出張', '13:30 開始の出張が第2スタンプ');
    assert.strictEqual(day15.stamps![1].subText, '13:30-16:30');
  });

  it('GT-PILOT-S2-06: [Primary Stamp Backward Compatibility] 既存の displaySymbol / displayName / stampColor / stampText との後方互換性が維持されること', () => {
    // 単一出張
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (301, 'BUSINESS_TRIP', 1, 1, '終日出張', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(JSON.stringify({ startDate: '2026-05-20', endDate: '2026-05-20', destination: '総合支援センター' }), now, now);

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day20 = projection.days[19];

    assert.strictEqual(day20.displaySymbol, '張');
    assert.strictEqual(day20.displayName, '公務旅行');
    assert.strictEqual(day20.stampColor, 'indigo');
    assert.strictEqual(day20.stampText, '出張');
    assert.strictEqual(day20.stamps!.length, 1);
    assert.strictEqual(day20.stamps![0].text, '出張');
  });

  it('GT-PILOT-S2-07: [Multi-Stamp 3+ Truncation Prevention] 同一日3件以上の服務発生時に stamps 配列に全件保持され欠落しないこと', () => {
    // 2026-05-18 に 08:30 年休 (1h) + 10:00 研修 (2h) + 14:00 出張 (2h)
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, version, created_at, updated_at)
      VALUES (401, 'LEAVE_ANNUAL', 1, 1, '時間年休', ?, ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-18', endDate: '2026-05-18', startTime: '08:30', endTime: '09:30', durationMinutes: 60, unitType: 'TIME', reasonCode: 'ANNUAL_LEAVE' }),
      JSON.stringify({ attendanceDeductionMinutes: 60 }),
      now, now
    );

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, version, created_at, updated_at)
      VALUES (402, 'TRAINING_SPECIAL_ACT_22_2', 1, 1, '校外研修', ?, ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-18', endDate: '2026-05-18', startTime: '10:00', endTime: '12:00', durationMinutes: 120, unitType: 'TIME', destination: '教育センター' }),
      JSON.stringify({ attendanceDeductionMinutes: 120 }),
      now, now
    );

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (403, 'BUSINESS_TRIP', 1, 1, '午後出張', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-18', endDate: '2026-05-18', startTime: '14:00', endTime: '16:00', durationMinutes: 120, destination: '市役所' }),
      now, now
    );

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const day18 = projection.days[17];

    assert.strictEqual(day18.stamps!.length, 3, '全3件のスタンプが保持されること');
    assert.strictEqual(day18.stamps![0].text, '年休');
    assert.strictEqual(day18.stamps![1].text, '研修');
    assert.strictEqual(day18.stamps![2].text, '出張');
  });

  it('GT-PILOT-S2-08: [Attendance Stamp Snapshot Persistence] 月次ロック保存時に resolution_json に stamps が正しく永続化・復元されること', () => {
    // 2026-05-15 に複数服務
    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, final_calculation_snapshot, current_status, version, created_at, updated_at)
      VALUES (501, 'LEAVE_ANNUAL', 1, 1, '時間年休', ?, ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', startTime: '08:30', endTime: '12:30', durationMinutes: 240, unitType: 'TIME', reasonCode: 'ANNUAL_LEAVE' }),
      JSON.stringify({ attendanceDeductionMinutes: 240 }),
      now, now
    );

    db.prepare(`
      INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at)
      VALUES (502, 'BUSINESS_TRIP', 1, 1, '午後出張', ?, 'FINAL_APPROVED', 1, ?, ?)
    `).run(
      JSON.stringify({ startDate: '2026-05-15', endDate: '2026-05-15', startTime: '13:30', endTime: '16:30', durationMinutes: 180, destination: '県教育委員会' }),
      now, now
    );

    const snapshotId = SnapshotService.finalizeMonth(1, '2026-05', actorPrincipal, '点検完了');
    assert.ok(snapshotId > 0);

    // ロック復元
    const locked = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    const restoredDay15 = locked.days[14];

    assert.ok(restoredDay15.stamps, '復元後も stamps が存在すること');
    assert.strictEqual(restoredDay15.stamps.length, 2, '復元後も2件のスタンプが保持されること');
    assert.strictEqual(restoredDay15.stamps[0].text, '年休');
    assert.strictEqual(restoredDay15.stamps[1].text, '出張');
  });

  it('GT-PILOT-S2-09: [Calendar and Holiday Stamp Handling] 週休日・祝日・代休日のスタンプが適切に isCalendarStatus=true を持ち解決されること', () => {
    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    // 2026-05-03 は 憲法記念日 (日曜日)
    const day3 = projection.days[2];
    assert.ok(day3.stamps && day3.stamps.length >= 1);
    assert.strictEqual(day3.stamps[0].isCalendarStatus, true, '祝日スタンプは isCalendarStatus=true であること');
    assert.strictEqual(day3.stamps[0].text, '祝日');
  });

  it('GT-PILOT-S2-10: [Personnel Override Stamp Projection] 育休・専従休職等の身分状態が正しく専用スタンプとして射影されること', () => {
    db.prepare(`
      INSERT INTO personnel_statuses (id, user_id, status_type, effective_from, effective_to, status, authority_basis, order_authority_snapshot, reason_code, registered_by_user_id, created_at, updated_at)
      VALUES (601, 1, 'CHILDCARE_LEAVE', '2026-05-01', '2026-05-31', 'CONFIRMED', 'OFFICIAL_ORDER', '山口県教育委員会', 'CHILDCARE_ACT', 1, ?, ?)
    `).run(now, now);

    const projection = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, '2026-05');
    // 2026-05-11 は 月曜日 (平日)
    const day11 = projection.days[10];

    assert.strictEqual(day11.primaryDayClassification, 'OTHER_NON_WORKDAY');
    assert.strictEqual(day11.displaySymbol, '育休');
    assert.ok(day11.stamps && day11.stamps.length >= 1);
    assert.strictEqual(day11.stamps[0].text, '育休');
    assert.strictEqual(day11.stamps[0].color, 'purple');
  });
});
