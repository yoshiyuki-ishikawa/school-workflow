import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectPreTripSchema, projectApplicationFormData, assembleWorkingStateForProjection } from './pages/NewApplicationModal';
import { BusinessTripFormSection } from './components/forms/BusinessTripFormSection';
import { BusinessTripDetailView } from './components/detail/views/BusinessTripDetailView';
import { FormSchemaRegistry } from '../../server/src/services/schema/formSchemaRegistry';
import { FormValidationEngine } from '../../server/src/services/schema/formValidationEngine';
import { ApplicationFormSchema } from './types/formSchema';
import { computeResidualFacts } from './utils/computeResidualFacts';

/**
 * Business Trip Canonical v1.2 FINAL Golden Test Suite (GT-BT-01 〜 GT-BT-16)
 * 
 * Formal Verification of Canonical UI Contract v1.2 FINAL & Implementation Plan v1.2 FINAL
 */
describe('Business Trip Canonical v1.2 FINAL Golden Suite (GT-BT-01〜16)', () => {
  const tripSchema = FormSchemaRegistry.resolveActiveSchema('BUSINESS_TRIP')!;

  function validateTrip(rawValues: Record<string, any>) {
    return FormValidationEngine.validate({
      typeId: 'BUSINESS_TRIP',
      rawValues: {
        destination: '県立教育センター',
        ...rawValues,
      },
      schemaSnapshot: FormSchemaRegistry.createSnapshot(tripSchema),
    });
  }

  // =========================================================================
  // GT-BT-01: Date-only Travel Period
  // =========================================================================
  it('GT-BT-01: ペイロードに startDate と endDate のみが含まれ、startAt / endAt は含まれないこと (時刻UI排除)', () => {
    const payload = projectApplicationFormData({
      selectedTypeId: 'BUSINESS_TRIP',
      startDate: '2026-06-15',
      endDate: '2026-06-16',
      destination: '県立教育センター',
      purpose: '指導法研究協議会',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      fundingSource: '県費',
      activeSchema: tripSchema,
    });

    assert.equal(payload.startDate, '2026-06-15');
    assert.equal(payload.endDate, '2026-06-16');
    assert.equal(payload.startAt, undefined, 'startAt must NOT be in payload for BUSINESS_TRIP');
    assert.equal(payload.endAt, undefined, 'endAt must NOT be in payload for BUSINESS_TRIP');
  });

  // =========================================================================
  // GT-BT-02: No Travel Time UI
  // =========================================================================
  it('GT-BT-02: 事前申請UI (BusinessTripFormSection) に時刻入力欄が存在せず、日付入力のみであること', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BusinessTripFormSection, {
        destination: 'テスト用務先',
        setDestination: () => {},
        purpose: 'テスト用務',
        setPurpose: () => {},
        startDate: '2026-06-15',
        setStartDate: () => {},
        endDate: '2026-06-16',
        setEndDate: () => {},
        transport: '公用車',
        setTransport: () => {},
        departurePlace: '本校',
        setDeparturePlace: () => {},
        arrivalPlace: '本校',
        setArrivalPlace: () => {},
        fundingSource: '県費',
        setFundingSource: () => {},
        isOralOrder: false,
        setIsOralOrder: () => {},
        oralOrderIssuedAt: '',
        setOralOrderIssuedAt: () => {},
      })
    );

    // 日付入力は存在するが、時刻専用入力 (type="time") は存在しない
    assert.ok(markup.includes('type="date"'), 'Must have date inputs');
    assert.equal(markup.includes('type="time"'), false, 'Must NOT have time inputs');
    assert.equal(markup.includes('出発時刻'), false, 'Must NOT have departure time label');
    assert.equal(markup.includes('帰着時刻'), false, 'Must NOT have arrival time label');
  });

  // =========================================================================
  // GT-BT-03: Origin / Return Required
  // =========================================================================
  it('GT-BT-03: departurePlace (出発地) および arrivalPlace (帰着地) が REQUIRED であること', () => {
    const tripDetails = tripSchema.sections.find((s) => s.id === 'trip_details')!;
    const depField = tripDetails.fields.find((f) => f.name === 'departurePlace')!;
    const arrField = tripDetails.fields.find((f) => f.name === 'arrivalPlace')!;

    assert.equal(depField.required, true, 'departurePlace must be REQUIRED');
    assert.equal(arrField.required, true, 'arrivalPlace must be REQUIRED');

    // バリデーションエンジンでの検証 (空文字指定で必須違反を検証)
    const res = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      transport: '公用車',
      fundingSource: '県費',
      coverageStatus: 'NOT_REQUIRED',
      departurePlace: '',
      arrivalPlace: '',
    });
    assert.equal(res.valid, false);
    assert.ok(res.issues?.some((e) => e.field === 'departurePlace'));
    assert.ok(res.issues?.some((e) => e.field === 'arrivalPlace'));
  });

  // =========================================================================
  // GT-BT-04: Transport 6 Categories
  // =========================================================================
  it('GT-BT-04: 交通手段 (transport) が日本語6区分固定で定義されていること', () => {
    const tripDetails = tripSchema.sections.find((s) => s.id === 'trip_details')!;
    const transportField = tripDetails.fields.find((f) => f.name === 'transport')!;
    assert.ok(transportField.options, 'transport must have options');

    const values = transportField.options!.map((o) => o.value);
    const expected = ['公共交通機関', '公用車', '自家用車', '貸切バス', '徒歩', 'その他'];
    assert.deepEqual(values, expected);
  });

  // =========================================================================
  // GT-BT-05: Transport OTHER Conditional
  // =========================================================================
  it('GT-BT-05: transport === "その他" の場合のみ transportOther が必須となること', () => {
    const tripDetails = tripSchema.sections.find((s) => s.id === 'trip_details')!;
    const otherField = tripDetails.fields.find((f) => f.name === 'transportOther')!;

    assert.deepEqual(otherField.visibleCondition, { field: 'transport', operator: 'EQUALS', value: 'その他' });
    assert.deepEqual(otherField.requiredCondition, { field: 'transport', operator: 'EQUALS', value: 'その他' });

    // その他選択時に未入力だとエラー
    const resFail = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: 'その他',
      transportOther: '', // 未入力
      fundingSource: '県費',
      coverageStatus: 'NOT_REQUIRED',
    });
    assert.equal(resFail.valid, false);
    assert.ok(resFail.issues?.some((e) => e.field === 'transportOther'));

    // その他選択時に詳細入力ありなら通過
    const resPass = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: 'その他',
      transportOther: '定期船',
      fundingSource: '県費',
      coverageStatus: 'NOT_REQUIRED',
    });
    assert.equal(resPass.valid, true);
  });

  // =========================================================================
  // GT-BT-06: Funding Source 6 Categories
  // =========================================================================
  it('GT-BT-06: 旅費財源 (fundingSource) が日本語6区分固定で定義され REQUIRED であること', () => {
    const tripDetails = tripSchema.sections.find((s) => s.id === 'trip_details')!;
    const fundingField = tripDetails.fields.find((f) => f.name === 'fundingSource')!;
    assert.equal(fundingField.required, true);
    assert.ok(fundingField.options, 'fundingSource must have options');

    const values = fundingField.options!.map((o) => o.value);
    const expected = ['県費', '県費別枠', '市費', '主催者負担', '旅費不要', 'その他'];
    assert.deepEqual(values, expected);
  });

  // =========================================================================
  // GT-BT-07: Funding OTHER Conditional
  // =========================================================================
  it('GT-BT-07: fundingSource === "その他" の場合のみ fundingSourceOther が必須となること', () => {
    const tripDetails = tripSchema.sections.find((s) => s.id === 'trip_details')!;
    const otherField = tripDetails.fields.find((f) => f.name === 'fundingSourceOther')!;

    assert.deepEqual(otherField.visibleCondition, { field: 'fundingSource', operator: 'EQUALS', value: 'その他' });
    assert.deepEqual(otherField.requiredCondition, { field: 'fundingSource', operator: 'EQUALS', value: 'その他' });

    // その他選択時に未入力だとエラー
    const resFail = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      fundingSource: 'その他',
      fundingSourceOther: '', // 未入力
      coverageStatus: 'NOT_REQUIRED',
    });
    assert.equal(resFail.valid, false);
    assert.ok(resFail.issues?.some((e) => e.field === 'fundingSourceOther'));

    // その他選択時に詳細入力ありなら通過
    const resPass = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      fundingSource: 'その他',
      fundingSourceOther: 'PTA教育活動振興費',
      coverageStatus: 'NOT_REQUIRED',
    });
    assert.equal(resPass.valid, true);
  });

  // =========================================================================
  // GT-BT-08: fundingSource / isExpenseClaimed Separation
  // =========================================================================
  it('GT-BT-08: fundingSource の値によって isExpenseClaimed が自動上書き・自動導出されないこと', () => {
    const payload = projectApplicationFormData({
      selectedTypeId: 'BUSINESS_TRIP',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      destination: '県立教育センター',
      purpose: '指導法研究協議会',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      fundingSource: '県費',
      isExpenseClaimed: false, // 明示的 false
      activeSchema: tripSchema,
    });

    assert.equal(payload.fundingSource, '県費');
    assert.equal(payload.isExpenseClaimed, false, 'isExpenseClaimed must remain false and not be auto-derived to true');
  });

  // =========================================================================
  // GT-BT-09: Private Car Reason Not Required
  // =========================================================================
  it('GT-BT-09: 自家用車選択時に privateCarReason なしでもバリデーションが通過すること (新規入力要件廃止)', () => {
    const res = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '自家用車',
      // privateCarReason を未指定
      fundingSource: '県費',
      coverageStatus: 'NOT_REQUIRED',
    });

    assert.equal(res.valid, true, 'Must be valid without privateCarReason');
  });

  // =========================================================================
  // GT-BT-10: Historical privateCarReason Preservation
  // =========================================================================
  it('GT-BT-10: 過去データに privateCarReason が存在する場合、Detail View で安全に表示されること', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BusinessTripDetailView, {
        formData: {
          destination: '遠隔地小学校',
          transport: '自家用車',
          privateCarReason: '多量の教材運搬のため',
          startDate: '2026-05-01',
          endDate: '2026-05-01',
          departurePlace: '本校',
          arrivalPlace: '本校',
        },
      })
    );

    assert.ok(markup.includes('自家用車公務使用'));
    assert.ok(markup.includes('多量の教材運搬のため'), 'Historical privateCarReason must be rendered');
  });

  // =========================================================================
  // GT-BT-11: Coverage Three-State Contract
  // =========================================================================
  it('GT-BT-11: 授業引継ぎ (coverageStatus) が三態 (NOT_REQUIRED, REQUIRED, UNSURE) で受容されること', () => {
    for (const status of ['NOT_REQUIRED', 'REQUIRED', 'UNSURE']) {
      const covData: any = {
        purpose: '用務',
        startDate: '2026-06-15',
        endDate: '2026-06-15',
        departurePlace: '本校',
        arrivalPlace: '本校',
        transport: '公用車',
        fundingSource: '県費',
        coverageStatus: status,
      };
      if (status === 'REQUIRED') {
        covData.coverageItems = [
          {
            period: '1',
            coverageType: 'SELF_STUDY_SUPERVISION',
            targetDate: '2026-06-15',
            subjectName: '国語',
            contentNotes: '漢字プリント',
          },
        ];
      }
      const res = validateTrip(covData);
      assert.equal(res.valid, true, `Status ${status} must be valid: ${res.message || ''}`);
    }
  });

  // =========================================================================
  // GT-BT-12: Coverage Items Conditional
  // =========================================================================
  it('GT-BT-12: coverageStatus === "REQUIRED" の場合のみ coverageItems が必須となること', () => {
    const resFail = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      fundingSource: '県費',
      coverageStatus: 'REQUIRED',
      // coverageItems なし
    });
    assert.equal(resFail.valid, false);
    assert.ok(resFail.issues?.some((e) => e.field === 'coverageItems'));
  });

  // =========================================================================
  // GT-BT-13: Prior Oral Order Conditional
  // =========================================================================
  it('GT-BT-13: isOralOrder === true の場合のみ oralOrderIssuedAt が必須となること', () => {
    const resFail = validateTrip({
      purpose: '用務',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      fundingSource: '県費',
      coverageStatus: 'NOT_REQUIRED',
      isOralOrder: true,
      oralOrderIssuedAt: '', // 未入力
    });
    assert.equal(resFail.valid, false);
    assert.ok(resFail.issues?.some((e) => e.field === 'oralOrderIssuedAt'));
  });

  // =========================================================================
  // GT-BT-14: Technical Time Boundary Non-Leakage
  // =========================================================================
  it('GT-BT-14: 内部フォールバック時刻 (00:00 / 23:59) が詳細画面に旅行時刻として表示されないこと', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BusinessTripDetailView, {
        formData: {
          destination: '県立教育センター',
          startDate: '2026-06-15',
          endDate: '2026-06-16',
          startAt: '2026-06-15T00:00:00', // Technical persistence boundary
          endAt: '2026-06-16T23:59:59',   // Technical persistence boundary
          departurePlace: '本校',
          arrivalPlace: '本校',
          transport: '公用車',
          fundingSource: '県費',
        },
      })
    );

    // 00:00 や 23:59 が出張期間に露出していないこと
    assert.ok(markup.includes('2026-06-15 〜 2026-06-16'));
    assert.equal(markup.includes('00:00'), false, '00:00 must NOT leak to display');
    assert.equal(markup.includes('23:59'), false, '23:59 must NOT leak to display');
  });

  // =========================================================================
  // GT-BT-15: Post-Trip Parent Fact Read-Only
  // =========================================================================
  it('GT-BT-15: 復命スキーマ (report_details) に旅行命令親Factの再入力フィールドが存在しないこと', () => {
    const reportSection = tripSchema.sections.find((s) => s.id === 'report_details')!;
    assert.ok(reportSection, 'report_details section must exist');

    const fieldNames = reportSection.fields.map((f) => f.name);
    // 復命で入力するのは reportDate, reportResult, actualMatchesPlan 等であり、親Factの再入力は存在しない
    assert.equal(fieldNames.includes('destination'), false, 'destination must NOT be re-input in post-trip');
    assert.equal(fieldNames.includes('purpose'), false, 'purpose must NOT be re-input in post-trip');
    assert.equal(fieldNames.includes('fundingSource'), false, 'fundingSource must NOT be re-input in post-trip');
    assert.equal(fieldNames.includes('startDate'), false, 'startDate must NOT be re-input in post-trip');
    assert.equal(fieldNames.includes('endDate'), false, 'endDate must NOT be re-input in post-trip');
  });

  // =========================================================================
  // GT-BT-16: Pre/Post Lifecycle Separation
  // =========================================================================
  it('GT-BT-16: 事前起案スキーマから report_details が完全除外され、ライフサイクルが独立していること', () => {
    const projectedPreTrip = projectPreTripSchema(tripSchema);
    assert.ok(projectedPreTrip);

    const hasReportSection = projectedPreTrip.sections.some((s) => s.id === 'report_details');
    assert.equal(hasReportSection, false, 'projected pre-trip schema must NOT include report_details');
  });

  // =========================================================================
  // GT-BT-17: Canonical purpose Detail Rendering
  // =========================================================================
  it('GT-BT-17: Canonical purpose が BusinessTripDetailView 上で正準ラベル「用務」として正しく描画されること', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BusinessTripDetailView, {
        formData: {
          purpose: '公務研究協議会出席',
          destination: '県立教育センター',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          departurePlace: '本校',
          arrivalPlace: '本校',
          transport: '公用車',
        },
      })
    );

    // 1. ラベル「用務」が存在すること
    assert.ok(markup.includes('用務'));
    // 2. 値「公務研究協議会出席」が存在すること
    assert.ok(markup.includes('公務研究協議会出席'));
    // 3. 「用務地・出張先」および値「県立教育センター」と独立して併存すること
    assert.ok(markup.includes('用務地・出張先'));
    assert.ok(markup.includes('県立教育センター'));
  });

  // =========================================================================
  // GT-BT-18: Legacy reason Alias Fallback & Canonical Priority
  // =========================================================================
  it('GT-BT-18: purpose 欠損時に reason がフォールバック表示され、共存時は purpose が優先されること', () => {
    // Case A: purpose 欠損、reason のみ存在
    const markupCaseA = renderToStaticMarkup(
      React.createElement(BusinessTripDetailView, {
        formData: {
          reason: '旧形式用務',
          destination: '出張先学校',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          departurePlace: '本校',
          arrivalPlace: '本校',
          transport: '公用車',
        },
      })
    );
    assert.ok(markupCaseA.includes('用務'));
    assert.ok(markupCaseA.includes('旧形式用務'));

    // Case B: purpose と reason が共存する場合、purpose が優先される
    const markupCaseB = renderToStaticMarkup(
      React.createElement(BusinessTripDetailView, {
        formData: {
          purpose: '正準用務',
          reason: '旧形式用務',
          destination: '出張先学校',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          departurePlace: '本校',
          arrivalPlace: '本校',
          transport: '公用車',
        },
      })
    );
    assert.ok(markupCaseB.includes('正準用務'));
    assert.equal(markupCaseB.includes('旧形式用務'), false, 'Canonical purpose must take priority over reason');

    // Case C: purpose / reason ともに欠損する場合、「（未設定）」が表示される
    const markupCaseC = renderToStaticMarkup(
      React.createElement(BusinessTripDetailView, {
        formData: {
          destination: '出張先学校',
          startDate: '2026-06-15',
          endDate: '2026-06-15',
          departurePlace: '本校',
          arrivalPlace: '本校',
          transport: '公用車',
        },
      })
    );
    assert.ok(markupCaseC.includes('（未設定）'));
  });

  // =========================================================================
  // GT-BT-19: Duplicate / Residual Leakage Prevention
  // =========================================================================
  it('GT-BT-19: BUSINESS_TRIP において purpose および reason が consumedKeys で消費され Residual Facts へ流出しないこと', () => {
    const tripFormData = {
      purpose: '公務研究協議会出席',
      reason: '旧形式エイリアス',
      destination: '県立教育センター',
      transport: '公用車',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
    };

    const { consumedKeys, residuals } = computeResidualFacts(tripFormData, tripSchema);

    // DELTA-02 Invariant 1 & 2: consumedKeys に purpose と reason が含まれること
    assert.equal(consumedKeys.has('purpose'), true, 'consumedKeys must contain purpose');
    assert.equal(consumedKeys.has('reason'), true, 'consumedKeys must contain reason');

    // DELTA-02 Invariant 3 & 4: residuals 内に purpose または reason の Fact が存在しないこと
    const residualKeys = residuals.map((r) => r.key);
    assert.equal(residualKeys.includes('purpose'), false, 'residuals must NOT contain purpose');
    assert.equal(residualKeys.includes('reason'), false, 'residuals must NOT contain reason');
  });

  // =========================================================================
  // GT-BT-20 (GT-HALF-B-06): Modal Working State Hidden Time Elimination
  // =========================================================================
  it('GT-BT-20 (GT-HALF-B-06): 出張申請モーダル状態からの投影時に startAt / endAt / startTime / endTime が完全に undefined であること', () => {
    // モーダルの buildFormData は selectedTypeId === 'BUSINESS_TRIP' 時に startTime / endTime を除去する
    const modalState: any = {
      typeId: 'BUSINESS_TRIP',
      title: '出張申請',
      genericValues: {
        unitType: undefined, // 出張は unitType 未設定
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        startTime: undefined, // buildFormData により遮断
        endTime: undefined,   // buildFormData により遮断
        reason: '県外出張'
      },
      tripState: {
        destination: '教育センター',
        purpose: '県外出張',
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        departurePlace: '本校',
        arrivalPlace: '本校',
        transport: '公用車',
        fundingSource: '県費',
        isExpenseClaimed: false,
        isOralOrder: false
      }
    };

    const workingState = assembleWorkingStateForProjection(modalState);

    // GT-HALF-B-06 & GT-BT-01: 出張申請では時刻が一切合成されないこと！
    assert.equal(workingState.startTime, undefined, 'startTime must be undefined for BUSINESS_TRIP');
    assert.equal(workingState.endTime, undefined, 'endTime must be undefined for BUSINESS_TRIP');
    assert.equal(workingState.startAt, undefined, 'startAt must be undefined for BUSINESS_TRIP');
    assert.equal(workingState.endAt, undefined, 'endAt must be undefined for BUSINESS_TRIP');
  });
});
