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

describe('Wave 1: Application Form Schema Dynamicization & Field Expansion Dedicated Golden Tests', () => {
  let db: any;

  const teacher = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎',
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

  // GT-W1-01: 年次有給休暇 (LEAVE_ANNUAL) 終日/半日/時間単位バリデーション
  it('GT-W1-01: 年次有給休暇の終日(DAY)・半日(HALF_DAY)・時間休(TIME)正常系バリデーション', () => {
    // 1. 終日
    const resDay = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        reason: '私事都合'
      }
    });
    assert.strictEqual(resDay.valid, true);
    assert.strictEqual(resDay.sanitizedValues?.unitType, 'DAY');
    assert.strictEqual(resDay.schemaVersion, '2026.1');

    // 2. 半日 (午前)
    const resHalf = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'HALF_DAY',
        halfDayType: 'MORNING',
        targetDate: '2026-10-16',
        reason: '通院'
      }
    });
    assert.strictEqual(resHalf.valid, true);
    assert.strictEqual(resHalf.sanitizedValues?.halfDayType, 'MORNING');

    // 3. 時間休
    const resTime = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'TIME',
        targetDate: '2026-10-17',
        startTime: '09:00',
        endTime: '12:00',
        reason: '役所手続き'
      }
    });
    assert.strictEqual(resTime.valid, true);
    assert.strictEqual(resTime.sanitizedValues?.startTime, '09:00');
    assert.strictEqual(resTime.sanitizedValues?.endTime, '12:00');
  });

  // GT-W1-02: 年次有給休暇 時間休で開始時刻/終了時刻欠落時は422拒絶
  it('GT-W1-02: 年次有給休暇の時間休で必須時刻欠落時は 422 拒絶される (Fail-Closed)', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'TIME',
        targetDate: '2026-10-17',
        // startTime / endTime 欠落
      }
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.errorCode, 'FORM_VALIDATION_FAILED');
    assert.ok(res.issues?.some(i => i.field === 'startTime'));
    assert.ok(res.issues?.some(i => i.field === 'endTime'));
  });

  // GT-W1-03: 出張申請 (BUSINESS_TRIP) 拡張フィールド正常系
  it('GT-W1-03: 出張申請の拡張フィールド (出発地/帰着地/日時/交通手段) 正常系検証', () => {
    const res = FormValidationEngine.validate({
      typeId: 'BUSINESS_TRIP',
      rawValues: {
        purpose: '第1回山口県教育研究会総会 出席',
        destination: '山口市教育センター',
        departurePlace: '本校',
        arrivalPlace: '自宅',
        startAt: '2026-11-10T08:30:00',
        endAt: '2026-11-10T17:00:00',
        transport: '公共交通機関',
        isExpenseClaimed: true,
        remarks: '電車・バス利用'
      }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.departurePlace, '本校');
    assert.strictEqual(res.sanitizedValues?.arrivalPlace, '自宅');
    assert.strictEqual(res.sanitizedValues?.isExpenseClaimed, true);
  });

  // GT-W1-04: Business Trip v1.2 Superseded Contract (privateCarReason NOT REQUIRED)
  // Business Trip v1.2 FINAL:
  // privateCarReason requiredCondition was intentionally removed.
  // This test protects the superseding v1.2 contract and prevents
  // the historical "private car reason required" rule from returning.
  it('GT-W1-04: 出張申請で交通手段が「自家用車」の場合でも自家用車使用理由未入力でバリデーションを通過する (Superseded Required Contract)', () => {
    // 1. 新規申請: 自家用車選択かつ privateCarReason 未入力でもバリデーション通過 (v1.2 凍結仕様)
    const res = FormValidationEngine.validate({
      typeId: 'BUSINESS_TRIP',
      rawValues: {
        purpose: '中学校部活動引率',
        destination: '防府市スポーツセンター',
        departurePlace: '本校',
        arrivalPlace: '本校',
        startAt: '2026-11-12T07:30:00',
        endAt: '2026-11-12T18:00:00',
        transport: '自家用車',
        // privateCarReason 欠落 (v1.2 では必須ではない)
      }
    });
    assert.strictEqual(res.valid, true);
    assert.ok(!res.issues?.some(i => i.field === 'privateCarReason'));

    // 2. 過去データ互換性: privateCarReason が存在する場合も正常にサニタイズ・通過
    const resValid = FormValidationEngine.validate({
      typeId: 'BUSINESS_TRIP',
      rawValues: {
        purpose: '中学校部活動引率',
        destination: '防府市スポーツセンター',
        departurePlace: '本校',
        arrivalPlace: '本校',
        startAt: '2026-11-12T07:30:00',
        endAt: '2026-11-12T18:00:00',
        transport: '自家用車',
        privateCarReason: '多量の大会用具・医療救護バッグ運搬のため'
      }
    });
    assert.strictEqual(resValid.valid, true);
    assert.strictEqual(resValid.sanitizedValues?.privateCarReason, '多量の大会用具・医療救護バッグ運搬のため');
  });

  // GT-W1-05: 病気休暇 (LEAVE_SICK) 診断書フラグおよび医療機関名
  it('GT-W1-05: 病気休暇の申請項目 (診断書フラグ/医療機関名) 正常系検証', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_SICK',
      rawValues: {
        startDate: '2026-11-01',
        endDate: '2026-11-10',
        calculatedDays: 8,
        reason: '急性気管支炎による療養通院',
        medicalCertificateAttached: true,
        medicalInstitutionName: '山口県立総合医療センター'
      }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.medicalCertificateAttached, true);
    assert.strictEqual(res.sanitizedValues?.medicalInstitutionName, '山口県立総合医療センター');
  });

  // GT-W1-06: 特別休暇 (LEAVE_SPECIAL) 忌引事由における続柄入力必須検証
  it('GT-W1-06: 特別休暇で忌引(SPECIAL_BEREAVEMENT)選択時の続柄入力条件付き必須検証', () => {
    // 続柄なし -> 拒絶
    const resInvalid = FormValidationEngine.validate({
      typeId: 'LEAVE_SPECIAL',
      rawValues: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        startDate: '2026-11-05',
        endDate: '2026-11-09',
        unitType: 'DAY',
        reason: '葬儀参列のため'
      }
    });
    assert.strictEqual(resInvalid.valid, false);
    assert.strictEqual(resInvalid.status, 422);
    assert.ok(resInvalid.issues?.some(i => i.field === 'relationship'));

    // 続柄あり -> 合格
    const resValid = FormValidationEngine.validate({
      typeId: 'LEAVE_SPECIAL',
      rawValues: {
        reasonCode: 'SPECIAL_BEREAVEMENT',
        relationship: '実父（山田 一郎）',
        startDate: '2026-11-05',
        endDate: '2026-11-09',
        unitType: 'DAY',
        reason: '葬儀参列のため'
      }
    });
    assert.strictEqual(resValid.valid, true);
    assert.strictEqual(resValid.sanitizedValues?.relationship, '実父（山田 一郎）');
  });

  // GT-W1-07: 特例法第22条第2項研修 主催者・研修場所検証
  it('GT-W1-07: 特例法第22条第2項研修の主催者・研修場所入力検証', () => {
    const res = FormValidationEngine.validate({
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      rawValues: {
        purpose: '中学校数学科におけるICT指導法教材研究',
        organizer: '山口県数学教育研究会',
        venue: '山口県立山口図書館',
        targetDate: '2026-10-20',
        unitType: 'DAY'
      }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.sanitizedValues?.organizer, '山口県数学教育研究会');
    assert.strictEqual(res.sanitizedValues?.venue, '山口県立山口図書館');
  });

  // GT-W1-08: Whitelist Security - 未知フィールドの拒絶 (Mass-Assignment防御)
  it('GT-W1-08 [Security]: スキーマに定義されていない未知フィールドを含むペイロードは 400 で即時拒絶される', () => {
    const res = FormValidationEngine.validate({
      typeId: 'LEAVE_ANNUAL',
      rawValues: {
        unitType: 'DAY',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        calculatedDays: 1,
        maliciousInjectedField: 'HACKED_VALUE',
        adminOverrideStatus: 'APPROVED'
      }
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.errorCode, 'UNRECOGNIZED_FIELD_REJECTED');
  });

  // GT-W1-09: 未登録の申請種別 (UNKNOWN_SCHEMA) の Fail-Closed
  it('GT-W1-09: 未登録の申請種別を指定した場合は UNKNOWN_SCHEMA で Fail-Closed 拒絶される', () => {
    const res = FormValidationEngine.validate({
      typeId: 'NON_EXISTENT_APPLICATION_TYPE',
      rawValues: {
        title: 'テスト'
      }
    });
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.errorCode, 'UNKNOWN_SCHEMA');
  });

  // GT-W1-10: 下書き (Draft) 保存時の部分入力許容
  it('GT-W1-10: 下書き保存時 (isDraft: true) は必須フィールド未入力でもバリデーションを通過する', () => {
    const resDraft = FormValidationEngine.validate({
      typeId: 'BUSINESS_TRIP',
      rawValues: {
        purpose: '出張計画中',
        // destination, departurePlace, arrivalPlace, startAt, endAt など未入力
      },
      isDraft: true
    });
    assert.strictEqual(resDraft.valid, true);
    assert.strictEqual(resDraft.schemaVersion, '2026.1');
    assert.ok(resDraft.schemaSnapshot);
  });

  // GT-W1-11: 差戻し後再提出 (RESUBMIT) 時の Historical Schema Snapshot 準拠
  it('GT-W1-11 [INV-016]: 差戻し後の再提出では Application にバインドされた旧バージョンスナップショットで検証される', () => {
    // 1. 初回提出 (v2026.1 Snapshot が form_data に保存される)
    const submitRes = WorkflowEngine.submitApplication(teacher, {
      typeId: 'LEAVE_ANNUAL',
      title: '初回年休申請',
      formData: {
        unitType: 'DAY',
        startDate: '2026-10-20',
        endDate: '2026-10-20',
        calculatedDays: 1,
        reason: '私用'
      }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    // DB内の form_data に schemaVersion / schemaSnapshot が保存されていることを検証
    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const storedFormData = JSON.parse(appRow.form_data);
    assert.strictEqual(storedFormData.schemaVersion, '2026.1');
    assert.strictEqual(storedFormData.schemaSnapshot.typeId, 'LEAVE_ANNUAL');
    assert.strictEqual(storedFormData.schemaSnapshot.version, '2026.1');

    // 2. 教頭が差戻し
    const returnRes = WorkflowEngine.returnApplication(vicePrincipal, {
      applicationId: appId,
      expectedVersion: 1,
      comment: '理由詳細を修正してください'
    });
    assert.strictEqual(returnRes.success, true);

    // 3. 再提出
    const resubmitRes = WorkflowEngine.resubmitApplication(teacher, {
      applicationId: appId,
      expectedVersion: 2,
      title: '修正後年休申請',
      formData: {
        unitType: 'DAY',
        startDate: '2026-10-20',
        endDate: '2026-10-20',
        calculatedDays: 1,
        reason: '通院・健康診断受診のため'
      }
    });
    assert.strictEqual(resubmitRes.success, true);

    // 再提出後もスナップショットが維持されていること
    const updatedAppRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const updatedFormData = JSON.parse(updatedAppRow.form_data);
    assert.strictEqual(updatedFormData.schemaVersion, '2026.1');
    assert.strictEqual(updatedFormData.schemaSnapshot.version, '2026.1');
  });

  // GT-W1-12: クライアント改ざんスナップショットの無効化 (Server-Authoritative Registry Override)
  it('GT-W1-12 [Security]: クライアントが改ざんした schemaSnapshot / schemaVersion を送信しても、Server Authoritative Registry で完全に上書き固定される', () => {
    const tamperedSnapshot = {
      typeId: 'LEAVE_ANNUAL',
      version: '9999.TAMPERED',
      sections: []
    };

    const submitRes = WorkflowEngine.submitApplication(teacher, {
      typeId: 'LEAVE_ANNUAL',
      title: '改ざんスナップショット送信試行',
      formData: {
        schemaVersion: '9999.TAMPERED',
        schemaSnapshot: tamperedSnapshot,
        unitType: 'DAY',
        startDate: '2026-10-22',
        endDate: '2026-10-22',
        calculatedDays: 1,
        reason: '私用'
      }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    const storedFormData = JSON.parse(appRow.form_data);
    
    // クライアントの 9999.TAMPERED ではなく、サーバー正式の 2026.1 が保存されていること
    assert.strictEqual(storedFormData.schemaVersion, '2026.1');
    assert.strictEqual(storedFormData.schemaSnapshot.version, '2026.1');
    assert.ok(storedFormData.schemaSnapshot.sections.length > 0);
  });

  // GT-W1-13: 代理申請における身分・起案者情報の分離とスキーマ検証
  it('GT-W1-13: 代理申請において対象教職員の身分でスキーマ検証が実行され、proxyReason が正しく保持される', () => {
    const submitRes = WorkflowEngine.submitProxyApplication(vicePrincipal, {
      typeId: 'LEAVE_ANNUAL',
      subjectUserId: teacher.id,
      title: '【代理起案】山田教諭年休',
      proxyReason: '本人急病のため電話連絡を受けて教頭代理起案',
      formData: {
        unitType: 'DAY',
        startDate: '2026-10-26',
        endDate: '2026-10-26',
        calculatedDays: 1,
        reason: '急病療養'
      }
    });
    assert.strictEqual(submitRes.success, true);
    const appId = submitRes.data.id;

    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as any;
    assert.strictEqual(appRow.subject_user_id, teacher.id);
    assert.strictEqual(appRow.submitted_by_user_id, vicePrincipal.id);
    assert.strictEqual(appRow.submission_actor_type, 'PROXY');

    const storedFormData = JSON.parse(appRow.form_data);
    assert.strictEqual(storedFormData.proxyReason, '本人急病のため電話連絡を受けて教頭代理起案');
    assert.strictEqual(storedFormData.schemaVersion, '2026.1');
  });

  // GT-W1-14: 将来拡張性検証 (仮想第27種別スキーマの動的追加とコア無修正検証)
  it('GT-W1-14 [Extensibility Proof]: コアロジック無修正で新規申請種別 (VIRTUAL_SPECIAL_LEAVE) を追加し、即座に提出・バリデーション可能', () => {
    // 新規スキーマをレジストリに動的登録
    FormSchemaRegistry.registerSchema({
      typeId: 'VIRTUAL_CHILD_NURSING',
      version: '2026.1',
      title: '子の看護休暇 承認申請書',
      description: '負傷し、又は疾病にかかつた子の世話を行うための休暇',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'child_nursing_details',
          title: '看護対象情報',
          fields: [
            {
              name: 'childName',
              label: '対象児童氏名',
              type: 'TEXT',
              required: true,
              placeholder: '例: 山田 花子'
            },
            {
              name: 'childAge',
              label: '子の年齢 (小学校就学前)',
              type: 'NUMBER',
              required: true,
              validation: { min: 0, max: 12 }
            },
            {
              name: 'targetDate',
              label: '看護実施日',
              type: 'DATE',
              required: true
            },
            {
              name: 'unitType',
              label: '取得単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '1日', value: 'DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            }
          ]
        }
      ]
    });

    // 必須欠落時 -> 拒絶
    const resInvalid = FormValidationEngine.validate({
      typeId: 'VIRTUAL_CHILD_NURSING',
      rawValues: {
        childName: '山田 花子',
        // childAge 欠落
        targetDate: '2026-11-20',
        unitType: 'DAY'
      }
    });
    assert.strictEqual(resInvalid.valid, false);
    assert.strictEqual(resInvalid.status, 422);
    assert.ok(resInvalid.issues?.some(i => i.field === 'childAge'));

    // 正常入力 -> 合格
    const resValid = FormValidationEngine.validate({
      typeId: 'VIRTUAL_CHILD_NURSING',
      rawValues: {
        childName: '山田 花子',
        childAge: 5,
        targetDate: '2026-11-20',
        unitType: 'DAY'
      }
    });
    assert.strictEqual(resValid.valid, true);
    assert.strictEqual(resValid.sanitizedValues?.childName, '山田 花子');
    assert.strictEqual(resValid.sanitizedValues?.childAge, 5);
  });

  // GT-W1-15: スキーマAPIエンドポイント検証 (/api/schemas/:typeId & /api/schemas)
  it('GT-W1-15: FormSchemaRegistry APIによりActiveスキーマが決定論的に取得可能', () => {
    const annualSchema = FormSchemaRegistry.resolveActiveSchema('LEAVE_ANNUAL');
    assert.ok(annualSchema);
    assert.strictEqual(annualSchema.typeId, 'LEAVE_ANNUAL');
    assert.strictEqual(annualSchema.version, '2026.1');
    assert.ok(annualSchema.sections.length > 0);

    const allSchemas = FormSchemaRegistry.getAllActiveSchemas();
    assert.ok(allSchemas.length >= 6);
    const typeIds = allSchemas.map(s => s.typeId);
    assert.ok(typeIds.includes('LEAVE_ANNUAL'));
    assert.ok(typeIds.includes('BUSINESS_TRIP'));
    assert.ok(typeIds.includes('LEAVE_SPECIAL'));
    assert.ok(typeIds.includes('LEAVE_SICK'));
    assert.ok(typeIds.includes('TRAINING_SPECIAL_ACT_22_2'));
    assert.ok(typeIds.includes('LEAVE_DUTY_EXEMPT'));
  });
});
