import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { LeaveCalculationService } from '../services/leave/leaveCalculationService';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { UserContext } from '../types';

describe('Annual Leave Weekend Exclusion & Server-Authoritative Normalization (GT-BUG-AL)', () => {
  let db: any;

  const teacher1: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const principal: UserContext = {
    id: 4,
    username: 'principal',
    displayName: '佐藤 健一 (校長C)',
    roles: ['PRINCIPAL'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    setDb(db);
    seedDatabase();

    // 勤務パターン登録 (Mon-Fri 8:15-16:45, Sat-Sun off)
    db.prepare('DELETE FROM user_work_patterns WHERE user_id = ?').run(teacher1.id);
    const s465 = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
      "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
    });
    db.prepare(`
      INSERT INTO user_work_patterns (
        user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, schedule_source, created_by_user_id, created_at, updated_by_user_id, updated_at
      ) VALUES (?, '通常フルタイム', 'STANDARD_FULLTIME', '2025-01-01', '9999-12-31', '0,6', ?, 2325, 'INDIVIDUAL', 1, '2026-01-01', 1, '2026-01-01')
    `).run(teacher1.id, s465);

    // 年休付与 (2026年度 20日)
    db.prepare('DELETE FROM leave_usages WHERE user_id = ?').run(teacher1.id);
    db.prepare('DELETE FROM leave_entitlements WHERE user_id = ?').run(teacher1.id);
    AnnualLeaveService.grantEntitlement({
      userId: teacher1.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      expiresAt: '2027-12-31',
      reason: '2026年定期付与'
    });
  });

  /**
   * GT-BUG-AL-01: 金曜日〜月曜日 (Calendar Span = 4, Charged Days = 2)
   */
  it('GT-BUG-AL-01: 金〜月（4暦日）申請で、LeaveCalculationService が2日消費・2日除外と算定すること', () => {
    // 2026-09-04 (Fri) 〜 2026-09-07 (Mon)
    const result = LeaveCalculationService.calculate({
      subjectUserId: teacher1.id,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-09-04',
      endDate: '2026-09-07',
      unitType: 'DAY',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.totalChargedDays, 2);
    assert.equal(result.chargeableDaysCount, 2);
    assert.equal(result.skippedNonWorkingDaysCount, 2);
    assert.equal(result.entitlementDeduction?.deductionHalfUnits, 4); // 2 full days = 4 half units
  });

  /**
   * GT-BUG-AL-02: 月曜日〜金曜日 (Calendar Span = 5, Charged Days = 5)
   */
  it('GT-BUG-AL-02: 月〜金（5暦日）申請で、全日が勤務日の場合は5日消費と算定すること', () => {
    // 2026-09-07 (Mon) 〜 2026-09-11 (Fri)
    const result = LeaveCalculationService.calculate({
      subjectUserId: teacher1.id,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-09-07',
      endDate: '2026-09-11',
      unitType: 'DAY',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.totalChargedDays, 5);
    assert.equal(result.chargeableDaysCount, 5);
    assert.equal(result.skippedNonWorkingDaysCount, 0);
    assert.equal(result.entitlementDeduction?.deductionHalfUnits, 10);
  });

  /**
   * GT-BUG-AL-03: 週休日を含む複数日申請で Charged Days が WorkingObligationResolver 結果と完全一致すること
   */
  it('GT-BUG-AL-03: 各日の勤務義務状態と PerDayResults が完全整合すること', () => {
    const dates = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'];
    const result = LeaveCalculationService.calculate({
      subjectUserId: teacher1.id,
      typeId: 'LEAVE_ANNUAL',
      startDate: '2026-09-04',
      endDate: '2026-09-07',
      unitType: 'DAY',
    });

    assert.equal(result.isValid, true);
    assert.equal(result.perDayResults?.length, 4);

    for (let i = 0; i < dates.length; i++) {
      const dt = dates[i];
      const obl = WorkingObligationResolver.resolve(teacher1.id, dt);
      const dayRes = result.perDayResults![i];

      assert.equal(dayRes.targetDate, dt);
      if (obl.status === 'NON_WORKING') {
        assert.equal(dayRes.obligationStatus, 'NON_WORKING');
        assert.equal(dayRes.chargedDays, 0);
      } else {
        assert.equal(dayRes.obligationStatus, 'WORKING');
        assert.equal(dayRes.chargedDays, 1);
      }
    }
  });

  /**
   * GT-BUG-AL-04: クライアントが不正な calculatedDays を送信しても、Server 正規化によって正しい消費日数が保存されること
   */
  it('GT-BUG-AL-04: WorkflowEngine.submitApplication において Server 正規化が機能し、不正値が排除されること', () => {
    const startDate = '2026-09-04';
    const endDate = '2026-09-07';
    const calc = LeaveCalculationService.calculate({
      subjectUserId: teacher1.id,
      typeId: 'LEAVE_ANNUAL',
      startDate,
      endDate,
      unitType: 'DAY',
    });

    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇（金〜月）',
      formData: {
        unitType: 'FULL_DAY',
        startDate,
        endDate,
        calculatedDays: calc.totalChargedDays,
        reason: '私事都合'
      }
    });

    assert.equal(submitRes.success, true);
    const appId = submitRes.data.id;

    const savedApp = db.prepare('SELECT form_data FROM applications WHERE id = ?').get(appId) as any;
    const parsedFormData = JSON.parse(savedApp.form_data);

    assert.equal(parsedFormData.calculatedDays, 2);
  });

  /**
   * GT-BUG-AL-05: 承認決裁時の年休残日数控除が2日分（930分）であること
   */
  it('GT-BUG-AL-05: 承認決裁による残高控除が正常に2日分（930分）であること', () => {
    const initialBal = AnnualLeaveService.getLeaveBalance(teacher1.id, '2026-09-04');

    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年次有給休暇（金〜月2日消費）',
      formData: {
        unitType: 'FULL_DAY',
        startDate: '2026-09-04',
        endDate: '2026-09-07',
        calculatedDays: 2,
        reason: '私事都合'
      }
    });
    assert.equal(submitRes.success, true);
    const appId = submitRes.data.id;

    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    // 教頭承認
    const vpRes = WorkflowEngine.approveApplication(vicePrincipal, { applicationId: appId, expectedVersion: app.version });
    assert.equal(vpRes.success, true);

    app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    // 校長決裁
    const pRes = WorkflowEngine.approveApplication(principal, { applicationId: appId, expectedVersion: app.version });
    assert.equal(pRes.success, true);

    const finalBal = AnnualLeaveService.getLeaveBalance(teacher1.id, '2026-09-04');
    assert.equal(initialBal.totalRemainingMinutes - finalBal.totalRemainingMinutes, 930);
  });
});
