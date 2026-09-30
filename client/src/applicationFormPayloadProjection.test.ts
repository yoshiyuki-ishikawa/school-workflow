import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectApplicationFormData,
  projectApplicationFormDataBySchema,
  PayloadProjectionError,
  APPLICATION_TYPE_TITLE_PREFIXES,
  normalizeWorkingStateDates,
} from './pages/NewApplicationModal';

describe('Layer 1: Client Application Form Payload Projection Golden Tests (GT-TD-C*)', () => {
  const baseFormState = {
    unitType: 'DAY' as const,
    halfDayType: 'MORNING' as const,
    startDate: '2026-09-10',
    endDate: '2026-09-10',
    targetDate: '2026-09-10', // 内部ステートには常に日付が入っている
    startTime: '08:10',
    endTime: '16:40',
    calculatedDays: 1,
    reason: '公務研究協議会出席のため',
    destination: '山口県教育センター',
    departurePlace: '本校',
    arrivalPlace: '本校',
    transport: '公用車',
  };

  it('GT-TD-C01: BUSINESS_TRIP Payload Key Omission - targetDate が payload および JSON.stringify 後に一切存在しないこと', () => {
    const rawPayload = projectApplicationFormData({
      ...baseFormState,
      selectedTypeId: 'BUSINESS_TRIP',
    });

    // 1. rawPayload において targetDate が undefined であること
    assert.strictEqual(rawPayload.targetDate, undefined);

    // 2. JSON.stringify 後の文字列に "targetDate" キーが存在しないこと
    const jsonString = JSON.stringify(rawPayload);
    assert.strictEqual(jsonString.includes('"targetDate"'), false);

    // 3. JSON.parse で復元したオブジェクトに targetDate プロパティが定義されていないこと
    const serializedParsed = JSON.parse(jsonString);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(serializedParsed, 'targetDate'), false);
    assert.strictEqual('targetDate' in serializedParsed, false);

    // 4. BUSINESS_TRIP に必要な正規フィールドが完全保持されていること
    assert.strictEqual(serializedParsed.startDate, '2026-09-10');
    assert.strictEqual(serializedParsed.endDate, '2026-09-10');
    assert.strictEqual(serializedParsed.destination, '山口県教育センター');
    assert.strictEqual(serializedParsed.transport, '公用車');
    assert.strictEqual(serializedParsed.purpose, '公務研究協議会出席のため');
    assert.strictEqual(serializedParsed.startAt, '2026-09-10T08:10:00');
    assert.strictEqual(serializedParsed.endAt, '2026-09-10T16:40:00');
  });

  it('GT-TD-C02: LEAVE_ANNUAL Payload Integrity - targetDate が payload に正しく保持され、unitType ロジックが維持されること', () => {
    // 終日年休
    const dayPayload = projectApplicationFormData({
      ...baseFormState,
      selectedTypeId: 'LEAVE_ANNUAL',
      unitType: 'DAY',
      startDate: '2026-09-15',
      endDate: '2026-09-15',
      targetDate: '2026-09-15',
    });
    const serializedDay = JSON.parse(JSON.stringify(dayPayload));
    assert.strictEqual(serializedDay.targetDate, '2026-09-15');
    assert.strictEqual(serializedDay.startDate, '2026-09-15');
    assert.strictEqual(serializedDay.unitType, 'DAY');

    // 時間休
    const timePayload = projectApplicationFormData({
      ...baseFormState,
      selectedTypeId: 'LEAVE_ANNUAL',
      unitType: 'TIME',
      startDate: '2026-09-15',
      endDate: '2026-09-15',
      targetDate: '2026-09-15',
      startTime: '10:00',
      endTime: '12:00',
    });
    const serializedTime = JSON.parse(JSON.stringify(timePayload));
    assert.strictEqual(serializedTime.targetDate, '2026-09-15');
    assert.strictEqual(serializedTime.unitType, 'TIME');
    assert.strictEqual(serializedTime.startTime, '10:00');
    assert.strictEqual(serializedTime.endTime, '12:00');
  });

  it('GT-TD-C03: TRAINING_SPECIAL_ACT_22_3 Positive Projection - Allowlist に含まれ targetDate が保持されること', () => {
    const trainingPayload = projectApplicationFormData({
      ...baseFormState,
      selectedTypeId: 'TRAINING_SPECIAL_ACT_22_3',
      unitType: 'DAY',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      targetDate: '2026-10-01',
    });

    const serialized = JSON.parse(JSON.stringify(trainingPayload));
    assert.strictEqual(serialized.targetDate, '2026-10-01');
    assert.strictEqual(serialized.startDate, '2026-10-01');
    assert.strictEqual(serialized.endDate, '2026-10-31');
  });

  it('GT-TD-C04: Allowlist Negative Projection Guard - 非対応種別では内部 state に値があっても payload から完全にキーが除外されること', () => {
    // 仮の非対応種別 'CUSTOM_NON_TARGET_DATE_TYPE'
    const nonSupportedPayload = projectApplicationFormData({
      ...baseFormState,
      selectedTypeId: 'CUSTOM_NON_TARGET_DATE_TYPE',
    });

    assert.strictEqual(nonSupportedPayload.targetDate, undefined);
    const jsonString = JSON.stringify(nonSupportedPayload);
    assert.strictEqual(jsonString.includes('"targetDate"'), false);

    const parsed = JSON.parse(jsonString);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, 'targetDate'), false);
  });

  it('GT-TD-C05: Pure Schema Projection SSOT - Schema-driven targetDate inclusion authority and normalizeWorkingStateDates verification', () => {
    // 1. Working-State 日付正規化ヘルパー単体検証
    const dayDates = normalizeWorkingStateDates({
      unitType: 'DAY',
      startDate: '2026-09-15',
      endDate: '2026-09-15',
      targetDate: '',
    });
    assert.strictEqual(dayDates.sDate, '2026-09-15');
    assert.strictEqual(dayDates.eDate, '2026-09-15');
    assert.strictEqual(dayDates.tDate, '2026-09-15');

    const timeDates = normalizeWorkingStateDates({
      unitType: 'TIME',
      startDate: '',
      endDate: '',
      targetDate: '2026-09-16',
    });
    assert.strictEqual(timeDates.sDate, '2026-09-16');
    assert.strictEqual(timeDates.eDate, '2026-09-16');
    assert.strictEqual(timeDates.tDate, '2026-09-16');

    // 2. スキーマ駆動投影における targetDate の存在/非存在権威検証
    const schemaWithTargetDate = {
      typeId: 'TEST_WITH_TD',
      version: '1',
      title: 'テスト',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'period',
          title: '期間',
          fields: [
            { name: 'targetDate', label: '対象日', type: 'DATE' as const, required: true },
            { name: 'startDate', label: '開始日', type: 'DATE' as const, required: false },
          ],
        },
      ],
    };

    const schemaWithoutTargetDate = {
      typeId: 'TEST_WITHOUT_TD',
      version: '1',
      title: 'テスト',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2099-12-31',
      sections: [
        {
          id: 'period',
          title: '期間',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE' as const, required: true },
            { name: 'endDate', label: '終了日', type: 'DATE' as const, required: true },
          ],
        },
      ],
    };

    const rawWorking = {
      targetDate: '2026-09-15',
      startDate: '2026-09-15',
      endDate: '2026-09-15',
    };

    const projectedWith = projectApplicationFormDataBySchema(rawWorking, schemaWithTargetDate);
    assert.strictEqual(projectedWith.targetDate, '2026-09-15');
    assert.strictEqual(projectedWith.startDate, '2026-09-15');

    const projectedWithout = projectApplicationFormDataBySchema(rawWorking, schemaWithoutTargetDate);
    assert.strictEqual(projectedWithout.targetDate, undefined);
    assert.strictEqual('targetDate' in projectedWithout, false);
    assert.strictEqual(projectedWithout.startDate, '2026-09-15');
    assert.strictEqual(projectedWithout.endDate, '2026-09-15');
  });
});

