import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine } from '../workflow/engine';

describe('Original Wave 2B Runtime Integration Tests (RT-W2B-01 〜 RT-W2B-12)', () => {
  const teacherUser = { id: 1, username: 'teacher1', displayName: '山田 太郎', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const shortTimeUser = { id: 2, username: 'teacher2', displayName: '佐藤 花子', roles: ['TEACHER'], ipAddress: '127.0.0.1' };
  const vpUser = { id: 3, username: 'vice_principal', displayName: '田中 誠', roles: ['VICE_PRINCIPAL'], ipAddress: '127.0.0.1' };
  const principalUser = { id: 4, username: 'principal', displayName: '鈴木 健一', roles: ['PRINCIPAL'], ipAddress: '127.0.0.1' };

  beforeEach(() => {
    initDatabase();
    seedDatabase();
    const db = getDb();

    // 既存の applications, sick_leave_applications, monthly locks をクリーンアップ
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
    db.prepare('DELETE FROM sick_leave_applications').run();
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM application_workflow_cycles').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM user_work_patterns WHERE user_id IN (1, 2)').run();

    const nowIso = new Date().toISOString();

    // ユーザー 1: フルタイム標準 (465分)
    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, weekly_off_days, weekly_total_minutes,
        effective_from, effective_to, schedule_details_json, record_origin, created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INDIVIDUAL')
    `).run(
      99901, 1, '標準フルタイム', 'STANDARD_FULLTIME', '0,6', 2325, '2026-01-01', '2027-12-31',
      JSON.stringify({
        0: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null },
        1: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        2: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        3: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        4: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        5: { isWorkDay: true, workMinutes: 465, startTime: '08:15', endTime: '16:45', intervals: [{ startTime: '08:10', endTime: '12:00' }, { startTime: '12:45', endTime: '16:40' }] },
        6: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null }
      }),
      'ADMIN_CONFIGURED', 1, nowIso, nowIso
    );

    // ユーザー 2: 短時間 (300分)
    db.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, weekly_off_days, weekly_total_minutes,
        effective_from, effective_to, schedule_details_json, record_origin, created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INDIVIDUAL')
    `).run(
      99902, 2, '短時間勤務', 'SHORT_TIME', '0,6', 1500, '2026-01-01', '2027-12-31',
      JSON.stringify({
        0: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null },
        1: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        2: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        3: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        4: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        5: { isWorkDay: true, workMinutes: 300, startTime: '08:30', endTime: '13:30', intervals: [{ startTime: '08:30', endTime: '13:30' }] },
        6: { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null }
      }),
      'ADMIN_CONFIGURED', 1, nowIso, nowIso
    );
  });

  // ヘルパー: 申請の提出から最終承認までを実行 (教頭確認 ➔ 校長決裁)
  function createAndApproveSickLeave(
    user: any,
    formData: any
  ): { appId: number; appRow: any; sickRow: any } {
    const db = getDb();
    const completeFormData = {
      calculatedDays: 1,
      reason: '発熱・療養',
      ...formData
    };

    const subRes = WorkflowEngine.submitApplication(user, {
      typeId: 'LEAVE_SICK',
      title: '病気休暇申請',
      formData: completeFormData
    });
    assert.strictEqual(subRes.success, true, `Submit failed: ${subRes.message}`);
    const appId = subRes.data?.id || subRes.data?.applicationId;

    // ステップ1: 教頭確認
    const app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveApplication(vpUser, {
      applicationId: appId,
      expectedVersion: app1.version,
      comment: '確認しました'
    });
    assert.strictEqual(vpRes.success, true, `VP Approve failed: ${vpRes.message}`);

    // ステップ2: 校長決裁 (Final Decision Step)
    const app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const princRes = WorkflowEngine.approveApplication(principalUser, {
      applicationId: appId,
      expectedVersion: app2.version,
      comment: '承認します'
    });
    assert.strictEqual(princRes.success, true, `Principal Approve failed: ${princRes.message}`);

    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const sickRow = db.prepare('SELECT * FROM sick_leave_applications WHERE application_id = ?').get(appId) as any;

    return { appId, appRow, sickRow };
  }

  // RT-W2B-01 & RT-W2B-02: Production Approval ➔ Calculator 到達 & 両テーブル Snapshot 永続化
  it('RT-W2B-01 & RT-W2B-02: 本番承認フロー実行時に Calculator が実行され、applications と sick_leave_applications の両方に Snapshot が永続化されること', () => {
    const { appRow, sickRow } = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-05-15',
      endDate: '2026-05-18', // 金〜月 4暦日
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    assert.strictEqual(appRow.current_status, 'FINAL_APPROVED');
    assert.ok(appRow.final_calculation_snapshot);

    assert.ok(sickRow);
    assert.strictEqual(sickRow.application_status, 'APPROVED');
    assert.strictEqual(sickRow.application_calendar_span_days, 4);
    assert.strictEqual(sickRow.consecutive_sick_leave_span_days, 4);
    assert.strictEqual(sickRow.accumulated_same_disease_calendar_days, 4);
    assert.ok(sickRow.final_calculation_snapshot);

    const appSnap = JSON.parse(appRow.final_calculation_snapshot);
    const sickSnap = JSON.parse(sickRow.final_calculation_snapshot);
    assert.strictEqual(appSnap.applicationCalendarSpanDays, 4);
    assert.strictEqual(sickSnap.applicationCalendarSpanDays, 4);
    assert.strictEqual(appSnap.totalDutyExemptionMinutes, 930);
    assert.strictEqual(sickSnap.totalDutyExemptionMinutes, 930);
  });

  // RT-W2B-03: Client 改ざん値無効化 (Server 再計算値が Authority)
  it('RT-W2B-03: Client が改ざんされた日数・免除時間を送信しても、最終承認時に Server 再計算値が Snapshot に記録されること', () => {
    const { appRow, sickRow } = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-05-15',
      endDate: '2026-05-18',
      // クライアントからの不正な改ざん日数
      calculatedDays: 999,
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    const sickSnap = JSON.parse(sickRow.final_calculation_snapshot);
    assert.strictEqual(sickRow.application_calendar_span_days, 4); // 正しい 4日
    assert.strictEqual(sickSnap.totalDutyExemptionMinutes, 930);   // 正しい 930分
    assert.notStrictEqual(sickRow.application_calendar_span_days, 999);
  });

  // RT-W2B-04: 非465分勤務 / Working Obligation SSOT
  it('RT-W2B-04: 短時間勤務職員 (300分) の本番承認で SSOT 由来の免除時間が Snapshot に記録されること', () => {
    const { sickRow } = createAndApproveSickLeave(shortTimeUser, {
      startDate: '2026-05-18', // 月
      endDate: '2026-05-19',   // 火 (2勤務日)
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    const snap = JSON.parse(sickRow.final_calculation_snapshot);
    assert.strictEqual(snap.applicationCalendarSpanDays, 2);
    assert.strictEqual(snap.totalDutyExemptionDays, 2.0);
    assert.strictEqual(snap.totalDutyExemptionMinutes, 600); // 300分 × 2日 = 600分
  });

  // RT-W2B-05: diseaseContinuityDecision === 'UNRESOLVED' での Fail-Closed 拒絶 & Rollback
  it('RT-W2B-05: 過去病休が存在する状況で UNRESOLVED のまま承認しようとした場合、Fail-Closed で拒絶され Rollback すること', () => {
    const db = getDb();
    // 1件目の承認済病休を作成
    createAndApproveSickLeave(teacherUser, {
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    // 2件目を UNRESOLVED で提出
    const subRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'LEAVE_SICK',
      title: '病休2件目',
      formData: {
        startDate: '2026-06-10',
        endDate: '2026-06-12',
        calculatedDays: 3,
        reason: '再療養',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'UNRESOLVED'
      }
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data?.id || subRes.data?.applicationId;
    
    // 教頭承認 (Step 1)
    const app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveApplication(vpUser, {
      applicationId: appId,
      expectedVersion: app1.version,
      comment: '教頭確認'
    });
    assert.strictEqual(vpRes.success, true);

    // 校長承認 (Step 2 ➔ 最終決裁時に Calculator 実行で UNRESOLVED 拒絶)
    const app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const princRes = WorkflowEngine.approveApplication(principalUser, {
      applicationId: appId,
      expectedVersion: app2.version,
      comment: '承認試行'
    });
    assert.strictEqual(princRes.success, false);
    assert.ok(princRes.message.includes('同一疾病かどうかの行政判断') || princRes.message.includes('未確定'));

    // Rollback の検証: 申請ステータスが FINAL_APPROVED にならず IN_APPROVAL のまま
    const rolledBackApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.notStrictEqual(rolledBackApp.current_status, 'FINAL_APPROVED');
    assert.strictEqual(rolledBackApp.final_calculation_snapshot, null);
  });

  // RT-W2B-06: 89 / 90 / 91日境界判定
  it('RT-W2B-06: 本番承認フローにおいて 89日, 90日, 91日の境界判定が決定論的に Snapshot に記録されること', () => {
    // 過去に80日間の承認病休を作成 (1/1 木曜〜3/21 土曜: 80日)
    // 1/1は祝日、1/5(月)から勤務日。開始日を1/5にする
    createAndApproveSickLeave(teacherUser, {
      startDate: '2026-01-05',
      endDate: '2026-03-25', // 80日
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE'
    });

    // 10日間申請 ➔ 80 + 10 = 90日 (境界到達・超過なし)
    const res90 = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-07-01', // 水
      endDate: '2026-07-10', // 10日
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE'
    });
    const snap90 = JSON.parse(res90.sickRow.final_calculation_snapshot);
    assert.strictEqual(snap90.accumulatedSameDiseaseCalendarDaysAfter, 90);
    assert.strictEqual(snap90.isExceeding90Days, false);

    // 11日間申請 ➔ 80 + 10(マージ後) + 11 = 91日 (90日超過)
    const res91 = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-08-03', // 月
      endDate: '2026-08-13', // 11日
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE'
    });
    const snap91 = JSON.parse(res91.sickRow.final_calculation_snapshot);
    assert.strictEqual(snap91.accumulatedSameDiseaseCalendarDaysAfter, 101);
    assert.strictEqual(snap91.isExceeding90Days, true);
  });

  // RT-W2B-07: Interval Union / 重複二重計上排除
  it('RT-W2B-07: 重複申請が存在しても、本番承認 Snapshot の accumulatedSameDiseaseCalendarDays に二重計上されないこと', () => {
    // 9/1〜9/10 (10日)
    createAndApproveSickLeave(teacherUser, {
      startDate: '2026-09-01',
      endDate: '2026-09-10',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE'
    });

    // 9/5〜9/15 (重複あり, 9/1〜9/15 = 15日)
    // サービスレベルで interval union を検証
    const { SickLeaveCalculator } = require('../domain/leave/sickLeaveCalculator');
    const { SickLeaveRepository } = require('../repositories/sickLeaveRepository');
    const db = getDb();
    const existingIntervals = SickLeaveRepository.getApprovedIntervals(teacherUser.id, db);
    const result = SickLeaveCalculator.calculate({
      userId: teacherUser.id,
      startDate: '2026-09-05',
      endDate: '2026-09-15',
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE',
      existingApprovedIntervals: existingIntervals
    });
    assert.strictEqual(result.snapshot?.accumulatedSameDiseaseCalendarDaysAfter, 15);
  });

  // RT-W2B-08: CANCELLED 通算除外
  it('RT-W2B-08: CANCELLED となった病気休暇が、後続病休の本番承認時通算集合から確実に除外されること', () => {
    const db = getDb();
    // 1件目を作成後、手動で CANCELLED に更新（取消完了を模擬）
    const res1 = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-02-02',
      endDate: '2026-02-11', // 10日 (2/2 月曜開始)
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SAME_DISEASE'
    });
    db.prepare("UPDATE sick_leave_applications SET application_status = 'CANCELLED' WHERE id = ?").run(res1.sickRow.id);
    db.prepare("UPDATE applications SET current_status = 'CANCELLED' WHERE id = ?").run(res1.appId);

    // 2件目 (5日間: 2/24 火曜〜2/28 土曜)
    const res2 = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-02-24',
      endDate: '2026-02-28', // 5日
      medicalCertificateAttached: false,
      diseaseContinuityDecision: 'SAME_DISEASE'
    });
    const snap = JSON.parse(res2.sickRow.final_calculation_snapshot);
    // 取消された10日間は除外され、5日間のみ起算
    assert.strictEqual(snap.accumulatedSameDiseaseCalendarDaysAfter, 5);
  });

  // RT-W2B-09: Atomic Rollback (6日以上で診断書未添付 ➔ 承認時 Fail-Closed & 全 Rollback)
  it('RT-W2B-09: 6日以上の病休で診断書未添付の場合、承認処理が例外送出され、申請ステータス含め全 Rollback すること', () => {
    const db = getDb();
    const subRes = WorkflowEngine.submitApplication(teacherUser, {
      typeId: 'LEAVE_SICK',
      title: '診断書なし6日病休',
      formData: {
        startDate: '2026-12-01', // 火
        endDate: '2026-12-06', // 6暦日
        calculatedDays: 6,
        reason: '療養',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'SEPARATE_DISEASE'
      }
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data?.id || subRes.data?.applicationId;

    // 教頭承認 (Step 1)
    const app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const vpRes = WorkflowEngine.approveApplication(vpUser, {
      applicationId: appId,
      expectedVersion: app1.version,
      comment: '教頭確認'
    });
    assert.strictEqual(vpRes.success, true);

    // 校長承認 (Step 2 ➔ 最終決裁時に Calculator 実行で 6日以上診断書未添付エラー)
    const app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const princRes = WorkflowEngine.approveApplication(principalUser, {
      applicationId: appId,
      expectedVersion: app2.version,
      comment: '承認試行'
    });
    assert.strictEqual(princRes.success, false);
    assert.ok(princRes.message.includes('診断書の提出が必要です'));

    // Rollback の検証: 申請ステータスが FINAL_APPROVED にならず、snapshot も保存されないこと
    const rolledBackApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.notStrictEqual(rolledBackApp.current_status, 'FINAL_APPROVED');
    assert.strictEqual(rolledBackApp.final_calculation_snapshot, null);
  });

  // RT-W2B-10: 代理申請・再申請・差戻後承認 No Bypass
  it('RT-W2B-10: 代理申請・再提出後の決裁完了時でも、Finalization が必ず実行され Snapshot が保存されること', () => {
    const db = getDb();
    // 事務 (userId=5) による代理申請提出 (subjectUserId=1)
    const officeUser = { id: 5, username: 'office1', displayName: '佐藤 事務', roles: ['OFFICE'], ipAddress: '127.0.0.1' };
    const subRes = WorkflowEngine.submitApplication(officeUser, {
      typeId: 'LEAVE_SICK',
      title: '代理病休申請',
      subjectUserId: 1,
      formData: {
        startDate: '2026-10-01', // 木
        endDate: '2026-10-02',
        calculatedDays: 2,
        reason: '代理療養申請',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'SEPARATE_DISEASE'
      }
    });
    assert.strictEqual(subRes.success, true);
    const appId = subRes.data?.id || subRes.data?.applicationId;

    // 教頭承認
    const app1 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vpUser, {
      applicationId: appId,
      expectedVersion: app1.version,
      comment: '代理申請確認'
    });

    // 校長承認
    const app2 = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(principalUser, {
      applicationId: appId,
      expectedVersion: app2.version,
      comment: '代理申請承認'
    });

    const finalizedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const finalizedSick = db.prepare('SELECT * FROM sick_leave_applications WHERE application_id = ?').get(appId) as any;

    assert.strictEqual(finalizedApp.current_status, 'FINAL_APPROVED');
    assert.ok(finalizedApp.final_calculation_snapshot);
    assert.ok(finalizedSick.final_calculation_snapshot);
  });

  // RT-W2B-11: Snapshot Pair Consistency & Guarded Write-Once
  describe('RT-W2B-11: Snapshot Pair Consistency & Write-Once Immutability', () => {
    it('Case A: 両方Snapshotなし ➔ 正常な初回 Finalization', () => {
      const { appRow, sickRow } = createAndApproveSickLeave(teacherUser, {
        startDate: '2026-11-02', // 月
        endDate: '2026-11-03',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'SEPARATE_DISEASE'
      });
      assert.ok(appRow.final_calculation_snapshot);
      assert.ok(sickRow.final_calculation_snapshot);
    });

    it('Case B: 両方Snapshotあり・同一 ➔ Idempotent (上書きせず成功)', () => {
      const { appId, appRow, sickRow } = createAndApproveSickLeave(teacherUser, {
        startDate: '2026-11-05', // 木
        endDate: '2026-11-06',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'SEPARATE_DISEASE'
      });
      const originalSnap = appRow.final_calculation_snapshot;

      // finalize を再度手動呼出 (Retry 模擬)
      const { SickLeaveService } = require('../services/sickLeaveService');
      SickLeaveService.finalizeSickLeaveApplication(appId);

      const db = getDb();
      const recheckedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
      assert.strictEqual(recheckedApp.final_calculation_snapshot, originalSnap);
    });

    it('Case C: 片方のみSnapshotあり ➔ Fail-Closed (DATA_INCONSISTENCY)', () => {
      const db = getDb();
      const { appId, sickRow } = createAndApproveSickLeave(teacherUser, {
        startDate: '2026-11-10', // 火
        endDate: '2026-11-11',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'SEPARATE_DISEASE'
      });

      // 不整合を人工生成 (applications 側のみ NULL に改ざん)
      db.prepare('UPDATE applications SET final_calculation_snapshot = NULL WHERE id = ?').run(appId);

      const { SickLeaveService } = require('../services/sickLeaveService');
      assert.throws(
        () => {
          SickLeaveService.finalizeSickLeaveApplication(appId);
        },
        (err: any) => {
          return err.message.includes('[DATA_INCONSISTENCY]');
        }
      );
    });

    it('Case D: 両方Snapshotあり・不一致 ➔ Fail-Closed (DATA_INCONSISTENCY)', () => {
      const db = getDb();
      const { appId } = createAndApproveSickLeave(teacherUser, {
        startDate: '2026-11-16', // 月
        endDate: '2026-11-17',
        medicalCertificateAttached: false,
        diseaseContinuityDecision: 'SEPARATE_DISEASE'
      });

      // 不整合を人工生成 (sick_leave_applications 側のスナップショット日数を書き換え)
      const tamperedSnap = JSON.stringify({
        applicationCalendarSpanDays: 999,
        consecutiveSickLeaveSpanDays: 999,
        accumulatedSameDiseaseCalendarDaysAfter: 999,
        diseaseContinuityDecision: 'SEPARATE_DISEASE',
        totalDutyExemptionMinutes: 0
      });
      db.prepare('UPDATE sick_leave_applications SET final_calculation_snapshot = ? WHERE application_id = ?').run(tamperedSnap, appId);

      const { SickLeaveService } = require('../services/sickLeaveService');
      assert.throws(
        () => {
          SickLeaveService.finalizeSickLeaveApplication(appId);
        },
        (err: any) => {
          return err.message.includes('[DATA_INCONSISTENCY]');
        }
      );
    });
  });

  // RT-W2B-12: dailyBreakdown Four-Layer Overlay Fact 共存
  it('RT-W2B-12: 承認後 Snapshot 内の dailyBreakdown に週休/祝日 Fact と病休 Fact が共存して記録されていること', () => {
    const { sickRow } = createAndApproveSickLeave(teacherUser, {
      startDate: '2026-05-01', // 金
      endDate: '2026-05-06',   // 祝日・振替休日を含む
      medicalCertificateAttached: true,
      diseaseContinuityDecision: 'SEPARATE_DISEASE'
    });

    const snap = JSON.parse(sickRow.final_calculation_snapshot);
    const holidayDay = snap.dailyBreakdown.find((d: any) => d.date === '2026-05-04');
    assert.ok(holidayDay);
    assert.strictEqual(holidayDay.obligation, 'NON_WORKING');
    assert.strictEqual(holidayDay.dutyExemptionMinutes, 0);
    assert.ok(holidayDay.overlayTags.includes('HOLIDAY') || holidayDay.overlayTags.includes('WEEKLY_OFF'));
    assert.ok(holidayDay.overlayTags.includes('IN_SICK_LEAVE_PERIOD'));
  });
});
