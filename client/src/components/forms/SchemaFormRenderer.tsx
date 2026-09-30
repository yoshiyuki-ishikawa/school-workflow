import React from 'react';
import { ApplicationFormSchema, FormFieldCondition, FormFieldDefinition, FormSectionDefinition } from '../../types/formSchema';
import { TypedApplicationFormState } from '../../types/formState';
import { GenericFormField, SUPPORTED_GENERIC_FIELD_TYPES, UnsupportedSchemaFieldError } from './GenericFormField';
import { DEDICATED_RENDERER_REGISTRY, DedicatedSectionProps, UnsupportedDedicatedRendererError } from './DedicatedRendererRegistry';

export interface SchemaFormRendererProps {
  schema: ApplicationFormSchema;
  state: TypedApplicationFormState;
  onUpdateGeneric: (name: string, value: any) => void;
  onUpdateTrip: (updater: (prev: any) => any) => void;
  onUpdateCare: (updater: (prev: any) => any) => void;
  onUpdateCoverage: (updater: (prev: any) => any) => void;
  careCases?: any[];
  carePeriods?: any[];
  members?: any[];
  onOpenCareCaseModal?: () => void;
  onOpenCarePeriodModal?: () => void;
  disabled?: boolean;
}

/**
 * 動的条件評価関数 (Pure Helper)
 */
export function evaluateCondition(
  condition: FormFieldCondition | undefined,
  values: Record<string, any>
): boolean {
  if (!condition) return true;

  const currentVal = values[condition.field];

  switch (condition.operator) {
    case 'EQUALS':
      return String(currentVal) === String(condition.value);
    case 'NOT_EQUALS':
      return String(currentVal) !== String(condition.value);
    case 'IN':
      return Array.isArray(condition.value) && condition.value.map(String).includes(String(currentVal));
    case 'IS_TRUE':
      return Boolean(currentVal) === true;
    case 'IS_FALSE':
      return Boolean(currentVal) === false;
    default:
      return false;
  }
}

/**
 * RD-B2-03: レンダラー解決アルゴリズム (Pure Function)
 */
export type SectionResolutionResult =
  | { kind: 'DEDICATED'; renderer: React.FC<DedicatedSectionProps> }
  | { kind: 'GENERIC'; fields: FormFieldDefinition[] }
  | { kind: 'ERROR'; error: Error };

export function resolveSectionRenderer(
  section: FormSectionDefinition,
  registry: typeof DEDICATED_RENDERER_REGISTRY = DEDICATED_RENDERER_REGISTRY
): SectionResolutionResult {
  // Case A: Dedicated Match
  if (registry[section.id]) {
    return { kind: 'DEDICATED', renderer: registry[section.id] };
  }

  // Check fields in section
  const fields = section.fields || [];

  // Dedicated section flag in schema metadata without registry match -> Case D (Missing Dedicated Renderer)
  if ((section as any).isDedicated && !registry[section.id]) {
    return { kind: 'ERROR', error: new UnsupportedDedicatedRendererError(section.id) };
  }

  // Check if all field types are supported by GenericFormField
  const unsupportedField = fields.find((f) => !SUPPORTED_GENERIC_FIELD_TYPES.includes(f.type));
  if (unsupportedField) {
    // Case C: Unsupported Field Type -> Fail-Closed
    return {
      kind: 'ERROR',
      error: new UnsupportedSchemaFieldError(unsupportedField.name, unsupportedField.type),
    };
  }

  // Case B: Generic Standard Match (未知の Section ID でも全フィールドが標準型なら安全に描画)
  return { kind: 'GENERIC', fields };
}

/**
 * Schema-Driven Unified Form Renderer (Step 3: Generic + Dedicated Resolution)
 */
export const SchemaFormRenderer: React.FC<SchemaFormRendererProps> = ({
  schema,
  state,
  onUpdateGeneric,
  onUpdateTrip,
  onUpdateCare,
  onUpdateCoverage,
  careCases,
  carePeriods,
  members,
  onOpenCareCaseModal,
  onOpenCarePeriodModal,
  disabled = false,
}) => {
  const genericValues = state.genericValues || {};

  return (
    <div className="space-y-6">
      {(schema.sections || []).map((section) => {
        const resolution = resolveSectionRenderer(section);

        if (resolution.kind === 'ERROR') {
          // Fail-Closed: 解決エラー時は例外をスローして停止
          throw resolution.error;
        }

        if (resolution.kind === 'DEDICATED') {
          const DedicatedComponent = resolution.renderer;
          return (
            <DedicatedComponent
              key={section.id}
              section={section}
              state={state}
              onUpdateGeneric={onUpdateGeneric}
              onUpdateTrip={onUpdateTrip}
              onUpdateCare={onUpdateCare}
              onUpdateCoverage={onUpdateCoverage}
              careCases={careCases}
              carePeriods={carePeriods}
              members={members}
              onOpenCareCaseModal={onOpenCareCaseModal}
              onOpenCarePeriodModal={onOpenCarePeriodModal}
              disabled={disabled}
            />
          );
        }

        // Generic Standard Fields
        const visibleFields = resolution.fields.filter((field) =>
          evaluateCondition(field.visibleCondition, genericValues)
        );

        if (visibleFields.length === 0) {
          return null;
        }

        return (
          <div key={section.id} className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-4">
            {section.title && (
              <h3 className="text-sm font-bold text-slate-800 border-b border-slate-200 pb-2">
                {section.title}
              </h3>
            )}
            {section.description && (
              <p className="text-xs text-slate-500">{section.description}</p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {visibleFields.map((field) => {
                const isRequired = evaluateCondition(field.requiredCondition, genericValues);
                return (
                  <GenericFormField
                    key={field.name}
                    field={field}
                    value={genericValues[field.name]}
                    onChange={onUpdateGeneric}
                    disabled={disabled}
                    isRequired={isRequired}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
