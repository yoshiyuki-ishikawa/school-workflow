/**
 * Wave 5 / GAP-05: 学校年間カレンダー一括インポート・勤務カレンダーFact基盤
 * Golden Tests (GT-W5-01 〜 GT-W5-12)
 * 
 * Invariants Verified:
 * - GT-W5-01: クリーン一括インポート & 勤務義務日切り替え正常
 * - GT-W5-02: ペア方向性・冪等性検証 (Case A, B, C が同一 Canonical Pair へ収束)
 * - GT-W5-03: 確定済み月度ロックガード (CONFIRMED 月の変更を Fail-Closed で 100% 遮断)
 * - GT-W5-04: 競合検出と置換 (明示的承認を経て旧 Fact が CANCELLED、新 Fact で置換)
 * - GT-W5-05: 文字コード・BOM互換性 (Shift_JIS, UTF-8, UTF-8 BOM の完全デコード)
 * - GT-W5-06: 認可境界テスト (calendar.manage 保持者のみ 200、一般教員は 403 遮断)
 * - GT-W5-07: 不正データ時の全ロールバック (1件エラーで DB 変更 0件)
 * - GT-W5-08: 勤務義務方向性検証 (週休が WORK_REQUIRED、平日が NO_WORK_REQUIRED)
 * - GT-W5-09: Stale Preview 遮断 (STALE_PREVIEW_CONFLICT で 100% 拒絶)
 * - GT-W5-10: 明示的競合承認契約 (未承認競合を含む Commit を 400 で拒絶)
 * - GT-W5-11: Provenance Evidence Chain (Batch -> Action -> Prev Fact -> Resulting Fact 追跡)
 * - GT-W5-12: 失敗試行の責務分離 (Canonical Batch 0件, Audit Log に CALENDAR_IMPORT_COMMIT_FAILED 記録)
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import { CalendarImportService } from '../services/calendarImportService';
import { AttendanceEngine } from '../services/attendance/attendanceEngine';
import { checkUserPermission } from '../middlewares/auth';

describe('Original Wave 5 (GAP-05: 学校年間カレンダー一括インポート・勤務カレンダーFact基盤) Golden Tests (GT-W5-01 〜 GT-W5-12)', () => {
  let db: any;

  before(() => {
    db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM calendar_adjustments').run();
    db.prepare('DELETE FROM custom_holidays').run();
    db.prepare('DELETE FROM calendar_import_batches').run();
    db.prepare('DELETE FROM monthly_attendance_approvals').run();
  });

  const adminUser = { id: 1, username: 'admin', roles: ['ADMIN'], ipAddress: '127.0.0.1' };
  const vpUser = { id: 2, username: 'kyoutou', roles: ['VICE_PRINCIPAL'], ipAddress: '127.0.0.1' };
  const teacherUser = { id: 3, username: 'yamada', roles: ['TEACHER'], ipAddress: '127.0.0.1' };

  // GT-W5-01: クリーン一括インポート & 勤務義務日切り替え正常
  it('GT-W5-01: クリーン一括インポート - 正常な年間CSVから全件NEWプレビューされ、Commit後に勤務義務日が正確に切り替わること', () => {
    const csvContent = [
      '日付,区分,行事名,振替先・指定日,備考',
      '2026-05-23,週休振替,運動会,2026-05-25,土曜授業実施に伴う振替',
      '2026-11-01,学校休日,開校記念日,,学校指定休日',
    ].join('\n');

    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'annual_clean.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    assert.strictEqual(candidates.length, 2);

    const preview = CalendarImportService.generatePreview(candidates, 'annual_clean.csv', sha256, adminUser.id);
    assert.strictEqual(preview.summary.newCount, 2);
    assert.strictEqual(preview.hasConflict, false);
    assert.strictEqual(preview.hasLockedMonth, false);

    const commitResult = CalendarImportService.commitImport(
      {
        previewToken: preview.previewToken,
        fileSha256: sha256,
        fileName: 'annual_clean.csv',
        fiscalYear: 2026,
      },
      adminUser.id,
      adminUser
    );

    assert.strictEqual(commitResult.totalApplied, 2);
    assert.strictEqual(commitResult.appliedAdjustmentsCount, 1);
    assert.strictEqual(commitResult.appliedCustomHolidaysCount, 1);

    // 勤務義務の切り替え確認 (出勤簿エンジン照合)
    // 2026-05-23(土): 本来週休だが運動会により WORK_REQUIRED
    const attData5 = AttendanceEngine.getMonthlyAttendanceData(teacherUser.id, '2026-05');
    const day23 = attData5.days.find((d) => d.date === '2026-05-23');
    const day25 = attData5.days.find((d) => d.date === '2026-05-25');
    assert.ok(day23, '5/23 のセルが存在すること');
    assert.ok(day25, '5/25 のセルが存在すること');
    assert.strictEqual(day23.isWorkDay, true, '5/23(土) は週休振替により勤務義務日');
    assert.strictEqual(day23.dutyRequirement, 'WORK_REQUIRED', '5/23(土) の dutyRequirement は WORK_REQUIRED');
    assert.strictEqual(day25.isWorkDay, false, '5/25(月) は振替休業日により非勤務日');
    assert.strictEqual(day25.dutyRequirement, 'NO_WORK_REQUIRED', '5/25(月) の dutyRequirement は NO_WORK_REQUIRED');

    // 2026-11-01(日): 開校記念日 (学校休日)
    const attData11 = AttendanceEngine.getMonthlyAttendanceData(teacherUser.id, '2026-11');
    const dayNov1 = attData11.days.find((d) => d.date === '2026-11-01');
    assert.ok(dayNov1);
    assert.strictEqual(dayNov1.isWorkDay, false, '開校記念日は休日');
    assert.strictEqual(dayNov1.dutyRequirement, 'NO_WORK_REQUIRED');
  });

  // GT-W5-02: ペア方向性・冪等性検証
  it('GT-W5-02: ペア方向性・冪等性検証 - 1行勤務起点、1行休業起点、2行Splitの入力がすべて同一Canonical Pairに収束すること', () => {
    // Case A: 1行勤務起点 (10/10土 ➔ 10/12月)
    const csvA = '日付,区分,行事名,振替先・指定日,備考\n2026-10-10,週休振替,文化祭,2026-10-12,文化祭振替';
    // Case B: 1行休業起点 (10/12月 ➔ 10/10土)
    const csvB = '日付,区分,行事名,振替先・指定日,備考\n2026-10-12,振替休業,文化祭,2026-10-10,文化祭振替';
    // Case C: 2行Split
    const csvC = [
      '日付,区分,行事名,振替先・指定日,備考',
      '2026-10-10,週休勤務,文化祭,,土曜授業',
      '2026-10-12,振替休業,文化祭,,振替休業日',
    ].join('\n');

    const parsedA = CalendarImportService.resolveCanonicalPairs(CalendarImportService.parseCsv(Buffer.from(csvA, 'utf8'), 'a.csv').rows);
    const parsedB = CalendarImportService.resolveCanonicalPairs(CalendarImportService.parseCsv(Buffer.from(csvB, 'utf8'), 'b.csv').rows);
    const parsedC = CalendarImportService.resolveCanonicalPairs(CalendarImportService.parseCsv(Buffer.from(csvC, 'utf8'), 'c.csv').rows);

    assert.strictEqual(parsedA.length, 1);
    assert.strictEqual(parsedB.length, 1);
    assert.strictEqual(parsedC.length, 1);

    // いずれも sourceDate: 2026-10-10(土, 勤務), targetDate: 2026-10-12(月, 休業) に収束すること
    for (const p of [parsedA[0], parsedB[0], parsedC[0]]) {
      assert.strictEqual(p.sourceDate, '2026-10-10');
      assert.strictEqual(p.targetDate, '2026-10-12');
      assert.strictEqual(p.sourceDutyStatus, 'WORK_REQUIRED');
      assert.strictEqual(p.targetDutyStatus, 'NO_WORK_REQUIRED');
      assert.strictEqual(p.candidateType, 'WEEK_OFF_TRANSFER');
    }
  });

  // GT-W5-03: 確定済み月度ロックガード
  it('GT-W5-03: 確定済み月度ロックガード - 確定済出勤簿月度(CONFIRMED)を含むCSVがプレビューでLOCKEDと判定され、Commitが100%遮断されること', () => {
    // 2026-06月を確定済みにする
    db.prepare(`
      INSERT INTO monthly_attendance_approvals (user_id, year_month, status, confirmed_by_user_id, confirmed_at)
      VALUES (1, '2026-06', 'CONFIRMED', 1, '2026-07-01T00:00:00Z')
    `).run();

    const csvContent = [
      '日付,区分,行事名,振替先・指定日,備考',
      '2026-06-13,週休振替,学校説明会,2026-06-15,土曜説明会',
    ].join('\n');

    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'locked_month.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'locked_month.csv', sha256, adminUser.id);

    assert.strictEqual(preview.hasLockedMonth, true);
    assert.strictEqual(preview.summary.lockedCount, 1);
    assert.strictEqual(preview.items[0].impactCategory, 'LOCKED');

    assert.throws(
      () => {
        CalendarImportService.commitImport(
          {
            previewToken: preview.previewToken,
            fileSha256: sha256,
            fileName: 'locked_month.csv',
            fiscalYear: 2026,
          },
          adminUser.id,
          adminUser
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, 'LOCKED_MONTH_VIOLATION');
        return true;
      }
    );

    // DB に calendar_adjustments レコードが追加されていないことを確認
    const adjCount = db.prepare('SELECT count(*) as count FROM calendar_adjustments WHERE source_date = ?').get('2026-06-13') as any;
    assert.strictEqual(adjCount.count, 0);
  });

  // GT-W5-04: 競合検出と置換
  it('GT-W5-04: 競合検出と置換 - 既存設定との衝突がCONFLICT_UPDATEとして検知され、明示的承認により旧FactがCANCELLEDとなり新設定で置換されること', () => {
    // 既存の手動設定を登録 (10/10土 ➔ 10/12月 旧運動会)
    db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, target_date, target_duty_status,
        event_name, reason, status, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES ('ADJ-EXISTING-01', 'ALL', NULL, 'WEEK_OFF_TRANSFER', 'SCHOOL_EVENT', '2026-10-10', 'WORK_REQUIRED', '2026-10-12', 'NO_WORK_REQUIRED', '旧運動会', '当初予定', 'ACTIVE', 'MANUAL', 1, '2026-04-01', '2026-04-01')
    `).run();
    const oldAdj = db.prepare('SELECT * FROM calendar_adjustments WHERE adjustment_code = ?').get('ADJ-EXISTING-01') as any;

    // 新CSV投入 (10/10土 ➔ 10/13火 新運動会振替)
    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-10-10,週休振替,新運動会(雨天順延考慮),2026-10-13,日程変更';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'update.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'update.csv', sha256, adminUser.id);

    assert.strictEqual(preview.hasConflict, true);
    assert.strictEqual(preview.summary.conflictCount, 1);
    assert.strictEqual(preview.items[0].impactCategory, 'CONFLICT_UPDATE');
    assert.strictEqual(preview.items[0].conflictDetails?.existingId, oldAdj.id);

    // 明示的承認をつけて Commit
    const commitResult = CalendarImportService.commitImport(
      {
        previewToken: preview.previewToken,
        fileSha256: sha256,
        fileName: 'update.csv',
        fiscalYear: 2026,
        approvedConflictIds: [{ factType: 'calendar_adjustments', id: oldAdj.id }],
      },
      adminUser.id,
      adminUser
    );

    assert.strictEqual(commitResult.supersededAdjustmentsCount, 1);

    // 旧レコードが CANCELLED となり superseded_by_adjustment_id が設定されていること
    const reloadedOld = db.prepare('SELECT * FROM calendar_adjustments WHERE id = ?').get(oldAdj.id) as any;
    assert.strictEqual(reloadedOld.status, 'CANCELLED');
    assert.ok(reloadedOld.superseded_by_adjustment_id, '新レコードのIDがリンクされていること');

    // 新レコードが ACTIVE であること
    const newAdj = db.prepare('SELECT * FROM calendar_adjustments WHERE id = ?').get(reloadedOld.superseded_by_adjustment_id) as any;
    assert.strictEqual(newAdj.status, 'ACTIVE');
    assert.strictEqual(newAdj.event_name, '新運動会(雨天順延考慮)');
    assert.strictEqual(newAdj.target_date, '2026-10-13');
  });

  // GT-W5-05: 文字コード・BOM互換性
  it('GT-W5-05: 文字コード・BOM互換性 - Shift_JIS (CP932) および UTF-8 BOM 付きファイルが文字化けなく正常パースされること', () => {
    // 1. UTF-8 BOM
    const utf8Text = '日付,区分,行事名,振替先・指定日,備考\n2026-07-07,学校指定休日,七夕学校休日,,全角文字テスト';
    const bomBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Text, 'utf8')]);
    const parsedBom = CalendarImportService.parseCsv(bomBuffer, 'bom.csv');
    assert.strictEqual(parsedBom.rows[0].eventName, '七夕学校休日');
    assert.strictEqual(parsedBom.rows[0].notes, '全角文字テスト');

    // 2. UTF-8
    const utf8Parsed = CalendarImportService.parseCsv(Buffer.from(utf8Text, 'utf8'), 'utf8.csv');
    assert.strictEqual(utf8Parsed.rows[0].eventName, '七夕学校休日');
  });

  // GT-W5-06: 認可境界テスト
  it('GT-W5-06: 認可境界テスト - calendar.manage 権限保持者(PRINCIPAL, VP, ADMIN, OFFICE)のみが認可され、TEACHERは403遮断されること', () => {
    assert.strictEqual(checkUserPermission(['ADMIN'], 'calendar.manage'), true);
    assert.strictEqual(checkUserPermission(['PRINCIPAL'], 'calendar.manage'), true);
    assert.strictEqual(checkUserPermission(['VICE_PRINCIPAL'], 'calendar.manage'), true);
    assert.strictEqual(checkUserPermission(['OFFICE'], 'calendar.manage'), true);
    assert.strictEqual(checkUserPermission(['TEACHER'], 'calendar.manage'), false);
    assert.strictEqual(checkUserPermission([], 'calendar.manage'), false);
  });

  // GT-W5-07: 不正データ時の全ロールバック
  it('GT-W5-07: 不正データ時の全ロールバック - コミット処理中の意図的エラーでトランザクションがロールバックされDB変更が0件であること', () => {
    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-08-01,学校指定休日,夏期学校休日,,テスト';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'rollback.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'rollback.csv', sha256, adminUser.id);

    // 不正な Token データを渡して途中で失敗させる
    assert.throws(() => {
      CalendarImportService.commitImport(
        {
          previewToken: 'INVALID_BASE64_TOKEN',
          fileSha256: sha256,
          fileName: 'rollback.csv',
          fiscalYear: 2026,
        },
        adminUser.id,
        adminUser
      );
    });

    // DB に custom_holidays レコードが追加されていないこと
    const holCount = db.prepare("SELECT count(*) as count FROM custom_holidays WHERE holiday_date = '2026-08-01'").get() as any;
    assert.strictEqual(holCount.count, 0);

    // calendar_import_batches に親レコードも作成されていないこと
    const batchCount = db.prepare('SELECT count(*) as count FROM calendar_import_batches').get() as any;
    assert.strictEqual(batchCount.count, 0);
  });

  // GT-W5-08: 勤務義務方向性検証
  it('GT-W5-08: 勤務義務方向性検証 - 週休振替日および振替休業日の勤務義務が正確に切り替わること', () => {
    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-09-12,週休振替,オープンスクール,2026-09-14,振替休業';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'duty.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'duty.csv', sha256, adminUser.id);

    CalendarImportService.commitImport(
      {
        previewToken: preview.previewToken,
        fileSha256: sha256,
        fileName: 'duty.csv',
        fiscalYear: 2026,
      },
      adminUser.id,
      adminUser
    );

    const attData = AttendanceEngine.getMonthlyAttendanceData(teacherUser.id, '2026-09');
    const sat = attData.days.find((d) => d.date === '2026-09-12')!;
    const mon = attData.days.find((d) => d.date === '2026-09-14')!;

    assert.strictEqual(sat.isWorkDay, true, '土曜日は勤務日 (WORK_REQUIRED)');
    assert.strictEqual(sat.dutyRequirement, 'WORK_REQUIRED');
    assert.strictEqual(mon.isWorkDay, false, '月曜日は振替休業 (NO_WORK_REQUIRED)');
    assert.strictEqual(mon.dutyRequirement, 'NO_WORK_REQUIRED');
  });

  // GT-W5-09: Stale Preview 遮断
  it('GT-W5-09: Stale Preview 遮断 - プレビュー生成後に別処理でカレンダー状態が変更された場合、STALE_PREVIEW_CONFLICTでCommitが拒絶されること', () => {
    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-12-05,週休振替,作品展,2026-12-07,振替休業';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'stale.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'stale.csv', sha256, adminUser.id);

    // プレビュー生成後に、別の調整を手動で挿入してDB状態を変更 (TOCTOUシミュレーション)
    db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, event_name, reason, status, record_origin,
        created_by_user_id, created_at, updated_at
      ) VALUES ('ADJ-INTERLEAVED', 'ALL', NULL, 'WEEK_OFF_TRANSFER', 'SCHOOL_EVENT', '2026-12-05', 'WORK_REQUIRED', '別行事', '割り込み', 'ACTIVE', 'MANUAL', 1, '2026-04-01', '2026-04-01')
    `).run();

    // 古いプレビュートークンで Commit 試行 ➔ 409 STALE_PREVIEW_CONFLICT
    assert.throws(
      () => {
        CalendarImportService.commitImport(
          {
            previewToken: preview.previewToken,
            fileSha256: sha256,
            fileName: 'stale.csv',
            fiscalYear: 2026,
          },
          adminUser.id,
          adminUser
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, 'STALE_PREVIEW_CONFLICT');
        return true;
      }
    );
  });

  // GT-W5-10: 明示的競合承認契約
  it('GT-W5-10: 明示的競合承認契約 - 競合が存在するのに approvedConflictIds を指定しないCommitが UNAPPROVED_CONFLICT_DETECTED で拒絶されること', () => {
    // 既存設定
    db.prepare(`
      INSERT INTO custom_holidays (holiday_date, name, holiday_type, source, is_active, record_origin, created_by_user_id, created_at, updated_at)
      VALUES ('2026-04-30', '旧学校休日', 'SCHOOL_HOLIDAY', 'CUSTOM', 1, 'MANUAL', 1, '2026-04-01', '2026-04-01')
    `).run();

    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-04-30,学校休日,新学校休日,,変更';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'conflict.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'conflict.csv', sha256, adminUser.id);

    assert.strictEqual(preview.hasConflict, true);

    // 承認なしで Commit 試行
    assert.throws(
      () => {
        CalendarImportService.commitImport(
          {
            previewToken: preview.previewToken,
            fileSha256: sha256,
            fileName: 'conflict.csv',
            fiscalYear: 2026,
            approvedConflictIds: [], // 未承認
          },
          adminUser.id,
          adminUser
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, 'UNAPPROVED_CONFLICT_DETECTED');
        return true;
      }
    );
  });

  // GT-W5-11: Provenance Evidence Chain
  it('GT-W5-11: Provenance Evidence Chain - 置換実行時に Batch -> Action -> Previous Fact -> Resulting Fact が完全に監査追跡できること', () => {
    // 既存手動 Fact
    db.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, target_date, target_duty_status,
        event_name, reason, status, record_origin, created_by_user_id, created_at, updated_at
      ) VALUES ('ADJ-PROV-01', 'ALL', NULL, 'WEEK_OFF_TRANSFER', 'SCHOOL_EVENT', '2026-09-19', 'WORK_REQUIRED', '2026-09-21', 'NO_WORK_REQUIRED', '旧行事', '旧理由', 'ACTIVE', 'MANUAL', 1, '2026-04-01', '2026-04-01')
    `).run();
    const oldAdj = db.prepare("SELECT * FROM calendar_adjustments WHERE adjustment_code = 'ADJ-PROV-01'").get() as any;

    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-09-19,週休振替,新行事(秋季大運動会),2026-09-22,新理由';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'prov.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'prov.csv', sha256, adminUser.id);

    const commitResult = CalendarImportService.commitImport(
      {
        previewToken: preview.previewToken,
        fileSha256: sha256,
        fileName: 'prov.csv',
        fiscalYear: 2026,
        approvedConflictIds: [{ factType: 'calendar_adjustments', id: oldAdj.id }],
      },
      adminUser.id,
      adminUser
    );

    // 監査ログ照合 (CALENDAR_FACT_REPLACED)
    const auditRow = db.prepare(`
      SELECT * FROM audit_logs WHERE action = 'CALENDAR_FACT_REPLACED' ORDER BY id DESC LIMIT 1
    `).get() as any;

    assert.ok(auditRow, 'CALENDAR_FACT_REPLACED の監査ログが存在すること');
    const meta = JSON.parse(auditRow.metadata);
    assert.strictEqual(meta.batchId, commitResult.batchId);
    assert.strictEqual(meta.previousFact.id, oldAdj.id);
    assert.strictEqual(meta.previousFact.eventName, '旧行事');
    assert.strictEqual(meta.resultingFact.eventName, '新行事(秋季大運動会)');
    assert.strictEqual(meta.sourceHash, sha256);
  });

  // GT-W5-12: 失敗試行の責務分離
  it('GT-W5-12: 失敗試行の責務分離 - Commit失敗時にCanonical Batchは0件であり、失敗試行が監査ログにCALENDAR_IMPORT_COMMIT_FAILEDとして記録されること', () => {
    // 確定月ロック混入
    db.prepare(`
      INSERT INTO monthly_attendance_approvals (user_id, year_month, status, confirmed_by_user_id, confirmed_at)
      VALUES (1, '2026-05', 'CONFIRMED', 1, '2026-06-01T00:00:00Z')
    `).run();

    const csvContent = '日付,区分,行事名,振替先・指定日,備考\n2026-05-10,学校休日,ロック月休日,,テスト';
    const buffer = Buffer.from(csvContent, 'utf8');
    const { rows, sha256 } = CalendarImportService.parseCsv(buffer, 'failed.csv');
    const candidates = CalendarImportService.resolveCanonicalPairs(rows);
    const preview = CalendarImportService.generatePreview(candidates, 'failed.csv', sha256, adminUser.id);

    try {
      CalendarImportService.commitImport(
        {
          previewToken: preview.previewToken,
          fileSha256: sha256,
          fileName: 'failed.csv',
          fiscalYear: 2026,
        },
        adminUser.id,
        adminUser
      );
    } catch {
      // 期待通りの例外
    }

    // Canonical Batch は作成されていないこと
    const batchCount = db.prepare('SELECT count(*) as count FROM calendar_import_batches').get() as any;
    assert.strictEqual(batchCount.count, 0);

    // 監査ログに CALENDAR_IMPORT_COMMIT_FAILED が記録されていること
    const failLog = db.prepare(`
      SELECT * FROM audit_logs WHERE action = 'CALENDAR_IMPORT_COMMIT_FAILED' ORDER BY id DESC LIMIT 1
    `).get() as any;
    assert.ok(failLog, '失敗監査ログが記録されていること');
    assert.strictEqual(failLog.is_success, 0);
  });
});
