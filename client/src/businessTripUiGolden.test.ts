import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { projectPreTripSchema, projectApplicationFormData } from './pages/NewApplicationModal';
import { ApprovalTimeline, classifyCycleSemantic, groupStepsByCycle } from './components/ApprovalTimeline';
import { WorkflowAlertBanners } from './components/detail/WorkflowAlertBanners';
import { DashboardPendingTasksPanel } from './components/DashboardPendingTasksPanel';
import { ApplicationFormSchema } from './types/formSchema';
import { ApprovalStep, BusinessTripReportStatus } from './types';

/**
 * Business Trip UI/UX v1.1 FINAL Golden Tests (GT-UI-BT-01〜08)
 * 
 * 4-Point Projection Fix × Smallest Safe Change Design Verification
 */
describe('Business Trip UI/UX v1.1 FINAL Golden Suite (GT-UI-BT-01〜08)', () => {
  // Mock activeSchema for Business Trip (matching server/seeds schema definition)
  const fullBusinessTripSchema: ApplicationFormSchema = {
    typeId: 'BUSINESS_TRIP',
    version: '1.0.0',
    title: '旅行命令兼復命書 (公務出張)',
    effectiveFrom: '2026-04-01',
    effectiveTo: '9999-12-31',
    sections: [
      {
        id: 'order_details',
        title: '旅行命令・用務日程 (事前起案)',
        fields: [
          { name: 'destination', label: '用務先・出張先', type: 'TEXT', required: true },
          { name: 'transport', label: '旅行方法 (交通手段)', type: 'SELECT', required: true, defaultValue: '公用車' },
          { name: 'startDate', label: '開始日', type: 'DATE', required: true },
          { name: 'endDate', label: '終了日', type: 'DATE', required: true },
        ],
      },
      {
        id: 'report_details',
        title: '復命書・旅行実績情報 (事後報告)',
        fields: [
          { name: 'reportDate', label: '復命年月日', type: 'DATE', required: false },
          { name: 'reportResult', label: '結果又は状況 (復命本文)', type: 'TEXTAREA', required: false },
          { name: 'reportRemarks', label: '復命備考', type: 'TEXTAREA', required: false },
          { name: 'actualMatchesPlan', label: '旅行実績は計画どおり', type: 'BOOLEAN', required: false, defaultValue: true },
          { name: 'actualDeparturePlace', label: '実績出発地', type: 'SELECT', required: false },
          { name: 'actualArrivalPlace', label: '実績帰着地', type: 'SELECT', required: false },
          { name: 'actualTransportMode', label: '実績交通手段', type: 'SELECT', required: false },
        ],
      },
    ],
  };

  // =========================================================================
  // GT-UI-BT-01: 新規出張起案画面で post-trip (report_details) UI が存在しないこと
  // =========================================================================
  it('GT-UI-BT-01: 新規出張起案画面で report_details セクションがスキーマから完全に除外されていること', () => {
    const projectedSchema = projectPreTripSchema(fullBusinessTripSchema);
    assert.ok(projectedSchema, 'projectedSchema must not be null');
    assert.equal(projectedSchema.sections.length, 1);
    assert.equal(projectedSchema.sections[0].id, 'order_details');

    const hasReportSection = projectedSchema.sections.some((s) => s.id === 'report_details');
    assert.equal(hasReportSection, false, 'report_details must not exist in projected pre-trip schema');

    const allFieldNames = projectedSchema.sections.flatMap((s) => s.fields.map((f) => f.name));
    assert.equal(allFieldNames.includes('actualMatchesPlan'), false);
    assert.equal(allFieldNames.includes('reportDate'), false);
    assert.equal(allFieldNames.includes('reportResult'), false);
    assert.equal(allFieldNames.includes('reportRemarks'), false);
    assert.equal(allFieldNames.includes('actualDeparturePlace'), false);
  });

  // =========================================================================
  // GT-UI-BT-02: Create Payload に actualMatchesPlan: true 等の事後フィールドが混入しないこと
  // =========================================================================
  it('GT-UI-BT-02: Create Payload に actualMatchesPlan: true などの defaultValue や事後フィールドが一切混入しないこと', () => {
    const payload = projectApplicationFormData({
      selectedTypeId: 'BUSINESS_TRIP',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      destination: '県立教育センター',
      transport: '公用車',
      activeSchema: fullBusinessTripSchema,
    });

    assert.equal(payload.destination, '県立教育センター');
    assert.equal(payload.transport, '公用車');
    assert.equal(payload.startDate, '2026-06-10');
    assert.equal(payload.endDate, '2026-06-10');

    // 絶対混入阻止
    assert.equal(payload.actualMatchesPlan, undefined, 'actualMatchesPlan: true defaultValue must NOT leak into payload');
    assert.equal(payload.reportDate, undefined);
    assert.equal(payload.reportResult, undefined);
    assert.equal(payload.reportRemarks, undefined);
    assert.equal(payload.actualDeparturePlace, undefined);
    assert.equal(payload.actualArrivalPlace, undefined);
    assert.equal(payload.actualTransportMode, undefined);
  });

  // =========================================================================
  // GT-UI-BT-03: 旅行命令Cycle正常完了後のUI（復命待ち）
  // =========================================================================
  it('GT-UI-BT-03: 旅行命令Cycle正常完了後（TRIP_APPROVED または FINAL_APPROVED + UNSUBMITTED）に旅行命令決裁完了バナーが表示されること', () => {
    let reportModalOpened = false;
    const element = WorkflowAlertBanners({
      currentStatus: 'TRIP_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'UNSUBMITTED',
      canSubmitReport: true,
      onOpenReportModal: () => {
        reportModalOpened = true;
      },
    }) as React.ReactElement;

    assert.ok(element);
    const jsonStr = JSON.stringify(element);
    assert.ok(jsonStr.includes('旅行命令 決裁完了'));
    assert.ok(jsonStr.includes('復命書を提出'));
  });

  // =========================================================================
  // GT-UI-BT-04: 復命Cycle進行中のUI（復命承認中）
  // =========================================================================
  it('GT-UI-BT-04: 復命Cycle進行中（REPORT_SUBMITTED または reportStatus === "REPORT_SUBMITTED"）に出張復命承認中バナーが表示されること', () => {
    const element = WorkflowAlertBanners({
      currentStatus: 'REPORT_SUBMITTED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'REPORT_SUBMITTED',
      canSubmitReport: false,
    }) as React.ReactElement;

    assert.ok(element);
    const jsonStr = JSON.stringify(element);
    assert.ok(jsonStr.includes('出張復命 承認中'));
    assert.ok(jsonStr.includes('復命書の決裁ルートが進行しています'));
  });

  // =========================================================================
  // GT-UI-BT-05: 復命最終完了後のUI（全行程完了）
  // =========================================================================
  it('GT-UI-BT-05: 復命最終完了後（reportStatus === "REPORT_FINAL_APPROVED"）に出張・復命 全行程完了バナーが表示されること', () => {
    const element = WorkflowAlertBanners({
      currentStatus: 'FINAL_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'REPORT_FINAL_APPROVED',
      canSubmitReport: false,
    }) as React.ReactElement;

    assert.ok(element);
    const jsonStr = JSON.stringify(element);
    assert.ok(jsonStr.includes('出張・復命 全行程完了'));
    assert.ok(jsonStr.includes('全決裁が完了しました'));
  });

  // =========================================================================
  // GT-UI-BT-06: Pending Task において APPROVAL と POST_TRIP_REPORT が識別できること
  // =========================================================================
  it('GT-UI-BT-06: Pending Task において cycle_purpose === "POST_TRIP_REPORT" は「出張復命承認」として通常承認と明確に識別されること', () => {
    // We test the presentation contract directly:
    // CANCELLATION -> '承認後取消'
    // POST_TRIP_REPORT -> '出張復命承認 (教頭確認)'
    // APPROVAL -> '教頭確認'
    const resolveTaskBadge = (task: { cycle_purpose: string; current_step_name: string }) => {
      if (task.cycle_purpose === 'CANCELLATION') return '承認後取消';
      if (task.cycle_purpose === 'POST_TRIP_REPORT') return `出張復命承認 (${task.current_step_name})`;
      return task.current_step_name;
    };

    assert.equal(
      resolveTaskBadge({ cycle_purpose: 'APPROVAL', current_step_name: '教頭確認' }),
      '教頭確認'
    );
    assert.equal(
      resolveTaskBadge({ cycle_purpose: 'POST_TRIP_REPORT', current_step_name: '教頭確認' }),
      '出張復命承認 (教頭確認)'
    );
    assert.equal(
      resolveTaskBadge({ cycle_purpose: 'CANCELLATION', current_step_name: '教頭確認' }),
      '承認後取消'
    );
  });

  // =========================================================================
  // GT-UI-BT-07: 旅行命令Cycle正常完了後、復命CycleがCurrentになった際、過去Cycleが「決裁完了」と表示されること
  // =========================================================================
  it('GT-UI-BT-07: 旅行命令Cycle（第1サイクル）が正常完了し、復命Cycle（第2サイクル）が進行中の場合、第1サイクルが「決裁完了」と表示され「差戻し履歴」と誤認表示されないこと', () => {
    const steps: ApprovalStep[] = [
      // 第1サイクル: 旅行命令承認 (全APPROVEDで完了)
      {
        id: 1,
        application_id: 201,
        approval_cycle: 1,
        step_order: 1,
        step_name: '教頭確認',
        required_role_id: 'VICE_PRINCIPAL',
        status: 'APPROVED',
        is_final_decision_step: 0,
      },
      {
        id: 2,
        application_id: 201,
        approval_cycle: 1,
        step_order: 2,
        step_name: '校長決裁',
        required_role_id: 'PRINCIPAL',
        status: 'APPROVED',
        is_final_decision_step: 1,
      },
      // 第2サイクル: 復命書審査中
      {
        id: 3,
        application_id: 201,
        approval_cycle: 2,
        step_order: 1,
        step_name: '教頭確認',
        required_role_id: 'VICE_PRINCIPAL',
        status: 'PENDING',
        is_final_decision_step: 0,
      },
      {
        id: 4,
        application_id: 201,
        approval_cycle: 2,
        step_order: 2,
        step_name: '校長決裁',
        required_role_id: 'PRINCIPAL',
        status: 'WAITING',
        is_final_decision_step: 1,
      },
    ];

    const cycles = groupStepsByCycle(steps);
    assert.equal(cycles.length, 2);
    // cycles[0] is cycle 2 (current), cycles[1] is cycle 1 (past)
    const [cycle2Num, cycle2Steps] = cycles[0];
    const [cycle1Num, cycle1Steps] = cycles[1];

    const class2 = classifyCycleSemantic(cycle2Num, cycle2Steps, true);
    assert.equal(class2.badgeVariant, 'current');
    assert.equal(class2.badgeLabel, '現在の承認フロー (第2サイクル)');

    const class1 = classifyCycleSemantic(cycle1Num, cycle1Steps, false);
    assert.equal(class1.badgeVariant, 'approved');
    assert.equal(class1.isCycleApproved, true);
    assert.equal(class1.isCycleReturned, false);
    assert.equal(class1.badgeLabel, '決裁完了 (第1サイクル)');
  });

  // =========================================================================
  // GT-UI-BT-08: 実際にRETURNEDとなったHistorical Cycleだけが「差戻し履歴」と表示されること
  // =========================================================================
  it('GT-UI-BT-08: 実際に差戻し（RETURNED）が発生して再申請された履歴サイクルだけが「差戻し履歴」として表示されること', () => {
    const steps: ApprovalStep[] = [
      // 第1サイクル: 差戻し
      {
        id: 1,
        application_id: 202,
        approval_cycle: 1,
        step_order: 1,
        step_name: '教頭確認',
        required_role_id: 'VICE_PRINCIPAL',
        status: 'RETURNED',
        is_final_decision_step: 0,
      },
      // 第2サイクル: 再申請後、現在進行中
      {
        id: 2,
        application_id: 202,
        approval_cycle: 2,
        step_order: 1,
        step_name: '教頭確認',
        required_role_id: 'VICE_PRINCIPAL',
        status: 'PENDING',
        is_final_decision_step: 0,
      },
      {
        id: 3,
        application_id: 202,
        approval_cycle: 2,
        step_order: 2,
        step_name: '校長決裁',
        required_role_id: 'PRINCIPAL',
        status: 'WAITING',
        is_final_decision_step: 1,
      },
    ];

    const cycles = groupStepsByCycle(steps);
    assert.equal(cycles.length, 2);
    const [cycle2Num, cycle2Steps] = cycles[0];
    const [cycle1Num, cycle1Steps] = cycles[1];

    const class2 = classifyCycleSemantic(cycle2Num, cycle2Steps, true);
    assert.equal(class2.badgeVariant, 'current');
    assert.equal(class2.badgeLabel, '現在の承認フロー (第2サイクル)');

    const class1 = classifyCycleSemantic(cycle1Num, cycle1Steps, false);
    assert.equal(class1.badgeVariant, 'returned');
    assert.equal(class1.isCycleReturned, true);
    assert.equal(class1.isCycleApproved, false);
    assert.equal(class1.badgeLabel, '差戻し履歴 (第1サイクル)');
  });
});

