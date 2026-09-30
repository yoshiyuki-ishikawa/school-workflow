import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';
import { ApplicationValidationPipeline } from '../services/applicationValidationPipeline';
import { AnnualLeaveService } from '../services/annualLeaveService';
import { UserContext } from '../types';

describe('Server Business Trip Payload Contract & Lifecycle Golden Tests (GT-TD-S* & GT-TD-L*)', () => {
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
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  const officeUser: UserContext = {
    id: 5,
    username: 'office',
    displayName: '高橋 節子 (事務D)',
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
  };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    db = getDb();
    db.prepare('DELETE FROM leave_usages').run();
    db.prepare('DELETE FROM leave_entitlements').run();
    db.prepare('DELETE FROM travel_order_snapshots').run();
    db.prepare('DELETE FROM post_trip_report_snapshots').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM trip_event_members').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM trip_events').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();

    AnnualLeaveService.grantEntitlement({
      userId: teacher1.id,
      entitlementType: 'REGULAR_GRANT',
      fiscalYear: 2026,
      grantedDays: 20,
      grantDate: '2026-04-01',
      effectiveFrom: '2026-04-01',
      expiresAt: '2028-03-31',
      reason: '2026年度当初付与',
    });
  });

  // ==========================================
  // Layer 2: Server Contract Tests (GT-TD-S*)
  // ==========================================

  it('GT-TD-S01: BUSINESS_TRIP Valid Contract - targetDate を含まない正規 payload が Validation を通過し正常受理されること', () => {
    const validFormData = {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      startAt: '2026-09-10T08:10:00',
      endAt: '2026-09-10T16:40:00',
      purpose: '県教委主催 地区教育研究協議会 出席',
      destination: '山口県教育センター',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      unitType: 'DAY',
      isExpenseClaimed: false,
    };

    // 1. Pipeline Validation
    const validation = ApplicationValidationPipeline.validate({
      typeId: 'BUSINESS_TRIP',
      subjectUserId: teacher1.id,
      formData: validFormData,
      db,
    });
    assert.strictEqual(validation.valid, true);

    // 2. Submit Application
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '【出張】地区教育研究協議会',
      formData: validFormData,
    });

    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.statusCode, 200);
    const appId = submitRes.data.id;

    // 3. DB & Workflow Verification
    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appRow.type_id, 'BUSINESS_TRIP');
    assert.strictEqual(appRow.current_status, 'SUBMITTED');

    const cycleRow = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 1').get(appId) as any;
    assert.strictEqual(cycleRow.status, 'IN_PROGRESS');

    const steps = db.prepare('SELECT * FROM application_approval_steps WHERE application_id = ? ORDER BY step_order ASC').all(appId) as any[];
    assert.strictEqual(steps.length, 3);
    assert.strictEqual(steps[0].status, 'PENDING');
  });

  it('GT-TD-S02: BUSINESS_TRIP Invalid Contract (Fail-Closed) - 意図的に targetDate を含めた場合 HTTP 400 で遮断されること', () => {
    const invalidFormData = {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      targetDate: '2026-09-10', // ★ 不正な未定義フィールド
      startAt: '2026-09-10T08:10:00',
      endAt: '2026-09-10T16:40:00',
      purpose: '地区教育研究協議会',
      destination: '山口県教育センター',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      unitType: 'DAY',
    };

    const validation = ApplicationValidationPipeline.validate({
      typeId: 'BUSINESS_TRIP',
      subjectUserId: teacher1.id,
      formData: invalidFormData,
      db,
    });

    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.status, 400);
    assert.strictEqual(validation.errorCode, 'UNRECOGNIZED_FIELD_REJECTED');
    assert.ok(validation.message?.includes('targetDate'));

    // DB に何も作成されていないこと
    const appsCount = db.prepare('SELECT count(*) as count FROM applications').get() as any;
    assert.strictEqual(appsCount.count, 0);
  });

  it('GT-TD-S03: Leave Application Valid Contract - targetDate を持つ休暇系申請が正常に受理されること', () => {
    // 研修ポリシーをCONFIRMEDに更新（テスト前提）
    db.prepare(`
      UPDATE policy_rules
      SET display_code = 'CONFIRMED',
          rule_definition_json = json_set(rule_definition_json, '$.status', 'CONFIRMED')
      WHERE policy_code = 'SPECIAL_ACT_22_3'
    `).run();

    const leaveTypes = [
      {
        typeId: 'LEAVE_ANNUAL',
        formData: {
          unitType: 'DAY',
          startDate: '2026-09-15',
          endDate: '2026-09-15',
          targetDate: '2026-09-15',
          calculatedDays: 1,
          reason: '私用',
        },
      },
      {
        typeId: 'LEAVE_SPECIAL',
        formData: {
          reasonCode: 'SPECIAL_BEREAVEMENT',
          relationship: '実父',
          startDate: '2026-09-16', // 2026-09-16 (水曜 勤務義務日)
          endDate: '2026-09-18',
          targetDate: '2026-09-16',
          unitType: 'DAY',
          reason: '忌引のため',
        },
      },
      {
        typeId: 'LEAVE_SICK',
        formData: {
          startDate: '2026-09-25',
          endDate: '2026-09-25',
          targetDate: '2026-09-25',
          unitType: 'DAY',
          calculatedDays: 1,
          reason: '通院療養',
        },
      },
      {
        typeId: 'LEAVE_DUTY_EXEMPT',
        formData: {
          purpose: '学校保健委員会出席',
          startDate: '2026-09-28',
          endDate: '2026-09-28',
          targetDate: '2026-09-28',
          unitType: 'DAY',
        },
      },
      {
        typeId: 'TRAINING_SPECIAL_ACT_22_3',
        formData: {
          purpose: '教職長期研修',
          destination: '県教育センター',
          startDate: '2026-10-01',
          endDate: '2026-10-31',
          targetDate: '2026-10-01',
          unitType: 'DAY',
        },
      },
    ];

    for (const lt of leaveTypes) {
      const validation = ApplicationValidationPipeline.validate({
        typeId: lt.typeId,
        subjectUserId: teacher1.id,
        formData: lt.formData,
        db,
      });
      assert.strictEqual(validation.valid, true, `Validation failed for ${lt.typeId}: ${validation.message}`);
    }
  });

  // ==========================================
  // Layer 3: Lifecycle Integration Tests (GT-TD-L*)
  // ==========================================

  it('GT-TD-L01: BUSINESS_TRIP Draft Save, Restore & Submit Lifecycle - targetDate なしで下書き保存・復元・提出が完結すること', () => {
    const validDraftFormData = {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      startAt: '2026-09-10T08:10:00',
      endAt: '2026-09-10T16:40:00',
      purpose: '下書き出張',
      destination: '教育センター',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      unitType: 'DAY',
    };

    // 1. 下書き保存 (Save Draft)
    const draftRes = WorkflowEngine.saveDraft(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '【下書き】出張申請',
      formData: validDraftFormData,
    });
    assert.strictEqual(draftRes.success, true);
    const draftId = draftRes.data.id;

    // 2. 下書き詳細取得 (Restore)
    const detail = WorkflowEngine.getApplicationDetail(teacher1, draftId);
    assert.strictEqual(detail.success, true);
    assert.strictEqual(detail.data.application.current_status, 'DRAFT');

    const storedFormData = JSON.parse(detail.data.application.form_data);
    assert.strictEqual(storedFormData.targetDate, undefined);

    // 3. 編集提出 (Submit from Draft)
    const updatedFormData = {
      ...storedFormData,
      purpose: '下書きから編集して正式提出した出張',
    };
    delete updatedFormData.schemaVersion;
    delete updatedFormData.schemaSnapshot;

    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      id: draftId,
      expectedVersion: detail.data.application.version,
      typeId: 'BUSINESS_TRIP',
      title: '【出張】正式提出',
      formData: updatedFormData,
    });

    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.statusCode, 200);

    const finalizedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(draftId) as any;
    assert.strictEqual(finalizedApp.current_status, 'SUBMITTED');
    const finalFormData = JSON.parse(finalizedApp.form_data);
    assert.strictEqual(finalFormData.targetDate, undefined);
  });

  it('GT-TD-L02: BUSINESS_TRIP RETURNED & RESUBMIT - 差戻し後の通常再提出で targetDate が混入せず正常に再開されること', () => {
    const validFormData = {
      startDate: '2026-09-10',
      endDate: '2026-09-10',
      startAt: '2026-09-10T08:10:00',
      endAt: '2026-09-10T16:40:00',
      purpose: '初回出張申請',
      destination: '教育センター',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      unitType: 'DAY',
    };

    // 1. 提出
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '【出張】初回申請',
      formData: validFormData,
    });
    const appId = submitRes.data.id;

    // 2. 事務による差戻し (RETURNED: Step 1 OFFICE)
    let app = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
    const retRes = WorkflowEngine.returnApplication(officeUser, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '用務の詳細を追記してください',
    });
    assert.strictEqual(retRes.success, true);

    // 3. 申請者による修正・再提出 (RESUBMIT)
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'RETURNED');

    const resubmitFormData = {
      ...validFormData,
      purpose: '修正後出張用務詳細：第1回研修協議会出席のため',
    };

    const resubmitRes = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '【出張】再提出申請',
      formData: resubmitFormData,
    });

    assert.strictEqual(resubmitRes.success, true);
    assert.strictEqual(resubmitRes.data.approvalCycle, 2);

    const cycle2 = db.prepare('SELECT * FROM application_workflow_cycles WHERE application_id = ? AND approval_cycle = 2').get(appId) as any;
    assert.strictEqual(cycle2.status, 'IN_PROGRESS');

    const appAfter = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appAfter.current_status, 'SUBMITTED');
    const parsedData = JSON.parse(appAfter.form_data);
    assert.strictEqual(parsedData.targetDate, undefined);
  });
});
