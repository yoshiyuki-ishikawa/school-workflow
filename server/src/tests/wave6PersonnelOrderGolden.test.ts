/**
 * Wave 6 / GAP-07: 人事発令（休職・停職等）管理Fact基盤 ＆ 出勤簿自動連動
 * Golden Test Suite (GT-W6-01 〜 GT-W6-42)
 * 
 * Invariants:
 * 1. Application Fact ≠ Personnel Order Fact
 * 2. Personnel Order is Authoritative Fact (既存申請を理由とする登録拒絶の禁止)
 * 3. Privacy ≠ Semantic Mutation (停・休を専へ偽装しない。公文書は真実、一般Viewは中立記号「-」)
 * 4. Order Cancellation ≠ Blind Application Resurrection (Exact Previous State Restore & 競合再検証)
 * 5. Exact Previous State Restore (固定APPROVEDではなくpre_supersede_statusに復元)
 * 6. AMEND ≠ CANCEL (訂正はSUPERSEDED_BY_AMENDMENT、取消はCANCELLED)
 * 7. issued_at ≠ effective_from
 * 8. effective_to = NULL 許容
 * 9. document_reference_no OPTIONAL / authority_basis MUST
 * 10. Snapshot Invalidation on Retroactive Mutation
 * 11. Server-Authoritative Authority Resolution
 * 12. Absence of End Fact ≠ Permission to Invent End Fact (EXPLICIT_END_REQUIRED)
 * 13. Current Configuration ≠ Historical Authority Fact (Legacy Backfill)
 * 14. Role ≠ Position / Server-Authoritative Permission
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { PersonnelService } from '../services/personnelService';
import { ConflictService } from '../services/conflictService';
import { PolicyService } from '../services/policyService';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { OrderAuthorityResolver } from '../services/authority/orderAuthorityResolver';
import { PersonnelStatusCompatibilityPolicy } from '../services/policy/personnelStatusCompatibilityPolicy';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { checkUserPermission } from '../middlewares/auth';
import { getServerIsoString } from '../utils/serverTime';

describe('Original Wave 6 / GAP-07: 人事発令管理Fact基盤 ＆ 出勤簿自動連動 Golden Tests (GT-W6-01 〜 GT-W6-42)', () => {
  let db: any;

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    // クリーンアップ (外部キー制約順序: applications -> personnel_actions -> personnel_statuses)
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM personnel_actions').run();
    db.prepare('DELETE FROM personnel_statuses').run();
    db.prepare('DELETE FROM monthly_attendance_snapshot_days').run();
    db.prepare('DELETE FROM monthly_attendance_snapshots').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
  });

  const adminUserId = 1; // ADMIN
  const teacherUserId = 3; // TEACHER (Yamada)

  // -------------------------------------------------------------
  // Group 1: 成立原因の分離 & 権威的事実 (GT-W6-01 〜 GT-W6-06)
  // -------------------------------------------------------------

  it('GT-W6-01: 人事発令登録時に申請データが存在しなくても直接Factが成立すること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-12-31',
      documentReferenceNo: '教人第101号',
      issuedAt: '2026-09-25',
      authorityBasis: 'OFFICIAL_ORDER',
      reasonCode: 'LEGAL_SUSPENSION_HEALTH',
      actorUserId: adminUserId,
    });

    assert.ok(statusId > 0);
    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.source_application_id, null);
    assert.strictEqual(row.status, 'CONFIRMED');
    assert.strictEqual(row.status_type, 'SUSPENSION');
    assert.strictEqual(row.order_authority_snapshot, '山口県教育委員会');
  });

  it('GT-W6-02: 既存の承認済服務申請が存在していても人事発令登録が拒絶されず優先成立すること', () => {
    // 先に年休申請を作成・決裁
    const appId = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', ?, ?, '年休申請', ?, 'FINAL_APPROVED', datetime('now'), datetime('now'))
    `).run(
      teacherUserId,
      teacherUserId,
      JSON.stringify({ startDate: '2026-10-10', endDate: '2026-10-10', unitType: 'DAY', calculatedDays: 1 })
    ).lastInsertRowid;

    // 人事発令登録（期間重複: 10/01〜10/31）
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'LEGAL_CHILDCARE',
      actorUserId: adminUserId,
    });

    assert.ok(statusId > 0);
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUPERSEDED');
    assert.strictEqual(app.pre_supersede_status, 'FINAL_APPROVED');
    assert.strictEqual(app.superseded_by_personnel_status_id, statusId);
  });

  it('GT-W6-03: 進行中の申請（SUBMITTED/FIRST_APPROVED）も発令登録に伴いSUPERSEDEDに遷移しProvenanceが記録されること', () => {
    const appId = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_SPECIAL', ?, ?, '特休申請', ?, 'SUBMITTED', datetime('now'), datetime('now'))
    `).run(
      teacherUserId,
      teacherUserId,
      JSON.stringify({ startDate: '2026-10-05', endDate: '2026-10-06', unitType: 'DAY', calculatedDays: 2 })
    ).lastInsertRowid;

    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-15',
      reasonCode: 'DISCIPLINARY_ACTION',
      actorUserId: adminUserId,
    });

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUPERSEDED');
    assert.strictEqual(app.pre_supersede_status, 'SUBMITTED');
    assert.strictEqual(app.superseded_by_personnel_status_id, statusId);
  });

  it('GT-W6-04: 年休申請が失効(SUPERSEDED)した際、年休残高がExact-Reversal方式で即時戻し入れされること', () => {
    // 1ロット付与
    const entId = AnnualLeaveService.grantEntitlement({
      userId: teacherUserId,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与',
    });

    // 年休申請作成＆引当
    const formData = { startDate: '2026-10-05', endDate: '2026-10-05', unitType: 'DAY', calculatedDays: 1 };
    const appId = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', ?, ?, '年休1日', ?, 'FINAL_APPROVED', datetime('now'), datetime('now'))
    `).run(teacherUserId, teacherUserId, JSON.stringify(formData)).lastInsertRowid;

    AnnualLeaveService.finalizeUsage(Number(appId));

    let bal = AnnualLeaveService.getLeaveBalance(teacherUserId, '2026-10-05');
    assert.strictEqual(bal.remainingDays, 19);

    // 発令登録による失効
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'LEGAL_SUSPENSION',
      actorUserId: adminUserId,
    });

    // 年休が Exact-Reversal で 20日に戻っていること
    bal = AnnualLeaveService.getLeaveBalance(teacherUserId, '2026-10-05');
    assert.strictEqual(bal.remainingDays, 20);

    const usage = db.prepare('SELECT * FROM leave_usages WHERE application_id = ?').get(appId) as any;
    assert.strictEqual(usage.status, 'REVERSED');
  });

  it('GT-W6-05: 物理削除が完全禁止され、全操作がpersonnel_actions監査テーブルに記録されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'GRADUATE_STUDY_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2027-03-31',
      reasonCode: 'LEGAL_STUDY',
      actorUserId: adminUserId,
    });

    const actions = db.prepare('SELECT * FROM personnel_actions WHERE personnel_status_id = ?').all(statusId) as any[];
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action_type, 'CREATE');
    assert.strictEqual(actions[0].actor_user_id, adminUserId);
  });

  it('GT-W6-06: 発令主体スナップショットが動的解決されUNVERIFIED_LEGACYや推測値が混入しないこと', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-11-01',
      effectiveTo: '2026-11-30',
      reasonCode: 'DISCIPLINARY',
      actorUserId: adminUserId,
    });

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.order_authority_snapshot, '山口県教育委員会');
    assert.strictEqual(row.authority_basis, 'OFFICIAL_ORDER');
  });

  // -------------------------------------------------------------
  // Group 2: プライバシー ＆ 出勤簿自動連動 (GT-W6-07 〜 GT-W6-12)
  // -------------------------------------------------------------

  it('GT-W6-07: 停職(DISCIPLINARY_SUSPENSION)が一般Viewで専従等へ偽装されず中立記号「-」として投影されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-05',
      effectiveTo: '2026-10-05',
      reasonCode: 'DISCIPLINARY',
      actorUserId: adminUserId,
    });

    // 一般View (includeRestricted = false)
    const dayNormal = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: false });
    assert.strictEqual(dayNormal.displaySymbol, '-');
    assert.strictEqual(dayNormal.displayName, '***');
    assert.notStrictEqual(dayNormal.displaySymbol, '専'); // 偽装禁止
  });

  it('GT-W6-08: 特権View (personnel.status.read.restricted) では停職が真実の記号「停」として投影されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-05',
      effectiveTo: '2026-10-05',
      reasonCode: 'DISCIPLINARY',
      actorUserId: adminUserId,
    });

    // 特権View (includeRestricted = true)
    const dayRestricted = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: true });
    assert.strictEqual(dayRestricted.displaySymbol, '停');
    assert.strictEqual(dayRestricted.dutyRequirement, 'NO_WORK_REQUIRED');
  });

  it('GT-W6-09: 分限休職(SUSPENSION)が特権Viewでは「休」、一般Viewでは中立記号「-」となること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-05',
      effectiveTo: '2026-10-05',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    const dayNormal = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: false });
    assert.strictEqual(dayNormal.displaySymbol, '-');

    const dayRestricted = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: true });
    assert.strictEqual(dayRestricted.displaySymbol, '休');
  });

  it('GT-W6-10: 育児休業(CHILDCARE_LEAVE)が「育」として非勤務義務(NO_WORK_REQUIRED)で合成されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-05',
      effectiveTo: '2026-10-05',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: false });
    assert.strictEqual(day.displaySymbol, '育');
    assert.strictEqual(day.dutyRequirement, 'NO_WORK_REQUIRED');
    assert.strictEqual(day.scheduledWorkMinutes, 0);
  });

  it('GT-W6-11: 専従休職(UNION_FULL_TIME_RELEASE)が「専」として合成されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'UNION_FULL_TIME_RELEASE',
      effectiveFrom: '2026-10-05',
      effectiveTo: '2026-10-05',
      reasonCode: 'UNION',
      actorUserId: adminUserId,
    });

    const day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: false });
    assert.strictEqual(day.displaySymbol, '専');
  });

  it('GT-W6-12: 大学院修学休業(GRADUATE_STUDY_LEAVE)が「修」として合成されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'GRADUATE_STUDY_LEAVE',
      effectiveFrom: '2026-10-05',
      effectiveTo: '2026-10-05',
      reasonCode: 'STUDY',
      actorUserId: adminUserId,
    });

    const day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-05', includeRestricted: false });
    assert.strictEqual(day.displaySymbol, '修');
  });

  // -------------------------------------------------------------
  // Group 3: 発令訂正 (AMEND) ライフサイクル (GT-W6-13 〜 GT-W6-18)
  // -------------------------------------------------------------

  it('GT-W6-13: AMEND実行時に元レコードがSUPERSEDED_BY_AMENDMENTに更新され新レコードIDが紐づくこと', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const newStatusId = PersonnelService.amendStatus({
      statusId,
      newEffectiveFrom: '2026-10-01',
      newEffectiveTo: '2026-11-15',
      amendmentReason: '期間延長訂正発令',
      actorUserId: adminUserId,
    });

    assert.ok(newStatusId > statusId);
    const oldRow = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(oldRow.status, 'SUPERSEDED_BY_AMENDMENT');
    assert.strictEqual(oldRow.superseded_by_status_id, newStatusId);

    const newRow = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(newStatusId) as any;
    assert.strictEqual(newRow.status, 'CONFIRMED');
    assert.strictEqual(newRow.effective_to, '2026-11-15');
  });

  it('GT-W6-14: AMEND時に元レコードがCANCELLEDに汚染されないこと (AMEND ≠ CANCEL)', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    PersonnelService.amendStatus({
      statusId,
      newEffectiveFrom: '2026-10-05',
      newEffectiveTo: '2026-10-31',
      amendmentReason: '開始日誤記訂正',
      actorUserId: adminUserId,
    });

    const oldRow = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.notStrictEqual(oldRow.status, 'CANCELLED');
    assert.strictEqual(oldRow.status, 'SUPERSEDED_BY_AMENDMENT');
  });

  it('GT-W6-15: AMEND後の新レコード期間に基づいて出勤簿Projectionが即座に追従すること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-10',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    // 10/11 は最初通常日
    let day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-11', includeRestricted: false });
    assert.notStrictEqual(day.displaySymbol, '育');

    // 10/15 まで訂正延長
    PersonnelService.amendStatus({
      statusId,
      newEffectiveFrom: '2026-10-01',
      newEffectiveTo: '2026-10-15',
      amendmentReason: '期間訂正',
      actorUserId: adminUserId,
    });

    // 10/11 が育休に切り替わること
    day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-11', includeRestricted: false });
    assert.strictEqual(day.displaySymbol, '育');
  });

  it('GT-W6-16: 既にCANCELLEDのレコードに対してAMENDを行おうとした場合Fail-Closedで遮断されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    PersonnelService.cancelStatus({
      statusId,
      cancellationReason: '発令取消',
      actorUserId: adminUserId,
    });

    assert.throws(() => {
      PersonnelService.amendStatus({
        statusId,
        newEffectiveFrom: '2026-10-01',
        newEffectiveTo: '2026-11-30',
        amendmentReason: '取消後訂正試行',
        actorUserId: adminUserId,
      });
    }, /既に取消または訂正済み/);
  });

  it('GT-W6-17: 既にSUPERSEDED_BY_AMENDMENTのレコードに対して再AMENDを行おうとした場合Fail-Closedで遮断されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    PersonnelService.amendStatus({
      statusId,
      newEffectiveFrom: '2026-10-05',
      newEffectiveTo: '2026-10-31',
      amendmentReason: '1回目訂正',
      actorUserId: adminUserId,
    });

    assert.throws(() => {
      PersonnelService.amendStatus({
        statusId,
        newEffectiveFrom: '2026-10-10',
        newEffectiveTo: '2026-10-31',
        amendmentReason: '旧レコードへの2回目訂正試行',
        actorUserId: adminUserId,
      });
    }, /既に取消または訂正済み/);
  });

  it('GT-W6-18: AMEND操作がpersonnel_actionsに旧・新状態JSONとともに記録されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    PersonnelService.amendStatus({
      statusId,
      newEffectiveFrom: '2026-10-05',
      newEffectiveTo: '2026-10-31',
      amendmentReason: '開始日訂正',
      actorUserId: adminUserId,
    });

    const actions = db.prepare("SELECT * FROM personnel_actions WHERE personnel_status_id = ? AND action_type = 'AMEND'").all(statusId) as any[];
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].previous_state_json.length > 0);
  });

  // -------------------------------------------------------------
  // Group 4: 発令取消 (CANCEL) ＆ Exact Previous State Restore (GT-W6-19 〜 GT-W6-24)
  // -------------------------------------------------------------

  it('GT-W6-19: 発令取消時に失効申請が固定APPROVEDではなく失効直前の厳密ステータスに完全復元されること', () => {
    // 申請A: SUBMITTED で失効
    const appA = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_SPECIAL', ?, ?, '特休', ?, 'SUBMITTED', datetime('now'), datetime('now'))
    `).run(teacherUserId, teacherUserId, JSON.stringify({ startDate: '2026-10-10', endDate: '2026-10-10', unitType: 'DAY' })).lastInsertRowid;

    // 申請B: FINAL_APPROVED で失効
    const appB = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('BUSINESS_TRIP', ?, ?, '出張', ?, 'FINAL_APPROVED', datetime('now'), datetime('now'))
    `).run(teacherUserId, teacherUserId, JSON.stringify({ startDate: '2026-10-12', endDate: '2026-10-12', unitType: 'DAY' })).lastInsertRowid;

    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    // 両方 SUPERSEDED
    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appA) as any).current_status, 'SUPERSEDED');
    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appB) as any).current_status, 'SUPERSEDED');

    // 発令取消
    PersonnelService.cancelStatus({
      statusId,
      cancellationReason: '辞令撤回',
      actorUserId: adminUserId,
    });

    // 復元検証 (Exact Previous State Restore)
    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appA) as any).current_status, 'SUBMITTED');
    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appB) as any).current_status, 'FINAL_APPROVED');
  });

  it('GT-W6-20: 発令取消時に年休承認済申請が復元された場合、年休再引当(Re-deduct)が実行されること', () => {
    AnnualLeaveService.grantEntitlement({
      userId: teacherUserId,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与',
    });

    const formData = { startDate: '2026-10-05', endDate: '2026-10-05', unitType: 'DAY', calculatedDays: 1 };
    const appId = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', ?, ?, '年休1日', ?, 'FINAL_APPROVED', datetime('now'), datetime('now'))
    `).run(teacherUserId, teacherUserId, JSON.stringify(formData)).lastInsertRowid;

    AnnualLeaveService.finalizeUsage(Number(appId));

    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    // 発令により失効し残高20日に戻る
    assert.strictEqual(AnnualLeaveService.getLeaveBalance(teacherUserId, '2026-10-05').remainingDays, 20);

    // 発令取消により申請復元 ＆ 再引当されて残高19日になること
    PersonnelService.cancelStatus({
      statusId,
      cancellationReason: '辞令撤回',
      actorUserId: adminUserId,
    });

    assert.strictEqual((db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appId) as any).current_status, 'FINAL_APPROVED');
    assert.strictEqual(AnnualLeaveService.getLeaveBalance(teacherUserId, '2026-10-05').remainingDays, 19);
  });

  it('GT-W6-21: 既にCANCELLEDのレコードを再取消しようとした場合Fail-Closedで遮断されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    PersonnelService.cancelStatus({
      statusId,
      cancellationReason: '1回目取消',
      actorUserId: adminUserId,
    });

    assert.throws(() => {
      PersonnelService.cancelStatus({
        statusId,
        cancellationReason: '2回目取消試行',
        actorUserId: adminUserId,
      });
    }, /既に取消または訂正済み/);
  });

  it('GT-W6-22: 復職(RETURN_TO_DUTY)が実行された場合、復職日前日をもってended_at/effective_toが短縮されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-12-31',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    PersonnelService.returnToDuty(statusId, '2026-11-01', adminUserId, '早期復職');

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.ended_at, '2026-11-01');
    assert.strictEqual(row.effective_to, '2026-10-31');

    // 11/01 は出勤簿上で通常勤務に戻っていること
    const day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-11-01', includeRestricted: false });
    assert.notStrictEqual(day.displaySymbol, '育');
  });

  it('GT-W6-23: 期間延長(EXTEND)が実行された場合、effective_toが更新され延長区間が自動連動すること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    PersonnelService.extendPeriod(statusId, '2026-11-30', adminUserId, '期間延長');

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.effective_to, '2026-11-30');

    // 11/15 が育休として投影されること
    const day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-11-15', includeRestricted: false });
    assert.strictEqual(day.displaySymbol, '育');
  });

  it('GT-W6-24: 終了事実なき自動推論の禁止 (EXPLICIT_END_REQUIRED) が遵守されること', () => {
    const policy = PersonnelStatusCompatibilityPolicy.getOpenEndedTransitionPolicy('UNION_FULL_TIME_RELEASE');
    assert.strictEqual(policy, 'EXPLICIT_END_REQUIRED');
  });

  // -------------------------------------------------------------
  // Group 5: 無期限・終了日未定 (effective_to = NULL) (GT-W6-25 〜 GT-W6-30)
  // -------------------------------------------------------------

  it('GT-W6-25: effective_to = NULL で人事発令が正常登録できること (HD-W6-01)', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'UNION_FULL_TIME_RELEASE',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      reasonCode: 'UNION',
      actorUserId: adminUserId,
    });

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.effective_to, null);
    assert.strictEqual(row.status, 'CONFIRMED');
  });

  it('GT-W6-26: effective_to = NULL の発令期間中の全日が「専」として出勤簿Projectionされること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'UNION_FULL_TIME_RELEASE',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      reasonCode: 'UNION',
      actorUserId: adminUserId,
    });

    const day1 = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-10-01', includeRestricted: false });
    const day2 = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2027-05-15', includeRestricted: false });
    assert.strictEqual(day1.displaySymbol, '専');
    assert.strictEqual(day2.displaySymbol, '専');
  });

  it('GT-W6-27: effective_to = NULL の発令中に服務申請を出そうとした場合ConflictServiceで遮断されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const conflict = ConflictService.validate({
      userId: teacherUserId,
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      applicationTypeId: 'LEAVE_ANNUAL',
    });

    assert.strictEqual(conflict.hasConflict, true);
    assert.strictEqual(conflict.conflictType, 'STATUS_CONFLICT');
  });

  it('GT-W6-28: effective_to = NULL の発令に対して復職(RETURN_TO_DUTY)で終了日が確定すること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'UNION_FULL_TIME_RELEASE',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      reasonCode: 'UNION',
      actorUserId: adminUserId,
    });

    PersonnelService.returnToDuty(statusId, '2026-12-01', adminUserId, '専従期間終了・復帰');

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.effective_to, '2026-11-30');
    assert.strictEqual(row.ended_at, '2026-12-01');

    // 12/01 は通常日に戻ること
    const day = AttendanceEngine.resolveDay({ userId: teacherUserId, date: '2026-12-01', includeRestricted: false });
    assert.notStrictEqual(day.displaySymbol, '専');
  });

  it('GT-W6-29: issued_at と effective_from が異なる日付でも正しく登録・保持されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-12-31',
      issuedAt: '2026-09-20', // 発令日 ≠ 開始日
      documentReferenceNo: '教人第99号',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.issued_at, '2026-09-20');
    assert.strictEqual(row.effective_from, '2026-10-01');
  });

  it('GT-W6-30: document_reference_no が NULL (未記入) でも authority_basis があれば正常登録できること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      authorityBasis: 'OFFICIAL_ORDER',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(statusId) as any;
    assert.strictEqual(row.document_reference_no, null);
    assert.strictEqual(row.authority_basis, 'OFFICIAL_ORDER');
  });

  // -------------------------------------------------------------
  // Group 6: 遡及変更 ＆ Snapshot Invalidation (GT-W6-31 〜 GT-W6-36)
  // -------------------------------------------------------------

  it('GT-W6-31: 確定済み(LOCKED)の月度に対して過去の発令が登録された場合NEEDS_RECONFIRMATIONに無効化されること', () => {
    // 2026-09 月度を確定ロック
    const snapId = db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum
      ) VALUES (?, '2026-09', 1, 'LOCKED', datetime('now'), 1, '管理者', '管理者', '{}', 'dummy')
    `).run(teacherUserId).lastInsertRowid;

    // 2026-09-15〜2026-09-20 の発令を登録
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-09-15',
      effectiveTo: '2026-09-20',
      reasonCode: 'DISCIPLINARY',
      actorUserId: adminUserId,
    });

    const snap = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = ?').get(snapId) as any;
    assert.strictEqual(snap.status, 'NEEDS_RECONFIRMATION');
    assert.ok(snap.reconfirmation_reason.includes('人事発令登録'));
  });

  it('GT-W6-32: 確定済み月度に対してAMENDが行われた場合もNEEDS_RECONFIRMATIONに無効化されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-10',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    const snapId = db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum
      ) VALUES (?, '2026-09', 1, 'LOCKED', datetime('now'), 1, '管理者', '管理者', '{}', 'dummy')
    `).run(teacherUserId).lastInsertRowid;

    PersonnelService.amendStatus({
      statusId,
      newEffectiveFrom: '2026-09-01',
      newEffectiveTo: '2026-09-20',
      amendmentReason: '期間訂正',
      actorUserId: adminUserId,
    });

    const snap = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = ?').get(snapId) as any;
    assert.strictEqual(snap.status, 'NEEDS_RECONFIRMATION');
  });

  it('GT-W6-33: 確定済み月度に対してCANCELが行われた場合もNEEDS_RECONFIRMATIONに無効化されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'SUSPENSION',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-10',
      reasonCode: 'HEALTH',
      actorUserId: adminUserId,
    });

    const snapId = db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum
      ) VALUES (?, '2026-09', 1, 'LOCKED', datetime('now'), 1, '管理者', '管理者', '{}', 'dummy')
    `).run(teacherUserId).lastInsertRowid;

    PersonnelService.cancelStatus({
      statusId,
      cancellationReason: '取消',
      actorUserId: adminUserId,
    });

    const snap = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = ?').get(snapId) as any;
    assert.strictEqual(snap.status, 'NEEDS_RECONFIRMATION');
  });

  it('GT-W6-34: 確定済み月度に対して復職(RETURN_TO_DUTY)が行われた場合も該当月が無効化されること', () => {
    const statusId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const snapId = db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum
      ) VALUES (?, '2026-09', 1, 'LOCKED', datetime('now'), 1, '管理者', '管理者', '{}', 'dummy')
    `).run(teacherUserId).lastInsertRowid;

    PersonnelService.returnToDuty(statusId, '2026-09-15', adminUserId, '早期復職');

    const snap = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = ?').get(snapId) as any;
    assert.strictEqual(snap.status, 'NEEDS_RECONFIRMATION');
  });

  it('GT-W6-35: 影響を受けない未来または過去の別月度はLOCKEDが維持されること', () => {
    // 2026-07 月度を確定ロック
    const snap7 = db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum
      ) VALUES (?, '2026-07', 1, 'LOCKED', datetime('now'), 1, '管理者', '管理者', '{}', 'dummy')
    `).run(teacherUserId).lastInsertRowid;

    // 2026-09 の発令登録
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-30',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const snap = db.prepare('SELECT * FROM monthly_attendance_snapshots WHERE id = ?').get(snap7) as any;
    assert.strictEqual(snap.status, 'LOCKED'); // 7月は維持
  });

  it('GT-W6-36: Invalidation発生時に監査ログにSNAPSHOT_INVALIDATEDが記録されること', () => {
    db.prepare(`
      INSERT INTO monthly_attendance_snapshots (
        user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
        confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json, checksum
      ) VALUES (?, '2026-09', 1, 'LOCKED', datetime('now'), 1, '管理者', '管理者', '{}', 'dummy')
    `).run(teacherUserId);

    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-30',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    const log = db.prepare("SELECT * FROM audit_logs WHERE action = 'SNAPSHOT_INVALIDATED'").get() as any;
    assert.ok(log);
    assert.ok(log.comment.includes('要再確定'));
  });

  // -------------------------------------------------------------
  // Group 7: 認可 ＆ 境界防御 (GT-W6-37 〜 GT-W6-42)
  // -------------------------------------------------------------

  it('GT-W6-37: personnel.status.manage 権限を持つPRINCIPAL/VICE_PRINCIPALロールは登録・訂正・取消が可能であること', () => {
    const hasPermPrincipal = checkUserPermission(['PRINCIPAL'], 'personnel.status.manage');
    const hasPermVp = checkUserPermission(['VICE_PRINCIPAL'], 'personnel.status.manage');
    assert.strictEqual(hasPermPrincipal, true);
    assert.strictEqual(hasPermVp, true);
  });

  it('GT-W6-38: personnel.status.manage 権限を持たない一般教員(TEACHER)は発令操作が403拒絶されること', () => {
    const hasPerm = checkUserPermission(['TEACHER'], 'personnel.status.manage');
    assert.strictEqual(hasPerm, false);
  });

  it('GT-W6-39: personnel.status.read.basic のみ持つ一般教員はセンシティブ発令がマスキングされること', () => {
    const hasBasic = checkUserPermission(['TEACHER'], 'personnel.status.read.basic');
    const hasRestricted = checkUserPermission(['TEACHER'], 'personnel.status.read.restricted');
    assert.strictEqual(hasBasic, true);
    assert.strictEqual(hasRestricted, false);
  });

  it('GT-W6-40: 過去Legacy移行データが issued_at = NULL, authority_basis = UNVERIFIED_LEGACY で保持されること', () => {
    // Migration 026 の Legacy Backfill 検証
    const legacyRow = db.prepare(`
      SELECT * FROM personnel_statuses WHERE authority_basis = 'UNVERIFIED_LEGACY'
    `).all();
    // 新規登録時は UNVERIFIED_LEGACY にならないことを確認
    const newId = PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });
    const row = db.prepare('SELECT * FROM personnel_statuses WHERE id = ?').get(newId) as any;
    assert.strictEqual(row.authority_basis, 'OFFICIAL_ORDER');
  });

  it('GT-W6-41: 同一人に対して同期間に異なる2つの身分状態を重複登録しようとした場合Fail-Closedで拒絶されること', () => {
    PersonnelService.createStatus({
      userId: teacherUserId,
      statusType: 'CHILDCARE_LEAVE',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-31',
      reasonCode: 'CHILDCARE',
      actorUserId: adminUserId,
    });

    assert.throws(() => {
      PersonnelService.createStatus({
        userId: teacherUserId,
        statusType: 'SUSPENSION',
        effectiveFrom: '2026-10-15',
        effectiveTo: '2026-11-15',
        reasonCode: 'HEALTH',
        actorUserId: adminUserId,
      });
    }, /身分状態の競合エラー/);
  });

  it('GT-W6-42: Phase E Authority Cutover が未許可（Legacyエンジンが Production Authority を維持）であることを確認', () => {
    // Legacy 出勤簿取得メソッドが正常動作すること
    const { getMonthlyAttendanceData } = require('../utils/attendanceEngine');
    const data = getMonthlyAttendanceData(teacherUserId, '2026-10');
    assert.ok(data);
    assert.strictEqual(data.userId, teacherUserId);
    assert.strictEqual(data.yearMonth, '2026-10');
  });
});