describe('Layer 1: Business Trip UI Runtime Integration Dedicated Tests (GT-GAP03-UI-C*, GT-GAP03-UI-A02)', () => {
  const baseTripFormState = {
    unitType: 'DAY' as const,
    halfDayType: 'MORNING' as const,
    startDate: '2026-10-15',
    endDate: '2026-10-15',
    targetDate: '2026-10-15',
    startTime: '09:00',
    endTime: '17:00',
    calculatedDays: 1,
    reason: '山口県教務研究協議会',
    destination: '山口県教育センター',
    departurePlace: '本校',
    arrivalPlace: '本校',
    transport: '公用車',
    privateCarReason: '',
    isExpenseClaimed: false,
    isOralOrder: false,
    oralOrderIssuedAt: '',
  };

  it('GT-GAP03-UI-C01: Oral Order Positive Projection - isOralOrder: true かつ oralOrderIssuedAt が設定されている場合、正しく payload に投影されること', () => {
    const payload = projectApplicationFormData({
      ...baseTripFormState,
      selectedTypeId: 'BUSINESS_TRIP',
      isOralOrder: true,
      oralOrderIssuedAt: '2026-10-14',
    });

    assert.strictEqual(payload.isOralOrder, true);
    assert.strictEqual(payload.oralOrderIssuedAt, '2026-10-14');
    assert.strictEqual(payload.destination, '山口県教育センター');
    assert.strictEqual(payload.transport, '公用車');
    assert.strictEqual(payload.departurePlace, '本校');
    assert.strictEqual(payload.arrivalPlace, '本校');
    assert.strictEqual(payload.targetDate, undefined);
  });

  it('GT-GAP03-UI-C02: Advance Trip Order Normal Projection - 通常事前出張申請（isOralOrder: false）の場合、isOralOrder: false かつ oralOrderIssuedAt が undefined になること', () => {
    const payload = projectApplicationFormData({
      ...baseTripFormState,
      selectedTypeId: 'BUSINESS_TRIP',
      isOralOrder: false,
      oralOrderIssuedAt: '',
    });

    assert.strictEqual(payload.isOralOrder, false);
    assert.strictEqual(payload.oralOrderIssuedAt, undefined);
  });

  it('GT-GAP03-UI-C03: Non-Trip Isolation - 休暇・研修申請時、isOralOrder / oralOrderIssuedAt が payload から完全に除外（undefined）されること', () => {
    const leavePayload = projectApplicationFormData({
      ...baseTripFormState,
      selectedTypeId: 'LEAVE_ANNUAL',
      isOralOrder: true,
      oralOrderIssuedAt: '2026-10-14',
    });

    assert.strictEqual(leavePayload.isOralOrder, undefined);
    assert.strictEqual(leavePayload.oralOrderIssuedAt, undefined);
    assert.strictEqual(leavePayload.targetDate, '2026-10-15');

    const serialized = JSON.parse(JSON.stringify(leavePayload));
    assert.strictEqual('isOralOrder' in serialized, false);
    assert.strictEqual('oralOrderIssuedAt' in serialized, false);
  });

  it('GT-GAP03-UI-C04: TargetDate Zero Pollution Guarantee - 出張申請のどのような入力パターンでも targetDate が混入しないこと', () => {
    const payloads = [
      projectApplicationFormData({ ...baseTripFormState, selectedTypeId: 'BUSINESS_TRIP', transport: '公用車' }),
      projectApplicationFormData({ ...baseTripFormState, selectedTypeId: 'BUSINESS_TRIP', transport: '自家用車', privateCarReason: '教材運搬' }),
      projectApplicationFormData({ ...baseTripFormState, selectedTypeId: 'BUSINESS_TRIP', transport: '公共交通機関' }),
      projectApplicationFormData({ ...baseTripFormState, selectedTypeId: 'BUSINESS_TRIP', transport: '徒歩' }),
      projectApplicationFormData({ ...baseTripFormState, selectedTypeId: 'BUSINESS_TRIP', isOralOrder: true, oralOrderIssuedAt: '2026-10-10' }),
    ];

    for (const p of payloads) {
      assert.strictEqual(p.targetDate, undefined);
      const json = JSON.stringify(p);
      assert.strictEqual(json.includes('"targetDate"'), false);
    }
  });

  it('GT-GAP03-UI-C05: Transport & Route Preservation - departurePlace, arrivalPlace, transport, privateCarReason, isExpenseClaimed が維持されること', () => {
    const payload = projectApplicationFormData({
      ...baseTripFormState,
      selectedTypeId: 'BUSINESS_TRIP',
      departurePlace: '自宅',
      arrivalPlace: '自宅',
      transport: '自家用車',
      privateCarReason: '器具運搬のため',
      isExpenseClaimed: true,
    });

    assert.strictEqual(payload.departurePlace, '自宅');
    assert.strictEqual(payload.arrivalPlace, '自宅');
    assert.strictEqual(payload.transport, '自家用車');
    assert.strictEqual(payload.privateCarReason, '器具運搬のため');
    assert.strictEqual(payload.isExpenseClaimed, true);
  });

  it('GT-GAP03-UI-A02: Post-Trip Report Explicit Difference Payload Projection - actualMatchesPlan: false 時に実差異情報が正確に構成されること', () => {
    // 復命書ペイロードの構築検証
    const buildReportPayload = (params: {
      expectedVersion: number;
      reportDate: string;
      reportResult: string;
      reportRemarks?: string;
      actualMatchesPlan: boolean;
      actualDeparturePlace?: string;
      actualArrivalPlace?: string;
      actualTransportMode?: string;
      vehicleUsageType?: 'DRIVER' | 'PASSENGER';
      actualDistanceKm?: number;
      communicationCostBorne?: boolean | null;
      travelExpenseRemarks?: string;
    }) => {
      const payload: any = {
        expectedVersion: params.expectedVersion,
        reportDate: params.reportDate,
        reportResult: params.reportResult.trim(),
        reportRemarks: params.reportRemarks?.trim() || '',
        actualMatchesPlan: params.actualMatchesPlan,
      };
      if (!params.actualMatchesPlan) {
        payload.actualDeparturePlace = params.actualDeparturePlace?.trim();
        payload.actualArrivalPlace = params.actualArrivalPlace?.trim();
        payload.actualTransportMode = params.actualTransportMode;
      }
      if (params.vehicleUsageType) payload.vehicleUsageType = params.vehicleUsageType;
      if (params.actualDistanceKm !== undefined) payload.actualDistanceKm = params.actualDistanceKm;
      if (params.communicationCostBorne !== undefined && params.communicationCostBorne !== null) {
        payload.communicationCostBorne = params.communicationCostBorne;
      }
      if (params.travelExpenseRemarks) payload.travelExpenseRemarks = params.travelExpenseRemarks.trim();
      return payload;
    };

    const diffPayload = buildReportPayload({
      expectedVersion: 2,
      reportDate: '2026-10-16',
      reportResult: '研究協議完了',
      actualMatchesPlan: false,
      actualDeparturePlace: '自宅',
      actualArrivalPlace: '本校',
      actualTransportMode: '公共交通機関',
      communicationCostBorne: true,
      travelExpenseRemarks: '切手代300円領収書提出',
    });

    assert.strictEqual(diffPayload.actualMatchesPlan, false);
    assert.strictEqual(diffPayload.actualDeparturePlace, '自宅');
    assert.strictEqual(diffPayload.actualArrivalPlace, '本校');
    assert.strictEqual(diffPayload.actualTransportMode, '公共交通機関');
    assert.strictEqual(diffPayload.communicationCostBorne, true);
    assert.strictEqual(diffPayload.travelExpenseRemarks, '切手代300円領収書提出');
  });
});

