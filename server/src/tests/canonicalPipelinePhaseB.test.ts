import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { setDb, getDb } from '../db/database';
import { SCHEMA_SQL } from '../db/schema';
import { migrator } from '../db/migrations';
import { seedDatabase } from '../db/seeds';
import {
  generateCanonicalFactIdentity,
  CanonicalFactDeduplicationRegistry,
  DuplicateCanonicalFactError,
  normalizeApplicationToFacts,
  normalizePersonnelStatusToFact,
  normalizeAbsenceToFact,
  normalizeCalendarToFact,
  normalizeCalendarAdjustmentToFact,
  normalizeWorkScheduleToFact,
  CanonicalPipelinePoC,
  CanonicalAttendanceEvaluator
} from '../services/canonical';
import { SnapshotService } from '../services/snapshotService';

describe('Phase B: Canonical Service Fact Pipeline PoC Tests', () => {
  before(() => {
    const db = new Database(':memory:');
    setDb(db);
    db.exec(SCHEMA_SQL);
    migrator.runMigrations(db);
    seedDatabase();
  });

  // TC-ID-01: Canonical Fact Identity 一意性
  it('TC-ID-01: Canonical Fact Identity 一意性 - 複数日・時間帯・Status・Sourceで衝突しないこと', () => {
    const id1 = generateCanonicalFactIdentity({
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 101,
      sourceVersion: 1,
      workflowCycleId: 1,
      targetDate: '2026-04-10',
      startTime: '08:30',
      endTime: '12:00',
      canonicalStatus: 'ANNUAL_LEAVE'
    });

    const id2 = generateCanonicalFactIdentity({
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 101,
      sourceVersion: 1,
      workflowCycleId: 1,
      targetDate: '2026-04-10',
      startTime: '13:00',
      endTime: '16:40',
      canonicalStatus: 'ANNUAL_LEAVE'
    });

    const id3 = generateCanonicalFactIdentity({
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 101,
      sourceVersion: 1,
      workflowCycleId: 1,
      targetDate: '2026-04-11', // 別日
      startTime: '08:30',
      endTime: '12:00',
      canonicalStatus: 'ANNUAL_LEAVE'
    });

    assert.notStrictEqual(id1, id2, '同一日の別時間帯は別Identityとなること');
    assert.notStrictEqual(id1, id3, '別日は別Identityとなること');
  });

  // TC-ID-02: Duplicate Emit Fail-Closed
  it('TC-ID-02: Duplicate Emit Fail-Closed - 重複Fact検知時にSilent Dropせず即時例外となること', () => {
    const registry = new CanonicalFactDeduplicationRegistry();
    const fact = {
      factId: 'TEST_FACT_1',
      userId: 1,
      canonicalStatus: 'ANNUAL_LEAVE' as const,
      factType: 'DAY_EVENT' as const,
      sourceType: 'INTERNAL_APPLICATION' as const,
      sourceTable: 'applications' as const,
      sourceId: 201,
      targetDate: '2026-04-15',
      isRestricted: false
    };

    registry.register(fact, 'TestAdapter');

    assert.throws(
      () => {
        registry.register(fact, 'TestAdapter');
      },
      (err: any) => {
        assert.ok(err instanceof DuplicateCanonicalFactError);
        assert.strictEqual(err.diagnostic.factId, 'TEST_FACT_1');
        assert.strictEqual(err.diagnostic.sourceTable, 'applications');
        return true;
      },
      '重複Fact登録時にDuplicateCanonicalFactErrorがスローされること'
    );
  });

  // TC-ID-03: 複数日申請の日次展開
  it('TC-ID-03: 複数日申請の日次展開 - 3日間の出張が3件の日次Factへ決定論的に展開されること', () => {
    const app = {
      id: 301,
      type_id: 'BUSINESS_TRIP',
      subject_user_id: 1,
      form_data: JSON.stringify({
        startDate: '2026-05-10',
        endDate: '2026-05-12',
        destination: '県教育センター',
        purpose: '情報教育研修会'
      }),
      current_status: 'TRIP_APPROVED',
      version: 1,
      approval_cycle: 1
    };

    const facts = normalizeApplicationToFacts(app);
    assert.strictEqual(facts.length, 3, '3日分の日次Factが生成されること');
    assert.strictEqual(facts[0].targetDate, '2026-05-10');
    assert.strictEqual(facts[1].targetDate, '2026-05-11');
    assert.strictEqual(facts[2].targetDate, '2026-05-12');
    assert.strictEqual(facts[0].canonicalStatus, 'OFFICIAL_BUSINESS_TRIP');
  });

  // TC-ID-04: 同日異種Fact共存 (C6 Non-Inversion & Zero-Schedule: 週休日と出張がIdentity上衝突せず共存し、非逆転・ゼロスケジュールが維持されること)
  it('TC-ID-04: 同日異種Fact共存 - 週休日と出張がIdentity上衝突せず共存し、非逆転・ゼロスケジュールが維持されること', () => {
    const weekOffFact = {
      factId: generateCanonicalFactIdentity({
        sourceType: 'WORK_SCHEDULE',
        sourceTable: 'user_work_patterns',
        sourceId: 1,
        targetDate: '2026-05-10',
        canonicalStatus: 'WEEKLY_OFF'
      }),
      userId: 1,
      canonicalStatus: 'WEEKLY_OFF' as const,
      factType: 'CALENDAR_STATUS' as const,
      sourceType: 'WORK_SCHEDULE' as const,
      sourceTable: 'user_work_patterns' as const,
      sourceId: 1,
      targetDate: '2026-05-10',
      isRestricted: false
    };

    const tripFact = {
      factId: generateCanonicalFactIdentity({
        sourceType: 'INTERNAL_APPLICATION',
        sourceTable: 'applications',
        sourceId: 301,
        sourceVersion: 1,
        workflowCycleId: 1,
        targetDate: '2026-05-10',
        canonicalStatus: 'OFFICIAL_BUSINESS_TRIP'
      }),
      userId: 1,
      canonicalStatus: 'OFFICIAL_BUSINESS_TRIP' as const,
      factType: 'DAY_EVENT' as const,
      sourceType: 'INTERNAL_APPLICATION' as const,
      sourceTable: 'applications' as const,
      sourceId: 301,
      targetDate: '2026-05-10',
      isRestricted: false
    };

    assert.notStrictEqual(weekOffFact.factId, tripFact.factId, '同日でもStatusが異なればIdentity衝突しないこと');

    const result = CanonicalAttendanceEvaluator.evaluateDay(
      { userId: 1, date: '2026-05-10', isWorkDay: false, scheduledWorkMinutes: 0 },
      [weekOffFact, tripFact]
    );

    assert.strictEqual(result.dutyStatus, 'NO_WORK_REQUIRED', '週休日の出張でWORK_REQUIREDに反転しないこと (FDC-12)');
    assert.strictEqual(result.primaryCanonicalStatus, 'WEEKLY_OFF', 'カレンダー分類がWEEKLY_OFFとして維持されること (FDC-12)');
    assert.deepStrictEqual(result.secondaryCanonicalStatuses, ['OFFICIAL_BUSINESS_TRIP'], '出張Factが副ステータスとして保持されること (FDC-15)');
    assert.strictEqual(result.countedWorkMinutes, 0, '週休日出張はゼロスケジュールにより実働算入0分であること (FDC-13)');
    assert.strictEqual(result.scheduledWorkMinutes, 0);
    assert.strictEqual(result.effectiveWorkMinutes, 0);
  });

  // TC-ID-05: Workflow Cycle Separation
  it('TC-ID-05: Workflow Cycle Separation - Cycle 1 と Cycle 2 の Fact が Identity 上区別されること', () => {
    const idCycle1 = generateCanonicalFactIdentity({
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 501,
      sourceVersion: 1,
      workflowCycleId: 1,
      targetDate: '2026-06-01',
      canonicalStatus: 'ANNUAL_LEAVE'
    });

    const idCycle2 = generateCanonicalFactIdentity({
      sourceType: 'INTERNAL_APPLICATION',
      sourceTable: 'applications',
      sourceId: 501,
      sourceVersion: 2,
      workflowCycleId: 2,
      targetDate: '2026-06-01',
      canonicalStatus: 'ANNUAL_LEAVE'
    });

    assert.notStrictEqual(idCycle1, idCycle2, '別Cycleは別Identityとなること');
    assert.ok(idCycle1.includes('CYCLE_1'));
    assert.ok(idCycle2.includes('CYCLE_2'));
  });

  // TC-ID-06: Snapshot Finalization Retry (回帰テスト)
  it('TC-ID-06: Snapshot Finalization Retry - LOCKED月への確定要求再送で新Versionが作成されないこと', () => {
    const db = getDb();
    const actor = { id: 4, username: 'principal', displayName: '鈴木 健一', stampName: '鈴木' };

    // 既に確定済みの状態をシミュレート
    db.prepare('DELETE FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = ?').run(1, '2026-04');
    
    // 1回目確定
    const snapId1 = SnapshotService.finalizeMonth(1, '2026-04', actor);
    assert.ok(snapId1 > 0);

    // 2回目確定 (リトライ / 重複リクエスト) -> 例外で拒絶され新Versionが作成されないこと
    assert.throws(
      () => {
        SnapshotService.finalizeMonth(1, '2026-04', actor);
      },
      /既に確定・ロックされています/,
      '確定済み月の再実行はエラーとなりVersion 2は作成されないこと'
    );

    const count = db.prepare('SELECT COUNT(*) as c FROM monthly_attendance_snapshots WHERE user_id = ? AND year_month = ?').get(1, '2026-04') as any;
    assert.strictEqual(count.c, 1, 'スナップショットは1件のみ存在すること');
  });

  // TC-ID-07: Missing Version / Cycle Sentinel
  it('TC-ID-07: Missing Version / Cycle Sentinel - 欠損値がVersion 1 / Cycle 0と誤同一視されないこと', () => {
    const idWithVersion = generateCanonicalFactIdentity({
      sourceType: 'PERSONNEL_ORDER',
      sourceTable: 'personnel_statuses',
      sourceId: 701,
      sourceVersion: 1,
      workflowCycleId: 0,
      targetDate: '2026-07-01',
      canonicalStatus: 'ADMINISTRATIVE_LEAVE_SUSPENSION'
    });

    const idWithoutVersion = generateCanonicalFactIdentity({
      sourceType: 'PERSONNEL_ORDER',
      sourceTable: 'personnel_statuses',
      sourceId: 701,
      sourceVersion: null,
      workflowCycleId: null,
      targetDate: '2026-07-01',
      canonicalStatus: 'ADMINISTRATIVE_LEAVE_SUSPENSION'
    });

    assert.notStrictEqual(idWithVersion, idWithoutVersion, 'Version欠損値とVersion 1が混同されないこと');
    assert.ok(idWithoutVersion.includes('NO_VERSION'));
    assert.ok(idWithoutVersion.includes('NO_CYCLE'));
  });

  // TC-ID-08: Identity Serialization Safety
  it('TC-ID-08: Identity Serialization Safety - sourceIdに区切り文字が含まれても安全にエスケープされること', () => {
    const idSpecial = generateCanonicalFactIdentity({
      sourceType: 'CALENDAR',
      sourceTable: 'custom_holidays',
      sourceId: 'HOLIDAY:SYS|SPEC\\1',
      targetDate: '2026-08-11',
      canonicalStatus: 'HOLIDAY'
    });

    assert.ok(idSpecial.includes('HOLIDAY\\:SYS\\|SPEC\\\\1'), '特殊区切り文字がエスケープされていること');
  });

  // TC-ID-09: Fail-Closed Unknown Policy / Period Status Override
  it('TC-ID-09: Period Status Override - 停職が存在する場合に全勤務義務がOVERRIDE_ALLされること', () => {
    const suspFact = {
      factId: generateCanonicalFactIdentity({
        sourceType: 'PERSONNEL_ORDER',
        sourceTable: 'personnel_statuses',
        sourceId: 901,
        targetDate: '2026-09-01',
        canonicalStatus: 'DISCIPLINARY_SUSPENSION'
      }),
      userId: 1,
      canonicalStatus: 'DISCIPLINARY_SUSPENSION' as const,
      factType: 'PERIOD_STATUS' as const,
      sourceType: 'PERSONNEL_ORDER' as const,
      sourceTable: 'personnel_statuses' as const,
      sourceId: 901,
      targetDate: '2026-09-01',
      isRestricted: true
    };

    const result = CanonicalPipelinePoC.evaluateDay(
      { userId: 1, date: '2026-09-01', isWorkDay: true },
      [suspFact]
    );

    assert.strictEqual(result.primaryCanonicalStatus, 'DISCIPLINARY_SUSPENSION');
    assert.strictEqual(result.appliedConflictAction, 'OVERRIDE_ALL');
    assert.strictEqual(result.dutyStatus, 'NO_WORK_REQUIRED');
    assert.strictEqual(result.effectiveWorkMinutes, 0);
    assert.strictEqual(result.isPersonnelStatusOverridden, true);
  });

  // TC-ID-10: Determinism
  it('TC-ID-10: Determinism - 同一入力Fixtureから何度実行しても同一Factおよび結果が得られること', () => {
    const app = {
      id: 1001,
      type_id: 'LEAVE_ANNUAL',
      subject_user_id: 1,
      form_data: JSON.stringify({
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        unitType: 'DAY'
      }),
      current_status: 'FINAL_APPROVED',
      version: 1,
      approval_cycle: 1
    };

    const run1 = normalizeApplicationToFacts(app);
    const run2 = normalizeApplicationToFacts(app);

    assert.deepStrictEqual(run1, run2, '何度実行しても同一Fact配列が導出されること');
    assert.strictEqual(run1[0].factId, run2[0].factId, 'Identityが完全一致すること');
  });
});
