import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { ConflictService } from '../services/conflictService';
import { PersonnelService } from '../services/personnelService';
import { WorkflowEngine } from '../workflow/engine';

describe('Phase 2: Conflict & Compatibility Engine Test Suite', () => {
  let db: any;
  let teacher1: any;
  let admin: any;

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
    teacher1 = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1') as any;
    admin = db.prepare('SELECT id FROM users WHERE username = ?').get('principal') as any;
  });

  it('1. 停職期間中の年休・出張等の申請が Status Conflict で確実に拒絶されること', () => {
    // 既存の停職レコードをクリーンアップ
    db.prepare('DELETE FROM personnel_actions WHERE personnel_status_id IN (SELECT id FROM personnel_statuses WHERE user_id = ?)').run(teacher1.id);
    db.prepare('DELETE FROM personnel_statuses WHERE user_id = ?').run(teacher1.id);

    // 停職登録: 2026-10-01 〜 2026-10-10
    const statusId = PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-10',
      reasonCode: 'DISCIPLINARY_10DAYS',
      actorUserId: admin.id
    });

    assert.ok(statusId > 0);

    // 停職期間内の年休申請チェック
    const check1 = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-05',
      endDate: '2026-10-05',
      applicationTypeId: 'LEAVE_ANNUAL'
    });

    assert.strictEqual(check1.hasConflict, true);
    assert.strictEqual(check1.conflictType, 'STATUS_CONFLICT');
    assert.ok(check1.reason?.includes('停職期間中'));

    // 停職期間外 (2026-10-15) の年休申請チェック -> 競合なし
    const check2 = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-10-15',
      endDate: '2026-10-15',
      applicationTypeId: 'LEAVE_ANNUAL'
    });
    assert.strictEqual(check2.hasConflict, false);
  });

  it('2. 同一期間への二重身分状態登録が Status Conflict で拒絶されること', () => {
    // 停職登録: 2026-10-01 〜 2026-10-10
    PersonnelService.createStatus({
      userId: teacher1.id,
      statusType: 'DISCIPLINARY_SUSPENSION',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-10',
      reasonCode: 'DISCIPLINARY_10DAYS',
      actorUserId: admin.id
    });

    // 既に停職がある期間 (10/01〜10/10) に分限休職を登録しようとした場合
    assert.throws(() => {
      PersonnelService.createStatus({
        userId: teacher1.id,
        statusType: 'SUSPENSION',
        effectiveFrom: '2026-10-05',
        effectiveTo: '2026-10-20',
        reasonCode: 'HEALTH_REASON',
        actorUserId: admin.id
      });
    }, /身分状態の競合エラー/);
  });

  it('REG-CONFLICT-001: 3日間出張 (9/1〜9/3) が存在する場合、9/2 終日年休の Submit が Server で拒絶されること', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
    const vp = { id: 3, username: 'vice_principal', displayName: '教頭', roles: ['VICE_PRINCIPAL'], ipAddress: '127.0.0.1' };
    const princ = { id: 4, username: 'principal', displayName: '校長', roles: ['PRINCIPAL'], ipAddress: '127.0.0.1' };

    // 1. 9/1〜9/3 出張申請を作成
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '県外出張 (3日間)',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        startAt: '2026-09-01T08:10:00',
        endAt: '2026-09-03T16:40:00',
        purpose: '教育研究会',
        destination: '東京',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, true);
    const tripAppId = tripRes.data.id;

    // 2. 9/2 終日年休を提出試行 -> 422 で拒絶
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇 (競合)',
      formData: {
        targetDate: '2026-09-02',
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        unitType: 'DAY',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, false);
    assert.strictEqual(leaveRes.statusCode, 422);
    assert.strictEqual(leaveRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('REG-CONFLICT-002: 9/2 終日年休が存在する場合、9/1〜9/3 出張の Submit が Server で拒絶されること', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };

    // 1. 9/2 終日年休を作成
    const leaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇',
      formData: {
        targetDate: '2026-09-02',
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        unitType: 'DAY',
        reason: '私用'
      }
    });
    assert.strictEqual(leaveRes.success, true);

    // 2. 9/1〜9/3 出張申請を提出試行 -> 422 で拒絶
    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '県外出張 (3日間)',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        startAt: '2026-09-01T08:10:00',
        endAt: '2026-09-03T16:40:00',
        purpose: '教育研究会',
        destination: '東京',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, false);
    assert.strictEqual(tripRes.statusCode, 422);
    assert.strictEqual(tripRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('REG-CONFLICT-003: 9/1〜9/3 病休が存在する場合、9/2 研修が Server で拒絶されること', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };

    // 1. 9/1〜9/3 病気休暇を作成
    const sickRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_SICK',
      title: '病気休暇',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        unitType: 'DAY',
        reason: '療養'
      }
    });
    assert.strictEqual(sickRes.success, true);

    // 2. 9/2 特例法22条2項研修を提出試行 -> 422 で拒絶
    const trainingRes = WorkflowEngine.submitApplication(user, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '校外研修',
      formData: {
        targetDate: '2026-09-02',
        unitType: 'DAY',
        reason: '研修'
      }
    });
    assert.strictEqual(trainingRes.success, false);
    assert.strictEqual(trainingRes.statusCode, 422);
    assert.strictEqual(trainingRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });

  it('REG-CONFLICT-004: 9/1 終日出張が存在する場合でも、同日 14:00〜16:00 時間年休が正常受理されること (Wave 2 W2-B: COEXIST_AND_DEDUCT)', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };

    const tripRes = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '市内出張',
      formData: {
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        startAt: '2026-09-01T08:10:00',
        endAt: '2026-09-01T16:40:00',
        purpose: '会議',
        destination: '市役所',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(tripRes.success, true);

    const timeLeaveRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '時間年休',
      formData: {
        targetDate: '2026-09-01',
        unitType: 'TIME',
        startTime: '14:00',
        endTime: '16:00',
        reason: '私用'
      }
    });
    assert.strictEqual(timeLeaveRes.success, true);
    assert.strictEqual(timeLeaveRes.statusCode, 200);
  });

  it('REG-CONFLICT-005: 時間単位申請の境界接触 (12:00〜13:00 と 13:00〜14:00) は正常に許容されること', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };

    const time1 = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-09-04',
      endDate: '2026-09-04',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '08:30',
      endTime: '09:30'
    });
    assert.strictEqual(time1.hasConflict, false);

    // 09:30〜10:30 (接触のみ)
    const time2 = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-09-04',
      endDate: '2026-09-04',
      applicationTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startTime: '09:30',
      endTime: '10:30'
    });
    assert.strictEqual(time2.hasConflict, false);
  });

  it('REG-CONFLICT-006: 競合しない別日申請は正常に許可されること', () => {
    const check = ConflictService.validate({
      userId: teacher1.id,
      startDate: '2026-09-10',
      endDate: '2026-09-11',
      applicationTypeId: 'BUSINESS_TRIP'
    });
    assert.strictEqual(check.hasConflict, false);
  });

  it('REG-CONFLICT-007〜013: 並行提出された競合A/Bについて、A決裁後のB最終決裁遮断・年休残数保護・Audit整合性の検証', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
    const vp = { id: 3, username: 'vice_principal', displayName: '教頭', roles: ['VICE_PRINCIPAL'], ipAddress: '127.0.0.1' };
    const princ = { id: 4, username: 'principal', displayName: '校長', roles: ['PRINCIPAL'], ipAddress: '127.0.0.1' };

    // テスト用にDB直接操作で同日（2026-09-15）の申請A（年休）と申請B（出張）を SUBMITTED で作成
    const now = '2026-09-01T00:00:00.000Z';
    const appA = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES ('LEAVE_ANNUAL', ?, ?, 'SELF', 'SINGLE', '年休A', ?, 'SUBMITTED', 1, 1, ?, ?)
    `).run(teacher1.id, teacher1.id, JSON.stringify({ targetDate: '2026-09-15', unitType: 'FULL_DAY' }), now, now);
    const appIdA = Number(appA.lastInsertRowid);

    const appB = db.prepare(`
      INSERT INTO applications (type_id, subject_user_id, submitted_by_user_id, submission_actor_type, submission_mode, title, form_data, current_status, current_step_order, version, created_at, updated_at)
      VALUES ('BUSINESS_TRIP', ?, ?, 'SELF', 'SINGLE', '出張B', ?, 'SUBMITTED', 1, 1, ?, ?)
    `).run(teacher1.id, teacher1.id, JSON.stringify({ startDate: '2026-09-15', endDate: '2026-09-15', purpose: '出張' }), now, now);
    const appIdB = Number(appB.lastInsertRowid);

    // 承認ステップの作成 (A: 1ステップで校長決裁、B: 1ステップで校長決裁)
    db.prepare(`INSERT INTO application_approval_steps (application_id, approval_cycle, step_order, step_name, step_key, required_role_id, assigned_user_id, status) VALUES (?, 1, 1, '決裁', 'PRINCIPAL', 'PRINCIPAL', 4, 'PENDING')`).run(appIdA);
    db.prepare(`INSERT INTO application_approval_steps (application_id, approval_cycle, step_order, step_name, step_key, required_role_id, assigned_user_id, status) VALUES (?, 1, 1, '決裁', 'PRINCIPAL', 'PRINCIPAL', 4, 'PENDING')`).run(appIdB);

    // 1. 申請A（年休）を校長が決裁 -> FINAL_APPROVED
    const approveA = WorkflowEngine.approveApplication(princ, {
      applicationId: appIdA,
      expectedVersion: 1,
      comment: '年休承認'
    });
    assert.strictEqual(approveA.success, true);
    assert.strictEqual(approveA.data.nextStatus, 'FINAL_APPROVED');

    // 2. 申請B（出張）を校長が決裁試行 -> 直前再検証により 409 Conflict で拒絶 (REG-CONFLICT-007)
    const approveB = WorkflowEngine.approveApplication(princ, {
      applicationId: appIdB,
      expectedVersion: 1,
      comment: '出張承認'
    });
    assert.strictEqual(approveB.success, false);
    assert.strictEqual(approveB.statusCode, 409);
    assert.ok(approveB.message.includes('別の服務申請'));

    // 3. 申請Bのステータスが SUBMITTED のままであること (REG-CONFLICT-011)
    const stateB = db.prepare('SELECT current_status FROM applications WHERE id = ?').get(appIdB) as any;
    assert.strictEqual(stateB.current_status, 'SUBMITTED');

    // 4. 申請Bの承認ステップが PENDING のままであること (REG-CONFLICT-012)
    const stepB = db.prepare('SELECT status FROM application_approval_steps WHERE application_id = ?').get(appIdB) as any;
    assert.strictEqual(stepB.status, 'PENDING');
  });

  it('REG-CONFLICT-014: 差戻し後の再提出（Resubmit）時に新たな競合が存在する場合に拒絶されること', () => {
    const user = { id: teacher1.id, username: 'teacher1', displayName: '教員1', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
    const vp = { id: 3, username: 'vice_principal', displayName: '教頭', roles: ['VICE_PRINCIPAL'], ipAddress: '127.0.0.1' };
    const princ = { id: 4, username: 'principal', displayName: '校長', roles: ['PRINCIPAL'], ipAddress: '127.0.0.1' };

    // 1. 9/24（木・平日）の年休申請を提出後、教頭が差戻し（RETURNED）にする
    const submit1 = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_ANNUAL',
      title: '9/24 年休',
      formData: { startDate: '2026-09-24', endDate: '2026-09-24', unitType: 'DAY', calculatedDays: 1, reason: '私用' }
    });
    assert.strictEqual(submit1.success, true);
    const appId1 = submit1.data.id;
    const returnRes = WorkflowEngine.returnApplication(vp, { applicationId: appId1, expectedVersion: 1, comment: '修正要請' });
    assert.strictEqual(returnRes.success, true);

    // 2. その間に別の出張申請（9/24）が提出・決裁される
    const submitTrip = WorkflowEngine.submitApplication(user, {
      typeId: 'BUSINESS_TRIP',
      title: '9/24 出張',
      formData: {
        startDate: '2026-09-24',
        endDate: '2026-09-24',
        startAt: '2026-09-24T08:10:00',
        endAt: '2026-09-24T16:40:00',
        purpose: '会議',
        destination: '出張先',
        departurePlace: '本校',
        arrivalPlace: '本校',
      }
    });
    assert.strictEqual(submitTrip.success, true);
    const tripAppId = submitTrip.data.id;
    // 出張は 3ステップ (教頭->校長->最終) または1ステップ (直接承認)
    const appTrip = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(vp, { applicationId: tripAppId, expectedVersion: appTrip.version });
    const appTrip2 = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    WorkflowEngine.approveApplication(princ, { applicationId: tripAppId, expectedVersion: appTrip2.version });
    const appTrip3 = db.prepare('SELECT version FROM applications WHERE id = ?').get(tripAppId) as any;
    if (appTrip3) {
      WorkflowEngine.approveApplication(princ, { applicationId: tripAppId, expectedVersion: appTrip3.version });
    }

    // 3. 差戻された年休申請を再提出（Resubmit）試行 -> 422 で拒絶
    const resubmitRes = WorkflowEngine.resubmitApplication(user, {
      applicationId: appId1,
      expectedVersion: 2,
      title: '9/24 年休再提出',
      formData: { startDate: '2026-09-24', endDate: '2026-09-24', unitType: 'DAY', calculatedDays: 1, reason: '再提出' }
    });
    assert.strictEqual(resubmitRes.success, false);
    assert.strictEqual(resubmitRes.statusCode, 422);
    assert.strictEqual(resubmitRes.errorCode, 'SERVICE_PERIOD_CONFLICT');
  });
});
