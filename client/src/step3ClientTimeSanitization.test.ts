/**
 * Pilot Critical Path STEP 3: Client Golden Test Suite (GT-PILOT-S3-C01 〜 C04)
 * Client-side Time Sanitization & Working State Projection Contract Verification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleWorkingStateForProjection,
  projectApplicationFormDataBySchema,
} from './pages/NewApplicationModal';

describe('Pilot Critical Path STEP 3: Client Dual Boundary Time Sanitization (GT-PILOT-S3-C01〜C04)', () => {
  const annualSchema: any = {
    typeId: 'LEAVE_ANNUAL',
    version: '2026.1',
    title: '年次有給休暇',
    sections: [
      {
        id: 'basic',
        title: '基本情報',
        fields: [
          { name: 'unitType', label: '取得単位', type: 'SELECT', required: true, defaultValue: 'DAY' },
          { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
          { name: 'startDate', label: '開始日', type: 'DATE', required: false },
          { name: 'endDate', label: '終了日', type: 'DATE', required: false },
          { name: 'startTime', label: '開始時刻', type: 'TIME', required: false },
          { name: 'endTime', label: '終了時刻', type: 'TIME', required: false },
          { name: 'calculatedDays', label: '取得日数', type: 'NUMBER', required: false },
          { name: 'reason', label: '事由', type: 'TEXT', required: false },
        ]
      }
    ]
  };

  it('GT-PILOT-S3-C01: [Client Sanitization] unitType: DAY 時、Working State および Schema Projection から不要な startTime/endTime が完全に除去されること', () => {
    const state: any = {
      genericValues: {
        unitType: 'DAY',
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        startTime: '09:00',
        endTime: '11:00',
        calculatedDays: 1,
        reason: '私事都合'
      }
    };

    const rawWorkingState = assembleWorkingStateForProjection(state);
    assert.strictEqual(rawWorkingState.startTime, undefined, 'assembleWorkingStateForProjection で startTime が undefined にサニタイズされること');
    assert.strictEqual(rawWorkingState.endTime, undefined, 'assembleWorkingStateForProjection で endTime が undefined にサニタイズされること');
    assert.strictEqual(rawWorkingState.startAt, undefined, 'startAt も undefined になること');
    assert.strictEqual(rawWorkingState.endAt, undefined, 'endAt も undefined になること');

    const projectedPayload = projectApplicationFormDataBySchema(rawWorkingState, annualSchema);
    assert.strictEqual('startTime' in projectedPayload, false, 'projectedPayload に startTime が含まれないこと');
    assert.strictEqual('endTime' in projectedPayload, false, 'projectedPayload に endTime が含まれないこと');
    assert.strictEqual(projectedPayload.unitType, 'DAY');
    assert.strictEqual(projectedPayload.startDate, '2026-10-15');
  });

  it('GT-PILOT-S3-C02: [Client Sanitization] unitType: HALF_DAY 時、startTime/endTime が除去されること', () => {
    const state: any = {
      genericValues: {
        unitType: 'HALF_DAY',
        halfDayType: 'MORNING',
        targetDate: '2026-10-16',
        startTime: '13:00',
        endTime: '17:00',
        reason: '通院'
      }
    };

    const rawWorkingState = assembleWorkingStateForProjection(state);
    assert.strictEqual(rawWorkingState.startTime, undefined);
    assert.strictEqual(rawWorkingState.endTime, undefined);

    const projectedPayload = projectApplicationFormDataBySchema(rawWorkingState, annualSchema);
    assert.strictEqual('startTime' in projectedPayload, false);
    assert.strictEqual('endTime' in projectedPayload, false);
    assert.strictEqual(projectedPayload.unitType, 'HALF_DAY');
  });

  it('GT-PILOT-S3-C03: [Client TIME Preservation] unitType: TIME 時、正当な startTime/endTime が完全保持されること', () => {
    const state: any = {
      genericValues: {
        unitType: 'TIME',
        targetDate: '2026-10-17',
        startDate: '2026-10-17',
        endDate: '2026-10-17',
        startTime: '10:00',
        endTime: '12:00',
        reason: '私事都合'
      }
    };

    const rawWorkingState = assembleWorkingStateForProjection(state);
    assert.strictEqual(rawWorkingState.startTime, '10:00');
    assert.strictEqual(rawWorkingState.endTime, '12:00');

    const projectedPayload = projectApplicationFormDataBySchema(rawWorkingState, annualSchema);
    assert.strictEqual(projectedPayload.startTime, '10:00');
    assert.strictEqual(projectedPayload.endTime, '12:00');
    assert.strictEqual(projectedPayload.unitType, 'TIME');
  });

  it('GT-PILOT-S3-C04: [Client Non-unitType Forms] unitType を持たない出張 (BUSINESS_TRIP) 等では時刻情報が正常に保持されること', () => {
    const state: any = {
      genericValues: {
        startDate: '2026-10-20',
        endDate: '2026-10-20',
        startTime: '08:30',
        endTime: '17:00',
        destination: '山口市教育委員会'
      },
      tripState: {
        destination: '山口市教育委員会',
        transport: '公用車'
      }
    };

    const rawWorkingState = assembleWorkingStateForProjection(state);
    assert.strictEqual(rawWorkingState.startTime, '08:30');
    assert.strictEqual(rawWorkingState.endTime, '17:00');
    assert.strictEqual(rawWorkingState.startAt, '2026-10-20T08:30:00');
    assert.strictEqual(rawWorkingState.endAt, '2026-10-20T17:00:00');
  });
});