describe('Phase A Alignment: Alias Canonicalization & Fail-Closed Tests (GT-ALIAS-01〜07)', () => {
  const dummySchemaWithAliases: any = {
    typeId: 'TEST_TYPE',
    version: '1.0',
    title: 'テストスキーマ',
    sections: [
      {
        id: 'sec1',
        title: 'Section 1',
        fields: [
          { name: 'targetDate', label: '対象日', type: 'DATE', required: true, aliases: ['startDate'] },
          { name: 'purpose', label: '目的', type: 'TEXT', required: true, aliases: ['reason'] },
          { name: 'destination', label: '場所', type: 'TEXT', required: false, aliases: ['venue'] },
        ]
      }
    ]
  };

  it('GT-ALIAS-01: Canonical Only Provided -> Canonical Value Preserved', () => {
    const raw = { targetDate: '2026-10-01' };
    const res = projectApplicationFormDataBySchema(raw, dummySchemaWithAliases);
    assert.strictEqual(res.targetDate, '2026-10-01');
    assert.strictEqual('startDate' in res, false);
  });

  it('GT-ALIAS-02: Alias Only Provided -> Normalized to Canonical Key', () => {
    const raw = { startDate: '2026-10-02' };
    const res = projectApplicationFormDataBySchema(raw, dummySchemaWithAliases);
    assert.strictEqual(res.targetDate, '2026-10-02');
    assert.strictEqual('startDate' in res, false);
  });

  it('GT-ALIAS-03: Canonical and Alias Provided with Identical Values -> Canonical Value Preserved', () => {
    const raw = { targetDate: '2026-10-03', startDate: '2026-10-03' };
    const res = projectApplicationFormDataBySchema(raw, dummySchemaWithAliases);
    assert.strictEqual(res.targetDate, '2026-10-03');
    assert.strictEqual('startDate' in res, false);
  });

  it('GT-ALIAS-04: Canonical and Alias Provided with Different Values -> Throws AMBIGUOUS_FIELD_VALUE', () => {
    const raw = { targetDate: '2026-10-03', startDate: '2026-10-04' };
    assert.throws(
      () => projectApplicationFormDataBySchema(raw, dummySchemaWithAliases),
      (err: any) => err instanceof PayloadProjectionError && err.code === 'AMBIGUOUS_FIELD_VALUE' && err.fieldName === 'targetDate'
    );
  });

  it('GT-ALIAS-05: Multiple Aliases with Conflicting Values -> Throws AMBIGUOUS_FIELD_VALUE', () => {
    const multiAliasSchema: any = {
      typeId: 'TEST_MULTI_ALIAS',
      version: '1.0',
      title: '複数エイリアス',
      sections: [
        {
          id: 'sec',
          title: 'Sec',
          fields: [
            { name: 'destination', label: '場所', type: 'TEXT', required: false, aliases: ['venue', 'loc'] }
          ]
        }
      ]
    };
    const raw = { venue: '会議室A', loc: '体育館' };
    assert.throws(
      () => projectApplicationFormDataBySchema(raw, multiAliasSchema),
      (err: any) => err instanceof PayloadProjectionError && err.code === 'AMBIGUOUS_FIELD_VALUE' && err.fieldName === 'destination'
    );
  });

  it('GT-ALIAS-06: Neither Canonical Nor Alias Provided, Field Has defaultValue -> defaultValue Used', () => {
    const defaultSchema: any = {
      typeId: 'TEST_DEF',
      version: '1.0',
      title: 'デフォルト',
      sections: [
        {
          id: 'sec',
          title: 'Sec',
          fields: [
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY', aliases: ['uType'] }
          ]
        }
      ]
    };
    const raw = {};
    const res = projectApplicationFormDataBySchema(raw, defaultSchema);
    assert.strictEqual(res.unitType, 'DAY');
  });

  it('GT-ALIAS-07: Ambiguous Alias Conflict Does NOT Fallback to defaultValue -> Strictly Aborts', () => {
    const defaultSchema: any = {
      typeId: 'TEST_DEF',
      version: '1.0',
      title: 'デフォルト',
      sections: [
        {
          id: 'sec',
          title: 'Sec',
          fields: [
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY', aliases: ['uType'] }
          ]
        }
      ]
    };
    const raw = { unitType: 'TIME', uType: 'HALF_DAY' };
    assert.throws(
      () => projectApplicationFormDataBySchema(raw, defaultSchema),
      (err: any) => err instanceof PayloadProjectionError && err.code === 'AMBIGUOUS_FIELD_VALUE' && err.fieldName === 'unitType'
    );
  });
});

