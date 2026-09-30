import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { WorkflowEngine } from '../workflow/engine';
import { FormSchemaRegistry } from '../services/schema/formSchemaRegistry';
import { FormValidationEngine } from '../services/schema/formValidationEngine';
import { ApplicationValidationPipeline } from '../services/applicationValidationPipeline';

describe('Wave 7 / GAP-09: Class Coverage & Substitute Teacher Structured Golden Tests', () => {
  let db: any;

  const teacher1 = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const teacher2 = {
    id: 2,
    username: 'teacher2',
    displayName: '佐藤 花子 (教員B)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const vicePrincipal = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const principal = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 健一 (校長C)',
    roles: ['PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  // GT-W7-01: 3-State 正常系 (NOT_REQUIRED) - coverageItems は空配列に正規化
  it('GT-W7-01: coverageStatus=NOT_REQUIRED の正常系バリデーションと正規化', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'NOT_REQUIRED',
        notRequiredReason: '担当授業のない放課後のため',
      },
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.coverageStatus, 'NOT_REQUIRED');
    assert.strictEqual(res.sanitizedValues?.notRequiredReason, '担当授業のない放課後のため');
    assert.deepStrictEqual(res.sanitizedValues?.coverageItems, []);
  });

  // GT-W7-02: 3-State 正常系 (REQUIRED) - 複数構造化明細の入力とスナップショット生成
  it('GT-W7-02: coverageStatus=REQUIRED の正常系バリデーションと教員情報Snapshot生成', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            targetDate: '2026-10-15',
            period: '2',
            coverageType: 'SUBSTITUTE_LESSON',
            substituteUserId: 2,
            subjectName: '算数',
            contentNotes: '教科書P.45〜46の練習問題を演習',
          },
          {
            targetDate: '2026-10-15',
            period: '3',
            coverageType: 'SELF_STUDY_SUPERVISION',
            substituteUserId: 3,
            subjectName: '理科',
            contentNotes: 'プリント課題No.3を配布して自習監督',
          },
        ],
      },
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.coverageStatus, 'REQUIRED');
    assert.strictEqual(res.sanitizedValues?.coverageItems?.length, 2);
    // Write-Time Snapshot が DB から自動解決・固定されていること
    assert.strictEqual(res.sanitizedValues?.coverageItems[0].substituteUserNameSnapshot, '佐藤 花子 (教員B)');
    assert.strictEqual(res.sanitizedValues?.coverageItems[1].substituteUserNameSnapshot, '田中 誠 (教頭B)');
  });

  // GT-W7-03: 3-State 正常系 (UNSURE) - 提出時は保留可能
  it('GT-W7-03: coverageStatus=UNSURE での申請提出（保留状態）の許容', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'UNSURE',
      },
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.coverageStatus, 'UNSURE');
  });

  // GT-W7-04: REQUIRED 時の coverageItems 空拒絶 (Fail-Closed)
  it('GT-W7-04: coverageStatus=REQUIRED で coverageItems が空配列の場合は 422 拒絶される', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'REQUIRED',
        coverageItems: [],
      },
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.issues?.some((i) => i.code === 'COVERAGE_ITEMS_REQUIRED'), true);
  });

  // GT-W7-05: 柔軟な校時 (period) 表現の許容
  it('GT-W7-05: 校時（period）に "7", "朝学習", "放課後", "短縮4", "その他" などの柔軟な文字列が受容される', () => {
    const periods = ['1', '6', '7', '朝学習', '放課後', '短縮4', '清掃・帰りの会'];
    for (const p of periods) {
      const res = FormValidationEngine.validate({
        typeId: 'LEAVE_ANNUAL',
        rawValues: {
          unitType: 'DAY',
          targetDate: '2026-10-15',
          startDate: '2026-10-15',
          endDate: '2026-10-15',
          calculatedDays: 1,
          coverageStatus: 'REQUIRED',
          coverageItems: [
            {
              targetDate: '2026-10-15',
              period: p,
              coverageType: 'OTHER',
              contentNotes: '業務引継ぎ',
            },
          ],
        },
      });

      assert.strictEqual(res.valid, true, `Period "${p}" should be valid`);
      assert.strictEqual(res.sanitizedValues?.coverageItems[0].period, p);
    }
  });

  // GT-W7-06: 無効な措置種別 (coverageType) の遮断 (Fail-Closed)
  it('GT-W7-06: 定義外の不正な coverageType は 422 で遮断される', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            targetDate: '2026-10-15',
            period: '1',
            coverageType: 'INVALID_TYPE_XYZ',
          },
        ],
      },
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.issues?.some((i) => i.code === 'INVALID_COVERAGE_TYPE'), true);
  });

  // GT-W7-07: 無効または非アクティブな substituteUserId の遮断
  it('GT-W7-07: 存在しない教員IDを指定した場合は 422 で遮断される', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            targetDate: '2026-10-15',
            period: '1',
            coverageType: 'SUBSTITUTE_LESSON',
            substituteUserId: 99999, // 存在しないID
          },
        ],
      },
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.issues?.some((i) => i.code === 'INACTIVE_OR_NONEXISTENT_USER'), true);
  });

  // GT-W7-08: 下書き保存時は coverageStatus や coverageItems の必須チェックが緩和される
  it('GT-W7-08: 下書き保存時 (isDraft: true) は未入力でもバリデーションを通過する', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        coverageStatus: 'REQUIRED',
        coverageItems: [], // 空配列でも下書きならOK
      },
      isDraft: true,
    });

    assert.strictEqual(res.valid, true);
  });

  // GT-W7-09: 提出・中間承認ライフサイクル (UNSURE 状態での中間承認通過)
  it('GT-W7-09: coverageStatus=UNSURE の申請は、中間承認（教頭一次確認）を正常に通過できる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (引継ぎ確認中)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'UNSURE',
      },
    });

    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // 教頭による一次承認
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const approveRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '授業引継ぎの確定を確認してから校長決裁に回してください',
    });

    assert.strictEqual(approveRes.success, true);
    assert.strictEqual(approveRes.statusCode, 200);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'IN_APPROVAL');
    assert.strictEqual(app.current_step_order, 2);
  });

  // GT-W7-10: 最終決裁時の UNSURE ガード (Fail-Closed 422 遮断)
  it('GT-W7-10: coverageStatus=UNSURE のまま最終決裁（校長決裁）を試行すると 422 で厳格遮断される', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (引継ぎ未確定)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'UNSURE',
      },
    });

    const appId = submitRes.data.id;

    // 一次承認 (教頭)
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    // 最終決裁 (校長) 試行 -> 422 エラー
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const finalApproveRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(finalApproveRes.success, false);
    assert.strictEqual(finalApproveRes.statusCode, 422);
    assert.strictEqual(finalApproveRes.errorCode, 'UNRESOLVED_COVERAGE_STATUS_ON_FINAL_APPROVAL');
  });

  // GT-W7-11: 授業引継ぎ確定後の最終決裁通過
  it('GT-W7-11: 授業引継ぎを確定（REQUIRED/NOT_REQUIRED）に更新した後は最終決裁が正常完了する', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (引継ぎ更新検証)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'UNSURE',
      },
    });

    const appId = submitRes.data.id;

    // 一次承認 (教頭)
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    // 授業引継ぎを確定 (NOT_REQUIRED に更新)
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const currentFormData = JSON.parse(app.form_data);
    const updatedFormData = {
      ...currentFormData,
      coverageStatus: 'NOT_REQUIRED',
      notRequiredReason: '教務主任と調整の上、自習措置不要を確認',
      coverageItems: [],
    };

    db.prepare(`
      UPDATE applications
      SET form_data = ?, version = version + 1
      WHERE id = ?
    `).run(JSON.stringify(updatedFormData), appId);

    // 校長最終決裁
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const finalRes = WorkflowEngine.approveApplication(principal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(finalRes.success, true);
    assert.strictEqual(finalRes.statusCode, 200);

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'FINAL_APPROVED');
  });

  // GT-W7-12: 出張申請 (BUSINESS_TRIP) における授業措置バリデーション
  it('GT-W7-12: 出張申請 (BUSINESS_TRIP) においても構造化授業引継ぎ明細が正常にバリデーション・保存される', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'BUSINESS_TRIP',
      title: '市内教科部会 出張',
      formData: {
        destination: '教育研究所',
        purpose: '算数科部会研究協議',
        startDate: '2026-10-20',
        endDate: '2026-10-20',
        startAt: '2026-10-20T08:10:00',
        endAt: '2026-10-20T16:40:00',
        departurePlace: '本校',
        arrivalPlace: '本校',
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            targetDate: '2026-10-20',
            period: '5',
            coverageType: 'TIMETABLE_EXCHANGE',
            substituteUserId: 2,
            subjectName: '算数',
            contentNotes: '金曜5限の図工と入れ替え',
          },
        ],
      },
    });

    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const formData = JSON.parse(app.form_data);
    assert.strictEqual(formData.coverageStatus, 'REQUIRED');
    assert.strictEqual(formData.coverageItems[0].substituteUserNameSnapshot, '佐藤 花子 (教員B)');
  });

  // GT-W7-13: 教員名変更後のスナップショット不変性 (Snapshot Immutability)
  it('GT-W7-13: 申請提出後に代替教員の users.display_name が改姓・変更されても、申請内スナップショットは不変を維持する', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (不変性検証)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            targetDate: '2026-10-15',
            period: '2',
            coverageType: 'SUBSTITUTE_LESSON',
            substituteUserId: 2, // 佐藤 花子
          },
        ],
      },
    });

    const appId = submitRes.data.id;

    // users テーブルの教員2の名前を変更 (結婚による改姓など)
    db.prepare('UPDATE users SET display_name = ? WHERE id = 2').run('伊藤 花子 (旧姓: 佐藤)');

    // 申請データを取得し、スナップショットが元の「佐藤 花子 (教員B)」のままであることを確認
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const formData = JSON.parse(app.form_data);
    assert.strictEqual(formData.coverageItems[0].substituteUserNameSnapshot, '佐藤 花子 (教員B)');
  });

  // GT-W7-14: 差戻し後の再申請 (Resubmit) での授業措置の修正と新スナップショット生成
  it('GT-W7-14: 差戻し後の再申請において、授業措置の要否および明細を変更して再提出できる', () => {
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (差戻し再申請検証)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'UNSURE',
      },
    });

    const appId = submitRes.data.id;

    // 教頭による差戻し
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    WorkflowEngine.returnApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
      comment: '自習監督の担当者を決めてから再提出してください',
    });

    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'RETURNED');

    // 再申請 (Cycle 2: REQUIRED + 構造化明細)
    const resubmitRes = WorkflowEngine.resubmitApplication(teacher1, {
      applicationId: appId,
      expectedVersion: app.version,
      title: '年休申請 (再提出: 自習措置確定)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            targetDate: '2026-10-15',
            period: '4',
            coverageType: 'SELF_STUDY_SUPERVISION',
            substituteUserId: 2,
            subjectName: '社会',
            contentNotes: 'ワークブックP.20〜22',
          },
        ],
      },
    });

    assert.strictEqual(resubmitRes.success, true);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(app.current_status, 'SUBMITTED');
    const newFormData = JSON.parse(app.form_data);
    assert.strictEqual(newFormData.coverageStatus, 'REQUIRED');
    assert.strictEqual(newFormData.coverageItems[0].substituteUserNameSnapshot, '佐藤 花子 (教員B)');
  });

  // GT-W7-15: 1段階決裁ルート（教頭専決等）における UNSURE ガード
  it('GT-W7-15: 1段階決裁ルートであっても、第1ステップが決裁ステップであれば UNSURE 決裁が遮断される', () => {
    // 1段階決裁の申請種別または単一ステップ状況を作成
    const submitRes = WorkflowEngine.submitApplication(teacher1, {
      typeId: 'LEAVE_ANNUAL',
      title: '年休申請 (1段階ルート検証)',
      formData: {
        unitType: 'DAY',
        targetDate: '2026-10-15',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        coverageStatus: 'UNSURE',
      },
    });

    const appId = submitRes.data.id;

    // DB上のステップ2（校長）を削除してステップ1（教頭）のみの1段階決裁ルートに模擬
    db.prepare('DELETE FROM application_approval_steps WHERE application_id = ? AND step_order = 2').run(appId);

    // ステップ1（教頭）が決裁ステップとなるため、UNSURE では 422 遮断される
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const approveRes = WorkflowEngine.approveApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: app.version,
    });

    assert.strictEqual(approveRes.success, false);
    assert.strictEqual(approveRes.statusCode, 422);
    assert.strictEqual(approveRes.errorCode, 'UNRESOLVED_COVERAGE_STATUS_ON_FINAL_APPROVAL');
  });

  // GT-W7-16: 旧自由記述 substituteTeacher データの Read Adapter 互換性
  it('GT-W7-16: 旧データ（substituteTeacher 自由記述文字列）が存在する場合も破綻なく読み込み可能', () => {
    const legacyFormData = {
      unitType: 'DAY',
      startDate: '2026-10-15',
      endDate: '2026-10-15',
      calculatedDays: 1,
      substituteTeacher: '2限: 佐藤教諭（算数自習）、3限: 田中教諭（理科）',
    };

    // FormValidationEngine での Whitelist 互換性（substituteTeacher は systemAllowedFields に含まれ破棄されない）
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: legacyFormData,
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.substituteTeacher, legacyFormData.substituteTeacher);
  });
});