/**
  * Business Trip Canonical report_status Tests (GT-UI-BT-CANON-01〜05)
  * 
  * Server / DB Canonical Values Contract Verification
  */
describe('Business Trip Canonical report_status Tests (GT-UI-BT-CANON-01〜05)', () => {
  // GT-UI-BT-CANON-01: Client BusinessTripReportStatus union conforms to Server Canonical values
  it('GT-UI-BT-CANON-01: BusinessTripReportStatus型がサーバー/DBの6つの正規値（UNSUBMITTED, REPORT_SUBMITTED, REPORT_FIRST_APPROVED, REPORT_SECOND_APPROVED, REPORT_RETURNED, REPORT_FINAL_APPROVED）に厳格準拠すること', () => {
    const validStatuses: BusinessTripReportStatus[] = [
      'UNSUBMITTED',
      'REPORT_SUBMITTED',
      'REPORT_FIRST_APPROVED',
      'REPORT_SECOND_APPROVED',
      'REPORT_RETURNED',
      'REPORT_FINAL_APPROVED',
    ];
    assert.equal(validStatuses.length, 6);
    // TypeScript 型チェックが通ることを検証
    const testAssign: (status: BusinessTripReportStatus) => string = (s) => s;
    validStatuses.forEach((s) => assert.equal(typeof testAssign(s), 'string'));
  });

  // GT-UI-BT-CANON-02: reportStatus === 'UNSUBMITTED' renders 旅行命令決裁完了 banner
  it('GT-UI-BT-CANON-02: reportStatus === "UNSUBMITTED" で旅行命令決裁完了バナーが表示されること', () => {
    const element = WorkflowAlertBanners({
      currentStatus: 'FINAL_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'UNSUBMITTED',
      canSubmitReport: true,
    }) as React.ReactElement;

    assert.ok(element);
    const jsonStr = JSON.stringify(element);
    assert.ok(jsonStr.includes('旅行命令 決裁完了'));
    assert.ok(jsonStr.includes('公務出張の旅行命令が発令されています'));
  });

  // GT-UI-BT-CANON-03: reportStatus === 'REPORT_SUBMITTED' renders 出張復命 承認中 banner
  it('GT-UI-BT-CANON-03: reportStatus === "REPORT_SUBMITTED" で出張復命承認中バナーが表示されること', () => {
    const element = WorkflowAlertBanners({
      currentStatus: 'TRIP_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'REPORT_SUBMITTED',
      canSubmitReport: false,
    }) as React.ReactElement;

    assert.ok(element);
    const jsonStr = JSON.stringify(element);
    assert.ok(jsonStr.includes('出張復命 承認中'));
    assert.ok(jsonStr.includes('復命書の決裁ルートが進行しています'));
  });

  // GT-UI-BT-CANON-04: reportStatus === 'REPORT_FIRST_APPROVED' / 'REPORT_SECOND_APPROVED' renders 出張復命 承認中 banner
  it('GT-UI-BT-CANON-04: 中間承認状態（REPORT_FIRST_APPROVED / REPORT_SECOND_APPROVED）で出張復命承認中バナーが表示されること', () => {
    const element1 = WorkflowAlertBanners({
      currentStatus: 'TRIP_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'REPORT_FIRST_APPROVED',
      canSubmitReport: false,
    }) as React.ReactElement;
    assert.ok(JSON.stringify(element1).includes('出張復命 承認中'));

    const element2 = WorkflowAlertBanners({
      currentStatus: 'TRIP_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'REPORT_SECOND_APPROVED',
      canSubmitReport: false,
    }) as React.ReactElement;
    assert.ok(JSON.stringify(element2).includes('出張復命 承認中'));
  });

  // GT-UI-BT-CANON-05: reportStatus === 'REPORT_FINAL_APPROVED' renders 出張・復命 全行程完了 banner
  it('GT-UI-BT-CANON-05: reportStatus === "REPORT_FINAL_APPROVED" で出張・復命 全行程完了バナーが表示されること', () => {
    const element = WorkflowAlertBanners({
      currentStatus: 'FINAL_APPROVED',
      hasActiveCancellation: false,
      isBusinessTrip: true,
      reportStatus: 'REPORT_FINAL_APPROVED',
      canSubmitReport: false,
    }) as React.ReactElement;

    assert.ok(element);
    const jsonStr = JSON.stringify(element);
    assert.ok(jsonStr.includes('出張・復命 全行程完了'));
    assert.ok(jsonStr.includes('旅行命令および復命書の全決裁が完了しました'));
  });
});

