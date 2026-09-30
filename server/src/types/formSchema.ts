/**
 * Application Form Schema Engine Types (SSOT)
 * Wave 1: Application Form Schema Dynamicization & Field Expansion
 */

export type FormFieldType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'DATE'
  | 'TIME'
  | 'DATETIME'
  | 'SELECT'
  | 'RADIO'
  | 'CHECKBOX'
  | 'BOOLEAN'
  | 'USER_SELECT'
  | 'ATTACHMENT'
  | 'ARRAY';

export type FieldConditionOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'IN'
  | 'IS_TRUE'
  | 'IS_FALSE';

export interface FormFieldCondition {
  field: string;
  operator: FieldConditionOperator;
  value?: any;
}

export interface FormFieldValidationRule {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string; // Regex pattern string
  customRuleCode?: string;
}

export interface FormFieldOption {
  label: string;
  value: string | number;
}

export interface FormFieldDefinition {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  defaultValue?: any;
  placeholder?: string;
  description?: string;
  options?: FormFieldOption[];
  validation?: FormFieldValidationRule;
  visibleCondition?: FormFieldCondition;
  requiredCondition?: FormFieldCondition;
  aliases?: string[];
}

export interface FormSectionDefinition {
  id: string;
  title: string;
  description?: string;
  fields: FormFieldDefinition[];
}

export interface SchemaCapabilities {
  classCoverageApplicable?: boolean;
}

export interface ApplicationFormSchema {
  typeId: string;
  version: string; // e.g. "2026.1"
  title: string;
  description?: string;
  effectiveFrom: string;
  effectiveTo: string;
  capabilities?: SchemaCapabilities;
  sections: FormSectionDefinition[];
}

/**
 * Historical Schema Snapshot (In-Payload Contract: OPTION H3)
 */
export interface FormSchemaSnapshot {
  typeId: string;
  version: string;
  capabilities?: SchemaCapabilities;
  sections: FormSectionDefinition[];
  capturedAt?: string;
}

/**
 * GAP-09 Class Coverage Types
 */
export type ClassCoverageStatus = 'REQUIRED' | 'NOT_REQUIRED' | 'UNSURE';

export type ClassCoverageType =
  | 'SUBSTITUTE_LESSON'
  | 'SELF_STUDY_SUPERVISION'
  | 'TIMETABLE_EXCHANGE'
  | 'COMBINED_CLASS'
  | 'OTHER';

export interface ClassCoverageItem {
  id?: string;
  targetDate: string;
  period: string;
  coverageType: ClassCoverageType;
  substituteUserId?: number;
  substituteUserNameSnapshot?: string;
  substituteUserDeptSnapshot?: string;
  subjectName?: string;
  contentNotes?: string;
}

export interface ClassCoverageData {
  coverageStatus?: ClassCoverageStatus;
  notRequiredReason?: string;
  coverageItems?: ClassCoverageItem[];
}

/**
 * Standard Application Payload Structure
 */
export interface StructuredApplicationFormData {
  schemaVersion?: string;
  schemaSnapshot?: FormSchemaSnapshot;
  values: Record<string, any>;
  // Legacy / Direct access properties (for seamless backward compatibility)
  [key: string]: any;
}

export interface SchemaValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface FormValidationResult {
  valid: boolean;
  status: number;
  errorCode?: string;
  message?: string;
  issues?: SchemaValidationIssue[];
  sanitizedValues?: Record<string, any>;
  schemaVersion?: string;
  schemaSnapshot?: FormSchemaSnapshot;
}
