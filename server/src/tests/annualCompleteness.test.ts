import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { SnapshotService } from '../services/snapshotService';

describe('2階層 Annual Completeness & Invariance Test Suite', () => {
  let db: any;
  const now = new Date().toISOString();

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  const actorPrincipal = {
    id: 4,
    username: 'principal',
    displayName: '鈴木 一郎',
    stampName: '鈴木',
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent'
  };

  describe('Level A: 年間全日完全性テスト (平年365日 & うるう年366日)', () => {
    it('平年 (2025年 365日) の全日決定論的判定と排他区分の合計完全一致', () => {
      let totalDays = 0;
      let totalWork = 0;
      let totalWeekOff = 0;
      let totalHoliday = 0;
      let totalSub = 0;
      let totalOther = 0;
      let totalUnknown = 0;

      // ユーザー1に2025年全年の勤務パターンを割り当て
      db.exec(`INSERT OR REPLACE INTO user_work_patterns (user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at)
        VALUES (1, '標準フルタイム2025', 'STANDARD_FULLTIME', '2025-01-01', '2025-12-31', '0,6', 2325, 3, '${now}', 3, '${now}')`);

      for (let month = 1; month <= 12; month++) {
        const ym = `2025-${String(month).padStart(2, '0')}`;
        const monthly = AttendanceEngine.getMonthlyAttendanceData(1, ym);

        totalDays += monthly.days.length;
        totalWork += monthly.domainSummary.exclusiveCounts.workdayCount;
        totalWeekOff += monthly.domainSummary.exclusiveCounts.weeklyOffCount;
        totalHoliday += monthly.domainSummary.exclusiveCounts.holidayCount;
        totalSub += monthly.domainSummary.exclusiveCounts.substituteHolidayCount;
        totalOther += monthly.domainSummary.exclusiveCounts.otherNonWorkdayCount;
        totalUnknown += monthly.domainSummary.exclusiveCounts.unknownPatternCount;

        // 全日クラッシュなく解決されていること
        assert.strictEqual(monthly.hasUnknownPattern, false);
      }

      assert.strictEqual(totalDays, 365, '平年2025年の全日数は365日であること');
      assert.strictEqual(
        totalWork + totalWeekOff + totalHoliday + totalSub + totalOther + totalUnknown,
        365,
        '排他日区分の総和が暦日数365日と厳密に一致すること'
      );
      assert.strictEqual(totalUnknown, 0, '未確定日 (UNKNOWN) は0日であること');
    });

    it('うるう年 (2024年 366日, 2月29日含む) の全日決定論的判定と排他区分の合計完全一致', () => {
      let totalDays = 0;
      let totalWork = 0;
      let totalWeekOff = 0;
      let totalHoliday = 0;
      let totalSub = 0;
      let totalOther = 0;
      let totalUnknown = 0;

      // ユーザー1に2024年全年の勤務パターンを割り当て
      db.exec(`INSERT OR REPLACE INTO user_work_patterns (user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at)
        VALUES (1, '標準フルタイム2024', 'STANDARD_FULLTIME', '2024-01-01', '2024-12-31', '0,6', 2325, 3, '${now}', 3, '${now}')`);

      for (let month = 1; month <= 12; month++) {
        const ym = `2024-${String(month).padStart(2, '0')}`;
        const monthly = AttendanceEngine.getMonthlyAttendanceData(1, ym);

        totalDays += monthly.days.length;
        totalWork += monthly.domainSummary.exclusiveCounts.workdayCount;
        totalWeekOff += monthly.domainSummary.exclusiveCounts.weeklyOffCount;
        totalHoliday += monthly.domainSummary.exclusiveCounts.holidayCount;
        totalSub += monthly.domainSummary.exclusiveCounts.substituteHolidayCount;
        totalOther += monthly.domainSummary.exclusiveCounts.otherNonWorkdayCount;
        totalUnknown += monthly.domainSummary.exclusiveCounts.unknownPatternCount;

        if (month === 2) {
          assert.strictEqual(monthly.days.length, 29, '2024年2月はうるう年29日であること');
        }
      }

      assert.strictEqual(totalDays, 366, 'うるう年2024年の全日数は366日であること');
      assert.strictEqual(
        totalWork + totalWeekOff + totalHoliday + totalSub + totalOther + totalUnknown,
        366,
        '排他日区分の総和が暦日数366日と厳密に一致すること'
      );
      assert.strictEqual(totalUnknown, 0, '未確定日 (UNKNOWN) は0日であること');
    });
  });

  describe('Level B: 12か月確定不変性テスト (年度4月〜翌年3月 100%不変復元)', () => {
    it('2026年度 12か月確定スナップショットの作成と不変性検証', () => {
      // 2026年4月〜2027年3月の12か月
      const months = [
        '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
        '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'
      ];

      // ユーザー1に2026年度通年の勤務パターン設定
      db.prepare('DELETE FROM user_work_patterns WHERE user_id = 1').run();
      const s465 = JSON.stringify({
        "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
        "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
        "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
        "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
        "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
        "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:10", "endTime": "16:40", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
        "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
      });
      db.prepare(`INSERT INTO user_work_patterns (user_id, pattern_name, pattern_type, effective_from, effective_to, weekly_off_days, schedule_details_json, weekly_total_minutes, created_by_user_id, created_at, updated_by_user_id, updated_at)
        VALUES (1, '標準フルタイム2026年度', 'STANDARD_FULLTIME', '2026-04-01', '2027-03-31', '0,6', ?, 2325, 3, '${now}', 3, '${now}')`).run(s465);

      for (const ym of months) {
        // 1. スナップショット作成前データ取得
        const beforeData = AttendanceEngine.getMonthlyAttendanceData(1, ym);

        // 2. 校長確定 (Snapshot作成)
        const snapshotId = SnapshotService.finalizeMonth(1, ym, actorPrincipal, `${ym} 定例点検確認`);
        assert(snapshotId > 0);

        // 3. スナップショット取得
        const snapshot = SnapshotService.getSnapshot(1, ym);
        assert(snapshot !== null);
        assert.strictEqual(snapshot!.parent.status, 'LOCKED');
        assert.strictEqual(snapshot!.days.length, beforeData.days.length);

        // 4. スナップショットの日次確定値とリアルタイム計算結果が100%一致すること
        for (let i = 0; i < snapshot!.days.length; i++) {
          const snapDay = snapshot!.days[i];
          const liveDay = beforeData.days[i];

          assert.strictEqual(snapDay.date, liveDay.date);
          assert.strictEqual(snapDay.display_symbol, liveDay.displaySymbol);
          assert.strictEqual(snapDay.scheduled_work_minutes, liveDay.scheduledWorkMinutes);
          assert.strictEqual(snapDay.actual_work_minutes, liveDay.actualWorkMinutes);
        }

        // 5. 二重確定が拒否されること (Lock保護)
        assert.throws(
          () => {
            SnapshotService.finalizeMonth(1, ym, actorPrincipal, '二重確定試行');
          },
          /既に確定・ロックされています/
        );
      }
    });
  });
});
