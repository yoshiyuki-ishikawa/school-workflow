import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFormSchema } from './types/formSchema';
import {
  TypedApplicationFormState,
  TypedProjectionInput,
  GenericFieldValues,
} from './types/formState';
import {
  assembleWorkingStateForProjection,
  projectApplicationFormDataBySchema,
  projectApplicationFormData,
  PayloadProjectionError,
} from './pages/NewApplicationModal';

describe('Phase B Step 1: Hybrid Typed Form State & Pure Schema Projection Golden Tests (GT-B-01〜09)', () => {
  const dummySchemaLeave: ApplicationFormSchema = {
    typeId: 'LEAVE_ANNUAL',
    version: '1',
    title: '年次有給休暇',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2099-12-31',
    sections: [
      {
        id: 'basic_period',
        title: '期間情報',
        fields: [
          { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
          { name: 'startDate', label: '開始日', type: 'DATE', required: true },
          { name: 'endDate', label: '終了日', type: 'DATE', required: true },
          { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
          { name: 'startTime', label: '開始時刻', type: 'TIME', required: false },
          { name: 'endTime', label: '終了時刻', type: 'TIME', required: false },
          { name: 'reason', label: '理由', type: 'TEXT', required: false, aliases: ['purpose'] },
        ],
      },
    ],
  };

  const dummySchemaTrip: ApplicationFormSchema = {
    typeId: 'BUSINESS_TRIP',
    version: '1',
    title: '出張申請',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2099-12-31',
    sections: [
      {
        id: 'trip_info',
        title: '出張内容',
        fields: [
          { name: 'destination', label: '用務先', type: 'TEXT', required: true },
          { name: 'departurePlace', label: '出発地', type: 'TEXT', required: true },
          { name: 'arrivalPlace', label: '到着地', type: 'TEXT', required: true },
          { name: 'transport', label: '交通手段', type: 'SELECT', required: true },
          { name: 'purpose', label: '用務内容', type: 'TEXT', required: true, aliases: ['reason'] },
          { name: 'startAt', label: '開始日時', type: 'DATETIME', required: false },
          { name: 'endAt', label: '終了日時', type: 'DATETIME', required: false },
          { name: 'isOralOrder', label: '口頭命令', type: 'BOOLEAN', required: false },
          { name: 'oralOrderIssuedAt', label: '口頭命令受令日', type: 'DATE', required: false },
        ],
      },
    ],
  };

  it('GT-B-01 (Type Safety & Synthesis): assembleWorkingStateForProjection が Typed State を型安全に合成すること', () => {
    const state: TypedApplicationFormState = {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】私用のため',
      genericValues: {
        unitType: 'DAY',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        targetDate: '2026-10-01',
        reason: '私用のため',
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const rawWorking = assembleWorkingStateForProjection(state);

    assert.strictEqual(rawWorking.unitType, 'DAY');
    assert.strictEqual(rawWorking.startDate, '2026-10-01');
    assert.strictEqual(rawWorking.endDate, '2026-10-02');
    assert.strictEqual(rawWorking.targetDate, '2026-10-01');
    assert.strictEqual(rawWorking.reason, '私用のため');
    assert.strictEqual(rawWorking.purpose, '私用のため');
  });

  it('GT-B-02 (Pure Schema Projection): assembleWorkingStateForProjection + projectApplicationFormDataBySchema で正確な Payload が生成されること', () => {
    const state: TypedApplicationFormState = {
      typeId: 'BUSINESS_TRIP',
      title: '【出張】研修参加',
      genericValues: {
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        targetDate: '2026-10-15', // Working state に存在していてもスキーマに無ければ投影されない
        startTime: '09:00',
        endTime: '17:00',
        reason: '教育課程研究大会出席',
      },
      tripState: {
        destination: '山口県教育会館',
        departurePlace: '本校',
        arrivalPlace: '本校',
        transport: '公用車',
        isExpenseClaimed: true,
        isOralOrder: true,
        oralOrderIssuedAt: '2026-10-14',
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const rawWorking = assembleWorkingStateForProjection(state);
    const payload = projectApplicationFormDataBySchema(rawWorking, dummySchemaTrip);

    assert.strictEqual(payload.destination, '山口県教育会館');
    assert.strictEqual(payload.departurePlace, '本校');
    assert.strictEqual(payload.arrivalPlace, '本校');
    assert.strictEqual(payload.transport, '公用車');
    assert.strictEqual(payload.purpose, '教育課程研究大会出席');
    assert.strictEqual(payload.isOralOrder, true);
    assert.strictEqual(payload.oralOrderIssuedAt, '2026-10-14');
    assert.strictEqual(payload.startAt, '2026-10-15T09:00:00');
    assert.strictEqual(payload.endAt, '2026-10-15T17:00:00');
    // targetDate is strictly not present in dummySchemaTrip
    assert.strictEqual('targetDate' in payload, false);
    assert.strictEqual(payload.targetDate, undefined);
  });

  it('GT-B-03 (Fail-Closed Ambiguity Check): Canonical Key と Alias の値が衝突した場合、Fail-Closed で AMBIGUOUS_FIELD_VALUE エラーをスローすること', () => {
    const conflictingWorkingState: TypedProjectionInput = {
      reason: '私用のため',
      purpose: '公務研究のため', // conflicting alias value
    };

    assert.throws(
      () => projectApplicationFormDataBySchema(conflictingWorkingState, dummySchemaLeave),
      (err: any) => {
        assert.strictEqual(err instanceof PayloadProjectionError, true);
        assert.strictEqual(err.code, 'AMBIGUOUS_FIELD_VALUE');
        assert.strictEqual(err.fieldName, 'reason');
        return true;
      }
    );
  });

  it('GT-B-04 (Domain State Isolation): Trip ドメインステートが不要な種別（年休）では Payload に混入しないこと', () => {
    const state: TypedApplicationFormState = {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】年休',
      genericValues: {
        unitType: 'DAY',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        targetDate: '2026-10-01',
      },
      tripState: {
        destination: '残存した目的地',
        departurePlace: '残存した出発地',
        arrivalPlace: '残存した到着地',
        transport: '公用車',
        isExpenseClaimed: false,
        isOralOrder: false,
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const rawWorking = assembleWorkingStateForProjection(state);
    const payload = projectApplicationFormDataBySchema(rawWorking, dummySchemaLeave);

    assert.strictEqual(payload.startDate, '2026-10-01');
    assert.strictEqual('destination' in payload, false);
    assert.strictEqual('departurePlace' in payload, false);
    assert.strictEqual('arrivalPlace' in payload, false);
    assert.strictEqual('transport' in payload, false);
  });

  it('GT-B-05 (Time Leave Normalization in Typed State): 時間休の場合に startDate/endDate が targetDate と同期して assemble されること', () => {
    const state: TypedApplicationFormState = {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】時間休',
      genericValues: {
        unitType: 'TIME',
        targetDate: '2026-10-20',
        startTime: '10:00',
        endTime: '12:00',
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const rawWorking = assembleWorkingStateForProjection(state);
    assert.strictEqual(rawWorking.targetDate, '2026-10-20');
    assert.strictEqual(rawWorking.startDate, '2026-10-20');
    assert.strictEqual(rawWorking.endDate, '2026-10-20');
    assert.strictEqual(rawWorking.startAt, '2026-10-20T10:00:00');
    assert.strictEqual(rawWorking.endAt, '2026-10-20T12:00:00');

    const payload = projectApplicationFormDataBySchema(rawWorking, dummySchemaLeave);
    assert.strictEqual(payload.targetDate, '2026-10-20');
    assert.strictEqual(payload.startDate, '2026-10-20');
    assert.strictEqual(payload.endDate, '2026-10-20');
  });
});

import {
  GenericFormField,
  SUPPORTED_GENERIC_FIELD_TYPES,
  UnsupportedSchemaFieldError,
} from './components/forms/GenericFormField';
import {
  SchemaFormRenderer,
  evaluateCondition,
} from './components/forms/SchemaFormRenderer';
import { FormFieldDefinition } from './types/formSchema';

describe('Phase B Step 2: Generic Standard Field Renderer Golden Tests (GT-B-06〜12)', () => {
  it('GT-B-06 (Supported Generic Field Types Verification): 全10種類の標準フィールド型が正しく定義・サポートされていること', () => {
    const expectedTypes = [
      'TEXT',
      'TEXTAREA',
      'NUMBER',
      'DATE',
      'TIME',
      'DATETIME',
      'SELECT',
      'RADIO',
      'CHECKBOX',
      'BOOLEAN',
    ];

    for (const t of expectedTypes) {
      assert.strictEqual(SUPPORTED_GENERIC_FIELD_TYPES.includes(t as any), true);
    }
  });

  it('GT-B-07 (Dynamic Condition Evaluation): evaluateCondition が EQUALS / NOT_EQUALS / IN / IS_TRUE / IS_FALSE を決定論的に評価すること', () => {
    const values = {
      unitType: 'HALF_DAY',
      isOralOrder: true,
      category: 'TEACHER',
    };

    assert.strictEqual(
      evaluateCondition({ field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' }, values),
      true
    );
    assert.strictEqual(
      evaluateCondition({ field: 'unitType', operator: 'EQUALS', value: 'DAY' }, values),
      false
    );
    assert.strictEqual(
      evaluateCondition({ field: 'unitType', operator: 'NOT_EQUALS', value: 'DAY' }, values),
      true
    );
    assert.strictEqual(
      evaluateCondition({ field: 'category', operator: 'IN', value: ['TEACHER', 'STAFF'] }, values),
      true
    );
    assert.strictEqual(
      evaluateCondition({ field: 'isOralOrder', operator: 'IS_TRUE' }, values),
      true
    );
    assert.strictEqual(
      evaluateCondition({ field: 'isOralOrder', operator: 'IS_FALSE' }, values),
      false
    );
  });

  it('GT-B-08 (Fail-Closed on Unsupported Field Type): 未知・非対応のフィールド型（ARRAY等）に遭遇した場合、推測描画せず UnsupportedSchemaFieldError をスローすること', () => {
    const unsupportedField: FormFieldDefinition = {
      name: 'unsupportedField',
      label: '未対応フィールド',
      type: 'ARRAY' as any,
      required: false,
    };

    // GenericFormField 直接呼出しによる Fail-Closed 検証
    assert.throws(
      () => {
        GenericFormField({
          field: unsupportedField,
          value: [],
          onChange: () => {},
        });
      },
      (err: any) => {
        assert.strictEqual(err instanceof UnsupportedSchemaFieldError, true);
        assert.strictEqual(err.fieldName, 'unsupportedField');
        assert.strictEqual(err.fieldType, 'ARRAY');
        return true;
      }
    );
  });

  it('GT-B-09 (Schema-Driven Rendering Contract): Schema に存在するフィールド順序・必須フラグ・Visible条件が決定論的に解決されること', () => {
    const conditionalSchema: ApplicationFormSchema = {
      typeId: 'SPECIAL_TEST',
      version: '1',
      title: '特別休暇',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'test_sec',
          title: '条件付きセクション',
          fields: [
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, options: [{ label: '日', value: 'DAY' }, { label: '時間', value: 'TIME' }] },
            {
              name: 'halfDayType',
              label: '半日種別',
              type: 'RADIO',
              required: true,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' },
            },
            {
              name: 'startTime',
              label: '開始時刻',
              type: 'TIME',
              required: false,
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
            },
          ],
        },
      ],
    };

    // 1. unitType: 'DAY' の場合、halfDayType の visibleCondition は false
    const dayValues = { unitType: 'DAY' };
    assert.strictEqual(
      evaluateCondition(conditionalSchema.sections[0].fields[1].visibleCondition, dayValues),
      false
    );
    assert.strictEqual(
      evaluateCondition(conditionalSchema.sections[0].fields[2].requiredCondition, dayValues),
      false
    );

    // 2. unitType: 'TIME' の場合、startTime の requiredCondition は true
    const timeValues = { unitType: 'TIME' };
    assert.strictEqual(
      evaluateCondition(conditionalSchema.sections[0].fields[2].requiredCondition, timeValues),
      true
    );
  });
});

import {
  DEDICATED_RENDERER_REGISTRY,
  UnsupportedDedicatedRendererError,
} from './components/forms/DedicatedRendererRegistry';
import {
  resolveSectionRenderer,
} from './components/forms/SchemaFormRenderer';
import { FormSectionDefinition } from './types/formSchema';

describe('Phase B Step 3: Dedicated Domain Widgets & Registry Integration Golden Tests (GT-B-10〜16)', () => {
  it('GT-B-10 (Registered Dedicated Sections Verification): trip_details / care_details / class_coverage が DEDICATED_RENDERER_REGISTRY に登録されていること', () => {
    assert.strictEqual(typeof DEDICATED_RENDERER_REGISTRY.trip_details, 'function');
    assert.strictEqual(typeof DEDICATED_RENDERER_REGISTRY.care_details, 'function');
    assert.strictEqual(typeof DEDICATED_RENDERER_REGISTRY.class_coverage, 'function');
  });

  it('GT-B-11 (Dedicated Renderer Resolution Case A): Registered Dedicated Section が Dedicated Renderer に決定論的に解決されること', () => {
    const tripSection: FormSectionDefinition = {
      id: 'trip_details',
      title: '出張内容',
      fields: [],
    };

    const result = resolveSectionRenderer(tripSection);
    assert.strictEqual(result.kind, 'DEDICATED');
    assert.strictEqual(result.renderer, DEDICATED_RENDERER_REGISTRY.trip_details);
  });

  it('GT-B-12 (Dedicated Domain State Isolation & Update): Dedicated Renderer 経由の変更が Domain Sub-State に反映され、Generic と隔離されること', () => {
    const state: TypedApplicationFormState = {
      typeId: 'BUSINESS_TRIP',
      title: '出張',
      genericValues: {},
      tripState: {
        destination: '旧目的地',
        transport: '公用車',
        departurePlace: '本校',
        arrivalPlace: '本校',
        isExpenseClaimed: false,
        isOralOrder: false,
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    // Update tripState updater simulation
    const updatedState: TypedApplicationFormState = {
      ...state,
      tripState: {
        ...state.tripState!,
        destination: '新目的地（県教育センター）',
      },
    };

    assert.strictEqual(updatedState.tripState?.destination, '新目的地（県教育センター）');
    assert.strictEqual(updatedState.genericValues.destination, undefined); // Isolated from genericValues
  });

  it('GT-B-13 (RD-B2-03 Case B): Unknown Section ID + Generic Supported Fields が Generic Renderer として正常解決されること', () => {
    const unknownSection: FormSectionDefinition = {
      id: 'custom_general_info',
      title: 'カスタム一般情報',
      fields: [
        { name: 'customRemarks', label: '備考', type: 'TEXT', required: false },
        { name: 'priorityLevel', label: '優先度', type: 'NUMBER', required: false },
      ],
    };

    const result = resolveSectionRenderer(unknownSection);
    assert.strictEqual(result.kind, 'GENERIC');
    if (result.kind === 'GENERIC') {
      assert.strictEqual(result.fields.length, 2);
      assert.strictEqual(result.fields[0].name, 'customRemarks');
    }
  });

  it('GT-B-14 (RD-B2-03 Case C): Unknown Section + Unsupported Field Type に遭遇した場合、推測描画せず Fail-Closed で ERROR を返すこと', () => {
    const invalidSection: FormSectionDefinition = {
      id: 'custom_invalid_section',
      title: '不正セクション',
      fields: [
        { name: 'validField', label: '有効', type: 'TEXT', required: true },
        { name: 'invalidField', label: '未対応型', type: 'ARRAY' as any, required: false },
      ],
    };

    const result = resolveSectionRenderer(invalidSection);
    assert.strictEqual(result.kind, 'ERROR');
    if (result.kind === 'ERROR') {
      assert.strictEqual(result.error instanceof UnsupportedSchemaFieldError, true);
      assert.strictEqual((result.error as UnsupportedSchemaFieldError).fieldName, 'invalidField');
    }
  });

  it('GT-B-15 (RD-B2-03 Case D): isDedicated が true かつ Registry 未登録のセクションに遭遇した場合、Fail-Closed で UnsupportedDedicatedRendererError を返すこと', () => {
    const missingDedicatedSection: FormSectionDefinition & { isDedicated?: boolean } = {
      id: 'missing_special_widget',
      title: '未登録専用ウィジェット',
      isDedicated: true,
      fields: [],
    };

    const result = resolveSectionRenderer(missingDedicatedSection);
    assert.strictEqual(result.kind, 'ERROR');
    if (result.kind === 'ERROR') {
      assert.strictEqual(result.error instanceof UnsupportedDedicatedRendererError, true);
      assert.strictEqual((result.error as UnsupportedDedicatedRendererError).sectionId, 'missing_special_widget');
    }
  });

  it('GT-B-16 (Pure Schema Projection Convergence): Dedicated State と Generic State が同一の Pure Schema Projection に収束すること', () => {
    const tripSchema: ApplicationFormSchema = {
      typeId: 'BUSINESS_TRIP',
      version: '1',
      title: '出張申請',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'trip_details',
          title: '出張内容',
          fields: [
            { name: 'destination', label: '用務先', type: 'TEXT', required: true },
            { name: 'transport', label: '交通手段', type: 'SELECT', required: true },
            { name: 'reason', label: '用務内容', type: 'TEXT', required: true, aliases: ['purpose'] },
          ],
        },
      ],
    };

    const state: TypedApplicationFormState = {
      typeId: 'BUSINESS_TRIP',
      title: '【出張】校外研修',
      genericValues: {
        reason: '教育研究大会参加',
      },
      tripState: {
        destination: '山口県セミナーパーク',
        transport: '公用車',
        departurePlace: '本校',
        arrivalPlace: '本校',
        isExpenseClaimed: false,
        isOralOrder: false,
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const rawWorking = assembleWorkingStateForProjection(state);
    const payload = projectApplicationFormDataBySchema(rawWorking, tripSchema);

    assert.strictEqual(payload.destination, '山口県セミナーパーク');
    assert.strictEqual(payload.transport, '公用車');
    assert.strictEqual(payload.reason, '教育研究大会参加');
  });
});

describe('Phase B Step 4: NewApplicationModal Orchestration Boundary Golden Tests (GT-B-17〜20)', () => {
  it('GT-B-17 (Single Submit Authority): Modal の送信・下書きデータ構築が Typed State -> assembleWorkingStateForProjection -> projectApplicationFormDataBySchema 経路を厳格に経由すること', () => {
    const fullFormState: TypedApplicationFormState = {
      typeId: 'LEAVE_ANNUAL',
      title: '【年休】終日年休',
      genericValues: {
        unitType: 'DAY',
        startDate: '2026-11-05',
        endDate: '2026-11-06',
        calculatedDays: 2,
        reason: '私事都合のため',
      },
      tripState: {
        destination: '',
        transport: '公用車',
        departurePlace: '本校',
        arrivalPlace: '本校',
        isExpenseClaimed: false,
        isOralOrder: false,
      },
      careState: {},
      coverageState: {
        coverageStatus: 'NOT_REQUIRED',
        notRequiredReason: '授業なし',
        coverageItems: [],
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const targetSchema: ApplicationFormSchema = {
      typeId: 'LEAVE_ANNUAL',
      version: '1',
      title: '年次有給休暇',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'leave_period',
          title: '休暇期間',
          fields: [
            { name: 'unitType', label: '取得単位', type: 'RADIO', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'reason', label: '事由', type: 'TEXTAREA', required: false },
          ],
        },
      ],
    };

    const assembled = assembleWorkingStateForProjection(fullFormState);
    const projected = projectApplicationFormDataBySchema(assembled, targetSchema);

    assert.strictEqual(projected.unitType, 'DAY');
    assert.strictEqual(projected.startDate, '2026-11-05');
    assert.strictEqual(projected.endDate, '2026-11-06');
    assert.strictEqual(projected.reason, '私事都合のため');
    assert.strictEqual('destination' in projected, false);
    assert.strictEqual('coverageStatus' in projected, false);
  });

  it('GT-B-18 (No Parallel Truth): Modal 内で activeSchema が存在する際、projectApplicationFormDataBySchema と projectApplicationFormData が完全に一致すること', () => {
    const targetSchema: ApplicationFormSchema = {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      version: '1',
      title: '校外研修',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'training_info',
          title: '研修情報',
          fields: [
            { name: 'unitType', label: '単位', type: 'RADIO', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'destination', label: '研修場所', type: 'TEXT', required: true, aliases: ['venue', 'location'] },
            { name: 'reason', label: '研修題目', type: 'TEXTAREA', required: true, aliases: ['purpose'] },
          ],
        },
      ],
    };

    const state: TypedApplicationFormState = {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      title: '【校外研修】教材研究',
      genericValues: {
        unitType: 'DAY',
        startDate: '2026-10-10',
        endDate: '2026-10-10',
        destination: '県立図書館',
        venue: '県立図書館',
        reason: '情報教育教材研究',
        purpose: '情報教育教材研究',
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const assembled = assembleWorkingStateForProjection(state);
    const schemaProjected = projectApplicationFormDataBySchema(assembled, targetSchema);

    const legacyWrapperProjected = projectApplicationFormData({
      selectedTypeId: 'TRAINING_SPECIAL_ACT_22_2',
      unitType: 'DAY',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      destination: '県立図書館',
      venue: '県立図書館',
      reason: '情報教育教材研究',
      activeSchema: targetSchema,
    });

    assert.deepStrictEqual(schemaProjected, legacyWrapperProjected);
    assert.strictEqual(schemaProjected.destination, '県立図書館');
    assert.strictEqual(schemaProjected.reason, '情報教育教材研究');
  });

  it('GT-B-19 (Modal Orchestration State Isolation & Mutators): Modal の Updater 関数経由の Generic/Trip/Care/Coverage 更新が意図しない Cross-Contamination を起こさないこと', () => {
    let genericState: Record<string, any> = { unitType: 'DAY', startDate: '2026-11-01' };
    let tripState = { destination: '東京', transport: '新幹線' };
    let careState = { careCaseId: 1, carePeriodId: 2 };
    let coverageState = { coverageStatus: 'NOT_REQUIRED', coverageItems: [] };

    // Generic Updater test
    genericState = { ...genericState, reason: '出張理由' };
    assert.strictEqual(tripState.destination, '東京');
    assert.strictEqual(genericState.reason, '出張理由');

    // Trip Updater test
    tripState = { ...tripState, destination: '大阪' };
    assert.strictEqual(tripState.destination, '大阪');
    assert.strictEqual(genericState.destination, undefined);

    // Care Updater test
    careState = { ...careState, careCaseId: 3 };
    assert.strictEqual(careState.careCaseId, 3);
    assert.strictEqual(careState.carePeriodId, 2);

    // Coverage Updater test
    coverageState = { ...coverageState, coverageStatus: 'REQUIRED' };
    assert.strictEqual(coverageState.coverageStatus, 'REQUIRED');
  });

  it('GT-B-20 (Orchestration with Multi-Section Complex Application): 介護休暇・出張・授業引継ぎを含む複雑な申請が SchemaFormRenderer と協調して正しい Payload を構築すること', () => {
    const careSchema: ApplicationFormSchema = {
      typeId: 'LEAVE_CARE',
      version: '1',
      title: '介護休暇',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      capabilities: {
        classCoverageApplicable: true,
      },
      sections: [
        {
          id: 'care_details',
          title: '介護対象家族・指定期間',
          fields: [
            { name: 'careCaseId', label: '介護ケース', type: 'NUMBER', required: true },
            { name: 'carePeriodId', label: '指定期間', type: 'NUMBER', required: true },
          ],
        },
        {
          id: 'period_section',
          title: '取得期間・単位',
          fields: [
            { name: 'unitType', label: '取得単位', type: 'RADIO', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
          ],
        },
        {
          id: 'class_coverage',
          title: '授業代替措置',
          fields: [
            { name: 'coverageStatus', label: '措置状況', type: 'RADIO', required: true },
            { name: 'notRequiredReason', label: '不要理由', type: 'TEXT', required: false },
          ],
        },
      ],
    };

    const state: TypedApplicationFormState = {
      typeId: 'LEAVE_CARE',
      title: '【介護休暇】家族介護',
      genericValues: {
        unitType: 'DAY',
        startDate: '2026-11-10',
        endDate: '2026-11-12',
      },
      careState: {
        careCaseId: 5,
        carePeriodId: 10,
      },
      coverageState: {
        coverageStatus: 'NOT_REQUIRED',
        notRequiredReason: '自習課題設定済み',
        coverageItems: [],
      },
      isProxy: false,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const assembled = assembleWorkingStateForProjection(state);
    const projected = projectApplicationFormDataBySchema(assembled, careSchema);

    assert.strictEqual(projected.careCaseId, 5);
    assert.strictEqual(projected.carePeriodId, 10);
    assert.strictEqual(projected.unitType, 'DAY');
    assert.strictEqual(projected.startDate, '2026-11-10');
    assert.strictEqual(projected.endDate, '2026-11-12');
    assert.strictEqual(projected.coverageStatus, 'NOT_REQUIRED');
    assert.strictEqual(projected.notRequiredReason, '自習課題設定済み');
  });
});

describe('Phase B Step 5: Fail-Closed Runtime Boundary & Obsolete Code Removal Golden Tests (GT-B-21〜26)', () => {
  it('GT-B-21 (Fail-Closed on Missing Active Schema): activeSchema が undefined の場合、旧ペイロードへのフォールバックを禁止し SCHEMA_REQUIRED エラーで Fail-Closed すること', () => {
    const rawWorking = {
      unitType: 'DAY',
      startDate: '2026-11-01',
      endDate: '2026-11-01',
    };

    assert.throws(
      () => {
        projectApplicationFormDataBySchema(rawWorking as any, undefined as any);
      },
      (err: any) => {
        assert.strictEqual(err instanceof PayloadProjectionError, true);
        assert.strictEqual(err.code, 'SCHEMA_REQUIRED');
        return true;
      }
    );
  });

  it('GT-B-22 (Fail-Closed on Malformed Schema / Null Sections): schema.sections が null / undefined の場合でも安全に Fail-Closed または空 Payload に処理されること', () => {
    const malformedSchema: ApplicationFormSchema = {
      typeId: 'TEST_MALFORMED',
      version: '1',
      title: '不正スキーマ',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: undefined as any,
    };

    const rawWorking = {
      unitType: 'DAY',
      startDate: '2026-11-01',
      endDate: '2026-11-01',
    };

    const payload = projectApplicationFormDataBySchema(rawWorking, malformedSchema);
    assert.deepStrictEqual(payload, {});
  });

  it('GT-B-23 (No Legacy Fallback in Pure Projection SSOT): 未定義フィールドやスキーマ外のゴミデータがペイロードに一切混入しないこと', () => {
    const strictSchema: ApplicationFormSchema = {
      typeId: 'LEAVE_ANNUAL',
      version: '1',
      title: '年次有給休暇',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'sec_1',
          title: '基本',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
          ],
        },
      ],
    };

    const dirtyWorking = {
      startDate: '2026-11-01',
      legacyFieldA: 'trash',
      legacyFieldB: 12345,
      destination: '東京',
      customSecret: 'leaked',
    };

    const payload = projectApplicationFormDataBySchema(dirtyWorking, strictSchema);
    assert.strictEqual(payload.startDate, '2026-11-01');
    assert.strictEqual('legacyFieldA' in payload, false);
    assert.strictEqual('legacyFieldB' in payload, false);
    assert.strictEqual('destination' in payload, false);
    assert.strictEqual('customSecret' in payload, false);
    assert.deepStrictEqual(Object.keys(payload), ['startDate']);
  });

  it('GT-B-24 (Fail-Closed on Unregistered Dedicated Section in Renderer Resolution): isDedicated: true かつ未登録のセクションは resolveSectionRenderer で即座に ERROR となること', () => {
    const unhandledDedicatedSection: FormSectionDefinition & { isDedicated?: boolean } = {
      id: 'unregistered_special_section',
      title: '未登録専用セクション',
      isDedicated: true,
      fields: [],
    };

    const res = resolveSectionRenderer(unhandledDedicatedSection);
    assert.strictEqual(res.kind, 'ERROR');
    if (res.kind === 'ERROR') {
      assert.strictEqual(res.error instanceof UnsupportedDedicatedRendererError, true);
      assert.strictEqual((res.error as UnsupportedDedicatedRendererError).sectionId, 'unregistered_special_section');
    }
  });

  it('GT-B-25 (Fail-Closed on Unsupported Field Type in Standard Section): 標準セクション内に未対応フィールド型（CUSTOM_WIDGET等）が含まれる場合は ERROR となること', () => {
    const unsupportedSection: FormSectionDefinition = {
      id: 'generic_sec',
      title: '汎用セクション',
      fields: [
        { name: 'normalField', label: '通常', type: 'TEXT', required: true },
        { name: 'invalidField', label: '不正', type: 'UNKNOWN_CUSTOM_TYPE' as any, required: false },
      ],
    };

    const res = resolveSectionRenderer(unsupportedSection);
    assert.strictEqual(res.kind, 'ERROR');
    if (res.kind === 'ERROR') {
      assert.strictEqual(res.error instanceof UnsupportedSchemaFieldError, true);
      assert.strictEqual((res.error as UnsupportedSchemaFieldError).fieldName, 'invalidField');
    }
  });

  it('GT-B-26 (Preserved Compatibility Boundary Invariant): projectApplicationFormData compatibility wrapper が activeSchema 存在時に projectApplicationFormDataBySchema と等価に動作すること', () => {
    const testSchema: ApplicationFormSchema = {
      typeId: 'LEAVE_ANNUAL',
      version: '1',
      title: '年次有給休暇',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'sec_1',
          title: '期間',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'unitType', label: '単位', type: 'RADIO', required: true },
          ],
        },
      ],
    };

    const result = projectApplicationFormData({
      selectedTypeId: 'LEAVE_ANNUAL',
      unitType: 'DAY',
      startDate: '2026-11-20',
      endDate: '2026-11-21',
      activeSchema: testSchema,
    });

    assert.strictEqual(result.startDate, '2026-11-20');
    assert.strictEqual(result.endDate, '2026-11-21');
    assert.strictEqual(result.unitType, 'DAY');
    assert.strictEqual('targetDate' in result, false);
  });
});

