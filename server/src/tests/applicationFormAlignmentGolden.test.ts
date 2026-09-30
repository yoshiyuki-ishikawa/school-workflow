import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FormSchemaRegistry } from '../services/schema/formSchemaRegistry';
import { FormValidationEngine } from '../services/schema/formValidationEngine';

describe('Application Form Schema Alignment - Server Golden Tests', () => {
  const schemas = FormSchemaRegistry.getAllActiveSchemas();

  it('GT-SRV-01: FormSchemaRegistry contains all standard schemas', () => {
    assert.ok(schemas.length >= 12, `Expected at least 12 schemas, found ${schemas.length}`);
    const registeredTypes = schemas.map(s => s.typeId);
    assert.ok(registeredTypes.includes('BUSINESS_TRIP'));
    assert.ok(registeredTypes.includes('LEAVE_ANNUAL'));
    assert.ok(registeredTypes.includes('LEAVE_SPECIAL'));
    assert.ok(registeredTypes.includes('LEAVE_SICK'));
    assert.ok(registeredTypes.includes('LEAVE_DUTY_EXEMPT'));
    assert.ok(registeredTypes.includes('WORK_PATTERN_CHILDCARE'));
    assert.ok(registeredTypes.includes('LEAVE_CARE'));
  });

  it('GT-SRV-02: WORK_PATTERN_CHILDCARE schema contains patternType', () => {
    const schema = FormSchemaRegistry.resolveActiveSchema('WORK_PATTERN_CHILDCARE');
    assert.ok(schema, 'WORK_PATTERN_CHILDCARE schema exists');
    const flatFields = FormSchemaRegistry.extractFlatFields(schema!.sections);
    const field = flatFields.get('patternType');
    assert.ok(field, 'patternType field exists');
    assert.strictEqual(field?.name, 'patternType');
  });

  it('GT-SRV-03: LEAVE_DUTY_EXEMPT schema contains unitType with DAY, HALF_DAY, TIME options', () => {
    const schema = FormSchemaRegistry.resolveActiveSchema('LEAVE_DUTY_EXEMPT');
    assert.ok(schema, 'LEAVE_DUTY_EXEMPT schema exists');
    const flatFields = FormSchemaRegistry.extractFlatFields(schema!.sections);
    const unitField = flatFields.get('unitType');
    assert.ok(unitField, 'unitType field exists');
    const optionValues = unitField?.options?.map(o => o.value);
    assert.deepStrictEqual(optionValues, ['DAY', 'HALF_DAY', 'TIME']);
  });

  it('GT-SRV-04: Capability classCoverageApplicable is defined strictly per schema', () => {
    const trip = FormSchemaRegistry.resolveActiveSchema('BUSINESS_TRIP');
    assert.strictEqual(trip?.capabilities?.classCoverageApplicable, true);

    const annual = FormSchemaRegistry.resolveActiveSchema('LEAVE_ANNUAL');
    assert.strictEqual(annual?.capabilities?.classCoverageApplicable, true);

    const workPattern = FormSchemaRegistry.resolveActiveSchema('WORK_PATTERN_CHILDCARE');
    assert.strictEqual(workPattern?.capabilities?.classCoverageApplicable, undefined);
  });

  it('GT-SRV-05: Server Validation accepts valid canonical payloads for all registered schemas', () => {
    for (const schema of schemas) {
      const flatFields = FormSchemaRegistry.extractFlatFields(schema.sections);
      const payload: Record<string, any> = {};
      
      for (const [name, field] of flatFields.entries()) {
        if (field.defaultValue !== undefined) {
          payload[name] = field.defaultValue;
        } else if (field.type === 'DATE') {
          payload[name] = '2026-04-01';
        } else if (field.type === 'TIME') {
          payload[name] = '09:00';
        } else if (field.type === 'DATETIME') {
          payload[name] = '2026-04-01T09:00:00';
        } else if (field.type === 'SELECT') {
          payload[name] = field.options && field.options.length > 0 ? field.options[0].value : 'OPTION1';
        } else if (field.type === 'NUMBER') {
          payload[name] = 1;
        } else if (field.type === 'BOOLEAN') {
          payload[name] = true;
        } else if (field.type === 'ARRAY') {
          payload[name] = [];
        } else {
          payload[name] = 'Valid String Content';
        }
      }

      const result = FormValidationEngine.validate({
        typeId: schema.typeId,
        rawValues: payload
      });
      assert.strictEqual(result.valid, true, `Validation failed for ${schema.typeId}: ${JSON.stringify(result.issues)}`);
    }
  });

  it('GT-SRV-06: Strict validation rejects unknown schema or invalid types fail-closed', () => {
    const result = FormValidationEngine.validate({
      typeId: 'UNKNOWN_NONEXISTENT_TYPE',
      rawValues: {
        someField: 'value'
      }
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errorCode, 'UNKNOWN_SCHEMA');
  });
});
