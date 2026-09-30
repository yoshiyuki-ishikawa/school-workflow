import { getServerIsoString } from '../../utils/serverTime';

export class TripReportFinalizationService {
  /**
   * 通信運送費負担の厳格パース (FINAL-PINPOINT-04: Strict Tri-State Parsing)
   * Invariant: false != unknown. "false" -> false, true -> true, null/undefined -> null
   */
  public static parseCommunicationCostBorne(val: any): boolean | null {
    if (val === true || val === 'true' || val === 1) return true;
    if (val === false || val === 'false' || val === 0) return false;
    return null; // 未入力 / 不明 (Unknown)
  }

  /**
   * 復命書および旅行実績情報の決裁完了処理 (Atomic Same DB Transaction)
   */
  static finalizeTripReport(applicationId: number, db: any, actor: any): void {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
    if (!app) {
      const err: any = new Error(`Application ${applicationId} not found`);
      err.statusCode = 404;
      throw err;
    }

    const trip = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(app.trip_event_id);
    if (!trip) {
      const err: any = new Error(`TripEvent ${app.trip_event_id} not found`);
      err.statusCode = 404;
      throw err;
    }

    const formData = JSON.parse(app.form_data || '{}');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(actor.id);

    // FINAL-PINPOINT-03 是正: 暗黙コピーの禁止と明示確認 Fact の適用
    const actualMatchesPlan = formData.actualMatchesPlan === true || formData.actualMatchesPlan === 'true';

    const actualDeparturePlace = formData.actualDeparturePlace !== undefined && formData.actualDeparturePlace !== ''
      ? formData.actualDeparturePlace
      : (actualMatchesPlan ? trip.departure_place : null);

    const actualArrivalPlace = formData.actualArrivalPlace !== undefined && formData.actualArrivalPlace !== ''
      ? formData.actualArrivalPlace
      : (actualMatchesPlan ? trip.arrival_place : null);

    const actualTransportMode = formData.actualTransportMode !== undefined && formData.actualTransportMode !== ''
      ? formData.actualTransportMode
      : (actualMatchesPlan ? trip.transport : null);

    const actualFacts = {
      actualMatchesPlan,
      actualDeparturePlace,
      actualArrivalPlace,
      actualTransportMode,
      vehicleUsageType: formData.vehicleUsageType || null,
      communicationCostBorne: this.parseCommunicationCostBorne(formData.communicationCostBorne),
      actualDistanceKm: typeof formData.actualDistanceKm === 'number' 
        ? formData.actualDistanceKm 
        : (formData.actualDistanceKm && !isNaN(Number(formData.actualDistanceKm)) ? Number(formData.actualDistanceKm) : null),
      actualTripStartAt: formData.actualTripStartAt || null,
      actualTripEndAt: formData.actualTripEndAt || null,
      travelExpenseRemarks: formData.travelExpenseRemarks || ''
    };

    // 承認サイクルの確認 (存在する場合のみFKを満たす)
    let cycleId: number | null = null;
    if (app.current_workflow_cycle_id) {
      const existingCycle = db.prepare('SELECT id FROM application_workflow_cycles WHERE id = ?').get(app.current_workflow_cycle_id);
      if (existingCycle) {
        cycleId = existingCycle.id;
      }
    }
    if (!cycleId) {
      const latestCycle = db.prepare('SELECT id FROM application_workflow_cycles WHERE application_id = ? ORDER BY approval_cycle DESC LIMIT 1').get(applicationId) as any;
      if (latestCycle) {
        cycleId = latestCycle.id;
      }
    }

    // 復命承認履歴スナップショットの収集 (現在のサイクル)
    const reportSteps = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ?
      ORDER BY step_order ASC
    `).all(applicationId);

    // 復命不変スナップショットの永続化
    db.prepare(`
      INSERT INTO post_trip_report_snapshots (
        application_id, workflow_cycle_id, report_date, result_summary,
        remarks, travel_actual_facts_json, author_user_id_snapshot,
        author_name_snapshot, report_approval_snapshots_json, finalized_at, finalized_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      applicationId,
      cycleId,
      formData.reportDate || getServerIsoString().split('T')[0],
      formData.reportResult || '復命完了',
      formData.reportRemarks || '',
      JSON.stringify(actualFacts),
      user?.id || actor.id,
      user?.display_name || actor.displayName || '教職員',
      JSON.stringify(reportSteps),
      getServerIsoString(),
      actor.id
    );
  }
}
