/**
 * Pilot Critical Path STEP 1: Dedicated Golden Test Suite (GT-PILOT-S1-06 〜 08)
 * SSOT Contract & Business Trip Transportation vs Role Verification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FormSchemaRegistry } from '../services/schema/formSchemaRegistry';
import { formatTripRemarksProjection } from '../routes/forms';

describe('Pilot Critical Path STEP 1: GAP-03 Golden Suite (GT-PILOT-S1-06〜08)', () => {
  it('GT-PILOT-S1-06: [Schema SSOT Contract] 出張スキーマの vehicleUsageType options に DRIVER / PASSENGER のみが存在し OWN_CAR が存在しないこと', () => {
    const schema = FormSchemaRegistry.resolveActiveSchema('BUSINESS_TRIP');
    assert.ok(schema !== null, '出張スキーマが登録されていること');

    let vehicleUsageField: any = null;
    for (const section of schema!.sections) {
      const found = section.fields.find(f => f.name === 'vehicleUsageType');
      if (found) {
        vehicleUsageField = found;
        break;
      }
    }

    assert.ok(vehicleUsageField !== null, 'vehicleUsageType フィールドが存在すること');
    assert.ok(vehicleUsageField.options, 'options が定義されていること');

    const optionValues = vehicleUsageField.options.map((o: any) => o.value);
    assert.ok(optionValues.includes('DRIVER'), 'options に DRIVER が含まれること');
    assert.ok(optionValues.includes('PASSENGER'), 'options に PASSENGER が含まれること');
    assert.strictEqual(optionValues.includes('OWN_CAR'), false, 'options に誤った OWN_CAR が一切存在しないこと');
  });

  it('GT-PILOT-S1-07: [Trip Report Print Precision] vehicleUsageType: DRIVER のとき、交通手段欄に (運転) が正確に出力されること', () => {
    const formatted = formatTripRemarksProjection(
      {
        actualTransportMode: '自家用車',
        vehicleUsageType: 'DRIVER',
        actualDistanceKm: 15.5
      },
      {}
    );

    assert.ok(formatted.includes('【交通手段】自家用車 (運転)'), `Expected '自家用車 (運転)' in: ${formatted}`);
    assert.ok(formatted.includes('【実測距離】15.5 km'));
  });

  it('GT-PILOT-S1-08: [Trip Report Passenger Print] vehicleUsageType: PASSENGER のとき、交通手段欄に (同乗) が正確に出力されること', () => {
    const formatted = formatTripRemarksProjection(
      {
        actualTransportMode: '自家用車',
        vehicleUsageType: 'PASSENGER'
      },
      {}
    );

    assert.ok(formatted.includes('【交通手段】自家用車 (同乗)'), `Expected '自家用車 (同乗)' in: ${formatted}`);
  });
});
