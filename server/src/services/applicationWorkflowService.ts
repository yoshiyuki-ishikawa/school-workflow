import { getDb } from '../db/database';
import { UserContext, isActionableApprover } from '../workflow/engine';

export interface PendingTaskItem {
  application_id: number;
  application_type: string;
  applicant_name: string;
  applicant_id: number;
  submitted_at: string;
  current_step_order: number;
  current_step_name: string;
  cycle_number: number;
  cycle_purpose: string;
  title: string;
}

export class ApplicationWorkflowService {
  /**
   * ログインユーザーが承認すべきPending申請の件数を取得する
   */
  static getPendingTaskCount(user: UserContext): number {
    const tasks = ApplicationWorkflowService.getPendingApplicationsForUser(user);
    return tasks.length;
  }

  /**
   * ログインユーザーが承認すべきPending申請の一覧を取得する
   * 
   * [Whole Aggregation Strict Fail-Closed & SSOT 準拠]:
   * 1. 孤立 Pending 構造異常 (CASE B) 検知時は集約処理全体を一括 Fail-Closed
   * 2. Multiple Active Cycles / Multiple Pending Steps 検知時も集約処理全体を一括 Fail-Closed
   * 3. 正常終了済み (CASE A) は正常スキップ
   * 4. 認可判定は本番共通の isActionableApprover を使用
   */
  static getPendingApplicationsForUser(
    user: UserContext,
    pagination?: { limit?: number; offset?: number }
  ): PendingTaskItem[] {
    const db = getDb();

    // 1. 孤立 Pending 構造異常の全体検証 (CASE B 検知)
    // Active Cycle (IN_PROGRESS) が存在しないのに、PENDING ステップが残存している不正データを検出
    const orphanPendingSteps = db.prepare(`
      SELECT s.id, s.application_id
      FROM application_approval_steps s
      LEFT JOIN application_workflow_cycles c 
        ON s.application_id = c.application_id AND c.status = 'IN_PROGRESS'
      WHERE s.status = 'PENDING'
        AND c.id IS NULL
    `).all() as { id: number; application_id: number }[];

    if (orphanPendingSteps.length > 0) {
      const err: any = new Error('DATA_INCONSISTENCY: Orphan pending steps detected without active workflow cycle');
      err.statusCode = 500;
      err.code = 'DATA_INCONSISTENCY';
      err.errorCode = 'DATA_INCONSISTENCY';
      throw err;
    }

    // 2. 学校内のアクティブサイクル (IN_PROGRESS) を持つ申請候補を抽出 (Candidate Universe)
    // APPROVAL / RESUBMISSION / CANCELLATION をすべて網羅
    const candidates = db.prepare(`
      SELECT 
        a.id AS application_id,
        a.subject_user_id,
        a.submitted_by_user_id,
        a.type_id AS application_type,
        a.title,
        a.created_at AS submitted_at,
        a.current_status AS application_status,
        a.current_step_order AS app_current_step_order,
        su.display_name AS applicant_name,
        c.id AS cycle_id,
        c.approval_cycle AS cycle_number,
        c.cycle_purpose,
        c.status AS cycle_status,
        c.started_by_user_id AS cycle_started_by_user_id
      FROM applications a
      JOIN application_workflow_cycles c 
        ON a.id = c.application_id AND c.status = 'IN_PROGRESS'
      JOIN users su ON a.subject_user_id = su.id
      ORDER BY a.created_at ASC
    `).all() as any[];

    // 3. 構造的整合性検証: Multiple Active Cycles 検知
    const appCycleCountMap = new Map<number, number>();
    for (const row of candidates) {
      appCycleCountMap.set(row.application_id, (appCycleCountMap.get(row.application_id) || 0) + 1);
    }

    const multipleActiveAppIds: number[] = [];
    for (const [appId, count] of appCycleCountMap.entries()) {
      if (count >= 2) {
        multipleActiveAppIds.push(appId);
      }
    }

    if (multipleActiveAppIds.length > 0) {
      const err: any = new Error(`DATA_INCONSISTENCY: Multiple active workflow cycles detected for applications: [${multipleActiveAppIds.join(', ')}]`);
      err.statusCode = 500;
      err.code = 'DATA_INCONSISTENCY';
      err.errorCode = 'DATA_INCONSISTENCY';
      throw err;
    }

    // 4. 承認対象ステップの解決 ＆ 整合性検証
    const validTasks: PendingTaskItem[] = [];

    for (const row of candidates) {
      const pendingSteps = db.prepare(`
        SELECT * FROM application_approval_steps
        WHERE application_id = ? AND approval_cycle = ? AND status = 'PENDING'
        ORDER BY step_order ASC
      `).all(row.application_id, row.cycle_number) as any[];

      // 整合性検証: 1つのActive Cycle内に複数のPENDINGステップが存在するのは構造異常
      if (pendingSteps.length >= 2) {
        const err: any = new Error(`DATA_INCONSISTENCY: Multiple PENDING steps detected in active cycle for application ${row.application_id}`);
        err.statusCode = 500;
        err.code = 'DATA_INCONSISTENCY';
        err.errorCode = 'DATA_INCONSISTENCY';
        throw err;
      }

      // PENDING ステップが 0 件の場合は現在承認待ちではない（正常系スキップ）
      if (pendingSteps.length === 0) {
        continue;
      }

      const currentStep = pendingSteps[0];

      // 5. Production Authorization SSOT: 本番同一述語による認可判定
      const canApprove = isActionableApprover(
        user,
        { subject_user_id: row.subject_user_id, submitted_by_user_id: row.submitted_by_user_id },
        { cycle_purpose: row.cycle_purpose, started_by_user_id: row.cycle_started_by_user_id },
        currentStep
      );

      if (canApprove) {
        validTasks.push({
          application_id: row.application_id,
          application_type: row.application_type,
          applicant_name: row.applicant_name,
          applicant_id: row.subject_user_id,
          submitted_at: row.submitted_at,
          current_step_order: currentStep.step_order,
          current_step_name: currentStep.step_name,
          cycle_number: row.cycle_number,
          cycle_purpose: row.cycle_purpose,
          title: row.title,
        });
      }
    }

    if (pagination && (pagination.limit !== undefined || pagination.offset !== undefined)) {
      const offset = pagination.offset || 0;
      const limit = pagination.limit || validTasks.length;
      return validTasks.slice(offset, offset + limit);
    }

    return validTasks;
  }
}
