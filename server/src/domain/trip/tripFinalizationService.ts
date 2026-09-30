import { toTokyoCalendarDate, getServerIsoString } from '../../utils/serverTime';
import { getCurrentOrganizationSnapshot } from '../../workflow/engine';
import { OfficialJobTitleResolver } from '../jobTitle/officialJobTitleResolver';


export class TripFinalizationService {
  /**
   * Final Authority（旅行命令権限者・校長等）の適格性および発令年月日の厳格解決
   * 
   * Invariant:
   * 1. 口頭発令出張: trip.oral_order_issued_at が Authority Fact (travel_order_issued_at < final_approved_at 成立)
   * 2. 通常電子申請: is_final_decision_step かつ 旅行命令権者（PRINCIPAL等）の承認操作日 (Asia/Tokyo 暦日)
   * 3. 権限不整合時: Fail-Closed (UNRESOLVED)
   */
  public static resolveTravelOrderIssuedAt(
    trip: any,
    finalAuthorityStep: any
  ): string {
    // 1. 口頭発令出張の場合: 実際の口頭発令年月日 (Authority Fact)
    if (trip.is_oral_order === 1) {
      if (!trip.oral_order_issued_at) {
        const err: any = new Error('FAIL-CLOSED: 口頭発令出張の oral_order_issued_at（Authority Fact）が欠落しています');
        err.statusCode = 500;
        err.errorCode = 'ORAL_ORDER_ISSUED_AT_MISSING';
        throw err;
      }
      return trip.oral_order_issued_at;
    }

    // 2. 通常電子申請の場合: Final Authority の承認操作日 (Legal Issuance Act)
    if (!finalAuthorityStep) {
      const err: any = new Error('FAIL-CLOSED: 旅行命令権者の承認ステップ記録が存在しません');
      err.statusCode = 500;
      err.errorCode = 'FINAL_AUTHORITY_STEP_MISSING';
      throw err;
    }

    // 旅行命令権限の検証 (GT-W3-26 ガード: 単なる最終ステップではなく権限者であることを検証)
    // INV-BT-AUTH-01 / INV-BT-AUTH-02: is_final_decision_step 単体での権限認定を撤廃し、構造的権限 (PRINCIPAL) を要求
    const isPrincipalOrAuthorized = 
      finalAuthorityStep.required_role_id === 'PRINCIPAL' ||
      finalAuthorityStep.selector_value_snapshot === 'PRINCIPAL' ||
      finalAuthorityStep.selector_value === 'PRINCIPAL';

    if (!isPrincipalOrAuthorized) {
      const err: any = new Error(`FAIL-CLOSED: [INVALID_TRAVEL_ORDER_AUTHORITY] 承認者ステップ [${finalAuthorityStep.step_name}] は旅行命令権限を持たないため、旅行命令発令年月日を生成できません`);
      err.statusCode = 500;
      err.errorCode = 'INVALID_TRAVEL_ORDER_AUTHORITY';
      throw err;
    }

    if (!finalAuthorityStep.acted_at) {
      const err: any = new Error('FAIL-CLOSED: 旅行命令権者の最終承認操作日時（acted_at）が未記録です');
      err.statusCode = 500;
      err.errorCode = 'FINAL_AUTHORITY_NOT_ACTED';
      throw err;
    }

    // Asia/Tokyo タイムゾーンによる公務暦日の厳密導出 (GT-W3-27 ガード: UTC先頭10文字切り出しを禁止)
    return toTokyoCalendarDate(finalAuthorityStep.acted_at);
  }

  /**
   * 旅行命令の決裁完了処理 (Atomic Same DB Transaction)
   */
  static finalizeTravelOrder(applicationId: number, db: any, actor: any): void {
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
    if (!app) {
      const err: any = new Error(`Application ${applicationId} not found`);
      err.statusCode = 404;
      throw err;
    }

    const trip = db.prepare('SELECT * FROM trip_events WHERE id = ?').get(app.trip_event_id);
    if (!trip) {
      const err: any = new Error(`TripEvent ${app.trip_event_id} not found for Application ${applicationId}`);
      err.statusCode = 404;
      throw err;
    }

    const user = db.prepare(`
      SELECT u.*, p.name as position_name 
      FROM users u 
      LEFT JOIN user_positions up ON u.id = up.user_id AND up.is_primary = 1
      LEFT JOIN positions p ON up.position_id = p.id 
      WHERE u.id = ?
    `).get(app.subject_user_id) as any;

    const orgSnapshot = getCurrentOrganizationSnapshot(db);
    const org = JSON.parse(orgSnapshot);

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

    // 承認履歴スナップショットの収集
    const steps = db.prepare(`
      SELECT * FROM application_approval_steps
      WHERE application_id = ?
      ORDER BY step_order ASC
    `).all(applicationId) as any[];

    // Final Authority ステップの特定 (is_final_decision_step = 1 または PRINCIPAL)
    const finalStep = steps.find(s => s.is_final_decision_step === 1 || s.step_key?.includes('PRINCIPAL') || s.required_role_id === 'PRINCIPAL') || steps[steps.length - 1];

    // 発令年月日の厳密導出 (Fail-Closed)
    const issuedAt = this.resolveTravelOrderIssuedAt(trip, finalStep);
    const targetOrderDate = issuedAt.split('T')[0];

    // 正式職名の厳格解決 (Fail-Closed: INV-JT-12, Target-Date: 発令日時点)
    const resolvedJobTitle = OfficialJobTitleResolver.resolveAtDate(db, app.subject_user_id, targetOrderDate, { strict: true });

    // 不変スナップショットの永続化
    db.prepare(`
      INSERT INTO travel_order_snapshots (
        application_id, workflow_cycle_id, trip_event_id, travel_order_issued_at,
        school_name_snapshot, traveler_user_id_snapshot, traveler_name_snapshot,
        traveler_position_snapshot, trip_plan_facts_json, approval_history_snapshots_json,
        finalized_at, finalized_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      applicationId,
      cycleId,
      trip.id,
      issuedAt,
      org.schoolName || '学校',
      user?.id || app.subject_user_id,
      user?.display_name || '教職員',
      resolvedJobTitle.displayName,
      JSON.stringify({
        purpose: trip.purpose,
        destination: trip.destination,
        departurePlace: trip.departure_place || null,
        arrivalPlace: trip.arrival_place || null,
        plannedTripStartAt: trip.start_at,
        plannedTripEndAt: trip.end_at,
        transport: trip.transport,
        isOralOrder: trip.is_oral_order === 1,
        oralOrderIssuedAt: trip.oral_order_issued_at || null,
        officialJobTitleSnapshot: {
          jobTitleId: resolvedJobTitle.jobTitleId,
          jobTitleCode: resolvedJobTitle.code,
          displayNameSnapshot: resolvedJobTitle.displayName,
          effectiveFromSnapshot: resolvedJobTitle.effectiveFrom,
          effectiveToSnapshot: resolvedJobTitle.effectiveTo,
          snapshottedAt: new Date().toISOString(),
        },
      }),
      JSON.stringify(steps),
      getServerIsoString(),
      actor.id

    );
  }
}
