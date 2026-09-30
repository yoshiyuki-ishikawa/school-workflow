import React from 'react';
import { FormFieldDefinition, FormFieldType } from '../../types/formSchema';

export class UnsupportedSchemaFieldError extends Error {
  public fieldName: string;
  public fieldType: string;

  constructor(fieldName: string, fieldType: string) {
    super(`[UnsupportedSchemaFieldError] Unsupported or unhandled field type: "${fieldType}" for field "${fieldName}"`);
    this.name = 'UnsupportedSchemaFieldError';
    this.fieldName = fieldName;
    this.fieldType = fieldType;
  }
}

export interface GenericFormFieldProps {
  field: FormFieldDefinition;
  value: any;
  onChange: (fieldName: string, value: any) => void;
  disabled?: boolean;
  isRequired?: boolean;
}

export const SUPPORTED_GENERIC_FIELD_TYPES: FormFieldType[] = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'TIME',
  'DATETIME',
  'SELECT',
  'RADIO',
  'CHECKBOX',
  'BOOLEAN',
];

export const GenericFormField: React.FC<GenericFormFieldProps> = ({
  field,
  value,
  onChange,
  disabled = false,
  isRequired = false,
}) => {
  const { name, label, type, placeholder, description, options, validation } = field;
  const effectiveRequired = isRequired || field.required;

  const renderInput = () => {
    switch (type) {
      case 'TEXT':
        return (
          <input
            id={`field-${name}`}
            type="text"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            placeholder={placeholder || ''}
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value)}
            disabled={disabled}
            required={effectiveRequired}
            minLength={validation?.minLength}
            maxLength={validation?.maxLength}
            pattern={validation?.pattern}
          />
        );

      case 'TEXTAREA':
        return (
          <textarea
            id={`field-${name}`}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            placeholder={placeholder || ''}
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value)}
            disabled={disabled}
            required={effectiveRequired}
            minLength={validation?.minLength}
            maxLength={validation?.maxLength}
            rows={3}
          />
        );

      case 'NUMBER':
        return (
          <input
            id={`field-${name}`}
            type="number"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            placeholder={placeholder || ''}
            value={value !== undefined && value !== null ? Number(value) : ''}
            onChange={(e) => onChange(name, e.target.value === '' ? undefined : Number(e.target.value))}
            disabled={disabled}
            required={effectiveRequired}
            min={validation?.min}
            max={validation?.max}
          />
        );

      case 'DATE':
        return (
          <input
            id={`field-${name}`}
            type="date"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value)}
            disabled={disabled}
            required={effectiveRequired}
          />
        );

      case 'TIME':
        return (
          <input
            id={`field-${name}`}
            type="time"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value)}
            disabled={disabled}
            required={effectiveRequired}
          />
        );

      case 'DATETIME':
        return (
          <input
            id={`field-${name}`}
            type="datetime-local"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value)}
            disabled={disabled}
            required={effectiveRequired}
          />
        );

      case 'SELECT':
        return (
          <select
            id={`field-${name}`}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500 bg-white"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onChange(name, e.target.value)}
            disabled={disabled}
            required={effectiveRequired}
          >
            {placeholder && <option value="">{placeholder}</option>}
            {(options || []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );

      case 'RADIO':
        return (
          <div className="flex flex-wrap gap-4 pt-1">
            {(options || []).map((opt) => (
              <label key={opt.value} className="inline-flex items-center text-sm text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  value={opt.value}
                  checked={String(value) === String(opt.value)}
                  onChange={() => onChange(name, opt.value)}
                  disabled={disabled}
                  required={effectiveRequired}
                  className="w-4 h-4 text-indigo-600 border-slate-300 focus:ring-indigo-500"
                />
                <span className="ml-2">{opt.label}</span>
              </label>
            ))}
          </div>
        );

      case 'CHECKBOX':
      case 'BOOLEAN':
        return (
          <div className="flex items-center pt-1">
            <label className="inline-flex items-center text-sm text-slate-700 cursor-pointer">
              <input
                id={`field-${name}`}
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => onChange(name, e.target.checked)}
                disabled={disabled}
                required={effectiveRequired}
                className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500"
              />
              <span className="ml-2">{label}</span>
            </label>
          </div>
        );

      default:
        // Fail-Closed: 未知型は絶対に推測描画せずエラーを投げる
        throw new UnsupportedSchemaFieldError(name, type);
    }
  };

  return (
    <div className="space-y-1">
      {type !== 'CHECKBOX' && type !== 'BOOLEAN' && (
        <label htmlFor={`field-${name}`} className="block text-xs font-semibold text-slate-700">
          {label}
          {effectiveRequired && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      {renderInput()}
      {description && <p className="text-xs text-slate-500">{description}</p>}
    </div>
  );
};
