import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectSchoolWorkSchedulePayload,
  calculateDayWorkMinutes,
  calculateWeeklyTotalMinutes,
  SchoolScheduleProjectionError,
  SchoolWorkScheduleFormState,
} from './utils/schoolWorkSchedulePayloadProjection';

describe('Wave 3B-1: School Default Daily Schedule Payload Projection Golden Tests (GT-W3B-01〜08)', () => {
  const validStandardState: SchoolWorkScheduleFormState = {
    scheduleName: '令和8年度 標準勤務日課',
    effectiveFrom: '2026-04-01',
    weeklyOffDays: '0,6',
    startTime: '08:15',
    endTime: '16:45',
    breakIntervals: [{ startTime: '12:00', endTime: '12:45' }],
  };

  it('GT-W3B-01: Standard Projection - 標準勤務時間 (08:15〜16:45, 休憩 12:00〜12:45) から週2,325分の Canonical Payload が完全生成されること', () => {
    const payload = projectSchoolWorkSchedulePayload(validStandardState);

    assert.strictEqual(payload.scheduleName, '令和8年度 標準勤務日課');
    assert.strictEqual(payload.effectiveFrom, '2026-04-01');
    assert.strictEqual(payload.weeklyOffDays, '0,6');

    const details = payload.scheduleDetails;
    assert.ok(details, 'scheduleDetails exists');
    assert.strictEqual(Object.keys(details).length, 7);

    // 月曜日 ('1') の検証 (465分, 2 intervals)
    const mon = details['1'];
    assert.strictEqual(mon.isWorkDay, true);
    assert.strictEqual(mon.workMinutes, 465);
    assert.strictEqual(mon.startTime, '08:15');
    assert.strictEqual(mon.endTime, '16:45');
    assert.strictEqual(mon.intervals?.length, 2);
    assert.strictEqual(mon.intervals?.[0].startTime, '08:15');
    assert.strictEqual(mon.intervals?.[0].endTime, '12:00');
    assert.strictEqual(mon.intervals?.[1].startTime, '12:45');
    assert.strictEqual(mon.intervals?.[1].endTime, '16:45');

    assert.strictEqual(mon.workIntervals?.length, 2);
    assert.strictEqual(mon.workIntervals?.[0].start, 495); // 08:15 = 495
    assert.strictEqual(mon.workIntervals?.[0].end, 720);   // 12:00 = 720
    assert.strictEqual(mon.workIntervals?.[1].start, 765); // 12:45 = 765
    assert.strictEqual(mon.workIntervals?.[1].end, 1005);  // 16:45 = 1005

    // 日曜日 ('0') & 土曜日 ('6') の検証 (週休日)
    assert.strictEqual(details['0'].isWorkDay, false);
    assert.strictEqual(details['0'].workMinutes, 0);
    assert.strictEqual(details['0'].intervals?.length, 0);
    assert.strictEqual(details['0'].workIntervals?.length, 0);

    assert.strictEqual(details['6'].isWorkDay, false);
    assert.strictEqual(details['6'].workMinutes, 0);

    // 週総実働時間の計算検証: 465 * 5 = 2,325分
    const weeklySum = [1, 2, 3, 4, 5].reduce((sum, d) => sum + (details[String(d)].workMinutes || 0), 0);
    assert.strictEqual(weeklySum, 2325);
  });

  it('GT-W3B-02: Multiple Breaks Preservation - 複数休憩区間 (昼休憩 + 夕方休憩) を指定した場合、3区間の workIntervals が正しく生成されること', () => {
    const multiBreakState: SchoolWorkScheduleFormState = {
      scheduleName: '令和8年度 複数休憩標準日課',
      effectiveFrom: '2026-04-01',
      weeklyOffDays: '0,6',
      startTime: '08:15',
      endTime: '17:00', // 総拘束時間 525分
      breakIntervals: [
        { startTime: '12:00', endTime: '12:45' }, // 45分
        { startTime: '15:00', endTime: '15:15' }, // 15分 -> 休憩合計 60分 -> 実働 465分
      ],
    };

    const payload = projectSchoolWorkSchedulePayload(multiBreakState);
    const mon = payload.scheduleDetails['1'];

    assert.strictEqual(mon.workMinutes, 465);
    assert.strictEqual(mon.intervals?.length, 3);
    assert.strictEqual(mon.intervals?.[0].startTime, '08:15');
    assert.strictEqual(mon.intervals?.[0].endTime, '12:00');
    assert.strictEqual(mon.intervals?.[1].startTime, '12:45');
    assert.strictEqual(mon.intervals?.[1].endTime, '15:00');
    assert.strictEqual(mon.intervals?.[2].startTime, '15:15');
    assert.strictEqual(mon.intervals?.[2].endTime, '17:00');

    assert.strictEqual(mon.workIntervals?.length, 3);
    assert.strictEqual(mon.workIntervals?.[0].start, 495);
    assert.strictEqual(mon.workIntervals?.[0].end, 720);
    assert.strictEqual(mon.workIntervals?.[1].start, 765);
    assert.strictEqual(mon.workIntervals?.[1].end, 900);
    assert.strictEqual(mon.workIntervals?.[2].start, 915);
    assert.strictEqual(mon.workIntervals?.[2].end, 1020);
  });

  it('GT-W3B-03: Invalid Weekly Sum Fail-Closed - 週総実働時間が 2,325分 (38時間45分) 以外の場合、INVALID_WEEKLY_TOTAL_MINUTES で遮断されること', () => {
    // 8:30〜16:30 (休憩45分) -> 1日 435分 (7時間15分) -> 週 2,175分
    const invalidWeeklyState: SchoolWorkScheduleFormState = {
      scheduleName: '不適合日課',
      effectiveFrom: '2026-04-01',
      startTime: '08:30',
      endTime: '16:30',
      breakIntervals: [{ startTime: '12:00', endTime: '12:45' }],
    };

    assert.throws(
      () => {
        projectSchoolWorkSchedulePayload(invalidWeeklyState);
      },
      (err: any) => {
        assert.ok(err instanceof SchoolScheduleProjectionError);
        assert.strictEqual(err.errorCode, 'INVALID_WEEKLY_TOTAL_MINUTES');
        assert.ok(err.message.includes('2,325分（38時間45分）'));
        return true;
      }
    );
  });

  it('GT-W3B-04: Time Range Inversion Fail-Closed - 終了時刻が開始時刻以前の場合、INVALID_TIME_RANGE で遮断されること', () => {
    const invertedState: SchoolWorkScheduleFormState = {
      scheduleName: '時刻逆転日課',
      effectiveFrom: '2026-04-01',
      startTime: '17:00',
      endTime: '08:30',
    };

    assert.throws(
      () => {
        projectSchoolWorkSchedulePayload(invertedState);
      },
      (err: any) => {
        assert.ok(err instanceof SchoolScheduleProjectionError);
        assert.strictEqual(err.errorCode, 'INVALID_TIME_RANGE');
        return true;
      }
    );
  });

  it('GT-W3B-05: Break Outside Work Hours Fail-Closed - 休憩時間帯が勤務時間外にある、または重複している場合、即時遮断されること', () => {
    // Case A: 休憩が勤務終了時刻以降にある
    assert.throws(
      () => {
        projectSchoolWorkSchedulePayload({
          ...validStandardState,
          breakIntervals: [{ startTime: '16:45', endTime: '17:30' }],
        });
      },
      (err: any) => {
        assert.ok(err instanceof SchoolScheduleProjectionError);
        assert.strictEqual(err.errorCode, 'BREAK_OUTSIDE_WORK_HOURS');
        return true;
      }
    );

    // Case B: 休憩同士が重複している
    assert.throws(
      () => {
        projectSchoolWorkSchedulePayload({
          ...validStandardState,
          breakIntervals: [
            { startTime: '12:00', endTime: '12:45' },
            { startTime: '12:30', endTime: '13:00' },
          ],
        });
      },
      (err: any) => {
        assert.ok(err instanceof SchoolScheduleProjectionError);
        assert.strictEqual(err.errorCode, 'OVERLAPPING_BREAKS');
        return true;
      }
    );
  });

  it('GT-W3B-06: Missing Required Fields Fail-Closed - 日課名が空文字、または勤務時刻が未入力の場合、MISSING_REQUIRED_FIELDS で遮断されること', () => {
    // Case A: 日課名が空文字
    assert.throws(
      () => {
        projectSchoolWorkSchedulePayload({
          ...validStandardState,
          scheduleName: '   ',
        });
      },
      (err: any) => {
        assert.ok(err instanceof SchoolScheduleProjectionError);
        assert.strictEqual(err.errorCode, 'MISSING_REQUIRED_FIELDS');
        return true;
      }
    );

    // Case B: 開始時刻が未入力
    assert.throws(
      () => {
        projectSchoolWorkSchedulePayload({
          ...validStandardState,
          startTime: '',
        });
      },
      (err: any) => {
        assert.ok(err instanceof SchoolScheduleProjectionError);
        assert.strictEqual(err.errorCode, 'MISSING_REQUIRED_FIELDS');
        return true;
      }
    );
  });

  it('GT-W3B-07: Effective-From Date Format & Boundary Fail-Closed - 有効開始日の日付形式 (YYYY-MM-DD) 不正や空・null値が渡された場合、即座に Fail-Closed 遮断されること', () => {
    const invalidDates = ['', '2026/04/01', '2026-4-1', 'invalid', '2026-04-01T00:00:00Z', null as any, undefined as any];

    for (const d of invalidDates) {
      assert.throws(
        () => {
          projectSchoolWorkSchedulePayload({
            ...validStandardState,
            effectiveFrom: d,
          });
        },
        (err: any) => {
          assert.ok(err instanceof SchoolScheduleProjectionError);
          assert.strictEqual(err.errorCode, 'INVALID_EFFECTIVE_FROM');
          assert.ok(err.message.includes('YYYY-MM-DD'));
          return true;
        },
        `Expected INVALID_EFFECTIVE_FROM for date: ${d}`
      );
    }
  });

  it('GT-W3B-08: Canonical Schedule Shape Contract Reconciliation - 射影された scheduleDetails が Server/Resolver の要求する Canonical Specification (7曜日 0〜6、workIntervals 分配列、intervals 文字列表現) を 100% 充足すること', () => {
    const payload = projectSchoolWorkSchedulePayload(validStandardState);
    const details = payload.scheduleDetails;

    // 1. 0〜6 のキーが完全に存在すること
    for (let d = 0; d < 7; d++) {
      const key = String(d);
      assert.ok(key in details, `Key ${key} must exist in scheduleDetails`);
      const day = details[key];
      assert.strictEqual(typeof day.isWorkDay, 'boolean');
      assert.strictEqual(typeof day.workMinutes, 'number');
      assert.ok(Array.isArray(day.intervals), `Day ${key} intervals must be an array`);
      assert.ok(Array.isArray(day.workIntervals), `Day ${key} workIntervals must be an array`);
    }

    // 2. 勤務日の Canonical Structure 検証 (月曜日)
    const workDay = details['1'];
    assert.strictEqual(workDay.isWorkDay, true);
    assert.strictEqual(workDay.workMinutes, 465);
    assert.strictEqual(workDay.startTime, '08:15');
    assert.strictEqual(workDay.endTime, '16:45');
    assert.strictEqual(workDay.intervals?.length, 2);
    assert.strictEqual(workDay.workIntervals?.length, 2);

    // workIntervals と intervals の数値・文字列完全一致検証
    assert.strictEqual(workDay.workIntervals?.[0].start, 495); // 8*60+15
    assert.strictEqual(workDay.workIntervals?.[0].end, 720);   // 12*60
    assert.strictEqual(workDay.intervals?.[0].startTime, '08:15');
    assert.strictEqual(workDay.intervals?.[0].endTime, '12:00');

    // 3. 週休日の Canonical Structure 検証 (日曜日)
    const offDay = details['0'];
    assert.strictEqual(offDay.isWorkDay, false);
    assert.strictEqual(offDay.workMinutes, 0);
    assert.strictEqual(offDay.startTime, null);
    assert.strictEqual(offDay.endTime, null);
    assert.strictEqual(offDay.intervals?.length, 0);
    assert.strictEqual(offDay.workIntervals?.length, 0);

    // 4. JSON シリアライズ完全性
    const jsonStr = JSON.stringify(payload);
    assert.ok(jsonStr.includes('"scheduleName":"令和8年度 標準勤務日課"'));
    assert.ok(jsonStr.includes('"scheduleDetails":{'));
    assert.ok(jsonStr.includes('"workIntervals":[{"start":495,"end":720}'));
  });
});
