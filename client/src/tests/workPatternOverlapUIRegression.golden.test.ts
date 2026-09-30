import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../services/api';

describe('Work Pattern Overlap UI Regression Golden Suite (GT-WPOR-01 〜 GT-WPOR-07)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // GT-WPOR-01: Structured 409 Preservation
  it('GT-WPOR-01: HTTP 409 レスポンス時に ApiError がスローされ、err.data.overlappingPattern が無欠損で保持されること', async () => {
    const mock409Payload = {
      success: false,
      errorCode: 'WORK_PATTERN_PERIOD_OVERLAP',
      message: '指定された適用期間（2026-10-01〜9999-12-31）は、既存の勤務パターン「標準フルタイム（2025-01-01〜2027-12-31）」と重複しています',
      overlappingPattern: {
        id: 99901,
        patternName: '標準フルタイム',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2027-12-31',
      },
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mock409Payload), {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      await api.createWorkPattern(1, {
        patternName: '週4日勤務（水曜週休）',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      });
      assert.fail('409 Conflict should throw an error');
    } catch (err: any) {
      // 修正前: err はただの Error であり、err.data や err.overlappingPattern は存在しない (FAIL)
      // 修正後: err は ApiError であり、err.data.overlappingPattern が保持されている (PASS)
      assert.ok(err.data, 'err.data must be preserved on thrown error');
      assert.equal(err.status, 409, 'err.status must be 409');
      assert.ok(err.data.overlappingPattern, 'err.data.overlappingPattern must be preserved');
      assert.equal(err.data.overlappingPattern.id, 99901);
      assert.equal(err.data.overlappingPattern.patternName, '標準フルタイム');
      assert.equal(err.data.overlappingPattern.effectiveFrom, '2025-01-01');
      assert.equal(err.data.overlappingPattern.effectiveTo, '2027-12-31');
    }
  });

  // GT-WPOR-02: Assist State Creation
  it('GT-WPOR-02: 409 捕捉時に overlappingPattern から overlapSuggestion が正しく生成されること', async () => {
    const mock409Payload = {
      success: false,
      errorCode: 'WORK_PATTERN_PERIOD_OVERLAP',
      message: '重複しています',
      overlappingPattern: {
        id: 99901,
        patternName: '標準フルタイム',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2027-12-31',
      },
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mock409Payload), {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const newEffectiveFrom = '2026-10-01';
    let patternError = '';
    let overlapSuggestion: any = null;

    // AdminAuditPage.tsx の Canonicalized handleCreatePattern ロジックの検証
    try {
      await api.createWorkPattern(1, {
        patternName: '週4日勤務（水曜週休）',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: newEffectiveFrom,
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      });
    } catch (err: any) {
      patternError = err.message || '勤務パターンの登録に失敗しました';
      const overlapping = err.data?.overlappingPattern || err.overlappingPattern;
      if (overlapping && overlapping.effectiveFrom < newEffectiveFrom) {
        const startDate = new Date(newEffectiveFrom);
        startDate.setDate(startDate.getDate() - 1);
        const suggestedEndDate = startDate.toISOString().split('T')[0];
        overlapSuggestion = {
          targetPattern: overlapping,
          suggestedEndDate,
        };
      }
    }

    // 修正前: err.data が存在しないため overlapSuggestion は null のまま (FAIL)
    // 修正後: overlapSuggestion が生成され、suggestedEndDate が 2026-09-30 となる (PASS)
    assert.equal(patternError, '重複しています');
    assert.ok(overlapSuggestion, 'overlapSuggestion must be generated upon 409 with overlappingPattern');
    assert.equal(overlapSuggestion.suggestedEndDate, '2026-09-30');
    assert.equal(overlapSuggestion.targetPattern.id, 99901);
  });

  // GT-WPOR-04: Generic Error Compatibility
  it('GT-WPOR-04: 400 / 500 等の通常エラー時、err.message が従来通り取得でき overlapSuggestion は生成されないこと', async () => {
    const mock400Payload = {
      success: false,
      errorCode: 'INVALID_SCHEDULE_SOURCE',
      message: '無効な scheduleSource です',
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mock400Payload), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      });
    };

    let patternError = '';
    let overlapSuggestion: any = null;
    const newEffectiveFrom = '2026-10-01';

    try {
      await api.createWorkPattern(1, {
        patternName: 'テスト',
        patternType: 'STANDARD_FULLTIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: newEffectiveFrom,
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 6],
      });
    } catch (err: any) {
      patternError = err.message || '勤務パターンの登録に失敗しました';
      const overlapping = err.data?.overlappingPattern || err.overlappingPattern;
      if (overlapping && overlapping.effectiveFrom < newEffectiveFrom) {
        const startDate = new Date(newEffectiveFrom);
        startDate.setDate(startDate.getDate() - 1);
        const suggestedEndDate = startDate.toISOString().split('T')[0];
        overlapSuggestion = {
          targetPattern: overlapping,
          suggestedEndDate,
        };
      }
    }

    assert.equal(patternError, '無効な scheduleSource です');
    assert.equal(overlapSuggestion, null, 'overlapSuggestion must remain null for non-overlap errors');
  });

  // GT-WPOR-05: Error instanceof Compatibility
  it('GT-WPOR-05: スローされるエラーは instanceof Error === true であり既存 caller と完全互換であること', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ success: false, message: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      await api.getMe();
      assert.fail('Should throw');
    } catch (err: any) {
      assert.ok(err instanceof Error, 'err must be an instance of Error');
      assert.equal(err.message, 'Server error');
    }
  });

  // GT-WPOR-06: Date Boundary Regression
  it('GT-WPOR-06: 既存の日付演算ロジック (KEEP AS-IS) により 2026-10-01 に対し 2026-09-30 が算出されること', () => {
    const newEffectiveFrom = '2026-10-01';
    const startDate = new Date(newEffectiveFrom);
    startDate.setDate(startDate.getDate() - 1);
    const suggestedEndDate = startDate.toISOString().split('T')[0];
    assert.equal(suggestedEndDate, '2026-09-30');
  });

  // GT-WPOR-07: Normal 2xx Success
  it('GT-WPOR-07: 正常な 2xx レスポンス時は従来通りパース済みデータが返却されること', async () => {
    const mockSuccess = {
      success: true,
      message: '勤務パターンを登録しました',
      patternId: 12345,
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mockSuccess), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const res = await api.createWorkPattern(1, {
      patternName: '正常パターン',
      patternType: 'STANDARD_FULLTIME',
      scheduleSource: 'SCHOOL_DEFAULT',
      effectiveFrom: '2026-10-01',
      effectiveTo: '9999-12-31',
      weeklyOffDays: [0, 6],
    });

    assert.equal(res.success, true);
    assert.equal(res.patternId, 12345);
  });

  // GT-WPOA-15: Client Single-Request Projection
  it('GT-WPOA-15: Client Single-Request Projection — api.resolveWorkPatternOverlap が単一の POST リクエストを発行すること', async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];

    globalThis.fetch = async (url: any, init: any) => {
      calls.push({
        url: String(url),
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return new Response(
        JSON.stringify({
          success: true,
          message: 'アトミック解決成功',
          shortenedPattern: { id: 101, effectiveFrom: '2025-01-01', effectiveTo: '2026-09-30' },
          createdPattern: { id: 102, effectiveFrom: '2026-10-01', effectiveTo: '9999-12-31' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    assert.ok(
      typeof (api as any).resolveWorkPatternOverlap === 'function',
      'api.resolveWorkPatternOverlap must be defined as an API method'
    );

    const res = await (api as any).resolveWorkPatternOverlap(1, {
      targetPatternId: 101,
      expectedCurrentEffectiveTo: '2027-12-31',
      newPattern: {
        patternName: '週4日勤務',
        patternType: 'SHORT_TIME',
        scheduleSource: 'SCHOOL_DEFAULT',
        effectiveFrom: '2026-10-01',
        effectiveTo: '9999-12-31',
        weeklyOffDays: [0, 3, 6],
      },
    });

    assert.equal(res.success, true);
    assert.equal(calls.length, 1, 'Exactly ONE HTTP request must be dispatched');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/admin\/users\/1\/work-patterns\/resolve-overlap$/);
    assert.equal(calls[0].body.targetPatternId, 101);
    assert.equal(calls[0].body.expectedCurrentEffectiveTo, '2027-12-31');
    assert.equal(calls[0].body.newPattern.effectiveFrom, '2026-10-01');
  });
});

