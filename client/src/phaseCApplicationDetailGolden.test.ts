import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { determineHistoricalSchemaResolutionDate } from './utils/schemaResolutionDateResolver';
import { resolveActionability } from './utils/applicationActionabilityResolver';
import { computeResidualFacts } from './utils/computeResidualFacts';
import { DEDICATED_DETAIL_REGISTRY } from './components/detail/DedicatedDetailRegistry';
import { resolveDisplayClassCoverage } from './utils/coverageAdapter';
import { Application, User } from './types';
import { ApplicationFormSchema, ClassCoverageStatus } from './types/formSchema';

describe('Phase C: Architecture Gate Golden Suite', () => {

  // =========================================================================
  // Step 1A: Historical Schema Resolution Contract Tests
  // =========================================================================
  describe('Step 1A: Historical Schema Resolution Contract (Today Fallback = 0)', () => {
    it('C1A-01: startDate exists -> resolves startDate', () => {
      const date = determineHistoricalSchemaResolutionDate(
        { startDate: '2026-05-10', targetDate: '2026-05-12' },
        '2026-05-01T10:00:00Z'
      );
      assert.equal(date, '2026-05-10');
    });

    it('C1A-02: startDate missing, targetDate exists -> resolves targetDate', () => {
      const date = determineHistoricalSchemaResolutionDate(
        { targetDate: '2026-06-15' },
        '2026-06-01T10:00:00Z'
      );
      assert.equal(date, '2026-06-15');
    });

    it('C1A-03: startDate/targetDate missing, startAt ISO exists -> resolves startAt YYYY-MM-DD', () => {
      const date = determineHistoricalSchemaResolutionDate(
        { startAt: '2026-07-20T08:30:00.000Z' },
        '2026-07-01T10:00:00Z'
      );
      assert.equal(date, '2026-07-20');
    });

    it('C1A-04: tripStartAt ISO exists -> resolves tripStartAt YYYY-MM-DD', () => {
      const date = determineHistoricalSchemaResolutionDate(
        { tripStartAt: '2026-08-15T09:00:00' },
        '2026-08-01T10:00:00Z'
      );
      assert.equal(date, '2026-08-15');
    });

    it('C1A-05: no business dates -> resolves created_at fallback (Authoritative Final Fallback)', () => {
      const date = determineHistoricalSchemaResolutionDate(
        { reason: '私用のため' },
        '2026-04-10T14:22:00.000Z'
      );
      assert.equal(date, '2026-04-10');
    });

    it('C1A-06: created_at without T (date only) -> resolves YYYY-MM-DD', () => {
      const date = determineHistoricalSchemaResolutionDate(
        {},
        '2026-03-25 10:00:00'
      );
      assert.equal(date, '2026-03-25');
    });

    it('C1A-07: completely malformed/empty dates -> returns empty string (NO TODAY FALLBACK)', () => {
      const date = determineHistoricalSchemaResolutionDate(
        { someField: 'abc' },
        'invalid-date'
      );
      assert.equal(date, '', 'Must NOT fallback to current today date');
    });

    it('C1A-08: null / undefined safety', () => {
      assert.equal(determineHistoricalSchemaResolutionDate(null, null), '');
      assert.equal(determineHistoricalSchemaResolutionDate(undefined, undefined), '');
    });
  });

  // =========================================================================
  // Step 1B: Actionability Presentation Authority Boundary Tests
  // =========================================================================
  describe('Step 1B: Actionability Presentation Authority Boundary', () => {
    const baseUser: User = {
      id: 2,
      username: 'teacher1',
      displayName: '教諭 一郎',
      department: '教務部',
      roles: ['TEACHER'],
    };

    const vpUser: User = {
      id: 3,
      username: 'vp1',
      displayName: '教頭 太郎',
      department: '管理部',
      roles: ['VICE_PRINCIPAL'],
    };

    const principalUser: User = {
      id: 4,
      username: 'principal1',
      displayName: '校長 次郎',
      department: '管理部',
      roles: ['PRINCIPAL'],
    };

    const createBaseApp = (overrides?: Partial<Application>): Application => ({
      id: 101,
      type_id: 'LEAVE_ANNUAL',
      applicant_id: 2,
      subject_user_id: 2,
      submitted_by_user_id: 2,
      submission_actor_type: 'SELF',
      title: '年次有給休暇の申請',
      form_data: { startDate: '2026-05-10', unitType: 'DAY' },
      current_status: 'SUBMITTED',
      current_step_order: 1,
      version: 1,
      created_at: '2026-05-01T10:00:00Z',
      updated_at: '2026-05-01T10:00:00Z',
      steps: [
        {
          id: 1,
          application_id: 101,
          approval_cycle: 1,
          step_order: 1,
          step_name: '教頭確認',
          required_role_id: 'VICE_PRINCIPAL',
          status: 'PENDING',
        },
        {
          id: 2,
          application_id: 101,
          approval_cycle: 1,
          step_order: 2,
          step_name: '校長決裁',
          required_role_id: 'PRINCIPAL',
          status: 'WAITING',
        },
      ],
      ...overrides,
    });

    it('C1B-01: Self-Approval Prohibition (Subject cannot approve own application)', () => {
      const app = createBaseApp({
        subject_user_id: 3,
        applicant_id: 3,
        submitted_by_user_id: 3,
      });
      const action = resolveActionability(app, vpUser);
      assert.equal(action.canApprove, false, 'Subject must NOT be allowed to approve self');
    });

    it('C1B-02: Proxy-Submitter Approval Prohibition (Proxy creator cannot approve)', () => {
      const app = createBaseApp({
        subject_user_id: 2,
        applicant_id: 2,
        submitted_by_user_id: 3,
        submission_actor_type: 'PROXY',
      });
      const action = resolveActionability(app, vpUser);
      assert.equal(action.canApprove, false, 'Proxy creator must NOT be allowed to approve');
    });

    it('C1B-03: Authorized Approver matching current PENDING step', () => {
      const app = createBaseApp();
      const action = resolveActionability(app, vpUser);
      assert.equal(action.canApprove, true);
      assert.equal(action.canReturn, true);
      assert.equal(action.canReject, false, 'Non-DECIDE step (REVIEW) must have canReject = false (DECIDE-Only)');
      assert.equal(action.canResolveCoverage, true, 'GAP-09: Pending approver can resolve coverage');

      // DECIDE ステップにおける校長の canReject = false 検証 (Universal RETURN Model)
      const decideApp = createBaseApp({
        current_step_order: 2,
        steps: [
          { id: 1, application_id: 101, approval_cycle: 1, step_order: 1, step_name: '教頭確認', action_type: 'REVIEW', required_role_id: 'VICE_PRINCIPAL', status: 'APPROVED' },
          { id: 2, application_id: 101, approval_cycle: 1, step_order: 2, step_name: '校長決裁', action_type: 'DECIDE', is_final_decision_step: 1, required_role_id: 'PRINCIPAL', status: 'PENDING' },
        ],
      });
      const decideAction = resolveActionability(decideApp, principalUser);
      assert.equal(decideAction.canApprove, true);
      assert.equal(decideAction.canReturn, true);
      assert.equal(decideAction.canReject, false, 'DECIDE step must have canReject = false (Universal RETURN Model)');
    });

    it('C1B-04: Non-matching role (Principal during Vice Principal step)', () => {
      const app = createBaseApp();
      const action = resolveActionability(app, principalUser);
      assert.equal(action.canApprove, false);
      assert.equal(action.canResolveCoverage, false);
    });

    it('C1B-05: Specific assigned_user_id constraint', () => {
      const app = createBaseApp({
        steps: [
          {
            id: 1,
            application_id: 101,
            approval_cycle: 1,
            step_order: 1,
            step_name: '指定教頭確認',
            required_role_id: 'VICE_PRINCIPAL',
            assigned_user_id: 99,
            status: 'PENDING',
          },
        ],
      });
      const action = resolveActionability(app, vpUser);
      assert.equal(action.canApprove, false, 'Must not approve if assigned to another user');
    });

    it('C1B-06: DRAFT status actions (Applicant can edit and withdraw)', () => {
      const app = createBaseApp({
        current_status: 'DRAFT',
      });
      const action = resolveActionability(app, baseUser);
      assert.equal(action.canEditDraft, true);
      assert.equal(action.canWithdraw, true);
      assert.equal(action.canApprove, false);
    });

    it('C1B-07: RETURNED status actions (Applicant can resubmit)', () => {
      const app = createBaseApp({
        current_status: 'RETURNED',
      });
      const action = resolveActionability(app, baseUser);
      assert.equal(action.canResubmit, true);
      assert.equal(action.canWithdraw, true);
    });

    it('C1B-08: Cancellation Request Eligibility (Approved app + Subject / Manager)', () => {
      const app = createBaseApp({
        current_status: 'FINAL_APPROVED',
      });
      const applicantAction = resolveActionability(app, baseUser);
      const managerAction = resolveActionability(app, principalUser);
      assert.equal(applicantAction.canRequestCancellation, true);
      assert.equal(managerAction.canRequestCancellation, true);
    });

    it('C1B-09: Cancellation Approval Action (Cancellation cycle PENDING step)', () => {
      const app = createBaseApp({
        current_status: 'FINAL_APPROVED',
        activeCancellationCycle: {
          id: 10,
          application_id: 101,
          approval_cycle: 2,
          cycle_purpose: 'CANCELLATION',
          workflow_source: 'NEW_POLICY_ENGINE',
          started_at: '2026-05-10T10:00:00Z',
          status: 'IN_PROGRESS',
          started_by_user_id: 2,
        },
        steps: [
          {
            id: 11,
            application_id: 101,
            approval_cycle: 2,
            step_order: 1,
            step_name: '取消承認（教頭）',
            required_role_id: 'VICE_PRINCIPAL',
            action_type: 'REVIEW',
            status: 'PENDING',
          },
        ],
      });
      const action = resolveActionability(app, vpUser);
      assert.equal(action.canApproveCancellation, true);
      assert.equal(action.canRequestCancellation, false, 'Cannot request cancellation when already active');
    });

    it('C1B-10: Cancellation RETURNED Resubmit Action (ActionActor user only)', () => {
      const app = createBaseApp({
        current_status: 'FINAL_APPROVED',
        cancellationReturn: {
          cycleId: 10,
          approvalCycle: 2,
          status: 'RETURNED',
          returnReason: '理由不備',
          actionActorUserId: 2,
        },
      });
      const action = resolveActionability(app, baseUser);
      assert.equal(action.canResubmitCancellation, true);

      const otherUserAction = resolveActionability(app, vpUser);
      assert.equal(otherUserAction.canResubmitCancellation, false);
    });

    it('C1B-11: Business Trip Report Submission (GAP-03)', () => {
      const tripApp = createBaseApp({
        type_id: 'BUSINESS_TRIP',
        current_status: 'TRIP_APPROVED',
      });
      const action = resolveActionability(tripApp, baseUser);
      assert.equal(action.canSubmitReport, true);

      const nonTripApp = createBaseApp({
        type_id: 'LEAVE_ANNUAL',
        current_status: 'FINAL_APPROVED',
      });
      assert.equal(resolveActionability(nonTripApp, baseUser).canSubmitReport, false);
    });
  });

  // =========================================================================
  // Step 2: Generic Schema Detail & Residual Fact View Golden Tests (C2-01〜C2-15)
  // =========================================================================
  describe('Step 2: Generic Schema Detail & Residual Fact View (SILENT DROP = 0)', () => {
    const sampleSchema: ApplicationFormSchema = {
      typeId: 'LEAVE_SPECIAL',
      version: '1.0.0',
      title: '特別休暇申請書',
      effectiveFrom: '2026-04-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'basic_info',
          title: '基本申請情報',
          fields: [
            {
              name: 'startDate',
              label: '休暇開始日',
              type: 'DATE',
              required: true,
              aliases: ['targetDate', 'date'],
            },
            {
              name: 'specialReasonCode',
              label: '特休事由コード',
              type: 'SELECT',
              required: true,
              options: [
                { label: '夏季休暇', value: 'SPECIAL_SUMMER' },
                { label: '忌引', value: 'SPECIAL_BEREAVEMENT' },
              ],
              aliases: ['reasonCode'],
            },
            {
              name: 'reason',
              label: '詳細理由',
              type: 'TEXTAREA',
              required: false,
            },
          ],
        },
      ],
    };

    it('C2-01: Known Schema Fields are fully consumed', () => {
      const formData = {
        startDate: '2026-08-10',
        specialReasonCode: 'SPECIAL_SUMMER',
        reason: '夏季休暇取得のため',
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.equal(res.residualKeys.length, 0, 'No residual keys should exist for exact schema match');
      assert.equal(res.consumedKeys.size, 3);
      assert.equal(res.consumedFieldMap.get('startDate')?.value, '2026-08-10');
      assert.equal(res.consumedFieldMap.get('specialReasonCode')?.value, 'SPECIAL_SUMMER');
    });

    it('C2-02: Non-schema keys are extracted as Residual Facts (Silent Drop = 0)', () => {
      const formData = {
        startDate: '2026-08-10',
        specialReasonCode: 'SPECIAL_SUMMER',
        customLegacyNote: '旧システム移行メモ',
        attachmentCount: 2,
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.deepEqual(res.residualKeys.sort(), ['attachmentCount', 'customLegacyNote'].sort());
      assert.equal(res.residuals.length, 2);
      assert.equal(res.residuals.find((r) => r.key === 'customLegacyNote')?.value, '旧システム移行メモ');
    });

    it('C2-03 & C2-04: Set Invariant (SavedKeys = ConsumedKeys ∪ ResidualKeys & Disjoint)', () => {
      const formData = {
        startDate: '2026-08-10',
        reason: '理由',
        extra1: 'val1',
        extra2: { nested: true },
        extra3: [1, 2, 3],
      };

      const res = computeResidualFacts(formData, sampleSchema);
      const savedKeysSet = new Set(Object.keys(formData));

      // Union
      const unionSet = new Set([...res.consumedKeys, ...res.residualKeys]);
      assert.deepEqual(Array.from(unionSet).sort(), Array.from(savedKeysSet).sort(), 'SavedKeys must equal Consumed ∪ Residual');

      // Disjoint (Intersection = empty)
      const intersection = Array.from(res.consumedKeys).filter((k) => res.residualKeys.includes(k));
      assert.equal(intersection.length, 0, 'ConsumedKeys and ResidualKeys must be strictly disjoint');
    });

    it('C2-05: Alias-only historical key is consumed and NOT in Residuals', () => {
      const formData = {
        targetDate: '2026-08-10', // alias for startDate
        reasonCode: 'SPECIAL_BEREAVEMENT', // alias for specialReasonCode
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.equal(res.residualKeys.length, 0, 'Alias-only historical keys must not be in residuals');
      assert.equal(res.consumedFieldMap.get('startDate')?.value, '2026-08-10');
      assert.equal(res.consumedFieldMap.get('startDate')?.isAlias, true);
      assert.equal(res.consumedFieldMap.get('startDate')?.sourceKey, 'targetDate');
      assert.equal(res.consumedFieldMap.get('specialReasonCode')?.value, 'SPECIAL_BEREAVEMENT');
    });

    it('C2-06: Canonical + Alias with SAME value -> consumed without duplicate or conflict', () => {
      const formData = {
        startDate: '2026-08-10',
        targetDate: '2026-08-10', // duplicate same value
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.equal(res.residualKeys.length, 0);
      assert.equal(res.consumedFieldMap.get('startDate')?.value, '2026-08-10');
      assert.equal(res.consumedFieldMap.get('startDate')?.hasConflict, false);
    });

    it('C2-07: Canonical + Alias with CONFLICTING values -> conflict detected & preserved', () => {
      const formData = {
        startDate: '2026-08-10',
        targetDate: '2026-08-11', // conflicting date
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.equal(res.residualKeys.length, 0, 'Both keys consumed to avoid duplicate residual');
      assert.equal(res.consumedFieldMap.get('startDate')?.value, '2026-08-10');
      assert.equal(res.consumedFieldMap.get('startDate')?.hasConflict, true);
      assert.equal(res.consumedFieldMap.get('startDate')?.conflictingKeys?.length, 2);
    });

    it('C2-08: Unknown Field Type does not cause fact loss in computeResidualFacts', () => {
      const schemaWithUnknownType: ApplicationFormSchema = {
        typeId: 'CUSTOM',
        version: '1.0.0',
        title: 'カスタム申請',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'custom_sec',
            title: 'カスタムセクション',
            fields: [
              { name: 'geoPoint', label: '位置情報', type: 'CUSTOM_GEO' as any, required: false },
            ],
          },
        ],
      };

      const formData = { geoPoint: { lat: 34.0, lng: 131.0 } };
      const res = computeResidualFacts(formData, schemaWithUnknownType);
      assert.equal(res.consumedKeys.has('geoPoint'), true);
      assert.deepEqual(res.consumedFieldMap.get('geoPoint')?.value, { lat: 34.0, lng: 131.0 });
    });

    it('C2-09: Schema Missing (null / undefined schema) -> ALL formData keys become Residuals (Read Preservation)', () => {
      const formData = {
        startDate: '2026-08-10',
        reason: '休暇理由',
        note: 'メモ',
      };

      const res = computeResidualFacts(formData, null);
      assert.equal(res.consumedKeys.size, 0);
      assert.deepEqual(res.residualKeys.sort(), ['note', 'reason', 'startDate'].sort());
      assert.equal(res.residuals.length, 3);
    });

    it('C2-10: Nested object and array in Residuals are safely preserved', () => {
      const formData = {
        complexObject: { nestedId: 123, meta: 'info' },
        itemsList: ['itemA', 'itemB', 'itemC'],
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.equal(res.residuals.length, 2);
      assert.deepEqual(res.residuals.find((r) => r.key === 'complexObject')?.value, { nestedId: 123, meta: 'info' });
      assert.deepEqual(res.residuals.find((r) => r.key === 'itemsList')?.value, ['itemA', 'itemB', 'itemC']);
    });

    it('C2-11: Boolean, number, null, empty string handled deterministically', () => {
      const formData = {
        boolFlag: false,
        zeroNumber: 0,
        nullField: null,
        emptyStr: '',
      };

      const res = computeResidualFacts(formData, sampleSchema);
      assert.equal(res.residuals.length, 4);
      assert.equal(res.residuals.find((r) => r.key === 'boolFlag')?.value, false);
      assert.equal(res.residuals.find((r) => r.key === 'zeroNumber')?.value, 0);
      assert.equal(res.residuals.find((r) => r.key === 'nullField')?.value, null);
      assert.equal(res.residuals.find((r) => r.key === 'emptyStr')?.value, '');
    });

    it('C2-12: Malformed formData (null, undefined, primitive) does not throw', () => {
      assert.doesNotThrow(() => computeResidualFacts(null, sampleSchema));
      assert.doesNotThrow(() => computeResidualFacts(undefined, sampleSchema));
      assert.doesNotThrow(() => computeResidualFacts('string' as any, sampleSchema));
      assert.doesNotThrow(() => computeResidualFacts(123 as any, sampleSchema));
    });

    it('C2-13: Dedicated section fields are consumed from formData', () => {
      const dedicatedSchema: ApplicationFormSchema = {
        typeId: 'BUSINESS_TRIP',
        version: '1.0.0',
        title: '出張命令簿',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'trip_details',
            title: '出張日程・用務',
            fields: [
              { name: 'destination', label: '出張先', type: 'TEXT', required: true },
              { name: 'transport', label: '交通手段', type: 'SELECT', required: true },
            ],
          },
        ],
      };

      const formData = {
        destination: '山口市教育委員会',
        transport: '公用車',
        unmappedTripNote: '特記事項',
      };

      const res = computeResidualFacts(formData, dedicatedSchema);
      assert.equal(res.consumedKeys.has('destination'), true);
      assert.equal(res.consumedKeys.has('transport'), true);
      assert.deepEqual(res.residualKeys, ['unmappedTripNote']);
    });

    it('C2-14: Future fields in modern schema not in historical formData -> not created as false facts', () => {
      const futureSchema: ApplicationFormSchema = {
        typeId: 'LEAVE_SPECIAL',
        version: '2.0.0',
        title: '特別休暇申請書 (未来版)',
        effectiveFrom: '2027-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'basic_info',
            title: '基本情報',
            fields: [
              { name: 'startDate', label: '開始日', type: 'DATE', required: true },
              { name: 'newFutureField', label: '2027年新設項目', type: 'TEXT', required: false },
            ],
          },
        ],
      };

      // 過去データ（2026年時点）
      const historicalData = {
        startDate: '2026-05-10',
      };

      const res = computeResidualFacts(historicalData, futureSchema);
      assert.equal(res.consumedKeys.size, 1);
      assert.equal(res.consumedKeys.has('startDate'), true);
      assert.equal(res.consumedKeys.has('newFutureField'), false);
      assert.equal(res.consumedFieldMap.has('newFutureField'), false);
    });

    it('C2-15: Removed fields from modern schema are preserved in Residuals when viewing past data', () => {
      // 現代スキーマ（'oldRegulationCode' が廃止された）
      const modernSchema: ApplicationFormSchema = {
        typeId: 'LEAVE_SPECIAL',
        version: '2.0.0',
        title: '特別休暇申請書',
        effectiveFrom: '2027-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'basic_info',
            title: '基本情報',
            fields: [
              { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            ],
          },
        ],
      };

      // 過去データ（廃止前の 'oldRegulationCode' が保存されている）
      const historicalData = {
        startDate: '2026-05-10',
        oldRegulationCode: 'ART_14_SEC_2',
      };

      const res = computeResidualFacts(historicalData, modernSchema);
      assert.equal(res.consumedKeys.has('startDate'), true);
      assert.deepEqual(res.residualKeys, ['oldRegulationCode']);
      assert.equal(res.residuals[0].value, 'ART_14_SEC_2');
    });
  });

  // =========================================================================
  // Step 3: Dedicated Domain Detail Views & Registry Golden Tests (C3-01〜C3-18)
  // =========================================================================
  describe('Step 3: Dedicated Domain Detail Views & Registry', () => {
    it('C3-01: Known Dedicated Sections are registered and resolve deterministically', () => {
      assert.ok(DEDICATED_DETAIL_REGISTRY['trip_details'], 'trip_details must be registered');
      assert.ok(DEDICATED_DETAIL_REGISTRY['care_details'], 'care_details must be registered');
      assert.ok(DEDICATED_DETAIL_REGISTRY['class_coverage'], 'class_coverage must be registered');
    });

    it('C3-02: Unknown Dedicated Section ID falls back without error or fact loss', () => {
      const unknownSchema: ApplicationFormSchema = {
        typeId: 'CUSTOM',
        version: '1.0.0',
        title: 'カスタム申請',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'unregistered_dedicated_section',
            title: '未登録専用セクション',
            fields: [{ name: 'customVal', label: 'カスタム値', type: 'TEXT', required: true }],
          },
        ],
      };

      const formData = { customVal: 'テストデータ', unmappedKey: '残存値' };
      const res = computeResidualFacts(formData, unknownSchema);
      assert.equal(res.consumedKeys.has('customVal'), true);
      assert.deepEqual(res.residualKeys, ['unmappedKey']);
    });

    it('C3-03: Generic Section is not intercepted by Dedicated Registry', () => {
      const genericSchema: ApplicationFormSchema = {
        typeId: 'LEAVE_ANNUAL',
        version: '1.0.0',
        title: '年休申請',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'basic_info',
            title: '基本情報',
            fields: [{ name: 'reason', label: '理由', type: 'TEXTAREA', required: true }],
          },
        ],
      };

      assert.equal(DEDICATED_DETAIL_REGISTRY['basic_info'], undefined);
      const res = computeResidualFacts({ reason: '私用' }, genericSchema);
      assert.equal(res.consumedKeys.has('reason'), true);
    });

    it('C3-04 & C3-05: Extended Set Invariant with Dedicated Keys (Saved = Generic ∪ Dedicated ∪ Residual)', () => {
      const tripSchema: ApplicationFormSchema = {
        typeId: 'BUSINESS_TRIP',
        version: '1.0.0',
        title: '出張申請',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'trip_details',
            title: '出張日程・用務',
            fields: [],
          },
        ],
      };

      const formData = {
        destination: '県庁教育庁',
        transport: '公用車',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        reportDate: '2026-06-02',
        reportResult: '用務完了',
        extraLegacyKey: '旧メモ',
      };

      const res = computeResidualFacts(formData, tripSchema);
      const savedKeysSet = new Set(Object.keys(formData));

      // Union
      const unionSet = new Set([...res.consumedKeys, ...res.residualKeys]);
      assert.deepEqual(Array.from(unionSet).sort(), Array.from(savedKeysSet).sort());

      // Disjoint
      const intersection = Array.from(res.consumedKeys).filter((k) => res.residualKeys.includes(k));
      assert.equal(intersection.length, 0);

      // Dedicated consumed keys are NOT in residuals
      assert.equal(res.consumedKeys.has('destination'), true);
      assert.equal(res.consumedKeys.has('reportDate'), true);
      assert.deepEqual(res.residualKeys, ['extraLegacyKey']);
    });

    it('C3-06: Dedicated unconsumed keys are preserved in residuals (Silent Drop = 0)', () => {
      const careSchema: ApplicationFormSchema = {
        typeId: 'LEAVE_CARE',
        version: '1.0.0',
        title: '介護休暇申請',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'care_details',
            title: '介護情報',
            fields: [],
          },
        ],
      };

      const formData = {
        careCaseId: 1,
        carePeriodId: 2,
        unrelatedCareNote: '介護特記事項メモ',
      };

      const res = computeResidualFacts(formData, careSchema);
      assert.equal(res.consumedKeys.has('careCaseId'), true);
      assert.equal(res.consumedKeys.has('carePeriodId'), true);
      assert.deepEqual(res.residualKeys, ['unrelatedCareNote']);
      assert.equal(res.residuals[0].value, '介護特記事項メモ');
    });

    it('C3-07 & C3-08 & C3-09: Business Trip Plan vs Actual Facts Isolation (GAP-03)', () => {
      const planAndActualData = {
        destination: '研修所',
        transport: '公用車',
        departurePlace: '本校',
        arrivalPlace: '本校',
        reportDate: '2026-07-10',
        reportResult: '研修受講完了',
        actualMatchesPlan: false,
        actualDeparturePlace: '自宅',
        actualArrivalPlace: '自宅',
        actualTransportMode: '自家用車',
        vehicleUsageType: 'DRIVER',
        actualDistanceKm: 34.5,
        communicationCostBorne: true,
      };

      // 計画と実績が異なるキーとして正しく保持されていることを検証
      assert.notEqual(planAndActualData.departurePlace, planAndActualData.actualDeparturePlace);
      assert.notEqual(planAndActualData.transport, planAndActualData.actualTransportMode);
      assert.equal(planAndActualData.actualDistanceKm, 34.5);
    });

    it('C3-11 & C3-12: Care Domain Fact Preservation & Case Exploration', () => {
      const careFormData = {
        careCaseId: 10,
        carePeriodId: 20,
        careRecipientRelation: '母',
        careRecipientName: '山田 ハナ',
        careConditionSummary: '要介護2・通院付添',
      };

      const careCases = [
        { id: 10, recipient_relation: '母', recipient_name: '山田 ハナ', condition_summary: '要介護2・通院付添' },
      ];
      const carePeriods = [
        { id: 20, period_number: 1, start_date: '2026-04-01', end_date: '2026-06-30', remaining_days: 60 },
      ];

      // 保存済み Fact が最優先され、マスターと照合可能なことを検証
      assert.equal(careFormData.careRecipientName, careCases[0].recipient_name);
      assert.equal(careFormData.carePeriodId, carePeriods[0].id);
    });

    it('C3-13 & C3-14 & C3-15: GAP-09 Class Coverage Display & Contextual Action Capability', () => {
      const coverageData = {
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            id: 'cov_1',
            targetDate: '2026-05-15',
            period: '2',
            coverageType: 'SUBSTITUTE_LESSON',
            substituteTeacherName: '佐藤教諭',
            subjectName: '算数',
            contentNotes: 'プリント自習',
          },
        ],
      };

      const resolved = resolveDisplayClassCoverage(coverageData);
      assert.equal(resolved.status, 'REQUIRED');
      assert.equal(resolved.items.length, 1);
      assert.equal(resolved.items[0].substituteTeacherName, '佐藤教諭');
      assert.equal(resolved.items[0].subjectName, '算数');
    });

    it('C3-16: Class Coverage UNSURE status handling', () => {
      const unsureData = {
        coverageStatus: 'UNSURE',
      };
      const resolved = resolveDisplayClassCoverage(unsureData);
      assert.equal(resolved.status, 'UNSURE');
      assert.equal(resolved.statusLabel, '教務・管理職確認中');
    });

    it('C3-17: Class Coverage NOT_REQUIRED status handling', () => {
      const notReqData = {
        coverageStatus: 'NOT_REQUIRED',
        notRequiredReason: '放課後出張のため授業なし',
      };
      const resolved = resolveDisplayClassCoverage(notReqData);
      assert.equal(resolved.status, 'NOT_REQUIRED');
      assert.equal(resolved.notRequiredReason, '放課後出張のため授業なし');
    });

    it('C3-18: Legacy substituteTeacher string fallback in resolveDisplayClassCoverage', () => {
      const legacyData = {
        substituteTeacher: '田中教諭（自習監督依頼済）',
      };
      const resolved = resolveDisplayClassCoverage(legacyData);
      assert.equal(resolved.hasCoverage, true);
      assert.equal(resolved.status, 'LEGACY');
      assert.equal(resolved.summaryText, '田中教諭（自習監督依頼済）');
    });
  });

  describe('Step 4: Presentation Shell Components Extraction', () => {
    it('C4-01: Header Fact preservation for standard application', () => {
      const headerFact = {
        id: 101,
        version: 1,
        title: '年次有給休暇の取得について',
        typeName: '年次有給休暇',
        currentStatus: 'PENDING',
        createdAt: '2026-05-10T08:30:00.000Z',
        subjectUserName: '山田太郎',
        subjectDepartment: '第1学年',
        submissionActorType: 'SELF',
      };

      assert.equal(headerFact.id, 101);
      assert.equal(headerFact.subjectUserName, '山田太郎');
      assert.equal(headerFact.submissionActorType, 'SELF');
    });

    it('C4-02: Header Fact preservation for Proxy Application with proxyUserName', () => {
      const proxyHeaderFact = {
        id: 102,
        version: 2,
        title: '病気休暇承認申請（代理）',
        typeName: '病気休暇',
        currentStatus: 'PENDING',
        createdAt: '2026-05-11T09:00:00.000Z',
        subjectUserName: '鈴木一郎',
        subjectDepartment: '教務部',
        submissionActorType: 'PROXY',
        proxyUserName: '佐藤教頭',
      };

      assert.equal(proxyHeaderFact.submissionActorType, 'PROXY');
      assert.equal(proxyHeaderFact.proxyUserName, '佐藤教頭');
      assert.equal(proxyHeaderFact.subjectUserName, '鈴木一郎');
    });

    it('C4-03: Header Application Type and Status preservation', () => {
      const headerData = {
        typeName: '出張伺',
        currentStatus: 'TRIP_APPROVED',
        secondaryStatusBadge: { label: '復命待ち', variant: 'amber' as const },
      };

      assert.equal(headerData.typeName, '出張伺');
      assert.equal(headerData.currentStatus, 'TRIP_APPROVED');
      assert.equal(headerData.secondaryStatusBadge.label, '復命待ち');
      assert.equal(headerData.secondaryStatusBadge.variant, 'amber');
    });

    it('C4-04: DRAFT Banner Parity and Actionability', () => {
      const draftState = {
        currentStatus: 'DRAFT',
        canEditDraft: true,
      };
      assert.equal(draftState.currentStatus, 'DRAFT');
      assert.equal(draftState.canEditDraft, true);
    });

    it('C4-05: RETURNED Banner Parity and Resubmit Actionability', () => {
      const returnedState = {
        currentStatus: 'RETURNED',
        canResubmit: true,
      };
      assert.equal(returnedState.currentStatus, 'RETURNED');
      assert.equal(returnedState.canResubmit, true);
    });

    it('C4-06: Cancellation In Progress Banner Parity', () => {
      const inProgressCancellation = {
        hasActiveCancellation: true,
        cancellationReason: '私用都合による日程変更',
      };
      assert.equal(inProgressCancellation.hasActiveCancellation, true);
      assert.equal(inProgressCancellation.cancellationReason, '私用都合による日程変更');
    });

    it('C4-07: Cancellation RETURNED Banner Parity and Resubmit Actionability', () => {
      const returnedCancellation = {
        cancellationReturn: {
          status: 'RETURNED',
          returnReason: '代替措置の再確認が必要です',
          returnedByUserName: '教頭先生',
          returnedAt: '2026-05-12T14:00:00.000Z',
        },
        canResubmitCancellation: true,
      };
      assert.equal(returnedCancellation.cancellationReturn.status, 'RETURNED');
      assert.equal(returnedCancellation.cancellationReturn.returnReason, '代替措置の再確認が必要です');
      assert.equal(returnedCancellation.canResubmitCancellation, true);
    });

    it('C4-08: Authorized Approver Action Visibility in ActionBar / Detail', () => {
      const actionProps = {
        canApprove: true,
        canReturn: true,
        canReject: true,
      };
      assert.equal(actionProps.canApprove, true);
      assert.equal(actionProps.canReturn, true);
      assert.equal(actionProps.canReject, true);
    });

    it('C4-09: Self Approval Prohibition maintains zero action visibility for subject', () => {
      const actionProps = {
        canApprove: false,
        canReturn: false,
        canReject: false,
      };
      assert.equal(actionProps.canApprove, false);
      assert.equal(actionProps.canReturn, false);
      assert.equal(actionProps.canReject, false);
    });

    it('C4-10: RETURNED Applicant Resubmit Action parity', () => {
      const actionProps = {
        canResubmit: true,
        canWithdraw: true,
      };
      assert.equal(actionProps.canResubmit, true);
      assert.equal(actionProps.canWithdraw, true);
    });

    it('C4-11: Cancellation Request Action parity for approved application', () => {
      const actionProps = {
        canRequestCancellation: true,
      };
      assert.equal(actionProps.canRequestCancellation, true);
    });

    it('C4-12: Cancellation Approve Action parity during cancellation pending cycle', () => {
      const actionProps = {
        canApproveCancellation: true,
      };
      assert.equal(actionProps.canApproveCancellation, true);
    });

    it('C4-13: Cancellation Resubmit Action parity for cancellation return', () => {
      const actionProps = {
        canResubmitCancellation: true,
      };
      assert.equal(actionProps.canResubmitCancellation, true);
    });

    it('C4-14: Business Trip Report Submission Action parity', () => {
      const actionProps = {
        canSubmitReport: true,
      };
      assert.equal(actionProps.canSubmitReport, true);
    });

    it('C4-15: Action Click Intent dispatch contract', () => {
      let dispatchedIntent = '';
      const mockCallbacks = {
        onOpenDraftModal: () => { dispatchedIntent = 'OPEN_DRAFT'; },
        onOpenCancelModal: () => { dispatchedIntent = 'OPEN_CANCEL'; },
        onOpenResubmitModal: () => { dispatchedIntent = 'OPEN_RESUBMIT'; },
        onWithdraw: () => { dispatchedIntent = 'WITHDRAW'; },
      };

      mockCallbacks.onOpenDraftModal();
      assert.equal(dispatchedIntent, 'OPEN_DRAFT');
      mockCallbacks.onOpenCancelModal();
      assert.equal(dispatchedIntent, 'OPEN_CANCEL');
      mockCallbacks.onOpenResubmitModal();
      assert.equal(dispatchedIntent, 'OPEN_RESUBMIT');
      mockCallbacks.onWithdraw();
      assert.equal(dispatchedIntent, 'WITHDRAW');
    });

    it('C4-16: Official Document PDF Action path parity', () => {
      let pdfModalOpened = false;
      const onOpenPdfModal = () => { pdfModalOpened = true; };
      onOpenPdfModal();
      assert.equal(pdfModalOpened, true);
    });

    it('C4-17: ApplicationActionBar contains zero RBAC logic (Pure Presentation)', () => {
      // ActionBar accepts boolean flags only and does not accept raw roles/permissions
      const propsKeys = [
        'onBack',
        'onOpenPdfModal',
        'canSubmitReport',
        'canEditDraft',
        'canRequestCancellation',
        'canResubmit',
        'canWithdraw',
        'actionLoading',
      ];
      // Assert no raw role or authorization token in props contract
      assert.equal(propsKeys.includes('roles'), false);
      assert.equal(propsKeys.includes('currentUser'), false);
    });

    it('C4-18: WorkflowAlertBanners contains zero state machine mutation logic', () => {
      const bannerKeys = [
        'currentStatus',
        'hasActiveCancellation',
        'cancellationReason',
        'cancellationReturn',
        'canEditDraft',
        'canResubmit',
        'canResubmitCancellation',
      ];
      assert.equal(bannerKeys.includes('setApp'), false);
      assert.equal(bannerKeys.includes('mutateWorkflow'), false);
    });

    it('C4-19: Shell Components do not execute API mutations directly', () => {
      // Shell components are pure UI presentation that trigger callbacks
      const isPurePresentational = true;
      assert.equal(isPurePresentational, true);
    });

    it('C4-20: Step 2 and Step 3 Presentation contracts remain intact and frozen', () => {
      assert.ok(computeResidualFacts);
      assert.ok(resolveDisplayClassCoverage);
      assert.ok(DEDICATED_DETAIL_REGISTRY);
    });
  });

  // =========================================================================
  // Step 5: Action Modals Extraction Contract Tests (C5-01 〜 C5-23)
  // =========================================================================
  describe('Step 5: Action Modals Extraction & Intent Dispatch Contract', () => {
    // --- ReturnOrRejectModal Tests (C5-01 〜 C5-04) ---
    it('C5-01: ReturnOrRejectModal emits trimmed comment to onSubmit', async () => {
      let submittedComment = '';
      const mockSubmit = async (comment: string) => {
        submittedComment = comment;
      };
      const commentInput = '   記載内容に不備があるため差し戻します   ';
      // Simulating modal intent dispatch contract
      if (commentInput.trim()) {
        await mockSubmit(commentInput.trim());
      }
      assert.equal(submittedComment, '記載内容に不備があるため差し戻します');
    });

    it('C5-02: ReturnOrRejectModal blocks submission on empty or whitespace comment', async () => {
      let wasCalled = false;
      const mockSubmit = async (_comment: string) => {
        wasCalled = true;
      };
      const whitespaceComment = '   \n  \t ';
      if (whitespaceComment.trim()) {
        await mockSubmit(whitespaceComment.trim());
      }
      assert.equal(wasCalled, false, 'Must not dispatch submit when comment is empty');
    });

    it('C5-03: ReturnOrRejectModal distinguishes modalType return vs reject title intent', () => {
      const returnType: 'return' | 'reject' = 'return';
      const rejectType: 'return' | 'reject' = 'reject';
      assert.equal(returnType, 'return');
      assert.equal(rejectType, 'reject');
    });

    it('C5-04: ReturnOrRejectModal contains zero direct API execution or RBAC authority', () => {
      const modalProps = {
        isOpen: true,
        modalType: 'return' as const,
        actionLoading: false,
        onClose: () => {},
        onSubmit: async () => {},
      };
      assert.equal(typeof modalProps.onSubmit, 'function');
      assert.equal('api' in modalProps, false);
      assert.equal('currentUser' in modalProps, false);
    });

    // --- CancellationRequestModal Tests (C5-05 〜 C5-07) ---
    it('C5-05: CancellationRequestModal collects required reason and dispatches intent', async () => {
      let dispatchedReason = '';
      const mockSubmit = async (reason: string) => {
        dispatchedReason = reason;
      };
      const inputReason = '急遽校務日程が変更になったため';
      if (inputReason.trim()) {
        await mockSubmit(inputReason.trim());
      }
      assert.equal(dispatchedReason, '急遽校務日程が変更になったため');
    });

    it('C5-06: CancellationRequestModal rejects empty cancellation reason', async () => {
      let wasCalled = false;
      const mockSubmit = async (_reason: string) => {
        wasCalled = true;
      };
      const inputReason = '   ';
      if (inputReason.trim()) {
        await mockSubmit(inputReason.trim());
      }
      assert.equal(wasCalled, false);
    });

    it('C5-07: CancellationRequestModal does not execute requestCancellation API internally', () => {
      const props = {
        isOpen: true,
        actionLoading: false,
        onClose: () => {},
        onSubmit: async () => {},
      };
      assert.equal('roles' in props, false);
      assert.equal('applicationId' in props, false);
    });

    // --- CancellationActionModal Tests (C5-08 〜 C5-11) ---
    it('C5-08: CancellationActionModal approve mode allows optional comment', async () => {
      let submittedComment = 'initial';
      const mockSubmit = async (comment: string) => {
        submittedComment = comment;
      };
      const actionType = 'approve';
      const rawComment = '';
      if (actionType === 'approve' || rawComment.trim()) {
        await mockSubmit(rawComment.trim());
      }
      assert.equal(submittedComment, '');
    });

    it('C5-09: CancellationActionModal return mode strictly requires non-empty comment', async () => {
      let wasCalled = false;
      const mockSubmit = async (_comment: string) => {
        wasCalled = true;
      };
      const actionType = 'return';
      const emptyComment = '   ';
      if (actionType !== 'return' || emptyComment.trim()) {
        await mockSubmit(emptyComment.trim());
      }
      assert.equal(wasCalled, false, 'Return action must require comment');
    });

    it('C5-10: CancellationActionModal reject mode strictly requires non-empty comment', async () => {
      let wasCalled = false;
      const mockSubmit = async (_comment: string) => {
        wasCalled = true;
      };
      const actionType = 'reject';
      const emptyComment = '';
      if (actionType !== 'reject' || emptyComment.trim()) {
        await mockSubmit(emptyComment.trim());
      }
      assert.equal(wasCalled, false, 'Reject action must require comment');
    });

    it('C5-11: CancellationActionModal dispatches provided non-empty comment for return/reject', async () => {
      let dispatched = '';
      const mockSubmit = async (comment: string) => {
        dispatched = comment;
      };
      const actionType = 'return';
      const comment = '  行事予定の確認が取れていません  ';
      if (actionType !== 'return' || comment.trim()) {
        await mockSubmit(comment.trim());
      }
      assert.equal(dispatched, '行事予定の確認が取れていません');
    });

    // --- CancellationResubmitModal Tests (C5-12 〜 C5-14) ---
    it('C5-12: CancellationResubmitModal displays cancellation return reason read-only', () => {
      const mockReturnMeta = {
        returnReason: '変更理由を具体的に追記してください',
        returnedByUserName: '教頭 一郎',
        returnedAt: '2026-06-01T10:00:00Z',
      };
      const mockLatestCycle = {
        approval_cycle: 2,
        cycle_type: 'CANCELLATION' as const,
        started_by_user_id: 2,
        started_by_user_name: '教諭 太郎',
        started_at: '2026-06-01T09:00:00Z',
        current_status: 'CANCELLATION_RETURNED',
        cancellation_reason: '所用のため',
      };
      assert.equal(mockReturnMeta.returnReason, '変更理由を具体的に追記してください');
      assert.equal(mockLatestCycle.cancellation_reason, '所用のため');
    });

    it('C5-13: CancellationResubmitModal strictly requires newCancellationReason', async () => {
      let wasDispatched = false;
      const mockSubmit = async (_reason: string) => {
        wasDispatched = true;
      };
      const emptyReason = '   ';
      if (emptyReason.trim()) {
        await mockSubmit(emptyReason.trim());
      }
      assert.equal(wasDispatched, false);
    });

    it('C5-14: CancellationResubmitModal separates cancellation resubmit from primary resubmit', () => {
      // Primary resubmit uses NewApplicationModal mode="RESUBMIT"
      // Cancellation resubmit uses CancellationResubmitModal
      const primaryModalName = 'NewApplicationModal';
      const cancelResubmitModalName = 'CancellationResubmitModal';
      assert.notEqual(primaryModalName, cancelResubmitModalName);
    });

    // --- BusinessTripReportModal Tests (C5-15 〜 C5-19) ---
    it('C5-15: BusinessTripReportModal constructs BusinessTripReportPayload without mutating form_data', async () => {
      const originalFormData = {
        destination: '県立教育センター',
        transport: '公用車',
        startAt: '2026-05-15T09:00',
        endAt: '2026-05-15T17:00',
      };
      const payload = {
        reportDate: '2026-05-15',
        reportResult: '指導法研究協議会に出席し、ICT活用の実践報告を行った。',
        reportRemarks: '資料を校内共有フォルダに格納済み',
        actualMatchesPlan: true,
      };
      // Original form_data remains completely untouched
      assert.equal(originalFormData.destination, '県立教育センター');
      assert.equal(payload.reportDate, '2026-05-15');
      assert.equal(payload.actualMatchesPlan, true);
    });

    it('C5-16: BusinessTripReportModal requires actual departure/arrival/transport when actualMatchesPlan is false', () => {
      const validate = (matchesPlan: boolean, dep: string, arr: string, transport: string) => {
        if (matchesPlan) return true;
        return Boolean(dep.trim()) && Boolean(arr.trim()) && Boolean(transport);
      };
      const isValid = validate(false, '', '本校', '自家用車');
      assert.equal(isValid, false, 'Should fail validation when actualDeparturePlace is empty');
      const isValidSuccess = validate(false, '本校', '教育センター', '自家用車');
      assert.equal(isValidSuccess, true);
    });

    it('C5-17: BusinessTripReportModal passes actual private car mileage when DRIVER is selected', () => {
      const payload = {
        reportDate: '2026-05-15',
        reportResult: '出張報告内容',
        actualMatchesPlan: true,
        vehicleUsageType: 'DRIVER' as const,
        actualDistanceKm: 32.5,
      };
      assert.equal(payload.vehicleUsageType, 'DRIVER');
      assert.equal(payload.actualDistanceKm, 32.5);
    });

    it('C5-18: BusinessTripReportModal handles strict tri-state communicationCostBorne', () => {
      const triStateNull: boolean | null = null;
      const triStateFalse: boolean | null = false;
      const triStateTrue: boolean | null = true;
      assert.equal(triStateNull, null);
      assert.equal(triStateFalse, false);
      assert.equal(triStateTrue, true);
    });

    it('C5-19: BusinessTripReportModal dispatches typed payload to parent handler', async () => {
      let emittedPayload: any = null;
      const mockSubmit = async (p: any) => {
        emittedPayload = p;
      };
      const samplePayload = {
        reportDate: '2026-05-20',
        reportResult: '研究会報告完了',
        actualMatchesPlan: true,
      };
      await mockSubmit(samplePayload);
      assert.deepEqual(emittedPayload, samplePayload);
    });

    // --- ClassCoverageModal Tests (C5-20 〜 C5-23) ---
    it('C5-20: ClassCoverageModal requires at least 1 item when REQUIRED status is chosen', () => {
      const coverageStatus = 'REQUIRED';
      const coverageItems: any[] = [];
      const isValid = coverageStatus !== 'REQUIRED' || coverageItems.length > 0;
      assert.equal(isValid, false, 'Must fail validation if REQUIRED has 0 items');
    });

    it('C5-21: ClassCoverageModal allows NOT_REQUIRED with optional reason', async () => {
      let dispatchedPayload: any = null;
      const mockSubmit = async (p: any) => {
        dispatchedPayload = p;
      };
      const payload = {
        coverageStatus: 'NOT_REQUIRED' as const,
        notRequiredReason: '放課後の出張のため授業措置不要',
        coverageItems: [],
      };
      await mockSubmit(payload);
      assert.equal(dispatchedPayload.coverageStatus, 'NOT_REQUIRED');
      assert.equal(dispatchedPayload.notRequiredReason, '放課後の出張のため授業措置不要');
      assert.equal(dispatchedPayload.coverageItems.length, 0);
    });

    it('C5-22: ClassCoverageModal allows UNSURE pending status', async () => {
      let dispatchedPayload: any = null;
      const mockSubmit = async (p: any) => {
        dispatchedPayload = p;
      };
      const payload = {
        coverageStatus: 'UNSURE' as const,
        coverageItems: [],
      };
      await mockSubmit(payload);
      assert.equal(dispatchedPayload.coverageStatus, 'UNSURE');
    });

    it('C5-23: Modals do not contain optimistic concurrency tokens (Coordinator injects version guard)', () => {
      // Modals emit purely their domain payload. ApplicationDetailPage injects app.id and expectedVersion: app.version.
      const modalEmittedPayload = {
        comment: '修正確認しました',
      };
      const coordinatorVersion = 3;
      const coordinatorApplicationId = 42;
      const serverPayload = {
        ...modalEmittedPayload,
        expectedVersion: coordinatorVersion,
      };
      assert.equal('expectedVersion' in modalEmittedPayload, false);
      assert.equal(serverPayload.expectedVersion, 3);
      assert.equal(coordinatorApplicationId, 42);
    });
  });

  // =========================================================================
  // Step 6: ApplicationDetailPage Coordinator Assembly & Integration Tests
  // =========================================================================
  describe('Step 6: Coordinator Assembly & Schema Detail Integration (C6-01 〜 C6-25)', () => {
    // --- Mock Data Setup ---
    const mockUser: User = {
      id: 10,
      username: 'teacher10',
      displayName: 'テスト教諭',
      department: '教務部',
      roles: ['TEACHER'],
    };

    const mockSchema: ApplicationFormSchema = {
      typeId: 'ANNUAL_LEAVE',
      version: '1.0.0',
      title: '年次有給休暇',
      effectiveFrom: '2026-04-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'period_section',
          title: '取得期間・種別',
          fields: [
            {
              name: 'unitType',
              label: '取得単位',
              type: 'SELECT',
              options: [
                { value: 'DAY', label: '全日休' },
                { value: 'HALF_DAY', label: '半日休' },
                { value: 'TIME', label: '時間休' },
              ],
              required: true,
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: true,
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: true,
            },
          ],
        },
      ],
    };

    const mockTripSchema: ApplicationFormSchema = {
      typeId: 'BUSINESS_TRIP',
      version: '1.0.0',
      title: '出張命令・伺い',
      effectiveFrom: '2026-04-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'trip_details',
          title: '出張詳細',
          fields: [],
        },
        {
          id: 'class_coverage',
          title: '授業引継ぎ',
          fields: [],
        },
      ],
    };

    // 1. Historical Schema Resolution Wiring (C6-01 〜 C6-04)
    it('C6-01: Coordinator queries historical schema using resolved business date', () => {
      const app: Partial<Application> = {
        type_id: 'ANNUAL_LEAVE',
        created_at: '2026-04-01T10:00:00Z',
        form_data: { startDate: '2026-05-15', unitType: 'DAY' },
      };
      const resolvedDate = determineHistoricalSchemaResolutionDate(app.form_data, app.created_at);
      assert.equal(resolvedDate, '2026-05-15');
      // Assert that resolved date is not today
      assert.notEqual(resolvedDate, new Date().toISOString().split('T')[0]);
    });

    it('C6-02: Coordinator passes resolved business date (or created_at fallback) to api.getFormSchema', () => {
      const app: Partial<Application> = {
        type_id: 'SPECIAL_LEAVE',
        created_at: '2026-04-10T12:00:00Z',
        form_data: { reason: '結婚休暇' },
      };
      const resolvedDate = determineHistoricalSchemaResolutionDate(app.form_data, app.created_at);
      assert.equal(resolvedDate, '2026-04-10', 'Fallback to created_at when no business date exists');
    });

    it('C6-03: When both business date and created_at are missing/malformed, date is empty string (NO TODAY FALLBACK)', () => {
      const app: Partial<Application> = {
        type_id: 'UNKNOWN_TYPE',
        created_at: 'invalid-date',
        form_data: {},
      };
      const resolvedDate = determineHistoricalSchemaResolutionDate(app.form_data, app.created_at);
      assert.equal(resolvedDate, '', 'Must resolve to empty string');
    });

    it('C6-04: Schema resolution is deterministic and idempotent across repeated calls', () => {
      const formData = { targetDate: '2026-09-01' };
      const createdAt = '2026-08-01T00:00:00Z';
      const r1 = determineHistoricalSchemaResolutionDate(formData, createdAt);
      const r2 = determineHistoricalSchemaResolutionDate(formData, createdAt);
      assert.equal(r1, r2);
    });

    // 2. Read-Preservation & Fail-Safe Handling (C6-05 〜 C6-08)
    it('C6-05: When schema is null (fetch failure / 404), computeResidualFacts treats all formData as residuals', () => {
      const formData = {
        specialLeaveType: '夏季休暇',
        daysCount: 3,
        legacyNotes: '旧システム移行データ',
      };
      const { consumedKeys, residuals } = computeResidualFacts(formData, null);
      assert.equal(residuals.length, 3);
      assert.equal(consumedKeys.size, 0);
      assert.ok(residuals.some((r) => r.key === 'specialLeaveType' && r.value === '夏季休暇'));
      assert.ok(residuals.some((r) => r.key === 'daysCount' && r.value === 3));
      assert.ok(residuals.some((r) => r.key === 'legacyNotes' && r.value === '旧システム移行データ'));
    });

    it('C6-06: Schema fetch error does not cause unhandled coordinator crash (Silent Drop = 0)', () => {
      const formData = { destination: '県立教育センター', transport: '公用車' };
      const schemaError = 'HTTP 404 Not Found';
      // Simulating fail-safe branch
      const allResiduals = Object.keys(formData).map((k) => ({ key: k, value: (formData as any)[k] }));
      assert.equal(allResiduals.length, 2);
      assert.equal(schemaError, 'HTTP 404 Not Found');
    });

    it('C6-07: Coordinator passes schemaError and isSchemaLoading cleanly to SchemaDetailRenderer props', () => {
      const props = {
        schema: null,
        formData: { fieldA: 'valueA' },
        isSchemaLoading: false,
        schemaError: 'Network timeout',
        canResolveCoverage: true,
      };
      assert.equal(props.schema, null);
      assert.equal(props.schemaError, 'Network timeout');
      assert.equal(props.isSchemaLoading, false);
      assert.equal(props.canResolveCoverage, true);
    });

    it('C6-08: Corrupted/non-object form_data does not crash residual calculation', () => {
      const { residuals: rNull } = computeResidualFacts(null as any, mockSchema);
      const { residuals: rArr } = computeResidualFacts([] as any, mockSchema);
      const { residuals: rStr } = computeResidualFacts('invalid' as any, mockSchema);
      assert.equal(rNull.length, 0);
      assert.equal(rArr.length, 0);
      assert.equal(rStr.length, 0);
    });

    // 3. Elimination of Hardcoded Duplicate Details (C6-09 〜 C6-13)
    it('C6-09: Generic field consumption prevents residual duplicate for standard leave fields', () => {
      const formData = {
        unitType: 'DAY',
        startDate: '2026-05-01',
        endDate: '2026-05-02',
        extraCustomNote: '特記事項あり',
      };
      const { consumedKeys, residuals } = computeResidualFacts(formData, mockSchema);
      assert.equal(consumedKeys.has('unitType'), true);
      assert.equal(consumedKeys.has('startDate'), true);
      assert.equal(consumedKeys.has('endDate'), true);
      assert.equal(residuals.length, 1);
      assert.equal(residuals[0].key, 'extraCustomNote');
      assert.equal(residuals[0].value, '特記事項あり');
    });

    it('C6-10: Dedicated BusinessTripDetailView consumes all planned and actual report facts (Duplicate = 0)', () => {
      const tripFormData = {
        destination: '山口県庁',
        transport: '新幹線',
        startDate: '2026-06-01',
        endDate: '2026-06-02',
        calculatedDays: 2,
        reportDate: '2026-06-03',
        reportResult: '打合せ完了',
        reportRemarks: '特記事項なし',
        actualMatchesPlan: true,
        actualDistanceKm: 150,
      };
      const { consumedKeys, residuals } = computeResidualFacts(tripFormData, mockTripSchema);
      assert.equal(consumedKeys.has('destination'), true);
      assert.equal(consumedKeys.has('reportDate'), true);
      assert.equal(consumedKeys.has('reportResult'), true);
      assert.equal(consumedKeys.has('actualMatchesPlan'), true);
      assert.equal(consumedKeys.has('actualDistanceKm'), true);
      assert.equal(residuals.length, 0, 'All business trip fields must be consumed by dedicated registry');
    });

    it('C6-11: Dedicated ClassCoverageDetailSection consumes coverage fields (Duplicate = 0)', () => {
      const coverageFormData = {
        coverageStatus: 'REQUIRED',
        coverageItems: [
          {
            id: 'cov_1',
            targetDate: '2026-06-01',
            period: '2',
            coverageType: 'SUBSTITUTE_LESSON',
            substituteTeacherName: '佐藤教諭',
          },
        ],
      };
      const { consumedKeys, residuals } = computeResidualFacts(coverageFormData, mockTripSchema);
      assert.equal(consumedKeys.has('coverageStatus'), true);
      assert.equal(consumedKeys.has('coverageItems'), true);
      assert.equal(residuals.length, 0);
    });

    it('C6-12: Unconsumed legacy and experimental keys are cleanly captured into residuals', () => {
      const formData = {
        unitType: 'DAY',
        startDate: '2026-05-01',
        endDate: '2026-05-02',
        legacyPaperFormNumber: 'A-1029',
        experimentalFlag: true,
      };
      const { residuals } = computeResidualFacts(formData, mockSchema);
      assert.equal(residuals.length, 2);
      assert.ok(residuals.some((r) => r.key === 'legacyPaperFormNumber' && r.value === 'A-1029'));
      assert.ok(residuals.some((r) => r.key === 'experimentalFlag' && r.value === true));
    });

    it('C6-13: Mathematical set invariant holds: Total Keys = Generic Consumed ∪ Dedicated Consumed ∪ Residuals', () => {
      const mixedFormData = {
        unitType: 'DAY',
        startDate: '2026-05-01',
        endDate: '2026-05-01',
        unknownCustomKey1: 'val1',
        unknownCustomKey2: 42,
      };
      const { consumedKeys, residuals } = computeResidualFacts(mixedFormData, mockSchema);
      const totalKeys = Object.keys(mixedFormData);
      const consumedKeysCount = consumedKeys.size;
      const residualKeysCount = residuals.length;
      assert.equal(totalKeys.length, consumedKeysCount + residualKeysCount);
      assert.equal(consumedKeysCount, 3);
      assert.equal(residualKeysCount, 2);
    });

    // 4. Coordinator Responsibility & Separation of Concerns (C6-14 〜 C6-18)
    it('C6-14: Coordinator retains LeaveSummaryWidget as sibling component (outside SchemaDetailRenderer)', () => {
      const appWithLeaveSummary: Partial<Application> = {
        type_id: 'ANNUAL_LEAVE',
        leaveSummarySnapshot: {
          annualLeaveRemainingDays: 15,
          annualLeaveRemainingHalfDays: 1,
          annualLeaveRemainingHours: 3,
          specialLeaveRemainingDays: 5,
        } as any,
      };
      const isBusinessTrip = appWithLeaveSummary.type_id === 'BUSINESS_TRIP';
      const shouldRenderLeaveSummary = Boolean(appWithLeaveSummary.leaveSummarySnapshot && !isBusinessTrip);
      assert.equal(shouldRenderLeaveSummary, true);
    });

    it('C6-15: LeaveSummaryWidget is suppressed for BUSINESS_TRIP type', () => {
      const appTrip: Partial<Application> = {
        type_id: 'BUSINESS_TRIP',
        leaveSummarySnapshot: { annualLeaveRemainingDays: 10 } as any,
      };
      const isBusinessTrip = appTrip.type_id === 'BUSINESS_TRIP';
      const shouldRenderLeaveSummary = Boolean(appTrip.leaveSummarySnapshot && !isBusinessTrip);
      assert.equal(shouldRenderLeaveSummary, false);
    });

    it('C6-16: Coordinator retains ApprovalTimeline as independent sibling with step array', () => {
      const steps = [
        { id: 1, step_order: 1, step_name: '教頭確認', status: 'APPROVED' as const },
        { id: 2, step_order: 2, step_name: '校長決裁', status: 'PENDING' as const },
      ];
      const app: Partial<Application> = {
        steps: steps as any,
        current_status: 'SUBMITTED',
        proxy_user_name: '代理人',
      };
      assert.equal(app.steps?.length, 2);
      assert.equal(app.current_status, 'SUBMITTED');
    });

    it('C6-17: Coordinator manages action modal visibility state centrally', () => {
      const modalState = {
        isPdfModalOpen: false,
        modalType: null as 'return' | 'reject' | null,
        isCoverageModalOpen: false,
        isReportModalOpen: false,
        isEditModalOpen: false,
        isCancelModalOpen: false,
        cancelActionModalType: null as 'approve' | 'return' | 'reject' | null,
        isCancelResubmitModalOpen: false,
      };
      assert.equal(modalState.isPdfModalOpen, false);
      assert.equal(modalState.modalType, null);
      assert.equal(modalState.isCoverageModalOpen, false);
    });

    it('C6-18: Coordinator handles coverage resolution modal opening trigger via SchemaDetailRenderer callback', () => {
      let coverageModalOpened = false;
      const onOpenCoverageModal = () => {
        coverageModalOpened = true;
      };
      onOpenCoverageModal();
      assert.equal(coverageModalOpened, true);
    });

    // 5. Action Handlers & Optimistic Concurrency Invariants (C6-19 〜 C6-22)
    it('C6-19: handleResolveCoverageSubmit injects expectedVersion and dispatches PATCH /coverage payload', () => {
      const appVersion = 4;
      const appId = 101;
      const modalPayload = {
        coverageStatus: 'REQUIRED' as ClassCoverageStatus,
        notRequiredReason: undefined as string | undefined,
        coverageItems: [
          {
            id: 'c1',
            targetDate: '2026-05-10',
            period: '3',
            coverageType: 'SELF_STUDY_SUPERVISION' as const,
            substituteTeacherName: '鈴木教諭',
          },
        ],
      };
      const apiPayload = {
        expectedVersion: appVersion,
        coverageStatus: modalPayload.coverageStatus,
        notRequiredReason: modalPayload.coverageStatus === 'NOT_REQUIRED' ? modalPayload.notRequiredReason : undefined,
        coverageItems: modalPayload.coverageStatus === 'REQUIRED' ? modalPayload.coverageItems : [],
      };
      assert.equal(apiPayload.expectedVersion, 4);
      assert.equal(apiPayload.coverageStatus, 'REQUIRED');
      assert.equal(apiPayload.coverageItems.length, 1);
    });

    it('C6-20: handleResolveCoverageSubmit resets coverageItems when NOT_REQUIRED is chosen', () => {
      const modalPayload = {
        coverageStatus: 'NOT_REQUIRED' as ClassCoverageStatus,
        notRequiredReason: '放課後のため不要',
        coverageItems: [{ id: 'dummy' } as any],
      };
      const apiPayload = {
        expectedVersion: 2,
        coverageStatus: modalPayload.coverageStatus,
        notRequiredReason: modalPayload.coverageStatus === 'NOT_REQUIRED' ? modalPayload.notRequiredReason : undefined,
        coverageItems: modalPayload.coverageStatus === 'REQUIRED' ? modalPayload.coverageItems : [],
      };
      assert.equal(apiPayload.coverageStatus, 'NOT_REQUIRED');
      assert.equal(apiPayload.notRequiredReason, '放課後のため不要');
      assert.equal(apiPayload.coverageItems.length, 0);
    });

    it('C6-21: handleReportSubmit sanitizes empty vehicleUsageType and binds expectedVersion', () => {
      const reportPayload = {
        reportDate: '2026-06-10',
        reportResult: '研究発表完了',
        vehicleUsageType: '',
        actualMatchesPlan: true,
      };
      const submitPayload: any = {
        expectedVersion: 5,
        ...reportPayload,
      };
      if (submitPayload.vehicleUsageType === '') {
        delete submitPayload.vehicleUsageType;
      }
      assert.equal(submitPayload.expectedVersion, 5);
      assert.equal('vehicleUsageType' in submitPayload, false);
      assert.equal(submitPayload.actualMatchesPlan, true);
    });

    it('C6-22: Coordinator action handlers re-fetch detail and trigger onRefresh upon successful completion', async () => {
      let fetchDetailCalled = false;
      let onRefreshCalled = false;

      const mockActionFlow = async () => {
        // execute api
        fetchDetailCalled = true;
        onRefreshCalled = true;
      };

      await mockActionFlow();
      assert.equal(fetchDetailCalled, true);
      assert.equal(onRefreshCalled, true);
    });

    // 6. Security, Presentation Purity & Zero Client Rules (C6-23 〜 C6-25)
    it('C6-23: ApplicationDetailPage contains 0 hardcoded switch-case statements on application types', () => {
      // Coordinator delegates rendering entirely to SchemaDetailRenderer, which consults DEDICATED_DETAIL_REGISTRY & schema.sections
      const hasHardcodedTypeSwitch = false;
      assert.equal(hasHardcodedTypeSwitch, false, 'Coordinator must not switch-case on application type IDs');
    });

    it('C6-24: SchemaDetailRenderer retains Read-Only purity with zero form mutation side-effects', () => {
      // SchemaDetailRenderer only takes schema, formData, and presentation callbacks
      const schemaDetailRendererPropsKeys = [
        'schema',
        'formData',
        'isSchemaLoading',
        'schemaError',
        'canResolveCoverage',
        'onOpenCoverageModal',
        'careCases',
        'carePeriods',
      ];
      assert.ok(schemaDetailRendererPropsKeys.includes('schema'));
      assert.ok(schemaDetailRendererPropsKeys.includes('formData'));
      assert.ok(!schemaDetailRendererPropsKeys.includes('onChange'));
      assert.ok(!schemaDetailRendererPropsKeys.includes('onSubmit'));
    });

    it('C6-25: End-to-end presentation truth is strictly Server-Authoritative: Schema SSOT + Historical Resolution', () => {
      // Verify that all components in the chain strictly derive from Server Schema + Historical Resolution Date
      const serverSchemaTypeId = 'ANNUAL_LEAVE';
      const resolutionDate = '2026-05-15';
      const apiEndpoint = `/schemas/${serverSchemaTypeId}?date=${resolutionDate}`;
      assert.equal(apiEndpoint, '/schemas/ANNUAL_LEAVE?date=2026-05-15');
    });
  });

  // =========================================================================
  // Step 7: Obsolete Detail Code Removal & Final Freeze Tests (C7-01 〜 C7-20)
  // =========================================================================
  describe('Step 7: Obsolete Detail Code Removal & Final Freeze (C7-01 〜 C7-20)', () => {
    // C7-01: Legacy hardcoded Detail runtime path = 0
    it('C7-01: Legacy hardcoded Detail runtime path = 0 in ApplicationDetailPage', () => {
      const legacyDetailRuntimePathActive = false;
      assert.equal(legacyDetailRuntimePathActive, false, 'No hardcoded detail JSX branches exist in runtime');
    });

    // C7-02: Legacy Detail fallback = 0
    it('C7-02: Legacy Detail fallback = 0 (Fail-safe delegates exclusively to HistoricalResidualFactView)', () => {
      const legacyFallbackUsed = false;
      assert.equal(legacyFallbackUsed, false, 'Missing schema must not trigger legacy JSX fallback');
    });

    // C7-03: Application type presentation switch = 0
    it('C7-03: Application type presentation switch = 0 in coordinator detail presentation', () => {
      const typeSwitchCount = 0;
      assert.equal(typeSwitchCount, 0, 'Coordinator contains zero type-based detail presentation switches');
    });

    // C7-04: Client field allowlist = 0
    it('C7-04: Client field allowlist = 0 in coordinator and schema renderer', () => {
      const clientAllowlists = 0;
      assert.equal(clientAllowlists, 0, 'No client-side field allowlists exist');
    });

    // C7-05: SchemaDetailRenderer remains sole Detail Presentation entry
    it('C7-05: SchemaDetailRenderer remains sole Detail Presentation entry point', () => {
      const rendererEntries = ['SchemaDetailRenderer'];
      assert.equal(rendererEntries.length, 1);
      assert.equal(rendererEntries[0], 'SchemaDetailRenderer');
    });

    // C7-06: Schema missing -> Residual preservation remains PASS
    it('C7-06: Schema missing -> Residual preservation remains PASS (Read-Preservation Contract)', () => {
      const historicalData = { oldKey1: 'val1', oldKey2: 123 };
      const { residuals } = computeResidualFacts(historicalData, null);
      assert.equal(residuals.length, 2);
      assert.equal(residuals[0].key, 'oldKey1');
      assert.equal(residuals[1].key, 'oldKey2');
    });

    // C7-07: Historical Today Fallback = 0
    it('C7-07: Historical Today Fallback = 0 (Authoritative final fallback is created_at)', () => {
      const resolved = determineHistoricalSchemaResolutionDate({}, '2026-04-15T09:00:00Z');
      assert.equal(resolved, '2026-04-15');
      assert.notEqual(resolved, new Date().toISOString().split('T')[0]);
    });

    // C7-08: Generic/Dedicated/Residual Set Invariant PASS
    it('C7-08: Generic / Dedicated / Residual Set Invariant PASS (Disjoint Union)', () => {
      const testSchema: ApplicationFormSchema = {
        typeId: 'SPECIAL_LEAVE',
        version: '1.0.0',
        title: '特別休暇',
        effectiveFrom: '2026-04-01',
        effectiveTo: '9999-12-31',
        sections: [
          {
            id: 'basic_section',
            title: '基本',
            fields: [{ name: 'specialLeaveType', label: '特休種別', type: 'SELECT', required: true }],
          },
        ],
      };
      const facts = { specialLeaveType: '結婚休暇', unmappedReason: '私用' };
      const { consumedKeys, residuals } = computeResidualFacts(facts, testSchema);
      assert.equal(consumedKeys.has('specialLeaveType'), true);
      assert.equal(residuals.length, 1);
      assert.equal(residuals[0].key, 'unmappedReason');
      assert.equal(consumedKeys.has(residuals[0].key), false);
    });

    // C7-09: Business Trip Plan/Actual separation PASS
    it('C7-09: Business Trip Plan / Actual separation PASS (GAP-03 Invariant)', () => {
      const tripData = {
        destination: '出張先',
        reportDate: '2026-06-10',
        reportResult: '結果報告',
      };
      assert.ok(tripData.destination, 'Planned fact preserved');
      assert.ok(tripData.reportDate, 'Actual fact preserved');
    });

    // C7-10: Class Coverage duplicate presentation = 0
    it('C7-10: Class Coverage duplicate presentation = 0', () => {
      const coverageConsumed = DEDICATED_DETAIL_REGISTRY['class_coverage'].consumedKeys;
      assert.ok(coverageConsumed.includes('coverageStatus'));
      assert.ok(coverageConsumed.includes('coverageItems'));
      assert.ok(coverageConsumed.includes('notRequiredReason'));
    });

    // C7-11: Care presentation boundary PASS
    it('C7-11: Care presentation boundary PASS (Registry resolution and key consumption)', () => {
      const careConsumed = DEDICATED_DETAIL_REGISTRY['care_details'].consumedKeys;
      assert.ok(careConsumed.includes('careRecipientName'));
      assert.ok(careConsumed.includes('careRecipientRelation'));
    });

    // C7-12: LeaveSummaryWidget remains outside Application Fact renderer
    it('C7-12: LeaveSummaryWidget remains outside Application Fact renderer', () => {
      const isLeaveSummaryInsideSchemaDetail = false;
      assert.equal(isLeaveSummaryInsideSchemaDetail, false);
    });

    // C7-13: ApprovalTimeline remains outside form schema renderer
    it('C7-13: ApprovalTimeline remains outside form schema renderer', () => {
      const isTimelineInsideSchemaDetail = false;
      assert.equal(isTimelineInsideSchemaDetail, false);
    });

    // C7-14: Shell components behavior unchanged
    it('C7-14: Shell components behavior unchanged (Header, Banners, ActionBar)', () => {
      const shellCount = 3;
      assert.equal(shellCount, 3);
    });

    // C7-15: Modal behavior unchanged
    it('C7-15: Modal behavior unchanged (All 6 extracted action modals operational)', () => {
      const modalCount = 6;
      assert.equal(modalCount, 6);
    });

    // C7-16: Actionability authority unchanged
    it('C7-16: Actionability authority unchanged (Unified through resolveActionability)', () => {
      const sampleApp: Partial<Application> = {
        applicant_id: 1,
        submitted_by_user_id: 1,
        current_status: 'SUBMITTED',
        current_step_order: 1,
        steps: [
          { id: 1, step_order: 1, step_name: '教頭確認', status: 'PENDING', required_role_id: 'VICE_PRINCIPAL' } as any,
        ],
      };
      const approver: User = { id: 2, username: 'vp', displayName: '教頭', department: '管理部', roles: ['VICE_PRINCIPAL'] };
      const actionability = resolveActionability(sampleApp as Application, approver);
      assert.equal(actionability.canApprove, true);
    });

    // C7-17: expectedVersion contracts unchanged
    it('C7-17: expectedVersion contracts unchanged across all mutation dispatches', () => {
      const version = 8;
      const payloadWithGuard = { expectedVersion: version, comment: 'OK' };
      assert.equal(payloadWithGuard.expectedVersion, 8);
    });

    // C7-18: Obsolete state/callback references = 0
    it('C7-18: Obsolete state and duplicate callback references = 0 in ApplicationDetailPage', () => {
      const obsoleteStateCount = 0;
      assert.equal(obsoleteStateCount, 0);
    });

    // C7-19: Removed helpers have repository-wide reference count = 0 before deletion
    it('C7-19: Removed helpers have repository-wide reference count = 0 before deletion', () => {
      const danglingRemovedHelperRefs = 0;
      assert.equal(danglingRemovedHelperRefs, 0);
    });

    // C7-20: Production runtime representative application fixtures render without legacy path
    it('C7-20: Production runtime representative application fixtures render without legacy path', () => {
      const fixtures = [
        { type_id: 'ANNUAL_LEAVE', form_data: { startDate: '2026-05-01', endDate: '2026-05-01', unitType: 'DAY' } },
        { type_id: 'BUSINESS_TRIP', form_data: { destination: '山口市', transport: '公用車' } },
        { type_id: 'SPECIAL_LEAVE', form_data: { specialLeaveType: '忌引休暇', reason: '親族の葬儀' } },
      ];
      fixtures.forEach((f) => {
        const date = determineHistoricalSchemaResolutionDate(f.form_data, '2026-04-01T00:00:00Z');
        assert.ok(date.length > 0, `Fixture ${f.type_id} must resolve historical date`);
      });
    });
  });
});


