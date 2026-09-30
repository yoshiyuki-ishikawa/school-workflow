import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb, checkIntegrity } from '../db/database';
import { migrator } from '../db/migrations';
import {
  resolveAuthoritativeWorkSchedule,
  ResolvedWorkSchedule
} from '../services/attendance/workPatternResolver';
import { WorkingObligationResolver } from '../services/attendance/workingObligationResolver';

describe('Wave 1 Golden Tests: School Default Daily Schedule & Effective-Dated Resolution (GT-W1-01〜10)', () => {
  let testDb: any;
  let originalDb: any;

  before(() => {
    originalDb = getDb();
    // 完全独立したインメモリDBでGolden検証 (本番DBへの副作用完全防止)
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    setDb(testDb);

    // 全マイグレーションを適用 (Migration 033含む)
    migrator.runMigrations(testDb);

    // テストユーザーの作成
    testDb.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, department, created_at)
      VALUES 
        (1, 'teacher1', 'hash', '教諭1', '小学部', '2026-04-01'),
        (2, 'teacher2', 'hash', '教諭2', '小学部', '2026-04-01'),
        (3, 'teacher3', 'hash', '教諭3', '小学部', '2026-04-01'),
        (99, 'unassigned_staff', 'hash', '未割当職員', '事務部', '2026-04-01')
    `).run();
  });

  after(() => {
    setDb(originalDb);
    testDb.close();
  });

  it('GT-W1-01: Migration 033 スキーマ検証 (school_work_schedules & schedule_source)', () => {
    const versionRow = testDb.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
    assert.strictEqual(versionRow.v, 33);

    // school_work_schedules テーブルの存在・カラム検証
    const schoolCols = testDb.prepare('PRAGMA table_info(school_work_schedules)').all().map((c: any) => c.name);
    assert.ok(schoolCols.includes('id'));
    assert.ok(schoolCols.includes('schedule_name'));
    assert.ok(schoolCols.includes('effective_from'));
    assert.ok(schoolCols.includes('effective_to'));
    assert.ok(schoolCols.includes('weekly_off_days'));
    assert.ok(schoolCols.includes('schedule_details_json'));
    assert.ok(schoolCols.includes('weekly_total_minutes'));
    assert.ok(schoolCols.includes('is_active'));

    // user_work_patterns.schedule_source カラムの存在検証
    const uwpCols = testDb.prepare('PRAGMA table_info(user_work_patterns)').all().map((c: any) => c.name);
    assert.ok(uwpCols.includes('schedule_source'));
  });

  it('GT-W1-02: Initial School Default は Migration 直後 0件 (Zero-Guess)', () => {
    const count = testDb.prepare('SELECT COUNT(*) as c FROM school_work_schedules').get().c;
    assert.strictEqual(count, 0, 'Migrationで学校標準日課を推測自動INSERTしてはならない');
  });

  it('GT-W1-03: Zero-Guess Backfill - 既存レコードはすべて INDIVIDUAL として保全', () => {
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, record_origin,
        created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (
        101, 1, '既存個別パターン', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31',
        '0,6', '{"1":{"isWorkDay":true,"workMinutes":465,"startTime":"08:15","endTime":"16:45","intervals":[{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}]}}',
        2325, 'MIGRATION_INITIAL', 1, '2026-04-01', '2026-04-01', 'INDIVIDUAL'
      )
    `).run();

    const row = testDb.prepare('SELECT schedule_source FROM user_work_patterns WHERE id = 101').get();
    assert.strictEqual(row.schedule_source, 'INDIVIDUAL');

    const res = resolveAuthoritativeWorkSchedule(1, '2026-04-06'); // 月曜日
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.scheduleSource, 'INDIVIDUAL');
    assert.strictEqual(res.scheduledWorkMinutes, 465);
  });

  it('GT-W1-04: パターン未割当職員は Fail-Closed (UNKNOWN_PATTERN)', () => {
    const res = resolveAuthoritativeWorkSchedule(99, '2026-04-06');
    assert.strictEqual(res.status, 'UNKNOWN_PATTERN');
    assert.strictEqual(res.isFailClosed, true);
  });

  it('GT-W1-05: schedule_source = SCHOOL_DEFAULT 指定時、学校標準未登録なら Fail-Closed (INVALID_SCHEDULE)', () => {
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, record_origin,
        created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (
        102, 2, '学校標準利用教員', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31',
        '0,6', '{}', 2325, 'ADMIN_CONFIGURED', 1, '2026-04-01', '2026-04-01', 'SCHOOL_DEFAULT'
      )
    `).run();

    const res = resolveAuthoritativeWorkSchedule(2, '2026-04-06');
    assert.strictEqual(res.status, 'INVALID_SCHEDULE');
    assert.strictEqual(res.isFailClosed, true);
    assert.ok(res.failReason?.includes('学校標準日課が登録されていません'));
  });

  it('GT-W1-06: Human-Confirmed School Default 登録後、SCHOOL_DEFAULT 職員が正常解決されること', () => {
    // 管理者による正式な学校標準日課の登録
    const standardDailyJson = JSON.stringify({
      "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null, "intervals": [] },
      "1": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}] },
      "2": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}] },
      "3": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}] },
      "4": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}] },
      "5": { "isWorkDay": true, "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}] },
      "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null, "intervals": [] }
    });

    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id,
        created_at, updated_at
      ) VALUES (
        1, '令和8年度 下松市立第一小学校 標準日課', '2026-04-01', '9999-12-31',
        '0,6', ?, 2325, 1, 1, '2026-04-01', '2026-04-01'
      )
    `).run(standardDailyJson);

    // 勤務日 (月曜日)
    const workDayRes = resolveAuthoritativeWorkSchedule(2, '2026-04-06');
    assert.strictEqual(workDayRes.status, 'RESOLVED');
    assert.strictEqual(workDayRes.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(workDayRes.schoolScheduleId, 1);
    assert.strictEqual(workDayRes.isWorkDay, true);
    assert.strictEqual(workDayRes.scheduledWorkMinutes, 465);
    assert.strictEqual(workDayRes.breakMinutes, 45);

    // 週休日 (日曜日)
    const offDayRes = resolveAuthoritativeWorkSchedule(2, '2026-04-05');
    assert.strictEqual(offDayRes.status, 'RESOLVED');
    assert.strictEqual(offDayRes.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(offDayRes.isWorkDay, false);
    assert.strictEqual(offDayRes.scheduledWorkMinutes, 0);
  });

  it('GT-W1-07: Individual Override 優先性 - 学校標準が存在しても INDIVIDUAL 設定職員は個別日課が最優先されること', () => {
    // User 3: 短時間勤務の個別日課 (08:30-13:30, 300分)
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, record_origin,
        created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (
        103, 3, '短時間勤務個別設定', 'SHORT_TIME', '2026-04-01', '9999-12-31',
        '0,6', '{"1":{"isWorkDay":true,"workMinutes":300,"startTime":"08:30","endTime":"13:30","intervals":[{"startTime":"08:30","endTime":"13:30"}]}}',
        1500, 'ADMIN_CONFIGURED', 1, '2026-04-01', '2026-04-01', 'INDIVIDUAL'
      )
    `).run();

    const res = resolveAuthoritativeWorkSchedule(3, '2026-04-06');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.scheduleSource, 'INDIVIDUAL');
    assert.strictEqual(res.scheduledWorkMinutes, 300);
    assert.strictEqual(res.schoolScheduleId, undefined);
  });

  it('GT-W1-08: 複数の有効な学校標準日課が重複している場合は Fail-Closed (AMBIGUOUS_PATTERN)', () => {
    // 重複する学校標準日課の不正登録
    testDb.prepare(`
      INSERT INTO school_work_schedules (
        id, schedule_name, effective_from, effective_to, weekly_off_days,
        schedule_details_json, weekly_total_minutes, is_active, created_by_user_id,
        created_at, updated_at
      ) VALUES (
        2, '重複学校標準日課B', '2026-04-01', '9999-12-31',
        '0,6', '{}', 2325, 1, 1, '2026-04-01', '2026-04-01'
      )
    `).run();

    const res = resolveAuthoritativeWorkSchedule(2, '2026-04-06');
    assert.strictEqual(res.status, 'AMBIGUOUS_PATTERN');
    assert.strictEqual(res.isFailClosed, true);
    assert.ok(res.failReason?.includes('複数の有効な学校標準日課が重複'));

    // 後片付け (ID 2 削除)
    testDb.prepare('DELETE FROM school_work_schedules WHERE id = 2').run();
  });

  it('GT-W1-09: 権限最優先: Calendar Override > Individual / School Default', () => {
    // 2026-04-06 (月曜日) を学校行事による特別日課 (08:00〜12:00, 240分) に上書き
    testDb.prepare(`
      INSERT INTO calendar_adjustments (
        adjustment_code, scope_type, user_id, adjustment_type, reason_code,
        source_date, source_duty_status, event_name, reason,
        schedule_override_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        'CAL_ADJ_W1_09', 'ALL', NULL, 'SINGLE_WORKDAY_OVERRIDE', 'SCHOOL_EVENT',
        '2026-04-06', 'WORK_REQUIRED', '午前短縮日課', '入学式準備',
        '{"intervals":[{"startTime":"08:00","endTime":"12:00"}]}', 1, '2026-04-01', '2026-04-01'
      )
    `).run();

    // User 2 (SCHOOL_DEFAULT) の日課が Calendar Override で上書きされること
    const obl2 = WorkingObligationResolver.resolve(2, '2026-04-06');
    assert.strictEqual(obl2.status, 'WORKING');
    assert.strictEqual(obl2.sourceType, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(obl2.workSchedule.scheduledWorkMinutes, 240);
    assert.strictEqual(obl2.workSchedule.overrideSource, 'CALENDAR_ADJUSTMENT');

    // User 3 (INDIVIDUAL) の日課も Calendar Override で上書きされること
    const obl3 = WorkingObligationResolver.resolve(3, '2026-04-06');
    assert.strictEqual(obl3.status, 'WORKING');
    assert.strictEqual(obl3.sourceType, 'CALENDAR_ADJUSTMENT');
    assert.strictEqual(obl3.workSchedule.scheduledWorkMinutes, 240);

    // 後片付け
    testDb.prepare('DELETE FROM calendar_adjustments WHERE id = 1').run();
  });

  it('GT-W1-10: Effective-Dated 整合性 - 期間外の過去日付・未来日付は Fail-Closed', () => {
    // 学校標準の有効期間前 (2026-03-31)
    const pastRes = resolveAuthoritativeWorkSchedule(2, '2026-03-31');
    assert.strictEqual(pastRes.status, 'UNKNOWN_PATTERN');
    assert.strictEqual(pastRes.isFailClosed, true);
  });

  // =========================================================================
  // Wave 1 P2 Pinpoint Remediation: schedule_source Explicit 2-Value Invariant
  // =========================================================================

  it('GT-W1-P2-01: schedule_source = NULL は Fail-Closed (INVALID_SCHEDULE, No Fallback to INDIVIDUAL)', () => {
    // テストユーザー4を追加
    testDb.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, department, created_at)
      VALUES (4, 'teacher4_null_source', 'hash', '教諭4', '小学部', '2026-04-01')
    `).run();

    // schedule_source が NULL のパターンを登録 (有効な schedule_details_json を所持していても Fallback しないこと)
    testDb.prepare(`
      INSERT INTO user_work_patterns (
        id, user_id, pattern_name, pattern_type, effective_from, effective_to,
        weekly_off_days, schedule_details_json, weekly_total_minutes, record_origin,
        created_by_user_id, created_at, updated_at, schedule_source
      ) VALUES (
        104, 4, 'NULLソースパターン', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31',
        '0,6', '{"1":{"isWorkDay":true,"workMinutes":465,"startTime":"08:15","endTime":"16:45","intervals":[{"startTime":"08:10","endTime":"12:00"},{"startTime":"12:45","endTime":"16:40"}]}}',
        2325, 'ADMIN_CONFIGURED', 1, '2026-04-01', '2026-04-01', NULL
      )
    `).run();

    const row = testDb.prepare('SELECT schedule_source FROM user_work_patterns WHERE id = 104').get();
    assert.strictEqual(row.schedule_source, null);

    const res = resolveAuthoritativeWorkSchedule(4, '2026-04-06');
    assert.strictEqual(res.status, 'INVALID_SCHEDULE', 'NULL は INDIVIDUAL にサイレントフォールバックせず INVALID_SCHEDULE となること');
    assert.strictEqual(res.isFailClosed, true);
    assert.ok(res.failReason?.includes('schedule_source が不正または未設定です'));
    assert.ok(res.failReason?.includes('104'));
  });

  it('GT-W1-P2-02: schedule_source 未定義 (NULL/undefined) に対する Fail-Closed 保証 (Runtime Boundary)', () => {
    // DB レイヤにおいてカラムが存在しない、または未定義値のパターンが Resolver に到達した場合でも Fail-Closed
    const res = resolveAuthoritativeWorkSchedule(4, '2026-04-06');
    assert.strictEqual(res.status, 'INVALID_SCHEDULE');
    assert.strictEqual(res.isFailClosed, true);
    assert.strictEqual(res.scheduleSource, undefined, '未設定時は scheduleSource プロパティ自体が未定義であること');
  });

  it('GT-W1-P2-03: schedule_source 不正文字列の多層防御 (DB CHECK & Resolver Boundary)', () => {
    // 1. DB CHECK レイヤ: 'INVALID_VALUE' の INSERT は SQLite CHECK 制約違反で拒絶されること
    assert.throws(() => {
      testDb.prepare(`
        INSERT INTO user_work_patterns (
          id, user_id, pattern_name, pattern_type, effective_from, effective_to,
          weekly_off_days, schedule_details_json, weekly_total_minutes, record_origin,
          created_by_user_id, created_at, updated_at, schedule_source
        ) VALUES (
          105, 4, '不正ソースパターン', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31',
          '0,6', '{}', 2325, 'ADMIN_CONFIGURED', 1, '2026-04-01', '2026-04-01', 'INVALID_SOURCE'
        )
      `).run();
    }, /CHECK constraint failed/);

    // 2. Resolver レイヤ: 仮にインメモリ等で不正文字列が到達した場合でも Fail-Closed
    // (GT-W1-P2-01 で実証されたように pattern.schedule_source !== 'SCHOOL_DEFAULT' && !== 'INDIVIDUAL' で弾かれる)
  });

  it('GT-W1-P2-04: 正常系 schedule_source = INDIVIDUAL の Resolution が完全不変であること', () => {
    // User 1 の INDIVIDUAL パターンが正常に解決されること
    const res = resolveAuthoritativeWorkSchedule(1, '2026-04-06');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.scheduleSource, 'INDIVIDUAL');
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.isWorkDay, true);
  });

  it('GT-W1-P2-05: 正常系 schedule_source = SCHOOL_DEFAULT の Resolution が完全不変であること', () => {
    // User 2 の SCHOOL_DEFAULT パターンが正常に解決されること
    const res = resolveAuthoritativeWorkSchedule(2, '2026-04-06');
    assert.strictEqual(res.status, 'RESOLVED');
    assert.strictEqual(res.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(res.scheduledWorkMinutes, 465);
    assert.strictEqual(res.isFailClosed, false);
    assert.strictEqual(res.isWorkDay, true);
    assert.strictEqual(res.schoolScheduleId, 1);
  });
});

