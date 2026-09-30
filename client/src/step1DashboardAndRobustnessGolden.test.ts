/**
 * Pilot Critical Path STEP 1: Client Golden Test Suite (GT-PILOT-S1-01 〜 05)
 * Dashboard Defensive Normalization & ErrorBoundary Contract Verification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatApplicationPeriodSummary } from './pages/DashboardPage';
import { ErrorBoundary } from './components/common/ErrorBoundary';

describe('Pilot Critical Path STEP 1: GAP-01 & GAP-02 Client Golden Suite (GT-PILOT-S1-01〜05)', () => {
  // GAP-01: ErrorBoundary
  it('GT-PILOT-S1-01: [ErrorBoundary Class Contract] getDerivedStateFromError captures thrown error without swallow', () => {
    const testError = new Error('Schema renderer fail-closed triggered');
    const nextState = ErrorBoundary.getDerivedStateFromError(testError);
    assert.strictEqual(nextState.hasError, true);
    assert.strictEqual(nextState.error, testError);
  });

  it('GT-PILOT-S1-02: [ErrorBoundary Reset Contract] handleReset triggers onReset callback properly', () => {
    let resetCalled = false;
    const eb = new ErrorBoundary({
      children: null,
      onReset: () => { resetCalled = true; }
    });
    // mock setState to update state synchronously in unit test environment
    (eb as any).setState = function(updater: any) {
      const patch = typeof updater === 'function' ? updater(this.state) : updater;
      this.state = { ...this.state, ...patch };
    };
    eb.state = { hasError: true, error: new Error('test error') };

    (eb as any).handleReset();
    assert.strictEqual(eb.state.hasError, false);
    assert.strictEqual(eb.state.error, null);
    assert.strictEqual(resetCalled, true);
  });

  // GAP-02: Dashboard Defensive Normalization
  it('GT-PILOT-S1-03: [Dashboard Null Safety] null / undefined / empty form_data does not crash and renders safe fallback', () => {
    const appNull = { id: 1, type_id: 'LEAVE_ANNUAL', title: 'テスト年休', form_data: null as any, applicant_id: 1 };
    const appUndefined = { id: 2, type_id: 'LEAVE_ANNUAL', title: 'テスト年休', form_data: undefined as any, applicant_id: 1 };
    const appEmpty = { id: 3, type_id: 'LEAVE_ANNUAL', title: 'テスト年休', form_data: {} as any, applicant_id: 1 };

    assert.doesNotThrow(() => {
      assert.strictEqual(formatApplicationPeriodSummary(appNull as any), '-');
      assert.strictEqual(formatApplicationPeriodSummary(appUndefined as any), '-');
      assert.strictEqual(formatApplicationPeriodSummary(appEmpty as any), '-');
    });
  });

  it('GT-PILOT-S1-04: [Dashboard Trip Display] BUSINESS_TRIP does not display leave deduction days (1日取得)', () => {
    const tripApp = {
      id: 10,
      type_id: 'BUSINESS_TRIP',
      title: '県外出張',
      applicant_id: 1,
      form_data: {
        startDate: '2026-06-10',
        endDate: '2026-06-12',
        startTime: '09:00',
        endTime: '17:00',
        destination: '東京',
      }
    };

    const summary = formatApplicationPeriodSummary(tripApp as any);
    assert.strictEqual(summary.includes('1日取得'), false, '出張に誤った休暇取得日数表示が含まれないこと');
    assert.strictEqual(summary.includes('取得'), false, '出張に休暇取得表現が含まれないこと');
    assert.ok(summary.includes('2026-06-10〜2026-06-12'), '出張期間が含まれること');
    assert.ok(summary.includes('(09:00〜17:00)'), '出張時間が含まれること');
  });

  it('GT-PILOT-S1-05: [Dashboard Leave Display] TIME / HALF_DAY / DAY Leave formats are accurately projected', () => {
    // 1. 時間休
    const timeApp = {
      id: 20,
      type_id: 'LEAVE_ANNUAL',
      title: '年休(時間)',
      applicant_id: 1,
      form_data: {
        unitType: 'TIME',
        targetDate: '2026-05-15',
        startTime: '08:30',
        endTime: '10:30',
        calculatedMinutes: 120,
      }
    };
    assert.strictEqual(formatApplicationPeriodSummary(timeApp as any), '2026-05-15 08:30〜10:30 (2h0m)');

    // 2. 半日休
    const halfApp = {
      id: 21,
      type_id: 'LEAVE_ANNUAL',
      title: '年休(半日)',
      applicant_id: 1,
      form_data: {
        unitType: 'HALF_DAY',
        targetDate: '2026-05-16',
        halfDayType: 'AM',
      }
    };
    assert.strictEqual(formatApplicationPeriodSummary(halfApp as any), '2026-05-16 (午前半日 0.5日)');

    // 3. 終日年休
    const dayApp = {
      id: 22,
      type_id: 'LEAVE_ANNUAL',
      title: '年休(終日)',
      applicant_id: 1,
      form_data: {
        unitType: 'DAY',
        startDate: '2026-05-20',
        endDate: '2026-05-21',
        calculatedDays: 2,
      }
    };
    assert.strictEqual(formatApplicationPeriodSummary(dayApp as any), '2026-05-20〜2026-05-21 (2日)');
  });
});
