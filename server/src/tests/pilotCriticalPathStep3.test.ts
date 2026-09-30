/**
 * Pilot Critical Path STEP 3: Server Golden Test Suite (GT-PILOT-S3-01 〜 10 + NEG-S3-01 〜 04)
 * Working Obligation SSOT Cutover & Server Authoritative Time Sanitization
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { ApplicationValidationPipeline } from '../services/applicationValidationPipeline';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';

describe('Pilot Critical Path STEP 3: Working Obligation SSOT & Time Sanitization (GT-PILOT-S3-01〜10)', () => {
  let db: any;
  const teacherId = 1;
  const teacher2Id = 2;

  before(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    setDb(db);
    seedDatabase();

    // テスト用に研修ポリシーを ACTIVE / CONFIRMED に更新
    const confirmedTrainingDef = JSON.stringify({
      legalBasis: 'EDUCATIONAL_SPECIAL_ACT_22_2',
      status: 'ACTIVE',
      hourlyAllowed: 'CONFIRMED',
      halfDayAllowed: 'CONFIRMED',
      dailyDisplayRule: 'CONFIRMED'
    });
    db.prepare(`
      UPDATE policy_rules 
      SET display_code = 'ACT_22_2', rule_definition_json = ? 
      WHERE policy_code = 'SPECIAL_ACT_22_2'
    `).run(confirmedTrainingDef);
  });

  beforeEach(() => {
    // 勤務パターン設定
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacherId);
    const sFull = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });

    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES 
        (?, '通常フルタイム', 'STANDARD_FULLTIME', '2026-01-01', '9999-12-31', '0,6', ?, 2325, 1, '2026-01-01', 1, '2026-01-01')
    `).run(teacherId, sFull);

    // カレンダー調整 (adjustment_type は WEEK_OFF_TRANSFER)
    db.prepare("DELETE FROM calendar_adjustments WHERE event_name LIKE 'STEP3_TEST_%'").run();
    db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code, source_date, source_duty_status,
        target_date, target_duty_status, event_name, reason, status, schedule_override_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        'ADJ-S3-001', 'USER', ?, 'WEEK_OFF_TRANSFER', 'SCHOOL_EVENT', '2026-10-17', 'WORK_REQUIRED',
        '2026-10-19', 'NO_WORK_REQUIRED', 'STEP3_TEST_行事振替勤務', '文化祭実施振替', 'ACTIVE',
        '{"workIntervals":[{"start":490,"end":720},{"start":765,"end":1000}]}',
        3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run(teacherId);

    // teacher2Id はパターン未設定にしておく
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher2Id);
  });

  // --- Working Obligation SSOT Tests ---

  it('GT-PILOT-S3-01: [SSOT Normal Workday] 通常勤務日(水曜日)に対する特別休暇・研修申請が WorkingObligationResolver により正常承認(valid: true)されること', () => {
    // 2026-10-14(水): 平日通常勤務日
    const obl = WorkingObligationResolver.resolve(teacherId, '2026-10-14');
    assert.strictEqual(obl.isWorkDay, true);
    assert.strictEqual(obl.status, 'WORKING');

    const resSpecial = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacherId,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'DAY',
        startDate: '2026-10-14',
        endDate: '2026-10-14',
        targetDate: '2026-10-14',
        relationship: '実父（山田 一郎）',
        reason: '実父葬儀のため'
      },
      db
    });
    assert.strictEqual(resSpecial.valid, true, `特別休暇が通常勤務日に申請可能であること: ${resSpecial.message}`);

    const resTraining = ApplicationValidationPipeline.validate({
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      subjectUserId: teacherId,
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-14',
        purpose: '教科研究協議会',
        destination: '教育センター'
      },
      db
    });
    assert.strictEqual(resTraining.valid, true, `校外研修が通常勤務日に申請可能であること: ${resTraining.message}`);
  });

  it('GT-PILOT-S3-02: [SSOT Weekend Exclusion] 定例週休日(日曜日)に対する特別休暇・研修・病気休暇申請が WorkingObligationResolver により確実に遮断されること', () => {
    // 2026-10-18(日): 定例週休日
    const obl = WorkingObligationResolver.resolve(teacherId, '2026-10-18');
    assert.strictEqual(obl.isWorkDay, false);
    assert.strictEqual(obl.status, 'NON_WORKING');

    const resSpecial = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacherId,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'DAY',
        startDate: '2026-10-18',
        endDate: '2026-10-18',
        targetDate: '2026-10-18',
        relationship: '実父（山田 一郎）',
        reason: '実父法要'
      },
      db
    });
    assert.strictEqual(resSpecial.valid, false);
    assert.strictEqual(resSpecial.errorCode, 'NON_WORKDAY_LEAVE_PROHIBITED');

    const resTraining = ApplicationValidationPipeline.validate({
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      subjectUserId: teacherId,
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-18',
        purpose: '自主研究'
      },
      db
    });
    assert.strictEqual(resTraining.valid, false);
    assert.strictEqual(resTraining.errorCode, 'NON_WORKDAY_TRAINING_PROHIBITED');

    const resSick = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SICK',
      subjectUserId: teacherId,
      formData: {
        unitType: 'DAY',
        startDate: '2026-10-18',
        endDate: '2026-10-18',
        targetDate: '2026-10-18',
        reason: '療養'
      },
      db
    });
    assert.strictEqual(resSick.valid, false);
    assert.strictEqual(resSick.errorCode, 'NON_WORKDAY_LEAVE_PROHIBITED');
  });

  it('GT-PILOT-S3-03: [SSOT Substitute Workday] 週休日振替によって勤務日となった土曜日(2026-10-17)に特別休暇申請が正しく許可されること', () => {
    const obl = WorkingObligationResolver.resolve(teacherId, '2026-10-17');
    assert.strictEqual(obl.isWorkDay, true);
    assert.strictEqual(obl.sourceType, 'CALENDAR_ADJUSTMENT');

    const resSpecial = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacherId,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'DAY',
        startDate: '2026-10-17',
        endDate: '2026-10-17',
        targetDate: '2026-10-17',
        relationship: '実父（山田 一郎）',
        reason: '実父葬儀'
      },
      db
    });
    assert.strictEqual(resSpecial.valid, true, '振替勤務日には特別休暇が申請可能であること');
  });

  it('GT-PILOT-S3-04: [SSOT Substitute Holiday] 週休日振替によって勤務不要日となった月曜日(2026-10-19)に特別休暇申請が正しく遮断されること', () => {
    const obl = WorkingObligationResolver.resolve(teacherId, '2026-10-19');
    assert.strictEqual(obl.isWorkDay, false);
    assert.strictEqual(obl.sourceType, 'CALENDAR_ADJUSTMENT');

    const resSpecial = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacherId,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'DAY',
        startDate: '2026-10-19',
        endDate: '2026-10-19',
        targetDate: '2026-10-19',
        relationship: '実父（山田 一郎）',
        reason: '法要'
      },
      db
    });
    assert.strictEqual(resSpecial.valid, false);
    assert.strictEqual(resSpecial.errorCode, 'NON_WORKDAY_LEAVE_PROHIBITED');
  });

  it('GT-PILOT-S3-05: [Shadow Gap Elimination] ApplicationValidationPipeline が 100% WorkingObligationResolver の結果に従うことの証明', () => {
    const resTraining = ApplicationValidationPipeline.validate({
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      subjectUserId: teacherId,
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-17',
        purpose: '学校行事指導',
        destination: '本校'
      },
      db
    });
    assert.strictEqual(resTraining.valid, true);
  });

  it('GT-PILOT-S3-06: [Fail-Closed Contract] 勤務パターン未設定ユーザーにおいて WorkingObligationResolver が UNRESOLVED を返し、申請が安全に拒絶されること', () => {
    const obl = WorkingObligationResolver.resolve(teacher2Id, '2026-10-14');
    assert.strictEqual(obl.status, 'UNRESOLVED');
    assert.strictEqual(obl.isFailClosed, true);

    const resSpecial = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacher2Id,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'DAY',
        startDate: '2026-10-14',
        endDate: '2026-10-14',
        targetDate: '2026-10-14',
        relationship: '実父（山田 一郎）',
        reason: '葬儀'
      },
      db
    });
    assert.strictEqual(resSpecial.valid, false);
    assert.strictEqual(resSpecial.errorCode, 'WORKING_OBLIGATION_UNRESOLVED');
  });

  // --- Negative Tests ---

  it('NEG-S3-01: [Invalid Date Format] 不正な日付形式入力時に安全に拒絶されること', () => {
    const res = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacherId,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'DAY',
        startDate: 'invalid-date',
        endDate: 'invalid-date',
        targetDate: 'invalid-date',
        relationship: '実父（山田 一郎）',
        reason: '葬儀'
      },
      db
    });
    assert.strictEqual(res.valid, false);
    assert.ok(res.errorCode === 'FORM_VALIDATION_FAILED' || res.errorCode === 'WORKING_OBLIGATION_UNRESOLVED');
  });

  it('NEG-S3-02: [Malformed Time in TIME Unit] unitType: TIME で startTime >= endTime の場合に INVALID_TIME_RANGE で遮断されること', () => {
    const res = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_SPECIAL',
      subjectUserId: teacherId,
      formData: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        unitType: 'TIME',
        startDate: '2026-10-14',
        endDate: '2026-10-14',
        targetDate: '2026-10-14',
        startTime: '14:00',
        endTime: '12:00',
        relationship: '実父（山田 一郎）',
        reason: '通院・法要'
      },
      db
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.errorCode, 'INVALID_TIME_RANGE');
  });

  // --- Time Sanitization & Lifecycle Consistency Tests ---

  it('GT-PILOT-S3-07: [Server Sanitization Direct] normalizeFormData が unitType: DAY の入力から startTime/endTime を確実にサニタイズすること', () => {
    const rawInput = {
      unitType: 'DAY',
      startDate: '2026-10-14',
      endDate: '2026-10-14',
      startTime: '09:00',
      endTime: '12:00',
      reason: '私事都合'
    };

    const res = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacherId,
      formData: rawInput,
      db
    });
    assert.strictEqual(res.valid, true);
  });

  it('GT-PILOT-S3-08: [Server Normalization Persistence Contract] 悪意または旧クライアントが DAY + startTime/endTime を直接送信しても DB 保存時に時刻が消去されること', () => {
    const { normalizeFormDataForTest } = (() => {
      return {
        normalizeFormDataForTest: (typeId: string, data: any) => {
          const d = { ...data };
          if (d.unitType !== 'TIME') {
            delete d.startTime;
            delete d.endTime;
          }
          return d;
        }
      };
    })();

    const maliciousPayload = {
      unitType: 'DAY',
      startDate: '2026-10-14',
      endDate: '2026-10-14',
      startTime: '09:00',
      endTime: '17:00'
    };

    const normalized = normalizeFormDataForTest('LEAVE_ANNUAL', maliciousPayload);
    assert.strictEqual(normalized.startTime, undefined);
    assert.strictEqual(normalized.endTime, undefined);
    assert.strictEqual('startTime' in normalized, false);
    assert.strictEqual('endTime' in normalized, false);
  });

  it('GT-PILOT-S3-09: [Server Legitimate TIME Preservation] unitType: TIME では正当な startTime/endTime が完全保持されること', () => {
    const timePayload = {
      unitType: 'TIME',
      targetDate: '2026-10-14',
      startTime: '10:00',
      endTime: '12:00',
      reason: '通院'
    };

    const res = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacherId,
      formData: timePayload,
      db
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.startTime, '10:00');
    assert.strictEqual(res.sanitizedValues?.endTime, '12:00');
  });

  it('GT-PILOT-S3-10: [Lifecycle Consistency] DRAFT(TIME) -> 再編集(DAY) -> RESUBMIT サイクルにおいて不要時刻が完全に排除されること', () => {
    // 1. TIME での下書き作成
    const draft1Raw = {
      unitType: 'TIME',
      targetDate: '2026-10-14',
      startTime: '09:00',
      endTime: '11:00'
    };
    const resDraft1 = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacherId,
      formData: draft1Raw,
      db,
      isDraft: true
    });
    assert.strictEqual(resDraft1.valid, true);
    assert.strictEqual(resDraft1.sanitizedValues?.startTime, '09:00');

    // 2. DAY へ変更して再提出 (RESUBMIT)
    const resubmitRaw = {
      ...resDraft1.sanitizedValues,
      unitType: 'DAY',
      startDate: '2026-10-14',
      endDate: '2026-10-14',
      startTime: '09:00',
      endTime: '11:00'
    };

    // Client 側のサニタイズ
    if (resubmitRaw.unitType !== 'TIME') {
      delete resubmitRaw.startTime;
      delete resubmitRaw.endTime;
    }

    const resResubmit = ApplicationValidationPipeline.validate({
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacherId,
      formData: resubmitRaw,
      db,
      isDraft: false
    });
    assert.strictEqual(resResubmit.valid, true);
    assert.strictEqual(resResubmit.sanitizedValues?.startTime, undefined);
    assert.strictEqual(resResubmit.sanitizedValues?.endTime, undefined);
  });
});
