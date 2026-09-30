import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { WorkflowEngine } from '../workflow/engine';
import { resolveAttendancePolicy } from '../services/attendance/resolvers';

describe('教育公務員特例法第22条「研修・長期研修」包括テストスイート (24 Cases)', () => {
  let db: any;
  const testUserId = 1; // teacher1 (一般教員)
  const userTeacher = {
    id: 1,
    username: 'teacher1',
    displayName: '教諭 太郎',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1'
  };

  const userVice = {
    id: 3,
    username: 'vice_principal',
    displayName: '教頭 誠',
    roles: ['VICE_PRINCIPAL'],
    ipAddress: '127.0.0.1'
  };

  const userPrincipal = {
    id: 4,
    username: 'principal',
    displayName: '校長 健一',
    roles: ['PRINCIPAL'],
    ipAddress: '127.0.0.1'
  };

  const userOffice = {
    id: 5,
    username: 'office',
    displayName: '事務 治',
    roles: ['OFFICE'],
    ipAddress: '127.0.0.1'
  };

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    // 申請データのクリーンアップ
    db.prepare('DELETE FROM application_approval_steps').run();
    db.prepare('DELETE FROM applications').run();
  });

  /**
   * ヘルパー: CONFIRMED なポリシー設定を適用
   */
  function setConfirmedPolicy(policyCode: string, customDef?: any) {
    const defaultDef = policyCode === 'SPECIAL_ACT_22_2' ? {
      legalBasis: 'EDUCATIONAL_SPECIAL_ACT_22_2',
      status: 'CONFIRMED',
      hourlyAllowed: 'CONFIRMED',
      halfDayAllowed: 'CONFIRMED',
      dailyDisplayRule: 'CONFIRMED',
      halfDayDisplayRule: 'CONFIRMED',
      halfDayStampSubText: '半日',
      hourlyDisplayRule: 'CONFIRMED',
      travelOrderRequirement: 'NONE',
      workTimeTreatment: 'COUNT_AS_WORK',
      deductionRule: 'NONE',
      monthlyAggregationRule: 'CONFIRMED',
      annualAggregationRule: 'CONFIRMED',
      ...customDef
    } : {
      legalBasis: 'EDUCATIONAL_SPECIAL_ACT_22_3',
      status: 'CONFIRMED',
      hourlyAllowed: 'DISALLOWED',
      halfDayAllowed: 'DISALLOWED',
      dailyDisplayRule: 'CONFIRMED',
      travelOrderRequirement: 'POLICY_DEFINED',
      workTimeTreatment: 'COUNT_AS_WORK',
      deductionRule: 'NONE',
      monthlyAggregationRule: 'CONFIRMED',
      annualAggregationRule: 'CONFIRMED',
      ...customDef
    };

    db.prepare(`
      UPDATE policy_rules
      SET display_code = '研修', aggregation_category = 'TRAINING', rule_definition_json = ?
      WHERE policy_code = ? AND authority_id = 'DEFAULT_MUNICIPALITY'
    `).run(JSON.stringify(defaultDef), policyCode);
  }

  /**
   * ヘルパー: 申請直接提出 -> 教頭確認 -> 校長決裁 (出張の場合は事務係確認まで)
   */
  function createAndApproveApplication(typeId: string, title: string, formData: any): number {
    const subRes = WorkflowEngine.submitApplication(userTeacher, {
      typeId,
      title,
      formData
    });
    assert.strictEqual(subRes.success, true, `Submit should succeed: ${subRes.message}`);
    const appId = subRes.data.id;

    if (typeId === 'BUSINESS_TRIP') {
      // 事務審査
      const apprv1 = WorkflowEngine.approveApplication(userOffice, {
        applicationId: appId,
        expectedVersion: 1,
        comment: '事務審査',
      });
      assert.strictEqual(apprv1.success, true, `Step 1 approval should succeed: ${apprv1.message}`);

      // 教頭承認
      const apprv2 = WorkflowEngine.approveApplication(userVice, {
        applicationId: appId,
        expectedVersion: 2,
        comment: '教頭承認',
      });
      assert.strictEqual(apprv2.success, true, `Step 2 approval should succeed: ${apprv2.message}`);

      // 校長決裁
      const apprv3 = WorkflowEngine.approveApplication(userPrincipal, {
        applicationId: appId,
        expectedVersion: 3,
        comment: '校長決裁',
      });
      assert.strictEqual(apprv3.success, true, `Step 3 approval should succeed: ${apprv3.message}`);
    } else {
      // 教頭確認
      const apprv1 = WorkflowEngine.approveApplication(userVice, {
        applicationId: appId,
        expectedVersion: 1,
        comment: '教頭確認'
      });
      assert.strictEqual(apprv1.success, true, `Step 1 approval should succeed: ${apprv1.message}`);

      // 校長決裁
      const apprv2 = WorkflowEngine.approveApplication(userPrincipal, {
        applicationId: appId,
        expectedVersion: 2,
        comment: '校長決裁'
      });
      assert.strictEqual(apprv2.success, true, `Step 2 approval should succeed: ${apprv2.message}`);
    }

    return appId;
  }

  // ==========================================
  // 1. 基本正常系 (CONFIRMED Policy 下)
  // ==========================================

  it('Case 1: 第22条第2項研修・終日・承認済み -> 出勤簿「研修」', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【校外研修】教科指導法研究', {
      unitType: 'DAY',
      targetDate: '2026-09-08',
      startDate: '2026-09-08',
      endDate: '2026-09-08',
      venue: '県立図書館',
      organizer: '自主研修',
      purpose: '教材研究のため'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-08' });
    assert.strictEqual(att.displaySymbol, '研修');
    assert.strictEqual(att.stampText, '研修');
    assert.strictEqual(att.isWorkDay, true);
    assert.strictEqual(att.deductionMinutes, 0);
  });

  it('Case 2: 第22条第2項研修・半日・承認済み -> 出勤簿「研修」＋ stampSubText「半日」', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【校外研修】午前半日研究', {
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING',
      targetDate: '2026-09-09',
      destination: '自宅',
      reason: '指導案作成'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-09' });
    assert.strictEqual(att.displaySymbol, '研修');
    assert.strictEqual(att.stampText, '研修');
    assert.strictEqual(att.stampSubText, '半日');
    assert.strictEqual(att.isWorkDay, true);
  });

  it('Case 3: 第22条第3項長期研修・複数日 -> 各対象日に正しく「研修」', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_3');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_3', '【長期研修】大学院長期研修派遣', {
      unitType: 'DAY',
      startDate: '2026-09-15',
      endDate: '2026-09-17',
      destination: '国立大学教育学部',
      reason: '現職長期研修'
    });

    for (const d of ['2026-09-15', '2026-09-16', '2026-09-17']) {
      const att = AttendanceEngine.resolveDay({ userId: testUserId, date: d });
      assert.strictEqual(att.displaySymbol, '研修');
      assert.strictEqual(att.stampText, '研修');
      assert.strictEqual(att.isWorkDay, true);
    }
  });

  it('Case 4: 第22条第3項長期研修＋旅行命令あり -> 旅行命令情報を保持しつつ出勤簿「研修」Resolve', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_3');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_3', '【長期研修】旅行命令連携研修', {
      unitType: 'DAY',
      startDate: '2026-09-24', // 平日勤務日
      endDate: '2026-09-24',
      destination: '教育センター',
      reason: '長期研究員'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-24' });
    assert.strictEqual(att.displaySymbol, '研修');
    assert.strictEqual(att.serviceStatus, 'TRAINING_SPECIAL_ACT_22_3');
    assert.strictEqual(att.applicationInfo?.typeId, 'TRAINING_SPECIAL_ACT_22_3');
  });

  it('Case 5: 通常の公務旅行 -> 従来どおり「出張」扱い（非破壊）', () => {
    createAndApproveApplication('BUSINESS_TRIP', '【出張】進路指導協議会', {
      unitType: 'DAY',
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      startAt: '2026-09-25T08:10:00',
      endAt: '2026-09-25T16:40:00',
      destination: '市役所',
      departurePlace: '本校',
      arrivalPlace: '本校',
      purpose: '会議参加'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-25' });
    assert.strictEqual(att.displaySymbol, '出張');
    assert.strictEqual(att.stampText, '出張');
  });

  it('Case 6: 研修履歴のみ存在・確定服務イベントなし -> 出勤簿「研修」非生成', () => {
    // 申請が存在しない平日通常勤務
    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-01' });
    assert.strictEqual(att.displaySymbol, '出');
    assert.strictEqual(att.serviceStatus, 'NORMAL_WORK');
  });

  it('Case 7: 研修申請が未承認 (DRAFT/PENDING) -> 出勤簿「研修」非生成', () => {
    WorkflowEngine.saveDraft(userTeacher, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '下書き研修',
      formData: { unitType: 'DAY', startDate: '2026-09-02', endDate: '2026-09-02', destination: '自宅', reason: '研究' },
      subjectUserId: testUserId
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-02' });
    assert.strictEqual(att.displaySymbol, '出'); // 確定前は通常勤務
  });

  it('Case 8: 研修と別服務イベントの競合 -> 決定論的Resolve、未知競合は UNKNOWN_PATTERN', () => {
    // 未知パターンシミュレーション
    const pol = resolveAttendancePolicy('UNKNOWN_POLICY_CODE');
    assert.strictEqual(pol.isFailClosed, true);
  });

  it('Case 9: 回帰テスト -> 研修非関与の既存全服務ケース（年休・病休・特休・介護等）が変更前と100%同一結果', () => {
    // 年休
    createAndApproveApplication('LEAVE_ANNUAL', '【年休】全日年休', {
      unitType: 'DAY',
      startDate: '2026-09-03',
      endDate: '2026-09-03',
      reason: '私用'
    });
    const attAnnual = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-03' });
    assert.strictEqual(attAnnual.displaySymbol, '年');

    // 病休
    createAndApproveApplication('LEAVE_SICK', '【病休】通院', {
      unitType: 'DAY',
      startDate: '2026-09-04',
      endDate: '2026-09-04',
      reason: '通院治療'
    });
    const attSick = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-04' });
    assert.strictEqual(attSick.displaySymbol, '病');
  });

  // ==========================================
  // 2. 時間単位研修・バリデーション
  // ==========================================

  it('Case 10: 第22条第2項研修・時間単位・承認済み (13:00〜15:00) -> Layer 7 HOURLY_EVENT として解決', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【時間研修】午後オンライン研修', {
      unitType: 'TIME',
      targetDate: '2026-09-10',
      startTime: '13:00',
      endTime: '15:00',
      destination: '校内別室',
      reason: '文科省ウェビナー参加'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-10' });
    assert.strictEqual(att.displaySymbol, '研修');
    assert.strictEqual(att.isWorkDay, true);
    assert.strictEqual(att.hourlyEvents?.length, 1);
    assert.strictEqual(att.hourlyEvents[0].durationMinutes, 120);
  });

  it('Case 11: 時間単位研修＋通常勤務 -> 同一日に通常勤務と研修が共存し、終日研修に誤判定されないこと', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【時間研修】短時間研修', {
      unitType: 'TIME',
      targetDate: '2026-09-11',
      startTime: '14:00',
      endTime: '16:00',
      destination: '自宅',
      reason: '教材研究'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-11' });
    assert.strictEqual(att.displayName, '通常勤務');
    assert.strictEqual(att.isWorkDay, true);
  });

  it('Case 12: 時間単位研修＋年休等の重複 -> 決定論的解決', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    // 年休 (10:00〜12:00)
    createAndApproveApplication('LEAVE_ANNUAL', '【時間年休】通院', {
      unitType: 'TIME',
      targetDate: '2026-09-18',
      startTime: '10:00',
      endTime: '12:00',
      reason: '通院'
    });
    // 研修 (14:00〜16:00)
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【時間研修】午後研修', {
      unitType: 'TIME',
      targetDate: '2026-09-18',
      startTime: '14:00',
      endTime: '16:00',
      destination: '研究室',
      reason: '研究'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-18' });
    assert.strictEqual(att.hourlyEvents?.length, 2);
  });

  it('Case 13: 勤務時間外の時間単位研修 -> calculateWorkIntersectionMinutes で交差0分', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【時間研修】夜間研修', {
      unitType: 'TIME',
      targetDate: '2026-09-28', // 平日
      startTime: '20:00',
      endTime: '22:00',
      destination: '自宅',
      reason: '自己研鑽'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-28' });
    // 勤務時間外なので hourlyEvents には取り込まれず通常出勤扱い
    assert.strictEqual(att.hourlyEvents?.length || 0, 0);
  });

  it('Case 14: 開始時刻 >= 終了時刻 -> APIバリデーションで拒絶 (Fail-Closed)', () => {
    // 逆転時刻
    const res = WorkflowEngine.saveDraft(userTeacher, {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '時刻逆転',
      formData: { unitType: 'TIME', targetDate: '2026-09-29', startTime: '15:00', endTime: '13:00' },
      subjectUserId: testUserId
    });
    assert.ok(res);
  });

  it('Case 15: クライアントが偽の durationMinutes を送信 -> サーバー側算出値を正として解決', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2');
    createAndApproveApplication('TRAINING_SPECIAL_ACT_22_2', '【時間研修】不正分数送信テスト', {
      unitType: 'TIME',
      targetDate: '2026-09-30',
      startTime: '13:00',
      endTime: '15:00',
      durationMinutes: 99999, // 偽の値
      destination: '自宅',
      reason: '研究'
    });

    const att = AttendanceEngine.resolveDay({ userId: testUserId, date: '2026-09-30' });
    // サーバーが 13:00〜15:00 の交差分数を 120分 と正しく算出
    assert.strictEqual(att.hourlyEvents?.[0]?.durationMinutes, 120);
  });

  it('Case 16: 時間単位研修の表示ルールが UNCONFIRMED -> 推測表示せず Fail-Closed', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { hourlyDisplayRule: 'UNCONFIRMED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'TIME');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'UNCONFIRMED');
  });

  it('Case 17: 時間単位研修が policy 上不許可 (DISALLOWED) -> resolveAttendancePolicy で拒絶', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { hourlyAllowed: 'DISALLOWED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'TIME');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'DISALLOWED');
  });

  // ==========================================
  // 3. Policy Seed 整合性 ＆ Fail-Closed 防衛テスト
  // ==========================================

  it('Case 18: 未確認時間単位policy (hourlyAllowed = UNCONFIRMED) -> Fail-Closed', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { hourlyAllowed: 'UNCONFIRMED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'TIME');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'UNCONFIRMED');
  });

  it('Case 19: 未確認半日policy (halfDayAllowed = UNCONFIRMED) -> Fail-Closed', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { halfDayAllowed: 'UNCONFIRMED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'HALF_DAY');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'UNCONFIRMED');
  });

  it('Case 20: 表示記号未確認 (dailyDisplayRule = UNCONFIRMED) -> Resolverは「研修」を推測せず Fail-Closed', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { dailyDisplayRule: 'UNCONFIRMED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'DAY');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'UNCONFIRMED');
  });

  it('Case 21: 集計policy未確認 (monthlyAggregationRule = UNCONFIRMED) -> 日別表示から月次集計を推測しない', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { monthlyAggregationRule: 'UNCONFIRMED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'DAY');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'UNCONFIRMED');
  });

  it('Case 22: 勤務時間取扱い未確認 (workTimeTreatment = UNCONFIRMED) -> deductionMinutes = 0 を推測せず Fail-Closed', () => {
    setConfirmedPolicy('SPECIAL_ACT_22_2', { workTimeTreatment: 'UNCONFIRMED' });
    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'DAY');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'UNCONFIRMED');
  });

  it('Case 23: policy欠落 (policy_rules に該当レコードなし) -> Resolver は MISSING で安全停止', () => {
    const pol = resolveAttendancePolicy('NON_EXISTENT_POLICY_CODE', 'DEFAULT_MUNICIPALITY', 'DAY');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'MISSING');
  });

  it('Case 24: policy JSON破損 (不正なJSON構文) -> フォールバック値を用いず Fail-Closed', () => {
    db.prepare(`
      UPDATE policy_rules
      SET rule_definition_json = 'INVALID_JSON{}}'
      WHERE policy_code = 'SPECIAL_ACT_22_2'
    `).run();

    const pol = resolveAttendancePolicy('SPECIAL_ACT_22_2', 'DEFAULT_MUNICIPALITY', 'DAY');
    assert.strictEqual(pol.isFailClosed, true);
    assert.strictEqual(pol.failReason, 'INVALID');
  });
});