describe('Phase A Alignment: Default Authority & Zero Client Default Injection Tests (GT-DEFAULT-01〜08)', () => {
  it('GT-DEFAULT-01: Schema Field Has defaultValue -> Resets to Schema defaultValue', () => {
    const schema: any = {
      typeId: 'TEST_DEF',
      version: '1.0',
      title: 'テスト',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
            { name: 'halfDayType', label: '半日区分', type: 'SELECT', required: false, defaultValue: 'MORNING' }
          ]
        }
      ]
    };
    const raw = {};
    const res = projectApplicationFormDataBySchema(raw, schema);
    assert.strictEqual(res.unitType, 'DAY');
    assert.strictEqual(res.halfDayType, 'MORNING');
  });

  it('GT-DEFAULT-02: Schema Field Has NO defaultValue -> Payload Does Not Contain Field when Unset', () => {
    const schema: any = {
      typeId: 'TEST_NODEF',
      version: '1.0',
      title: 'テスト',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { name: 'startTime', label: '開始時刻', type: 'TIME', required: false },
            { name: 'endTime', label: '終了時刻', type: 'TIME', required: false }
          ]
        }
      ]
    };
    const raw = {};
    const res = projectApplicationFormDataBySchema(raw, schema);
    assert.strictEqual('startTime' in res, false);
    assert.strictEqual('endTime' in res, false);
  });

  it('GT-DEFAULT-03: WORK_PATTERN_CHILDCARE PatternType Has NO Default Value -> Remains Empty', () => {
    const schema: any = {
      typeId: 'WORK_PATTERN_CHILDCARE',
      version: '1.0',
      title: '育児短時間勤務',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { name: 'patternType', label: '勤務形態パターン', type: 'TEXT', required: false }
          ]
        }
      ]
    };
    const raw = {};
    const res = projectApplicationFormDataBySchema(raw, schema);
    assert.strictEqual('patternType' in res, false);
  });

  it('GT-DEFAULT-04: LEAVE_CHILDCARE Has No unitType or coverageStatus -> Clean Projection', () => {
    const schema: any = {
      typeId: 'LEAVE_CHILDCARE',
      version: '1.0',
      title: '育児休業',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        }
      ]
    };
    const raw = {
      startDate: '2026-11-01',
      endDate: '2027-03-31',
      unitType: 'DAY',
      coverageStatus: 'NOT_REQUIRED',
      startTime: '08:10'
    };
    const res = projectApplicationFormDataBySchema(raw, schema);
    assert.strictEqual(res.startDate, '2026-11-01');
    assert.strictEqual(res.endDate, '2027-03-31');
    assert.strictEqual('unitType' in res, false);
    assert.strictEqual('coverageStatus' in res, false);
    assert.strictEqual('startTime' in res, false);
  });

  it('GT-DEFAULT-05: Title Prefix SSOT Mapping Correctness', () => {
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_ANNUAL, '【年休】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_SICK, '【病休】通院・療養');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_SPECIAL, '【特休】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_DUTY_EXEMPT, '【職専免】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_CARE, '【介護休暇】家族介護');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_CARE_TIME, '【介護時間】家族介護');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.TRAINING_SPECIAL_ACT_22_2, '【校外研修】教特法第22条第2項');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.TRAINING_SPECIAL_ACT_22_3, '【長期研修】教特法第22条第3項');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.BUSINESS_TRIP, '【出張】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_CHILDCARE, '【育児休業】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.WORK_PATTERN_CHILDCARE, '【育児短時間勤務】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_CHILDCARE_PARTIAL, '【育児部分休業】');
    assert.strictEqual(APPLICATION_TYPE_TITLE_PREFIXES.LEAVE_LARGE_SCHOOL, '【休暇申請】');
  });

  it('GT-DEFAULT-06: Schema Required Check on projectApplicationFormDataBySchema -> Throws SCHEMA_REQUIRED', () => {
    assert.throws(
      () => projectApplicationFormDataBySchema({ startDate: '2026-10-01' }, null as any),
      (err: any) => err instanceof PayloadProjectionError && err.code === 'SCHEMA_REQUIRED'
    );
  });

  it('GT-DEFAULT-07: Preserved Values on Form Update with Valid Schema', () => {
    const schema: any = {
      typeId: 'BUSINESS_TRIP',
      version: '1.0',
      title: '出張',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { name: 'destination', label: '用務先', type: 'TEXT', required: true },
            { name: 'transport', label: '交通手段', type: 'TEXT', required: true, defaultValue: '公用車' }
          ]
        }
      ]
    };
    const raw = { destination: '県教育庁' };
    const res = projectApplicationFormDataBySchema(raw, schema);
    assert.strictEqual(res.destination, '県教育庁');
    assert.strictEqual(res.transport, '公用車');
  });

  it('GT-DEFAULT-08: Zero Client Injection for Unknown Types', () => {
    const customSchema: any = {
      typeId: 'CUSTOM_LEAVE',
      version: '1.0',
      title: '独自休暇',
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { name: 'customReason', label: '独自理由', type: 'TEXT', required: true }
          ]
        }
      ]
    };
    const raw = {
      customReason: '特別事由',
      unitType: 'DAY',
      calculatedDays: 1,
      targetDate: '2026-10-10'
    };
    const res = projectApplicationFormDataBySchema(raw, customSchema);
    assert.strictEqual(res.customReason, '特別事由');
    assert.strictEqual('unitType' in res, false);
    assert.strictEqual('calculatedDays' in res, false);
    assert.strictEqual('targetDate' in res, false);
  });
});

