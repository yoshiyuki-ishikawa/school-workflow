import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectWorkPatternPayload, PayloadProjectionError } from '../utils/workSchedulePayloadProjection';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adminAuditPagePath = path.resolve(__dirname, '../pages/AdminAuditPage.tsx');

describe('Common Daily Schedule Wiring Golden Suite (GT-INDIV-01 〜 GT-INDIV-05)', () => {
  const getAdminAuditPageSource = () => {
    return fs.readFileSync(adminAuditPagePath, 'utf-8');
  };

  // GT-INDIV-01: AdminAuditPage UI Wiring Contract
  it('GT-INDIV-01: AdminAuditPage.tsx の Create パスが、newScheduleSource === "INDIVIDUAL" の場合にのみ commonDailySchedule を projectWorkPatternPayload へ渡すUI配線契約', () => {
    const src = getAdminAuditPageSource();

    // 1. commonDailySchedule が projectWorkPatternPayload 呼び出しに渡されていること
    assert.match(
      src,
      /commonDailySchedule:\s*newScheduleSource === ['"]INDIVIDUAL['"]\s*\?/,
      'handleCreatePattern must wire commonDailySchedule conditionally on newScheduleSource === "INDIVIDUAL"'
    );

    // 2. commonDailySchedule のプロパティが newStartTime, newEndTime, newBreaks に結びついていること
    assert.match(
      src,
      /startTime:\s*newStartTime/,
      'commonDailySchedule must map startTime to newStartTime state'
    );
    assert.match(
      src,
      /endTime:\s*newEndTime/,
      'commonDailySchedule must map endTime to newEndTime state'
    );
    assert.match(
      src,
      /breakIntervals:\s*newBreaks/,
      'commonDailySchedule must map breakIntervals to newBreaks state'
    );
  });

  // GT-INDIV-02: Initial State and Modal Open Reset Contract
  it('GT-INDIV-02: 新規INDIVIDUAL用State (newStartTime, newEndTime, newBreaks) が存在し、初期値が空欄かつ handleOpenPatternModal() で空欄へ RESET されること', () => {
    const src = getAdminAuditPageSource();

    // 1. 初期 State 定義が空欄であること (DELTA-1 準拠: 暗黙補完禁止)
    assert.match(
      src,
      /const\s*\[\s*newStartTime\s*,\s*setNewStartTime\s*\]\s*=\s*useState<string>\(\s*['"]['"]\s*\)/,
      'newStartTime state must be initialized to empty string'
    );
    assert.match(
      src,
      /const\s*\[\s*newEndTime\s*,\s*setNewEndTime\s*\]\s*=\s*useState<string>\(\s*['"]['"]\s*\)/,
      'newEndTime state must be initialized to empty string'
    );
    assert.match(
      src,
      /const\s*\[\s*newBreaks\s*,\s*setNewBreaks\s*\]\s*=\s*useState<[\s\S]*?>\(\s*\[\s*\]\s*\)/,
      'newBreaks state must be initialized to empty array'
    );

    // 2. handleOpenPatternModal 内でリセットされていること (Cross-user state leakage 防止)
    assert.match(
      src,
      /handleOpenPatternModal\s*=\s*\(.*?\)\s*=>\s*\{[\s\S]*?setNewStartTime\(\s*['"]['"]\s*\)[\s\S]*?setNewEndTime\(\s*['"]['"]\s*\)[\s\S]*?setNewBreaks\(\s*\[\s*\]\s*\)/,
      'handleOpenPatternModal must reset newStartTime, newEndTime, and newBreaks to empty'
    );
  });

  // GT-INDIV-03: Empty Times Fail-Closed Contract
  it('GT-INDIV-03: INDIVIDUALで始業・終業が空欄の場合、UI Wiring 経由で既存 Projection へ到達し MISSING_COMMON_TIMES で Fail-Closed すること', () => {
    const src = getAdminAuditPageSource();

    // UI コード上で commonDailySchedule が渡されている前提を確認
    assert.match(
      src,
      /commonDailySchedule:\s*newScheduleSource === ['"]INDIVIDUAL['"]/,
      'commonDailySchedule must be wired to projection'
    );

    // 空文字 '' のまま projectWorkPatternPayload に渡すと MISSING_COMMON_TIMES がスローされること
    assert.throws(
      () => {
        projectWorkPatternPayload({
          patternName: 'テストパターン',
          patternType: 'SHORT_TIME',
          scheduleSource: 'INDIVIDUAL',
          effectiveFrom: '2026-09-01',
          effectiveTo: '9999-12-31',
          weeklyOffDays: [0, 3, 6],
          commonDailySchedule: {
            startTime: '',
            endTime: '',
            breakIntervals: [],
          },
        });
      },
      (err: any) => {
        assert.ok(err instanceof PayloadProjectionError);
        assert.strictEqual(err.errorCode, 'MISSING_COMMON_TIMES');
        assert.strictEqual(err.message, '開始時刻と終了時刻を入力してください');
        return true;
      }
    );
  });

  // GT-INDIV-04: Incomplete Break Fail-Closed (No Silent Drop) Contract
  it('GT-INDIV-04: 不完全な休憩入力 (startTime のみ、または endTime のみ) が silent drop されず Fail-Closed すること', () => {
    const src = getAdminAuditPageSource();

    // 1. AdminAuditPage.tsx において filter で不完全行を消し去る silent drop が行われていないこと
    assert.doesNotMatch(
      src,
      /newBreaks\.filter\(\s*\(?\s*b\s*\)?\s*=>\s*b\.startTime\s*&&\s*b\.endTime\s*\)/,
      'AdminAuditPage.tsx must not silently drop incomplete break rows with filter()'
    );

    // 2. 不完全な休憩入力 (片方のみ空文字) は INVALID_TIME_FORMAT で Fail-Closed すること
    const incompleteCases = [
      { startTime: '12:00', endTime: '' },
      { startTime: '', endTime: '12:30' },
      { startTime: '', endTime: '' },
    ];

    for (const brk of incompleteCases) {
      assert.throws(
        () => {
          projectWorkPatternPayload({
            patternName: 'テストパターン',
            patternType: 'SHORT_TIME',
            scheduleSource: 'INDIVIDUAL',
            effectiveFrom: '2026-09-01',
            effectiveTo: '9999-12-31',
            weeklyOffDays: [0, 3, 6],
            commonDailySchedule: {
              startTime: '08:30',
              endTime: '14:00',
              breakIntervals: [brk],
            },
          });
        },
        (err: any) => {
          assert.ok(err instanceof PayloadProjectionError);
          assert.strictEqual(err.errorCode, 'INVALID_TIME_FORMAT');
          assert.ok(err.message.includes('不正な時刻フォーマットです'));
          return true;
        }
      );
    }
  });

  // GT-INDIV-05: Warning Transition Contract
  it('GT-INDIV-05: Production UI から既存 "Wave 3C 実装予定" が完全除去され、MODEL A の入力案内へ置換されていること', () => {
    const src = getAdminAuditPageSource();

    // 1. 古い警告テキストが存在しないこと
    assert.doesNotMatch(
      src,
      /Wave 3C 実装予定/,
      'AdminAuditPage.tsx must not contain stale warning "Wave 3C 実装予定"'
    );
    assert.doesNotMatch(
      src,
      /詳細日課エディタが必要です/,
      'AdminAuditPage.tsx must not state that detailed editor is missing'
    );

    // 2. MODEL A の案内文が存在すること
    assert.match(
      src,
      /個別勤務時間帯の設定（全勤務日共通）/,
      'AdminAuditPage.tsx must contain MODEL A section title'
    );
    assert.match(
      src,
      /選択した定例週休日以外のすべての曜日にこの勤務時間が適用されます/,
      'AdminAuditPage.tsx must contain MODEL A notice description'
    );
  });
});
