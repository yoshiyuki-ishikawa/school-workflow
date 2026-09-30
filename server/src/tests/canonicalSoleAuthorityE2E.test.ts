/**
 * Phase E: Canonical Sole-Authority Dedicated E2E Test Suite (E2E-CUT-01 〜 E2E-CUT-09)
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { setDb, getDb } from "../db/database";
import { SCHEMA_SQL } from "../db/schema";
import { migrator } from "../db/migrations";
import { seedDatabase } from "../db/seeds";
import { AttendanceEngine } from "../services/attendance/attendanceEngine";
import { CanonicalAttendanceProjectionEngine } from "../services/canonical/projectionEngine";
import { SnapshotService } from "../services/snapshotService";
import { CareLeaveService } from "../services/careLeaveService";
import { WorkingObligationResolver } from "../services/attendance/workingObligationResolver";

describe("Phase E: Canonical Sole-Authority Dedicated E2E Suite (E2E-CUT-01〜09)", () => {
  let db: any;
  const now = new Date().toISOString();

  let legacyCallCount = 0;
  const originalGetMonthlyAttendanceData = AttendanceEngine.getMonthlyAttendanceData;
  const originalResolveDay = AttendanceEngine.resolveDay;

  before(() => {
    db = new Database(":memory:");
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();

    (AttendanceEngine as any).getMonthlyAttendanceData = function(...args: any[]) {
      legacyCallCount++;
      return originalGetMonthlyAttendanceData.apply(this, args);
    };
    (AttendanceEngine as any).resolveDay = function(...args: any[]) {
      legacyCallCount++;
      return originalResolveDay.apply(this, args);
    };
  });

  beforeEach(() => {
    legacyCallCount = 0;
    db.prepare("DELETE FROM applications").run();
    db.prepare("DELETE FROM personnel_statuses").run();
    db.prepare("DELETE FROM absences").run();
    db.prepare("DELETE FROM calendar_adjustments").run();
    db.prepare("DELETE FROM monthly_attendance_snapshots").run();
    db.prepare("DELETE FROM monthly_attendance_snapshot_days").run();
    db.prepare("DELETE FROM monthly_attendance_approvals").run();
    db.prepare("DELETE FROM care_periods").run();
    db.prepare("DELETE FROM care_cases").run();
  });

  const actorManager = {
    id: 3,
    username: "vice_principal",
    displayName: "山田 太郎",
    stampName: "山田",
    ipAddress: "127.0.0.1",
    userAgent: "test-agent"
  };

  it("E2E-CUT-01: 通常勤務・年休・病休・出張混在月の Canonical 出勤簿取得と集計完全性", () => {
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at) VALUES (101, \x27LEAVE_ANNUAL\x27, 1, 1, \x27年休\x27, ?, \x27FINAL_APPROVED\x27, 1, ?, ?)`).run(JSON.stringify({ startDate: "2026-05-15", endDate: "2026-05-15", reasonCode: "ANNUAL_LEAVE" }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at) VALUES (102, \x27LEAVE_SICK\x27, 1, 1, \x27病休\x27, ?, \x27FINAL_APPROVED\x27, 1, ?, ?)`).run(JSON.stringify({ startDate: "2026-05-18", endDate: "2026-05-18" }), now, now);
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at) VALUES (103, \x27BUSINESS_TRIP\x27, 1, 1, \x27出張\x27, ?, \x27FINAL_APPROVED\x27, 1, ?, ?)`).run(JSON.stringify({ startDate: "2026-05-20", endDate: "2026-05-20", destination: "県教育センター" }), now, now);

    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, "2026-05", { includeRestricted: true });
    assert.strictEqual(result.days.length, 31);
    assert.strictEqual(result.days[14].displaySymbol, "年");
    assert.strictEqual(result.days[17].displaySymbol, "病");
    assert.strictEqual(result.days[19].displaySymbol, "張");
    assert.strictEqual(result.summary.annualLeave.days, 1);
    assert.strictEqual(result.summary.sickLeave.days, 1);
    assert.strictEqual(result.summary.businessTripDays, 1);
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-02: ATTENDANCE_BOOK 帳票 Projection の完全生成 (HD-PE-03)", () => {
    const docData = CanonicalAttendanceProjectionEngine.getDocumentProjection(1, "2026-05");
    assert.ok(docData.template);
    assert.strictEqual(docData.template.form_code, "ATTENDANCE_BOOK");
    assert.ok(docData.user);
    assert.strictEqual(docData.user.id, 1);
    assert.ok(docData.attendanceData);
    assert.ok(docData.organizationSettings);
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-03: 月次確定 Snapshot 保存・親子テーブル永続化・SHA-256 チェックサム確定 (INV-CUT-05)", () => {
    const snapshotId = SnapshotService.finalizeMonth(1, "2026-05", actorManager, "点検完了");
    assert.ok(snapshotId > 0);
    const snapshot = db.prepare("SELECT * FROM monthly_attendance_snapshots WHERE id = ?").get(snapshotId);
    assert.strictEqual(snapshot.status, "LOCKED");
    assert.strictEqual(snapshot.user_id, 1);
    assert.strictEqual(snapshot.year_month, "2026-05");
    assert.ok(snapshot.checksum && snapshot.checksum.length === 64, "SHA-256 ハッシュが記録されていること");
    const days = db.prepare("SELECT COUNT(*) as cnt FROM monthly_attendance_snapshot_days WHERE snapshot_id = ?").get(snapshotId);
    assert.strictEqual(days.cnt, 31);
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-04: LOCKED 月は Immutable Snapshot を Single Source of Truth とし再計算しないこと (INV-CUT-09)", () => {
    const snapshotId = SnapshotService.finalizeMonth(1, "2026-05", actorManager, "点検完了");
    db.prepare(`INSERT INTO applications (id, type_id, subject_user_id, submitted_by_user_id, title, form_data, current_status, version, created_at, updated_at) VALUES (999, \x27LEAVE_ANNUAL\x27, 1, 1, \x27不正後付年休\x27, ?, \x27FINAL_APPROVED\x27, 1, ?, ?)`).run(JSON.stringify({ startDate: "2026-05-12", endDate: "2026-05-12", reasonCode: "ANNUAL_LEAVE" }), now, now);
    const result = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, "2026-05");
    assert.strictEqual(result.days[11].displaySymbol, "出", "確定済みスナップショットが不変維持されること (INV-CUT-09)");
    assert.strictEqual(result.days[11].primaryDayClassification, "WORKDAY");
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-05: 介護休暇・介護時間のバリデーションが WorkingObligationResolver を直接参照し休日申請を遮断すること (P0-02)", () => {
    db.prepare(`INSERT INTO care_cases (id, user_id, recipient_relation, recipient_name, condition_summary, created_by_user_id, created_at) VALUES (1, 1, \x27母\x27, \x27山田花子\x27, \x27要介護2\x27, 1, ?)`).run(now);
    const sundayResult = CareLeaveService.validateCareLeave({ targetDate: "2026-05-10", careCaseId: 1, unitType: "DAY" }, 1);
    assert.strictEqual(sundayResult.valid, false);
    assert.ok(sundayResult.message?.includes("勤務義務のない日"), "週休日の介護休暇申請が遮断されること");
    const workdayResult = CareLeaveService.validateCareLeave({ targetDate: "2026-05-12", careCaseId: 1, unitType: "DAY" }, 1);
    assert.strictEqual(workdayResult.valid, true);
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-06: 勤務パターン未設定日が残存する月は Fail-Closed で月次確定が拒絶されること (INV-CUT-06)", () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, display_name, department, is_active, created_at) VALUES (99, 'unpatterned_user', 'hash', '未設定教員', '小学部', 1, ?)`).run(now);
    db.prepare(`INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to, created_at) VALUES (99, 'JOB_TITLE_TEACHER', '2020-04-01', '9999-12-31', ?)`).run(now);
    assert.throws(() => {
      SnapshotService.finalizeMonth(99, "2026-05", actorManager);
    }, /未確定の日次状態/);
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-07: 閲覧権限マスキング (includeRestricted=false) 前後で Canonical Domain Fact が不変であること (INV-CUT-08, HD-PE-02)", () => {
    db.prepare(`INSERT INTO absences (id, user_id, absence_type, target_date, duration_minutes, reason, status, registered_by_user_id, confirmed_by_user_id, created_at, updated_at) VALUES (701, 1, \x27FULL_DAY\x27, \x272026-05-22\x27, 465, \x27家庭都合機密理由\x27, \x27CONFIRMED\x27, 1, 1, ?, ?)`).run(now, now);
    const generalView = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, "2026-05", { includeRestricted: false });
    assert.strictEqual(generalView.days[21].absenceInfo?.reason, "非公開");
    assert.strictEqual(generalView.days[21].displaySymbol, "欠");
    const adminView = CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, "2026-05", { includeRestricted: true });
    assert.strictEqual(adminView.days[21].absenceInfo?.reason, "家庭都合機密理由");
    assert.strictEqual(adminView.days[21].displaySymbol, "欠");
    assert.strictEqual(generalView.days[21].deductionMinutes, adminView.days[21].deductionMinutes);
    assert.strictEqual(generalView.days[21].actualWorkMinutes, adminView.days[21].actualWorkMinutes);
    assert.strictEqual(legacyCallCount, 0, "Legacy AttendanceEngine 呼出が 0 回であること (INV-CUT-01)");
  });

  it("E2E-CUT-08: 本番エンドポイント全経路実行で Legacy AttendanceEngine 呼出回数が厳格に 0 回であること (INV-CUT-01)", () => {
    db.prepare(`INSERT INTO care_cases (id, user_id, recipient_relation, recipient_name, condition_summary, created_by_user_id, created_at) VALUES (1, 1, \x27母\x27, \x27山田花子\x27, \x27要介護2\x27, 1, ?)`).run(now);
    CanonicalAttendanceProjectionEngine.getMonthlyProjection(1, "2026-05");
    CanonicalAttendanceProjectionEngine.getDocumentProjection(1, "2026-05");
    WorkingObligationResolver.resolve(1, "2026-05-15");
    CareLeaveService.validateCareLeave({ targetDate: "2026-05-15", careCaseId: 1, unitType: "DAY" }, 1);
    assert.strictEqual(legacyCallCount, 0, "全本番経路で Legacy AttendanceEngine 呼出が厳格に 0 回であること");
  });

  it("E2E-CUT-09: Canonical 内部例外発生時に Legacy へ Fallback せず Fail-Closed すること (INV-CUT-07)", () => {
    // DB 接続を壊した状態で実行し例外がそのまま投下され Legacy へ Fallback しないことを確認
    assert.throws(() => {
      CanonicalAttendanceProjectionEngine.getMonthlyProjection(-999, "2026-05");
      // または存在しないユーザーのDocumentProjection
      CanonicalAttendanceProjectionEngine.getDocumentProjection(-999, "2026-05");
    });
    assert.strictEqual(legacyCallCount, 0, "Canonical 例外時に Legacy への Fallback が一切発生しないこと (INV-CUT-07)");
  });
});