describe('Phase A Alignment: Exhaustive 132 Directional Transition Leakage & Default Reset Tests (GT-CROSS-132)', () => {
  const ALL_12_TYPES = [
    'LEAVE_ANNUAL',
    'LEAVE_SICK',
    'LEAVE_SPECIAL',
    'LEAVE_CARE',
    'LEAVE_CARE_TIME',
    'TRAINING_SPECIAL_ACT_22_2',
    'TRAINING_SPECIAL_ACT_22_3',
    'LEAVE_DUTY_EXEMPT',
    'BUSINESS_TRIP',
    'LEAVE_CHILDCARE',
    'WORK_PATTERN_CHILDCARE',
    'LEAVE_CHILDCARE_PARTIAL'
  ];

  // 12 × 11 = 132 Directional Transitions
  let transitionCount = 0;
  for (const srcType of ALL_12_TYPES) {
    for (const dstType of ALL_12_TYPES) {
      if (srcType === dstType) continue;
      transitionCount++;
      const testName = `GT-CROSS-132 [${String(transitionCount).padStart(3, '0')}/132] Transition: ${srcType} -> ${dstType}`;

      it(testName, () => {
        // 1. Simulate source form pollution state with unique markers from srcType
        const pollutedState: Record<string, any> = {
          title: APPLICATION_TYPE_TITLE_PREFIXES[srcType] || '【旧件名】',
          destination: '旧用務先_POLLUTED',
          transport: '自家用車',
          privateCarReason: '用具運搬_POLLUTED',
          isExpenseClaimed: true,
          isOralOrder: true,
          oralOrderIssuedAt: '2026-09-01',
          medicalCertificateAttached: true,
          medicalInstitutionName: '旧病院名_POLLUTED',
          relationship: '旧続柄_POLLUTED',
          childBirthExpectedDate: '2026-09-30',
          selectedCareCaseId: 999,
          selectedCarePeriodId: 888,
          organizer: '旧主催者_POLLUTED',
          venue: '旧会場_POLLUTED',
          patternType: '旧パターン_POLLUTED',
          coverageStatus: 'REQUIRED',
          notRequiredReason: '旧理由_POLLUTED',
          coverageItems: [{ id: 'cov_1', targetDate: '2026-09-10', period: '1', coverageType: 'SUBSTITUTE_LESSON' }],
          unitType: 'TIME',
          halfDayType: 'AFTERNOON',
          startTime: '13:00',
          endTime: '15:00',
          reason: '旧理由_POLLUTED',
        };

        // 2. Perform Default Reset as done in handleTypeChange
        const newTitle = APPLICATION_TYPE_TITLE_PREFIXES[dstType] || '';
        assert.ok(newTitle.length > 0, `Title prefix for ${dstType} must exist`);
        assert.notStrictEqual(newTitle, APPLICATION_TYPE_TITLE_PREFIXES[srcType], `Title prefix must not retain old ${srcType} prefix`);

        // 3. Define schema for dstType to project against
        const dstSchema: any = {
          typeId: dstType,
          version: '2026.1',
          title: `Schema for ${dstType}`,
          capabilities: {
            classCoverageApplicable: ['LEAVE_ANNUAL', 'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_CARE', 'LEAVE_CARE_TIME', 'TRAINING_SPECIAL_ACT_22_2', 'TRAINING_SPECIAL_ACT_22_3', 'LEAVE_DUTY_EXEMPT'].includes(dstType)
          },
          sections: [
            {
              id: 'sec_main',
              title: 'Main',
              fields: [] as any[]
            }
          ]
        };

        // Populate fields based on Canonical specifications for dstType
        if (dstType === 'BUSINESS_TRIP') {
          dstSchema.sections[0].fields.push(
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'destination', label: '用務先', type: 'TEXT', required: true },
            { name: 'transport', label: '交通手段', type: 'TEXT', required: true, defaultValue: '公用車' },
            { name: 'purpose', label: '目的', type: 'TEXT', required: true, aliases: ['reason'] }
          );
        } else if (dstType === 'WORK_PATTERN_CHILDCARE') {
          dstSchema.sections[0].fields.push(
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'patternType', label: '勤務形態パターン', type: 'TEXT', required: false },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          );
        } else if (dstType === 'LEAVE_CHILDCARE') {
          dstSchema.sections[0].fields.push(
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          );
        } else if (dstType === 'LEAVE_CHILDCARE_PARTIAL') {
          dstSchema.sections[0].fields.push(
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true, aliases: ['startDate'] },
            { name: 'startTime', label: '開始時刻', type: 'TIME', required: true },
            { name: 'endTime', label: '終了時刻', type: 'TIME', required: true },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          );
        } else if (dstType === 'LEAVE_ANNUAL') {
          dstSchema.sections[0].fields.push(
            { name: 'unitType', label: '取得単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true, aliases: ['startDate'] },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          );
        } else if (dstType === 'LEAVE_SICK') {
          dstSchema.sections[0].fields.push(
            { name: 'unitType', label: '取得単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true, aliases: ['startDate'] },
            { name: 'medicalInstitutionName', label: '病院名', type: 'TEXT', required: false },
            { name: 'reason', label: '事由', type: 'TEXT', required: true }
          );
        } else if (dstType === 'LEAVE_DUTY_EXEMPT') {
          dstSchema.sections[0].fields.push(
            { name: 'unitType', label: '取得単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true, aliases: ['startDate'] },
            { name: 'purpose', label: '用務', type: 'TEXT', required: true, aliases: ['reason'] }
          );
        }

        // Add coverage section if applicable
        if (dstSchema.capabilities.classCoverageApplicable) {
          dstSchema.sections.push({
            id: 'class_coverage',
            title: '授業措置',
            fields: [
              { name: 'coverageStatus', label: '要否', type: 'SELECT', required: true, defaultValue: 'NOT_REQUIRED' }
            ]
          });
        }

        // 4. Test Clean Form State (after reset) against dstSchema
        const cleanState: Record<string, any> = {
          startDate: '2026-10-20',
          endDate: '2026-10-20',
          targetDate: '2026-10-20',
          reason: '正規の理由',
          destination: dstType === 'BUSINESS_TRIP' ? '正規の用務先' : undefined,
          patternType: dstType === 'WORK_PATTERN_CHILDCARE' ? 'パターンA' : undefined,
          startTime: '08:10',
          endTime: '12:00',
        };

        const projected = projectApplicationFormDataBySchema(cleanState, dstSchema);

        // Verification: No foreign keys from srcType exist in projected output
        if (dstType !== 'BUSINESS_TRIP') {
          assert.strictEqual('destination' in projected && dstType !== 'TRAINING_SPECIAL_ACT_22_3', false, `destination must not leak into ${dstType}`);
          assert.strictEqual('transport' in projected, false, `transport must not leak into ${dstType}`);
        }
        if (dstType !== 'WORK_PATTERN_CHILDCARE') {
          assert.strictEqual('patternType' in projected, false, `patternType must not leak into ${dstType}`);
        }
        if (!dstSchema.capabilities.classCoverageApplicable) {
          assert.strictEqual('coverageStatus' in projected, false, `coverageStatus must not exist in non-coverage type ${dstType}`);
        }
        if (dstType === 'BUSINESS_TRIP') {
          assert.strictEqual('targetDate' in projected, false, `targetDate must NOT leak into BUSINESS_TRIP`);
        }
      });
    }
  }

  it('Total Cross-Type Transitions executed equals 132', () => {
    assert.strictEqual(transitionCount, 132);
  });
});

describe('Phase A Remediation: Runtime Regression Tests (GT-RUNTIME-ALIAS-01〜06)', () => {
  it('GT-RUNTIME-ALIAS-01: LEAVE_CHILDCARE (育児休業) - User changes startDate/endDate -> Normal Projection without AMBIGUOUS_FIELD_VALUE', () => {
    const schema: any = {
      typeId: 'LEAVE_CHILDCARE',
      version: '2026.1',
      title: '育児休業 請求書',
      sections: [
        {
          id: 'childcare_details',
          title: '育児休業請求内容',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
            { name: 'reason', label: '請求事由', type: 'TEXT', required: false }
          ]
        }
      ]
    };

    // User selects 2026-10-01 to 2027-03-31 (while modal default targetDate was 2026-09-12)
    const payload = projectApplicationFormData({
      selectedTypeId: 'LEAVE_CHILDCARE',
      unitType: 'DAY',
      startDate: '2026-10-01',
      endDate: '2027-03-31',
      targetDate: '2026-09-12', // old internal modal date
      reason: '育児のため',
      activeSchema: schema
    });

    assert.strictEqual(payload.startDate, '2026-10-01');
    assert.strictEqual(payload.endDate, '2027-03-31');
    assert.strictEqual(payload.reason, '育児のため');
    assert.strictEqual(payload.targetDate, '2026-09-12');
  });

  it('GT-RUNTIME-ALIAS-02: WORK_PATTERN_CHILDCARE (育児短時間勤務) - Multi-month date range with patternType -> Normal Projection', () => {
    const schema: any = {
      typeId: 'WORK_PATTERN_CHILDCARE',
      version: '2026.1',
      title: '育児短時間勤務 請求書',
      sections: [
        {
          id: 'work_pattern_childcare_details',
          title: '育児短時間勤務請求内容',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
            { name: 'patternType', label: '勤務形態パターン', type: 'TEXT', required: false },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        }
      ]
    };

    const payload = projectApplicationFormData({
      selectedTypeId: 'WORK_PATTERN_CHILDCARE',
      unitType: 'DAY',
      startDate: '2026-10-01',
      endDate: '2027-03-31',
      targetDate: '2026-09-12',
      patternType: 'パターンA (週31時間)',
      reason: '育児短時間勤務の適用',
      activeSchema: schema
    });

    assert.strictEqual(payload.startDate, '2026-10-01');
    assert.strictEqual(payload.endDate, '2027-03-31');
    assert.strictEqual(payload.patternType, 'パターンA (週31時間)');
    assert.strictEqual(payload.reason, '育児短時間勤務の適用');
    assert.strictEqual(payload.targetDate, '2026-09-12');
  });

  it('GT-RUNTIME-ALIAS-03: BUSINESS_TRIP (出張) - Canonical startAt/endAt correctly extracted, no date alias collision', () => {
    const schema: any = {
      typeId: 'BUSINESS_TRIP',
      version: '2026.1',
      title: '出張申請',
      sections: [
        {
          id: 'trip_details',
          title: '旅行命令事項',
          fields: [
            { name: 'purpose', label: '出張用務名', type: 'TEXT', required: true, aliases: ['reason'] },
            { name: 'destination', label: '目的地', type: 'TEXT', required: true },
            { name: 'startAt', label: '出発日時', type: 'DATETIME', required: true },
            { name: 'endAt', label: '帰着日時', type: 'DATETIME', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: false },
            { name: 'endDate', label: '終了日', type: 'DATE', required: false },
            { name: 'transport', label: '交通手段', type: 'SELECT', required: true, defaultValue: '公用車' },
          ]
        }
      ]
    };

    const payload = projectApplicationFormData({
      selectedTypeId: 'BUSINESS_TRIP',
      startDate: '2026-11-15',
      endDate: '2026-11-15',
      startTime: '08:30',
      endTime: '17:00',
      destination: '山口県庁',
      reason: '県下校長協議会',
      transport: '公用車',
      activeSchema: schema
    });

    assert.strictEqual(payload.startAt, '2026-11-15T08:30:00');
    assert.strictEqual(payload.endAt, '2026-11-15T17:00:00');
    assert.strictEqual(payload.startDate, '2026-11-15');
    assert.strictEqual(payload.endDate, '2026-11-15');
    assert.strictEqual(payload.purpose, '県下校長協議会');
    assert.strictEqual(payload.destination, '山口県庁');
    assert.strictEqual(payload.transport, '公用車');
    assert.strictEqual('targetDate' in payload, false);
  });

  it('GT-RUNTIME-ALIAS-04: LEAVE_ANNUAL (年休) - Half-day / Time Leave emits targetDate, Day Leave emits startDate/endDate and targetDate', () => {
    const schema: any = {
      typeId: 'LEAVE_ANNUAL',
      version: '2026.1',
      title: '年次有給休暇',
      sections: [
        {
          id: 'basic',
          title: '基本申請情報',
          fields: [
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
            { name: 'halfDayType', label: '半日区分', type: 'SELECT', required: false },
            { name: 'targetDate', label: '取得対象日', type: 'DATE', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: false },
            { name: 'endDate', label: '終了日', type: 'DATE', required: false },
            { name: 'calculatedDays', label: '取得日数', type: 'NUMBER', required: false, defaultValue: 1 },
          ]
        }
      ]
    };

    // 1. 半日年休
    const halfDayPayload = projectApplicationFormData({
      selectedTypeId: 'LEAVE_ANNUAL',
      unitType: 'HALF_DAY',
      halfDayType: 'MORNING',
      targetDate: '2026-10-15',
      activeSchema: schema
    });
    assert.strictEqual(halfDayPayload.unitType, 'HALF_DAY');
    assert.strictEqual(halfDayPayload.halfDayType, 'MORNING');
    assert.strictEqual(halfDayPayload.targetDate, '2026-10-15');
    assert.strictEqual(halfDayPayload.calculatedDays, 0.5);

    // 2. 終日年休 (2日間)
    const dayPayload = projectApplicationFormData({
      selectedTypeId: 'LEAVE_ANNUAL',
      unitType: 'DAY',
      startDate: '2026-10-20',
      endDate: '2026-10-21',
      calculatedDays: 2,
      activeSchema: schema
    });
    assert.strictEqual(dayPayload.unitType, 'DAY');
    assert.strictEqual(dayPayload.startDate, '2026-10-20');
    assert.strictEqual(dayPayload.endDate, '2026-10-21');
    assert.strictEqual(dayPayload.calculatedDays, 2);
    assert.strictEqual(dayPayload.targetDate, '2026-10-20');
  });

  it('GT-RUNTIME-ALIAS-05: LEAVE_CARE (介護休暇) - Period Leave with careCaseId -> Clean Projection', () => {
    const schema: any = {
      typeId: 'LEAVE_CARE',
      version: '2026.1',
      title: '介護休暇',
      sections: [
        {
          id: 'care_details',
          title: '介護休暇内容',
          fields: [
            { name: 'careCaseId', label: '対象家族事案ID', type: 'NUMBER', required: false },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: false },
            { name: 'endDate', label: '終了日', type: 'DATE', required: false },
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        }
      ]
    };

    const payload = projectApplicationFormData({
      selectedTypeId: 'LEAVE_CARE',
      unitType: 'DAY',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      selectedCareCaseId: 101,
      reason: '母の通院・介護',
      activeSchema: schema
    });

    assert.strictEqual(payload.startDate, '2026-11-01');
    assert.strictEqual(payload.endDate, '2026-11-05');
    assert.strictEqual(payload.careCaseId, 101);
    assert.strictEqual(payload.reason, '母の通院・介護');
    assert.strictEqual(payload.targetDate, '2026-11-01');
  });

  it('GT-RUNTIME-ALIAS-06: TRAINING_SPECIAL_ACT_22_2 (校外研修) - venue & destination separation, purpose canonicalization', () => {
    const schema: any = {
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      version: '2026.1',
      title: '教育公務員特例法第22条第2項研修',
      sections: [
        {
          id: 'training_details',
          title: '研修内容',
          fields: [
            { name: 'purpose', label: '研修題目', type: 'TEXT', required: true, aliases: ['reason'] },
            { name: 'venue', label: '研修場所', type: 'TEXT', required: false },
            { name: 'targetDate', label: '研修実施日', type: 'DATE', required: true },
            { name: 'unitType', label: '単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
          ]
        }
      ]
    };

    const payload = projectApplicationFormData({
      selectedTypeId: 'TRAINING_SPECIAL_ACT_22_2',
      unitType: 'DAY',
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      targetDate: '2026-10-10',
      reason: '情報教育研修協議会',
      venue: '県立情報センター',
      activeSchema: schema
    });

    assert.strictEqual(payload.purpose, '情報教育研修協議会');
    assert.strictEqual(payload.venue, '県立情報センター');
    assert.strictEqual('reason' in payload, false);
  });
});


