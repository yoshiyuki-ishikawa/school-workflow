import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FormSchemaRegistry } from '../services/schema/formSchemaRegistry';
import { ApplicationFormSchema } from '../types/formSchema';

describe('Form Schema Namespace Isolation & Structural Invariant Tests (GT-SCHEMA-NS-*)', () => {
  const schemas = FormSchemaRegistry.getAllActiveSchemas();

  it('GT-SCHEMA-NS-01: Positive - All Active Production Schemas strictly satisfy C(S) ∩ A(S) = ∅', () => {
    assert.ok(schemas.length >= 12, `Expected at least 12 schemas, found ${schemas.length}`);

    for (const schema of schemas) {
      const canonicalNames = new Set<string>();
      const aliasNames = new Set<string>();

      for (const section of schema.sections || []) {
        for (const field of section.fields || []) {
          canonicalNames.add(field.name);
          for (const alias of field.aliases || []) {
            aliasNames.add(alias);
          }
        }
      }

      // Check intersection
      const intersection = [...aliasNames].filter(a => canonicalNames.has(a));
      assert.deepStrictEqual(
        intersection,
        [],
        `Invariant N Violation in schema '${schema.typeId}': Canonical/Alias collision detected on fields: ${intersection.join(', ')}`
      );
    }
  });

  it('GT-SCHEMA-NS-02: Positive - No Alias is owned by multiple fields in the same schema', () => {
    for (const schema of schemas) {
      const aliasMap = new Map<string, string>(); // aliasName -> fieldName
      for (const section of schema.sections || []) {
        for (const field of section.fields || []) {
          for (const alias of field.aliases || []) {
            if (aliasMap.has(alias)) {
              assert.fail(`Schema '${schema.typeId}' has shared alias '${alias}' between '${aliasMap.get(alias)}' and '${field.name}'`);
            }
            aliasMap.set(alias, field.name);
          }
        }
      }
    }
  });

  it('GT-SCHEMA-NS-03: Positive - No Field defines an alias to itself (Self-Alias)', () => {
    for (const schema of schemas) {
      for (const section of schema.sections || []) {
        for (const field of section.fields || []) {
          if (field.aliases && field.aliases.includes(field.name)) {
            assert.fail(`Schema '${schema.typeId}' has self-alias on field '${field.name}'`);
          }
        }
      }
    }
  });

  it('GT-SCHEMA-NS-04: Positive - Production FormSchemaRegistry instance is directly verified', () => {
    assert.ok(FormSchemaRegistry, 'FormSchemaRegistry instance must exist');
    const directSchemas = FormSchemaRegistry.getAllActiveSchemas();
    assert.strictEqual(directSchemas.length, schemas.length);
  });

  it('GT-SCHEMA-NS-05: Negative - Future Invalid Schemas are deterministically rejected at registration (Fail-Closed)', () => {
    // 1. Rejects Canonical ∩ Alias Collision
    const collidingSchema: ApplicationFormSchema = {
      typeId: 'INVALID_COLLIDING_SCHEMA',
      version: '2026.1',
      title: '不正スキーマ (衝突)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'sec1',
          title: 'Section 1',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: false, aliases: ['startDate'] },
          ]
        }
      ]
    };
    assert.throws(
      () => FormSchemaRegistry.registerSchema(collidingSchema),
      (err: any) => err.message.includes('Invariant N Violation: Canonical/Alias collision')
    );

    // 2. Rejects Self-Alias
    const selfAliasSchema: ApplicationFormSchema = {
      typeId: 'INVALID_SELF_ALIAS_SCHEMA',
      version: '2026.1',
      title: '不正スキーマ (自己エイリアス)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'sec1',
          title: 'Section 1',
          fields: [
            { name: 'destination', label: '用務先', type: 'TEXT', required: true, aliases: ['destination'] },
          ]
        }
      ]
    };
    assert.throws(
      () => FormSchemaRegistry.registerSchema(selfAliasSchema),
      (err: any) => err.message.includes('Invariant N Violation: Self-alias detected')
    );

    // 3. Rejects Alias-to-Alias Collision (Multiple owners)
    const sharedAliasSchema: ApplicationFormSchema = {
      typeId: 'INVALID_SHARED_ALIAS_SCHEMA',
      version: '2026.1',
      title: '不正スキーマ (エイリアス共有)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'sec1',
          title: 'Section 1',
          fields: [
            { name: 'fieldA', label: '項目A', type: 'TEXT', required: false, aliases: ['commonAlias'] },
            { name: 'fieldB', label: '項目B', type: 'TEXT', required: false, aliases: ['commonAlias'] },
          ]
        }
      ]
    };
    assert.throws(
      () => FormSchemaRegistry.registerSchema(sharedAliasSchema),
      (err: any) => err.message.includes('Invariant N Violation: Alias \'commonAlias\' is owned by multiple fields')
    );
  });
});
