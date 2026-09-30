import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectWorkPatternPayload,
  validateExistingRecordSource,
  parseExistingScheduleDetails,
  PayloadProjectionError,
  WorkPatternFormState,
  CanonicalScheduleDetails,
} from './utils/workSchedulePayloadProjection';

describe('Wave 3A-1: Work Schedule Payload Projection Golden Tests (GT-W3-01〜08)', () => {
  const validBaseState: WorkPatternFormState = {
    patternName: '通常勤務パターン',
    patternType: 'STANDARD_FULLTIME',
    scheduleSource: 'SCHOOL_DEFAULT',
    effectiveFrom: '2026-04-01',
    effectiveTo: '9999-12-31',
    weeklyOffDays: '0,6',
    memo: '令和8年度標準',
    statutoryPatternCode: null,
  };

  // 既存本番DB（ID: 5）と同一構造の Canonical Fixture (2 interval: 08:10〜12:00, 12:45〜16:40)
  const existingProductionDetailsFixture: CanonicalScheduleDetails = {
    '0': { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null, intervals: [], workIntervals: [] },
    '1': {
      isWorkDay: true,
      workMinutes: 465,
      startTime: '08:15',
      endTime: '16:45',
      intervals: [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      workIntervals: [
        { start: 490, end: 720 },
        { start: 765, end: 1000 },
      ],
    },
    '2': {
      isWorkDay: true,
      workMinutes: 465,
      startTime: '08:15',
      endTime: '16:45',
      intervals: [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      workIntervals: [
        { start: 490, end: 720 },
        { start: 765, end: 1000 },
      ],
    },
    '3': {
      isWorkDay: true,
      workMinutes: 465,
      startTime: '08:15',
      endTime: '16:45',
      intervals: [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      workIntervals: [
        { start: 490, end: 720 },
        { start: 765, end: 1000 },
      ],
    },
    '4': {
      isWorkDay: true,
      workMinutes: 465,
      startTime: '08:15',
      endTime: '16:45',
      intervals: [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      workIntervals: [
        { start: 490, end: 720 },
        { start: 765, end: 1000 },
      ],
    },
    '5': {
      isWorkDay: true,
      workMinutes: 465,
      startTime: '08:15',
      endTime: '16:45',
      intervals: [
        { startTime: '08:10', endTime: '12:00' },
        { startTime: '12:45', endTime: '16:40' },
      ],
      workIntervals: [
        { start: 490, end: 720 },
        { start: 765, end: 1000 },
      ],
    },
    '6': { isWorkDay: false, workMinutes: 0, startTime: null, endTime: null, intervals: [], workIntervals: [] },
  };

  it('GT-W3-01: School Default Payload - scheduleSource === SCHOOL_DEFAULT かつ scheduleDetails キーが完全に省略されること', () => {
    const payload = projectWorkPatternPayload({
      ...validBaseState,
      scheduleSource: 'SCHOOL_DEFAULT',
    });

    assert.strictEqual(payload.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(payload.patternName, '通常勤務パターン');
    assert.strictEqual(payload.patternType, 'STANDARD_FULLTIME');
    assert.strictEqual(payload.scheduleDetails, undefined);
    assert.strictEqual('scheduleDetails' in payload, false);

    const jsonStr = JSON.stringify(payload);
    assert.strictEqual(jsonStr.includes('"scheduleDetails"'), false);
    assert.strictEqual(jsonStr.includes('"scheduleSource":"SCHOOL_DEFAULT"'), true);
  });

  it('GT-W3-02: Individual Payload - scheduleSource === INDIVIDUAL かつ Canonical scheduleDetails が完全に出力されること', () => {
    const payload = projectWorkPatternPayload({
      ...validBaseState,
      scheduleSource: 'INDIVIDUAL',
      workingScheduleDetails: existingProductionDetailsFixture,
    });

    assert.strictEqual(payload.scheduleSource, 'INDIVIDUAL');
    assert.ok(payload.scheduleDetails, 'scheduleDetails exists');
    assert.strictEqual(Object.keys(payload.scheduleDetails).length, 7);
    assert.strictEqual(payload.scheduleDetails['1'].isWorkDay, true);
    assert.strictEqual(payload.scheduleDetails['1'].workMinutes, 465);
    assert.strictEqual(payload.scheduleDetails['0'].isWorkDay, false);
    assert.strictEqual(payload.weeklyTotalMinutes, 2325);

    const jsonStr = JSON.stringify(payload);
    assert.strictEqual(jsonStr.includes('"scheduleDetails"'), true);
    assert.strictEqual(jsonStr.includes('"scheduleSource":"INDIVIDUAL"'), true);
  });

  it('GT-W3-03: Missing Source Fail-Closed - UNSELECTED / null / undefined / 空文字 で即座に PayloadProjectionError が発生すること', () => {
    const missingCases = ['UNSELECTED', null, undefined, ''];

    for (const src of missingCases) {
      assert.throws(
        () => {
          projectWorkPatternPayload({
            ...validBaseState,
            scheduleSource: src,
          });
        },
        (err: any) => {
          assert.ok(err instanceof PayloadProjectionError);
          assert.strictEqual(err.errorCode, 'MISSING_SCHEDULE_SOURCE');
          assert.ok(err.message.includes('明示選択は必須です'));
          return true;
        },
        `Expected Fail-Closed for missing scheduleSource: ${String(src)}`
      );
    }
  });

  it('GT-W3-04: Unknown Source Fail-Closed - 未知の値 (DEFAULT, SCHOOL, CUSTOM_SOURCE, UNKNOWN) が渡された場合 Fail-Closed となること', () => {
    const unknownCases = ['DEFAULT', 'SCHOOL', 'CUSTOM_SOURCE', 'UNKNOWN', 'INVALID_VAL'];

    for (const src of unknownCases) {
      assert.throws(
        () => {
          projectWorkPatternPayload({
            ...validBaseState,
            scheduleSource: src,
          });
        },
        (err: any) => {
          assert.ok(err instanceof PayloadProjectionError);
          assert.strictEqual(err.errorCode, 'INVALID_SCHEDULE_SOURCE');
          assert.ok(err.message.includes('無効な勤務日課ソースです'));
          return true;
        },
        `Expected Fail-Closed for unknown scheduleSource: ${src}`
      );
    }
  });

  it('GT-W3-05: Existing Individual Lossless Round-Trip - scheduleDetailsDirty === false で既存 2-interval 構造の Semantic Fact が 100% 保持されること', () => {
    const payload = projectWorkPatternPayload({
      ...validBaseState,
      scheduleSource: 'INDIVIDUAL',
      scheduleDetailsDirty: false,
      originalScheduleDetails: existingProductionDetailsFixture,
    });

    assert.strictEqual(payload.scheduleSource, 'INDIVIDUAL');
    const outDetails = payload.scheduleDetails!;
    assert.ok(outDetails);

    // 各曜日の Semantic Fact 照合
    for (let d = 0; d < 7; d++) {
      const dayKey = String(d);
      const expectedDay = existingProductionDetailsFixture[dayKey];
      const actualDay = outDetails[dayKey];

      assert.strictEqual(actualDay.isWorkDay, expectedDay.isWorkDay, `Day ${d} isWorkDay mismatch`);
      assert.strictEqual(actualDay.workMinutes, expectedDay.workMinutes, `Day ${d} workMinutes mismatch`);
      assert.strictEqual(actualDay.startTime, expectedDay.startTime, `Day ${d} startTime mismatch`);
      assert.strictEqual(actualDay.endTime, expectedDay.endTime, `Day ${d} endTime mismatch`);

      if (expectedDay.isWorkDay) {
        assert.strictEqual(actualDay.intervals?.length, expectedDay.intervals?.length, `Day ${d} interval count mismatch`);
        assert.strictEqual(actualDay.intervals?.[0].startTime, '08:10');
        assert.strictEqual(actualDay.intervals?.[0].endTime, '12:00');
        assert.strictEqual(actualDay.intervals?.[1].startTime, '12:45');
        assert.strictEqual(actualDay.intervals?.[1].endTime, '16:40');
      }
    }
  });

  it('GT-W3-06: Day-of-Week Variation Preservation - 水曜日だけ別日課 (短縮) を設定した場合に曜日差異が Payload で保持されること', () => {
    const variationDetails: CanonicalScheduleDetails = JSON.parse(JSON.stringify(existingProductionDetailsFixture));
    // 水曜日 ('3') だけ 8:30〜13:30 (300分) の短縮勤務に設定
    variationDetails['3'] = {
      isWorkDay: true,
      workMinutes: 300,
      startTime: '08:30',
      endTime: '13:30',
      intervals: [{ startTime: '08:30', endTime: '13:30' }],
      workIntervals: [{ start: 510, end: 810 }],
    };

    const payload = projectWorkPatternPayload({
      ...validBaseState,
      scheduleSource: 'INDIVIDUAL',
      scheduleDetailsDirty: true,
      workingScheduleDetails: variationDetails,
    });

    assert.strictEqual(payload.scheduleSource, 'INDIVIDUAL');
    const out = payload.scheduleDetails!;

    // 月曜日 ('1') は通常 465分
    assert.strictEqual(out['1'].workMinutes, 465);
    assert.strictEqual(out['1'].intervals?.length, 2);

    // 水曜日 ('3') は短縮 300分
    assert.strictEqual(out['3'].workMinutes, 300);
    assert.strictEqual(out['3'].startTime, '08:30');
    assert.strictEqual(out['3'].endTime, '13:30');
    assert.strictEqual(out['3'].intervals?.length, 1);
    assert.strictEqual(out['3'].intervals?.[0].startTime, '08:30');
    assert.strictEqual(out['3'].intervals?.[0].endTime, '13:30');

    // 週合計: 465 * 4 + 300 = 2160分
    assert.strictEqual(payload.weeklyTotalMinutes, 2160);
  });

  it('GT-W3-07: Source Switch Cleanliness - INDIVIDUAL → SCHOOL_DEFAULT で不要日課が完全除去され、逆方向で日課なしは Fail-Closed となること', () => {
    // Case A: State に Individual 用の詳細が残っていても、scheduleSource === 'SCHOOL_DEFAULT' なら Payload から完全除去される
    const payloadA = projectWorkPatternPayload({
      ...validBaseState,
      scheduleSource: 'SCHOOL_DEFAULT',
      workingScheduleDetails: existingProductionDetailsFixture,
      commonDailySchedule: { startTime: '08:30', endTime: '15:15' },
    });

    assert.strictEqual(payloadA.scheduleSource, 'SCHOOL_DEFAULT');
    assert.strictEqual(payloadA.scheduleDetails, undefined);
    assert.strictEqual('scheduleDetails' in payloadA, false);
    assert.strictEqual(JSON.stringify(payloadA).includes('"scheduleDetails"'), false);

    // Case B: scheduleSource === 'INDIVIDUAL' へ切り替えたが、有効な日課詳細が存在しない場合は Fail-Closed
    assert.throws(
      () => {
        projectWorkPatternPayload({
          ...validBaseState,
          scheduleSource: 'INDIVIDUAL',
          scheduleDetailsDirty: true,
          workingScheduleDetails: null,
          commonDailySchedule: null,
          originalScheduleDetails: null,
        });
      },
      (err: any) => {
        assert.ok(err instanceof PayloadProjectionError);
        assert.strictEqual(err.errorCode, 'MISSING_SCHEDULE_DETAILS');
        return true;
      }
    );
  });

  it('GT-W3-08: Corrupted Record Edit Protection - 既存レコードの schedule_source が破損している場合、編集処理が Fail-Closed となること', () => {
    const corruptedCases = [null, undefined, 'UNKNOWN', '', 'INVALID_SOURCE', 123, {}];

    for (const src of corruptedCases) {
      assert.throws(
        () => {
          validateExistingRecordSource(src);
        },
        (err: any) => {
          assert.ok(err instanceof PayloadProjectionError);
          assert.strictEqual(err.errorCode, 'CORRUPTED_RECORD_SOURCE');
          assert.ok(err.message.includes('既存レコードの勤務時間ソースが不正または破損しています'));
          return true;
        },
        `Expected validateExistingRecordSource to throw for: ${String(src)}`
      );
    }

    // 正しい Canonical 2値は正常に通過すること
    assert.strictEqual(validateExistingRecordSource('SCHOOL_DEFAULT'), 'SCHOOL_DEFAULT');
    assert.strictEqual(validateExistingRecordSource('INDIVIDUAL'), 'INDIVIDUAL');
  });
});
