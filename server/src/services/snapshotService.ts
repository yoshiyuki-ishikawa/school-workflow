import crypto from "crypto";
import { getDb } from "../db/database";
import { CanonicalAttendanceProjectionEngine } from "./canonical/projectionEngine";
import { MonthlyAttendanceSnapshot, MonthlyAttendanceSnapshotDay } from "../types";
import { getServerIsoString } from "../utils/serverTime";

export class SnapshotService {
  /**
   * 月次確定出勤簿 Snapshot の作成 (親 + 子テーブルへのアトミック保存)
   */
  static finalizeMonth(
    userId: number,
    yearMonth: string,
    actor: { id: number; username: string; displayName: string; stampName: string },
    comment?: string
  ): number {
    const db = getDb();
    const now = getServerIsoString();

    return db.transaction(() => {
      // 1. 既存のLOCKEDスナップショットがないか確認
      const existing = db.prepare("SELECT id, version, status FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = ? ORDER BY version DESC LIMIT 1").get(userId, yearMonth) as any;

      if (existing && existing.status === "LOCKED") {
        throw new Error(`対象月 (${yearMonth}) の出勤簿は既に確定・ロックされています`);
      }

      const nextVersion = existing ? existing.version + 1 : 1;
      const supersedesId = existing ? existing.id : null;

      // 2. 出勤簿の Canonical Snapshot Projection 計算 (Single Source of Truth: HD-PE-01)
      const snapshotData = CanonicalAttendanceProjectionEngine.getSnapshotProjection(userId, yearMonth);

      // Fail-Closed: 勤務パターン未確定日 (UNKNOWN_PATTERN) が1日でも残っている場合は月次確定を拒否
      if (snapshotData.hasUnknownPattern) {
        throw new Error(`未確定の日次状態 (UNKNOWN_PATTERN) が ${snapshotData.unresolvedDays.length} 日含まれているため、月次確定できません。勤務パターン設定を完了してください。`);
      }

      const days = snapshotData.days;
      const summaryJson = snapshotData.summaryJson;

      // チェックサム計算 (改ざん検知ハッシュ: nextVersion を含めて再計算)
      const contentToHash = `${userId}:${yearMonth}:${nextVersion}:${summaryJson}:${JSON.stringify(days)}`;
      const checksum = crypto.createHash("sha256").update(contentToHash).digest("hex");

      // 3. 親テーブル INSERT
      const insertParent = db.prepare(`
        INSERT INTO monthly_attendance_snapshots (
          user_id, year_month, version, status, confirmed_at, confirmed_by_user_id,
          confirmed_by_user_name, confirmed_user_stamp_name, monthly_summary_json,
          checksum, supersedes_snapshot_id, created_at
        ) VALUES (?, ?, ?, 'LOCKED', ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = insertParent.run(
        userId,
        yearMonth,
        nextVersion,
        now,
        actor.id,
        actor.displayName,
        actor.stampName,
        summaryJson,
        checksum,
        supersedesId,
        now
      );

      const snapshotId = Number(result.lastInsertRowid);

      // 旧バージョンを SUPERSEDED に更新
      if (supersedesId) {
        db.prepare("UPDATE monthly_attendance_snapshots SET status = 'SUPERSEDED' WHERE id = ?").run(supersedesId);
      }

      // 4. 子テーブル INSERT (日次確定明細)
      const insertDay = db.prepare(`
        INSERT INTO monthly_attendance_snapshot_days (
          snapshot_id, date, day_of_month, is_required_work_day,
          scheduled_work_minutes, actual_work_minutes, personnel_status_code,
          daily_event_code, display_symbol, display_name, aggregation_category,
          resolution_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const d of days) {
        const dayOfMonth = parseInt(d.date.split("-")[2], 10);
        insertDay.run(
          snapshotId,
          d.date,
          dayOfMonth,
          d.isWorkDay ? 1 : 0,
          d.scheduledWorkMinutes,
          d.actualWorkMinutes,
          d.personnelStatusCode || (d.absenceInfo ? "ABSENCE" : "NORMAL"),
          d.dailyEventCode || null,
          d.displaySymbol,
          d.displayName,
          d.aggregationCategory,
          JSON.stringify(d),
          now
        );
      }

      // 既存 monthly_attendance_approvals との互換性同期
      let orgSnapshot = "{}";
      try {
        const { getCurrentOrganizationSnapshot } = require("../workflow/engine");
        orgSnapshot = getCurrentOrganizationSnapshot(db);
      } catch {}

      db.prepare(`
        INSERT INTO monthly_attendance_approvals (
          user_id, year_month, status, confirmed_by_user_id, confirmed_at, comment,
          confirmed_user_display_name, confirmed_user_stamp_name, organization_snapshot, version
        ) VALUES (?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, year_month) DO UPDATE SET
          status = 'CONFIRMED',
          confirmed_by_user_id = excluded.confirmed_by_user_id,
          confirmed_at = excluded.confirmed_at,
          comment = excluded.comment,
          confirmed_user_display_name = excluded.confirmed_user_display_name,
          confirmed_user_stamp_name = excluded.confirmed_user_stamp_name,
          organization_snapshot = excluded.organization_snapshot,
          version = excluded.version
      `).run(userId, yearMonth, actor.id, now, comment || "出勤簿点検・確認済", actor.displayName, actor.stampName, orgSnapshot, nextVersion);

      return snapshotId;
    })();
  }

  /**
   * 確定済みSnapshot取得 (確定後は再計算せずDBから100%復元: INV-CUT-09)
   */
  static getSnapshot(userId: number, yearMonth: string): { parent: MonthlyAttendanceSnapshot; days: MonthlyAttendanceSnapshotDay[] } | null {
    const db = getDb();
    const parent = db.prepare(`
      SELECT * FROM monthly_attendance_snapshots
      WHERE user_id = ? AND year_month = ? AND status != 'SUPERSEDED'
      ORDER BY version DESC LIMIT 1
    `).get(userId, yearMonth) as MonthlyAttendanceSnapshot | undefined;

    if (!parent) return null;

    const days = db.prepare(`
      SELECT * FROM monthly_attendance_snapshot_days
      WHERE snapshot_id = ?
      ORDER BY date ASC
    `).all(parent.id) as MonthlyAttendanceSnapshotDay[];

    return { parent, days };
  }
}
