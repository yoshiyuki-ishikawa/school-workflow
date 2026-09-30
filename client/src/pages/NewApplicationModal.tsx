import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { ApplicationType, User, UserLeaveSummary } from '../types';
import { ApplicationFormSchema, ClassCoverageStatus, ClassCoverageType, ClassCoverageItem } from '../types/formSchema';
import {
  TypedApplicationFormState,
  TypedProjectionInput,
  ProjectionInputValue,
  GenericFieldValues,
  BusinessTripDomainState,
  CareDomainState,
  ClassCoverageDomainState,
} from '../types/formState';
import { COVERAGE_TYPE_LABELS } from '../utils/coverageAdapter';
import { LeaveSummaryWidget } from '../components/LeaveSummaryWidget';
import { CareCaseModal } from '../components/CareCaseModal';
import { CarePeriodModal } from '../components/CarePeriodModal';
import { BusinessTripFormSection } from '../components/forms/BusinessTripFormSection';
import { SchemaFormRenderer } from '../components/forms/SchemaFormRenderer';
import { X, Save, Send, Calendar, Clock, MapPin, FileText, AlertCircle, Users, UserCheck, BookOpen, Plus, Heart, Trash2 } from 'lucide-react';

export type ApplicationModalMode = 'CREATE' | 'EDIT_DRAFT' | 'RESUBMIT';

/**
 * Step 0: UI Working-State 日付正規化ヘルパー (Pure Function)
 * 終日・半日・時間休の切替に伴う入力値の相互同期（UI Convenience）を明示化
 */
export function normalizeWorkingStateDates(params: {
  unitType?: string;
  startDate?: string;
  endDate?: string;
  targetDate?: string;
}): { sDate?: string; eDate?: string; tDate?: string } {
  const isDay = params.unitType === 'DAY';
  const sDate = isDay ? params.startDate : (params.targetDate || params.startDate);
  const eDate = isDay ? params.endDate : (params.targetDate || params.endDate);
  const tDate = isDay ? (params.targetDate || sDate) : params.targetDate;

  return { sDate, eDate, tDate };
}

/**
 * Custom Error Class for Schema-based Form Projection Failures (Fail-Closed)
 */
export class PayloadProjectionError extends Error {
  public code: string;
  public fieldName?: string;
  public candidateValues?: any[];

  constructor(code: string, fieldName?: string, message?: string, candidateValues?: any[]) {
    super(message || `[PayloadProjectionError] ${code}${fieldName ? `: ${fieldName}` : ''}`);
    this.name = 'PayloadProjectionError';
    this.code = code;
    this.fieldName = fieldName;
    this.candidateValues = candidateValues;
  }
}

/**
 * Standard Application Type Title Prefixes (SSOT)
 */
export const APPLICATION_TYPE_TITLE_PREFIXES: Record<string, string> = {
  LEAVE_ANNUAL: '【年休】',
  LEAVE_SICK: '【病休】通院・療養',
  LEAVE_SPECIAL: '【特休】',
  LEAVE_DUTY_EXEMPT: '【職専免】',
  LEAVE_CARE: '【介護休暇】家族介護',
  LEAVE_CARE_TIME: '【介護時間】家族介護',
  TRAINING_SPECIAL_ACT_22_2: '【校外研修】教特法第22条第2項',
  TRAINING_SPECIAL_ACT_22_3: '【長期研修】教特法第22条第3項',
  BUSINESS_TRIP: '【出張】',
  LEAVE_CHILDCARE: '【育児休業】',
  WORK_PATTERN_CHILDCARE: '【育児短時間勤務】',
  LEAVE_CHILDCARE_PARTIAL: '【育児部分休業】',
  LEAVE_LARGE_SCHOOL: '【休暇申請】',
};

export function generateDefaultTitle(typeId: string, isBatchTrip?: boolean): string {
  if (typeId === 'BUSINESS_TRIP' && isBatchTrip) {
    return '【一括出張】公務出張';
  }
  if (typeId === 'BUSINESS_TRIP') {
    return '【出張】公務出張';
  }
  if (typeId === 'LEAVE_ANNUAL') {
    return '【年休】年次有給休暇';
  }
  if (typeId === 'LEAVE_SPECIAL') {
    return '【特休】特別休暇';
  }
  if (typeId === 'LEAVE_DUTY_EXEMPT') {
    return '【職専免】職務専念義務免除';
  }
  return APPLICATION_TYPE_TITLE_PREFIXES[typeId] || '【服務申請】';
}

export function isSystemGeneratedTitle(title: string): boolean {
  if (!title || !title.trim()) return true;
  const t = title.trim();
  const allValues = Object.values(APPLICATION_TYPE_TITLE_PREFIXES);
  allValues.push(
    '【一括出張】',
    '【一括出張】公務出張',
    '一括出張',
    '【年休】',
    '【年休】年次有給休暇',
    '年次有給休暇',
    '【病休】',
    '【病休】通院・療養',
    '通院・療養',
    '【特休】',
    '【特休】特別休暇',
    '特別休暇',
    '【職専免】',
    '【職専免】職務専念義務免除',
    '職務専念義務免除',
    '【出張】',
    '【出張】公務出張',
    '公務出張',
    '【校外研修】',
    '【校外研修】教特法第22条第2項',
    '教特法第22条第2項',
    '【長期研修】',
    '【長期研修】教特法第22条第3項',
    '教特法第22条第3項',
    '【介護休暇】',
    '【介護休暇】家族介護',
    '家族介護',
    '【介護時間】',
    '【介護時間】家族介護',
    '【育児休業】',
    '【育児短時間勤務】',
    '【育児部分休業】',
    '【休暇申請】',
    '【服務申請】'
  );
  return allValues.some((v) => t === v || t === v.replace(/【.*】/, '').trim());
}

/**
 * Step 1: Hybrid Typed Form State から Projection Input を型安全に合成する Pure Helper (any 排除)
 */
export function assembleWorkingStateForProjection(
  state: TypedApplicationFormState
): TypedProjectionInput {
  const { typeId, genericValues, tripState, careState, coverageState } = state;
  const unitType = genericValues.unitType ? String(genericValues.unitType) : undefined;
  const startDate = genericValues.startDate ? String(genericValues.startDate) : undefined;
  const endDate = genericValues.endDate ? String(genericValues.endDate) : undefined;
  const targetDate = genericValues.targetDate ? String(genericValues.targetDate) : undefined;

  const dates = normalizeWorkingStateDates({
    unitType,
    startDate,
    endDate,
    targetDate,
  });

  const isTimeType = unitType === 'TIME' || !unitType;
  const startTime = (isTimeType && genericValues.startTime) ? String(genericValues.startTime) : undefined;
  const endTime = (isTimeType && genericValues.endTime) ? String(genericValues.endTime) : undefined;

  const destination = tripState?.destination || (genericValues.destination ? String(genericValues.destination) : undefined);
  const venue = genericValues.venue ? String(genericValues.venue) : undefined;
  const reason = genericValues.reason ? String(genericValues.reason) : undefined;
  const specialReasonCode = genericValues.selectedSpecialReasonCode
    ? String(genericValues.selectedSpecialReasonCode)
    : (genericValues.specialReasonCode ? String(genericValues.specialReasonCode) : undefined);

  const rawWorkingState: TypedProjectionInput = {
    ...genericValues,
    unitType,
    halfDayType: unitType === 'HALF_DAY' ? (genericValues.halfDayType ? String(genericValues.halfDayType) : undefined) : undefined,
    startDate: dates.sDate,
    endDate: dates.eDate,
    targetDate: dates.tDate,
    startTime,
    endTime,
    selectedSpecialReasonCode: specialReasonCode,
    specialReasonCode: specialReasonCode,
    reasonCode: specialReasonCode,
    reason,
    purpose: reason,
    destination,
    venue,
    location: destination || venue,
    startAt: (dates.sDate && startTime) ? `${dates.sDate}T${startTime}:00` : undefined,
    endAt: (dates.eDate && endTime) ? `${dates.eDate}T${endTime}:00` : undefined,
  };

  if (tripState) {
    rawWorkingState.destination = tripState.destination;
    rawWorkingState.purpose = tripState.purpose || reason;
    rawWorkingState.startDate = tripState.startDate || dates.sDate;
    rawWorkingState.endDate = tripState.endDate || dates.eDate;
    rawWorkingState.transport = tripState.transport;
    rawWorkingState.transportOther = tripState.transportOther || undefined;
    rawWorkingState.departurePlace = tripState.departurePlace;
    rawWorkingState.arrivalPlace = tripState.arrivalPlace;
    rawWorkingState.privateCarReason = tripState.privateCarReason || undefined;
    rawWorkingState.fundingSource = tripState.fundingSource;
    rawWorkingState.fundingSourceOther = tripState.fundingSourceOther || undefined;
    rawWorkingState.isExpenseClaimed = tripState.isExpenseClaimed;
    rawWorkingState.isOralOrder = tripState.isOralOrder;
    rawWorkingState.oralOrderIssuedAt = tripState.oralOrderIssuedAt || undefined;
  }

  if (careState) {
    rawWorkingState.careCaseId = careState.careCaseId ? Number(careState.careCaseId) : undefined;
    rawWorkingState.carePeriodId = careState.carePeriodId ? Number(careState.carePeriodId) : undefined;
    rawWorkingState.selectedCareCaseId = careState.careCaseId || undefined;
    rawWorkingState.selectedCarePeriodId = careState.carePeriodId || undefined;
  }

  if (coverageState) {
    rawWorkingState.coverageStatus = coverageState.coverageStatus || undefined;
    rawWorkingState.notRequiredReason = coverageState.coverageStatus === 'NOT_REQUIRED' ? coverageState.notRequiredReason : undefined;
    rawWorkingState.coverageItems = coverageState.coverageStatus === 'REQUIRED' ? coverageState.coverageItems : [];
  }

  return rawWorkingState;
}

/**
 * Pre-Trip Schema Projection Gate (POINT-01-A)
 * 出張申請スキーマから事後復命欄 (report_details) を除外した事前申請専用スキーマを射影する。
 */
export function projectPreTripSchema(schema: ApplicationFormSchema | null | undefined): ApplicationFormSchema | null {
  if (!schema) return null;
  if (schema.typeId === 'BUSINESS_TRIP') {
    return {
      ...schema,
      sections: (schema.sections || []).filter((section) => section.id !== 'report_details'),
    };
  }
  return schema;
}

/**
 * Pure Schema-based Payload Projection Function (SSOT)
 */
export function projectApplicationFormDataBySchema(
  rawState: TypedProjectionInput,
  activeSchema: ApplicationFormSchema
): Record<string, ProjectionInputValue> {
  if (!activeSchema) {
    throw new PayloadProjectionError('SCHEMA_REQUIRED', undefined, 'Active Form Schema is required for payload projection.');
  }

  const payload: Record<string, ProjectionInputValue> = {};

  // Extract all fields across all sections in activeSchema
  for (const section of activeSchema.sections || []) {
    for (const field of section.fields || []) {
      const canonicalName = field.name;
      const aliases = field.aliases || [];

      // Collect defined values from rawState for canonical key and all aliases
      const candidateValues: ProjectionInputValue[] = [];
      if (rawState[canonicalName] !== undefined && rawState[canonicalName] !== '') {
        candidateValues.push(rawState[canonicalName]);
      }
      for (const alias of aliases) {
        if (rawState[alias] !== undefined && rawState[alias] !== '') {
          candidateValues.push(rawState[alias]);
        }
      }

      let resolvedValue: ProjectionInputValue = undefined;

      if (candidateValues.length > 0) {
        // Fail-Closed check: if multiple distinct values are present, throw AMBIGUOUS_FIELD_VALUE
        const firstValStr = JSON.stringify(candidateValues[0]);
        const isConflict = candidateValues.some(v => JSON.stringify(v) !== firstValStr);
        if (isConflict) {
          throw new PayloadProjectionError('AMBIGUOUS_FIELD_VALUE', canonicalName, undefined, candidateValues);
        }
        resolvedValue = candidateValues[0];
      } else if (field.defaultValue !== undefined) {
        resolvedValue = field.defaultValue;
      }

      if (resolvedValue !== undefined) {
        payload[canonicalName] = resolvedValue;
      }
    }
  }

  return payload;
}

/**
 * Test-only compatibility wrapper for projectApplicationFormData
 */
export function projectApplicationFormData(params: {
  selectedTypeId: string;
  unitType?: 'DAY' | 'HALF_DAY' | 'TIME' | string;
  halfDayType?: 'MORNING' | 'AFTERNOON' | string;
  startDate?: string;
  endDate?: string;
  targetDate?: string;
  startTime?: string;
  endTime?: string;
  calculatedDays?: number;
  selectedSpecialReasonCode?: string;
  specialLeavePolicies?: any[];
  relationship?: string;
  childBirthExpectedDate?: string;
  medicalCertificateAttached?: boolean;
  medicalInstitutionName?: string;
  selectedCareCaseId?: number | '';
  selectedCarePeriodId?: number | '';
  destination?: string;
  purpose?: string;
  departurePlace?: string;
  arrivalPlace?: string;
  transport?: string;
  transportOther?: string;
  privateCarReason?: string;
  fundingSource?: string;
  fundingSourceOther?: string;
  isExpenseClaimed?: boolean;
  isOralOrder?: boolean;
  oralOrderIssuedAt?: string;
  reason?: string;
  organizer?: string;
  venue?: string;
  substituteTeacher?: string;
  coverageStatus?: ClassCoverageStatus | '';
  notRequiredReason?: string;
  coverageItems?: ClassCoverageItem[];
  patternType?: string;
  activeSchema?: ApplicationFormSchema;
}): Record<string, any> {
  const dates = normalizeWorkingStateDates({
    unitType: params.unitType,
    startDate: params.startDate,
    endDate: params.endDate,
    targetDate: params.targetDate,
  });
  const sDate = dates.sDate;
  const eDate = dates.eDate;

  const hasTargetDateField = params.activeSchema
    ? (params.activeSchema.sections || []).some(s => (s.fields || []).some(f => f.name === 'targetDate' || f.aliases?.includes('targetDate')))
    : (params.selectedTypeId.startsWith('LEAVE_') || params.selectedTypeId.startsWith('TRAINING_'));

  const rawState: Record<string, any> = {
    unitType: params.unitType,
    halfDayType: params.unitType === 'HALF_DAY' ? params.halfDayType : undefined,
    startDate: sDate,
    endDate: eDate,
    targetDate: hasTargetDateField ? dates.tDate : undefined,
    startTime: params.startTime,
    endTime: params.endTime,
    calculatedDays: params.calculatedDays !== undefined
      ? params.calculatedDays
      : (params.unitType === 'HALF_DAY' ? 0.5 : undefined),
    reasonCode: params.selectedSpecialReasonCode,
    specialReasonCode: params.selectedSpecialReasonCode,
    selectedSpecialReasonCode: params.selectedSpecialReasonCode,
    specialLeaveType: params.selectedTypeId === 'LEAVE_SPECIAL' ? (params.specialLeavePolicies?.find(p => p.reasonCode === params.selectedSpecialReasonCode)?.name || params.selectedSpecialReasonCode) : undefined,
    relationship: params.selectedTypeId === 'LEAVE_SPECIAL' && params.selectedSpecialReasonCode === 'SPECIAL_BEREAVEMENT' ? params.relationship : undefined,
    childBirthExpectedDate: params.selectedTypeId === 'LEAVE_SPECIAL' && ['SPECIAL_MATERNITY', 'SPECIAL_SPOUSE_BIRTH', 'SPECIAL_CHILDCARE_PARTICIPATION'].includes(params.selectedSpecialReasonCode || '') ? params.childBirthExpectedDate : undefined,
    medicalCertificateAttached: params.selectedTypeId === 'LEAVE_SICK' ? params.medicalCertificateAttached : undefined,
    medicalInstitutionName: params.selectedTypeId === 'LEAVE_SICK' ? params.medicalInstitutionName : undefined,
    careCaseId: (params.selectedTypeId === 'LEAVE_CARE' || params.selectedTypeId === 'LEAVE_CARE_TIME') && params.selectedCareCaseId ? Number(params.selectedCareCaseId) : undefined,
    carePeriodId: params.selectedTypeId === 'LEAVE_CARE' && params.selectedCarePeriodId ? Number(params.selectedCarePeriodId) : undefined,
    destination: (params.selectedTypeId === 'BUSINESS_TRIP' || params.selectedTypeId.startsWith('TRAINING_')) ? params.destination : undefined,
    departurePlace: params.selectedTypeId === 'BUSINESS_TRIP' ? params.departurePlace : undefined,
    arrivalPlace: params.selectedTypeId === 'BUSINESS_TRIP' ? params.arrivalPlace : undefined,
    startAt: (sDate && params.startTime) ? `${sDate}T${params.startTime}:00` : undefined,
    endAt: (eDate && params.endTime) ? `${eDate}T${params.endTime}:00` : undefined,
    transport: params.selectedTypeId === 'BUSINESS_TRIP' ? params.transport : undefined,
    transportOther: params.selectedTypeId === 'BUSINESS_TRIP' && params.transport === 'その他' ? params.transportOther : undefined,
    privateCarReason: params.selectedTypeId === 'BUSINESS_TRIP' && params.transport === '自家用車' ? params.privateCarReason : undefined,
    fundingSource: params.selectedTypeId === 'BUSINESS_TRIP' ? params.fundingSource : undefined,
    fundingSourceOther: params.selectedTypeId === 'BUSINESS_TRIP' && params.fundingSource === 'その他' ? params.fundingSourceOther : undefined,
    isExpenseClaimed: params.selectedTypeId === 'BUSINESS_TRIP' ? params.isExpenseClaimed : undefined,
    isOralOrder: params.selectedTypeId === 'BUSINESS_TRIP' ? params.isOralOrder : undefined,
    oralOrderIssuedAt: (params.selectedTypeId === 'BUSINESS_TRIP' && params.isOralOrder && params.oralOrderIssuedAt) ? params.oralOrderIssuedAt : undefined,
    purpose: (params.selectedTypeId === 'BUSINESS_TRIP' || params.selectedTypeId.startsWith('TRAINING_') || params.selectedTypeId === 'LEAVE_DUTY_EXEMPT') ? (params.purpose || params.reason) : undefined,
    organizer: params.selectedTypeId.startsWith('TRAINING_') ? params.organizer : undefined,
    venue: params.selectedTypeId.startsWith('TRAINING_') ? (params.venue || params.destination) : undefined,
    reason: params.reason,
    substituteTeacher: params.substituteTeacher,
    coverageStatus: params.coverageStatus || undefined,
    notRequiredReason: params.coverageStatus === 'NOT_REQUIRED' ? params.notRequiredReason : undefined,
    coverageItems: params.coverageStatus === 'REQUIRED' ? params.coverageItems : [],
    patternType: params.patternType,
  };

  if (params.activeSchema) {
    const effectiveSchema = projectPreTripSchema(params.activeSchema);
    return projectApplicationFormDataBySchema(rawState, effectiveSchema || params.activeSchema);
  }

  // Fallback for standalone tests without activeSchema
  return rawState;
}

interface Props {
  isOpen: boolean;
  currentUser?: User | null;
  mode?: ApplicationModalMode;
  initialData?: {
    id: number;
    typeId: string;
    title: string;
    version: number;
    formData: Record<string, any>;
    isProxy?: boolean;
    subjectUserId?: number;
    proxyReason?: string;
  } | null;
  isResubmitMode?: boolean; // 下位互換性用
  onClose: () => void;
  onSuccess: () => void;
}

export const NewApplicationModal: React.FC<Props> = ({
  isOpen,
  currentUser,
  mode: propMode,
  initialData,
  isResubmitMode = false,
  onClose,
  onSuccess,
}) => {
  // 明示的モード決定
  const effectiveMode: ApplicationModalMode = propMode || (isResubmitMode ? 'RESUBMIT' : initialData ? 'EDIT_DRAFT' : 'CREATE');

  const [types, setTypes] = useState<ApplicationType[]>([]);
  const [schemasMap, setSchemasMap] = useState<Map<string, ApplicationFormSchema>>(new Map());
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [policyRules, setPolicyRules] = useState<any[]>([]);
  const [specialLeavePolicies, setSpecialLeavePolicies] = useState<any[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string>('LEAVE_ANNUAL');
  const [summary, setSummary] = useState<UserLeaveSummary | null>(null);
  const [members, setMembers] = useState<User[]>([]);

  // 代理申請ステート
  const [isProxyMode, setIsProxyMode] = useState(false);
  const [targetSubjectId, setTargetSubjectId] = useState<number | ''>('');
  const [proxyReason, setProxyReason] = useState('');

  const [transport, setTransport] = useState('公用車');

  // フォームステート
  const [title, setTitle] = useState('');
  const [unitType, setUnitType] = useState<'DAY' | 'HALF_DAY' | 'TIME' | string>('DAY');
  const [halfDayType, setHalfDayType] = useState<'MORNING' | 'AFTERNOON' | string>('MORNING');

  // 日単位用
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [calculatedDays, setCalculatedDays] = useState(1);

  // 時間単位用 (勤務時間 8:10〜16:40)
  const [targetDate, setTargetDate] = useState(new Date().toISOString().split('T')[0]);
  const [startTime, setStartTime] = useState('08:10');
  const [endTime, setEndTime] = useState('12:00');
  const [calculatedHoursText, setCalculatedHoursText] = useState('');

  const [selectedSpecialReasonCode, setSelectedSpecialReasonCode] = useState('SPECIAL_BEREAVEMENT');

  // 介護関連ステート (条例第15条・第16条)
  const [careCases, setCareCases] = useState<any[]>([]);
  const [selectedCareCaseId, setSelectedCareCaseId] = useState<number | ''>('');
  const [selectedCarePeriodId, setSelectedCarePeriodId] = useState<number | ''>('');
  const [isCareCaseModalOpen, setIsCareCaseModalOpen] = useState(false);
  const [isCarePeriodModalOpen, setIsCarePeriodModalOpen] = useState(false);

  // 出張用・研修用場所
  const [destination, setDestination] = useState('');
  const [departurePlace, setDeparturePlace] = useState('本校');
  const [arrivalPlace, setArrivalPlace] = useState('本校');
  const [transportOther, setTransportOther] = useState('');
  const [privateCarReason, setPrivateCarReason] = useState('');
  const [fundingSource, setFundingSource] = useState('県費');
  const [fundingSourceOther, setFundingSourceOther] = useState('');
  const [isExpenseClaimed, setIsExpenseClaimed] = useState(false);
  const [isOralOrder, setIsOralOrder] = useState(false);
  const [oralOrderIssuedAt, setOralOrderIssuedAt] = useState('');

  // 研修用
  const [organizer, setOrganizer] = useState('');
  const [venue, setVenue] = useState('');

  // 特休用
  const [relationship, setRelationship] = useState('');
  const [childBirthExpectedDate, setChildBirthExpectedDate] = useState('');

  // 病休用
  const [medicalCertificateAttached, setMedicalCertificateAttached] = useState(false);
  const [medicalInstitutionName, setMedicalInstitutionName] = useState('');

  // 育児短時間勤務用
  const [patternType, setPatternType] = useState('');

  // GAP-09: 授業引継ぎ・代替措置ステート
  const [coverageStatus, setCoverageStatus] = useState<ClassCoverageStatus | ''>('');
  const [notRequiredReason, setNotRequiredReason] = useState('');
  const [coverageItems, setCoverageItems] = useState<ClassCoverageItem[]>([]);

  // 共通
  const [reason, setReason] = useState('');
  const [substituteTeacher, setSubstituteTeacher] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canProxy = currentUser?.roles.some((r) => ['OFFICE', 'VICE_PRINCIPAL', 'PRINCIPAL'].includes(r));

  // 現在選択中のスキーマ
  const rawActiveSchema = schemasMap.get(selectedTypeId);
  const activeSchema = projectPreTripSchema(rawActiveSchema);

  // ポリシーから当該種別で時間単位・半日単位がCONFIRMEDされているか判定
  const currentPolicy = policyRules.find((p) => {
    if (selectedTypeId === 'TRAINING_SPECIAL_ACT_22_2') return p.policy_code === 'SPECIAL_ACT_22_2';
    if (selectedTypeId === 'TRAINING_SPECIAL_ACT_22_3') return p.policy_code === 'SPECIAL_ACT_22_3';
    return false;
  });

  const isHourlyConfirmed = currentPolicy?.rule_definition?.hourlyAllowed === 'CONFIRMED' || currentPolicy?.rule_definition?.hourlyAllowed === true;
  const isHalfDayConfirmed = currentPolicy?.rule_definition?.halfDayAllowed === 'CONFIRMED' || currentPolicy?.rule_definition?.halfDayAllowed === true;
  const isTrainingUnconfirmed = currentPolicy && (currentPolicy.rule_definition?.status === 'UNCONFIRMED' || currentPolicy.display_code === 'UNCONFIRMED');

  useEffect(() => {
    if (isOpen) {
      setError('');
      setIsProxyMode(false);
      setTargetSubjectId('');
      setProxyReason('');

      api.getAllFormSchemas()
        .then((res) => {
          if (res.schemas) {
            const map = new Map<string, ApplicationFormSchema>();
            for (const s of res.schemas) {
              map.set(s.typeId, s);
            }
            setSchemasMap(map);
          }
        })
        .catch((err) => setError(`フォームスキーマの取得に失敗しました: ${err.message || 'ネットワークエラー'}`));

      api.getApplicationTypes()
        .then((res) => {
          setTypes(res.types);
          if (res.types.length > 0) {
            const initialType = initialData ? res.types.find(t => t.id === initialData.typeId) || res.types[0] : res.types[0];
            setSelectedTypeId(initialType.id);
            setSelectedCategoryId(initialType.categoryId || '');
            if (!initialData) {
              setTitle(generateDefaultTitle(initialType.id));
            }
          }
        })
        .catch((err) => setError(err.message));

      api.getPolicyRules()
        .then((res) => setPolicyRules(res.policyRules || []))
        .catch(() => {});

      api.getSpecialLeavePolicies()
        .then((res) => {
          setSpecialLeavePolicies(res.policies || []);
          if (res.policies && res.policies.length > 0) {
            setSelectedSpecialReasonCode(res.policies[0].reasonCode);
          }
        })
        .catch(() => {});

      api.getMembers()
        .then((res) => setMembers(res.members))
        .catch(() => {});

      api.getLeaveSummary()
        .then((res) => setSummary(res.summary))
        .catch(() => setSummary(null));

      api.getCareCases()
        .then((res) => {
          setCareCases(res.cases || []);
          if (res.cases && res.cases.length > 0) {
            setSelectedCareCaseId(res.cases[0].id);
            if (res.cases[0].periods && res.cases[0].periods.length > 0) {
              setSelectedCarePeriodId(res.cases[0].periods[0].id);
            }
          }
        })
        .catch(() => {});

      if (initialData) {
        setSelectedTypeId(initialData.typeId);
        setTitle(initialData.title || '');
        if (initialData.isProxy && initialData.subjectUserId) {
          setIsProxyMode(true);
          setTargetSubjectId(initialData.subjectUserId);
          setProxyReason(initialData.proxyReason || '');
        }
        const fd = initialData.formData || {};
        if (fd.unitType) setUnitType(fd.unitType);
        if (fd.halfDayType) setHalfDayType(fd.halfDayType);
        if (fd.startDate) setStartDate(fd.startDate);
        if (fd.endDate) setEndDate(fd.endDate);
        if (fd.targetDate) setTargetDate(fd.targetDate);
        if (fd.startTime) setStartTime(fd.startTime);
        if (fd.endTime) setEndTime(fd.endTime);
        if (fd.calculatedDays) setCalculatedDays(fd.calculatedDays);
        if (fd.reasonCode) setSelectedSpecialReasonCode(fd.reasonCode);
        if (fd.careCaseId) setSelectedCareCaseId(fd.careCaseId);
        if (fd.carePeriodId) setSelectedCarePeriodId(fd.carePeriodId);
        if (fd.destination) setDestination(fd.destination);
        if (fd.departurePlace) setDeparturePlace(fd.departurePlace);
        if (fd.arrivalPlace) setArrivalPlace(fd.arrivalPlace);
        if (fd.transport) setTransport(fd.transport);
        if (fd.transportOther) setTransportOther(fd.transportOther);
        if (fd.privateCarReason) setPrivateCarReason(fd.privateCarReason);
        if (fd.fundingSource) setFundingSource(fd.fundingSource);
        if (fd.fundingSourceOther) setFundingSourceOther(fd.fundingSourceOther);
        if (fd.isExpenseClaimed !== undefined) setIsExpenseClaimed(fd.isExpenseClaimed);
        if (fd.isOralOrder !== undefined) setIsOralOrder(Boolean(fd.isOralOrder));
        if (fd.oralOrderIssuedAt) setOralOrderIssuedAt(fd.oralOrderIssuedAt);
        if (fd.organizer) setOrganizer(fd.organizer);
        if (fd.venue) setVenue(fd.venue);
        if (fd.relationship) setRelationship(fd.relationship);
        if (fd.childBirthExpectedDate) setChildBirthExpectedDate(fd.childBirthExpectedDate);
        if (fd.medicalCertificateAttached !== undefined) setMedicalCertificateAttached(fd.medicalCertificateAttached);
        if (fd.medicalInstitutionName) setMedicalInstitutionName(fd.medicalInstitutionName);
        if (fd.patternType) setPatternType(fd.patternType);
        if (fd.reason || fd.purpose) setReason(fd.reason || fd.purpose);
        if (fd.substituteTeacher) setSubstituteTeacher(fd.substituteTeacher);
        if (fd.coverageStatus) setCoverageStatus(fd.coverageStatus);
        if (fd.notRequiredReason) setNotRequiredReason(fd.notRequiredReason);
        if (Array.isArray(fd.coverageItems)) setCoverageItems(fd.coverageItems);
      } else {
        setCoverageStatus('');
        setNotRequiredReason('');
        setCoverageItems([]);
      }
    }
  }, [isOpen, currentUser, initialData]);

  // 代理申請対象者変更時にその対象者の休暇サマリー・介護ケースを取得
  useEffect(() => {
    const targetId = isProxyMode && targetSubjectId ? Number(targetSubjectId) : undefined;
    api.getLeaveSummary(targetId)
      .then((res) => setSummary(res.summary))
      .catch(() => setSummary(null));

    api.getCareCases(targetId)
      .then((res) => {
        setCareCases(res.cases || []);
        if (res.cases && res.cases.length > 0) {
          setSelectedCareCaseId(res.cases[0].id);
          if (res.cases[0].periods && res.cases[0].periods.length > 0) {
            setSelectedCarePeriodId(res.cases[0].periods[0].id);
          } else {
            setSelectedCarePeriodId('');
          }
        } else {
          setSelectedCareCaseId('');
          setSelectedCarePeriodId('');
        }
      })
      .catch(() => {});
  }, [isProxyMode, targetSubjectId]);

  // 暦日数（カレンダースパン）計算
  const [calendarSpanDays, setCalendarSpanDays] = useState(1);
  useEffect(() => {
    if (unitType === 'DAY') {
      const s = new Date(startDate);
      const e = new Date(endDate);
      if (e >= s) {
        const diffDays = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        setCalendarSpanDays(diffDays);
        setCalculatedDays(diffDays);
      } else {
        setCalendarSpanDays(0);
        setCalculatedDays(0);
      }
    }
  }, [startDate, endDate, unitType]);

  const [calculationPreview, setCalculationPreview] = useState<any>(null);
  const [calculationError, setCalculationError] = useState<string>('');

  // リアルタイム計算プレビュー (Server-Authoritative API 連携)
  useEffect(() => {
    let active = true;
    setCalculationError('');

    if (['LEAVE_ANNUAL', 'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT', 'TRAINING_SPECIAL_ACT_22_2'].includes(selectedTypeId)) {
      const targetSubId = isProxyMode && targetSubjectId ? Number(targetSubjectId) : undefined;
      const isDay = unitType === 'DAY';
      const sDate = isDay ? startDate : targetDate;
      const eDate = isDay ? endDate : targetDate;

      // 入力条件ガード: 期間が不完全または終了日が開始日より前の場合はスキップ
      if (!sDate || !eDate || (isDay && eDate < sDate)) {
        setCalculationPreview(null);
        setCalculatedHoursText('');
        return;
      }
      
      api.previewLeaveCalculation({
        typeId: selectedTypeId,
        targetDate: sDate,
        startDate: sDate,
        endDate: eDate,
        unitType: unitType as any,
        halfDayType: unitType === 'HALF_DAY' ? (halfDayType as any) : undefined,
        startTime: unitType === 'TIME' ? startTime : undefined,
        endTime: unitType === 'TIME' ? endTime : undefined,
        calculatedDays: unitType === 'DAY' ? calculatedDays : undefined,
        reasonCode: selectedTypeId === 'LEAVE_SPECIAL' ? selectedSpecialReasonCode : undefined,
        subjectUserId: targetSubId
      })
        .then((res) => {
          if (!active) return;
          if (res.success && res.calculation) {
            setCalculationPreview(res.calculation);
            if (res.calculation.totalChargedDays !== undefined && (unitType === 'DAY' || unitType === 'HALF_DAY')) {
              setCalculatedDays(res.calculation.totalChargedDays);
            }
            if (res.calculation.detailsText) {
              setCalculatedHoursText(res.calculation.detailsText);
            }
          }
        })
        .catch((err) => {
          if (!active) return;
          setCalculationPreview(null);
          setCalculationError(err.message || '計算プレビュー取得エラー');
          setCalculatedHoursText('');
        });
    } else {
      setCalculationPreview(null);
      setCalculatedHoursText('');
    }

    return () => {
      active = false;
    };
  }, [
    selectedTypeId,
    unitType,
    halfDayType,
    startDate,
    endDate,
    targetDate,
    startTime,
    endTime,
    calculatedDays,
    selectedSpecialReasonCode,
    isProxyMode,
    targetSubjectId
  ]);

  // 申請種別変更時の件名自動補完 & Default Reset
  const handleTypeChange = (typeId: string) => {
    setSelectedTypeId(typeId);

    // 1. 件名初期化 (User Override Preservation: ユーザーが手動編集していない場合のみ再生成)
    if (isSystemGeneratedTitle(title)) {
      setTitle(generateDefaultTitle(typeId));
    }

    // 2. Default Reset Algorithm: Form Schema の defaultValue を抽出し適用 (Client勝手なデフォルト注入を完全排除)
    const targetSchema = schemasMap.get(typeId);
    const schemaDefaults = new Map<string, any>();
    if (targetSchema) {
      for (const sec of targetSchema.sections || []) {
        for (const f of sec.fields || []) {
          if (f.defaultValue !== undefined) {
            schemaDefaults.set(f.name, f.defaultValue);
          }
        }
      }
    }

    // 各状態変数を schemaDefaults に従ってリセット
    setUnitType(schemaDefaults.get('unitType') || 'DAY');
    setHalfDayType(schemaDefaults.get('halfDayType') || 'MORNING');
    setCalculatedDays(schemaDefaults.get('calculatedDays') !== undefined ? schemaDefaults.get('calculatedDays') : 1);
    setStartDate(new Date().toISOString().split('T')[0]);
    setEndDate(new Date().toISOString().split('T')[0]);
    setTargetDate(new Date().toISOString().split('T')[0]);
    setStartTime(schemaDefaults.get('startTime') || '08:10');
    setEndTime(schemaDefaults.get('endTime') || '12:00');
    setReason('');
    setDestination('');
    setDeparturePlace('本校');
    setArrivalPlace('本校');
    setTransport(schemaDefaults.get('transport') || '公用車');
    setTransportOther('');
    setPrivateCarReason('');
    setFundingSource(schemaDefaults.get('fundingSource') || '県費');
    setFundingSourceOther('');
    setIsExpenseClaimed(Boolean(schemaDefaults.get('isExpenseClaimed')));
    setIsOralOrder(Boolean(schemaDefaults.get('isOralOrder')));
    setOralOrderIssuedAt('');
    setOrganizer('');
    setVenue('');
    setRelationship('');
    setChildBirthExpectedDate('');
    setMedicalCertificateAttached(false);
    setMedicalInstitutionName('');
    setPatternType('');
    setSubstituteTeacher('');

    // GAP-09 Class Coverage Reset (capability に応じて初期化)
    if (targetSchema?.capabilities?.classCoverageApplicable) {
      setCoverageStatus(schemaDefaults.get('coverageStatus') || 'NOT_REQUIRED');
    } else {
      setCoverageStatus('');
    }
    setNotRequiredReason('');
    setCoverageItems([]);
  };

  if (!isOpen) return null;

  const buildFormData = () => {
    if (!activeSchema) {
      throw new PayloadProjectionError(
        'SCHEMA_REQUIRED',
        undefined,
        `申請種別 "${selectedTypeId}" の Active Form Schema が取得できません。安全のため処理を中断します。`
      );
    }

    const state: TypedApplicationFormState = {
      typeId: selectedTypeId,
      title,
      genericValues: {
        unitType,
        halfDayType: unitType === 'HALF_DAY' ? halfDayType : undefined,
        startDate,
        endDate,
        targetDate,
        startTime: selectedTypeId === 'BUSINESS_TRIP' ? undefined : startTime,
        endTime: selectedTypeId === 'BUSINESS_TRIP' ? undefined : endTime,
        calculatedDays,
        selectedSpecialReasonCode,
        specialReasonCode: selectedSpecialReasonCode,
        reasonCode: selectedSpecialReasonCode,
        relationship,
        childBirthExpectedDate,
        medicalCertificateAttached,
        medicalInstitutionName,
        reason,
        organizer,
        venue,
        destination,
        substituteTeacher,
        patternType,
      },
      tripState: {
        destination,
        purpose: reason,
        startDate,
        endDate,
        departurePlace,
        arrivalPlace,
        transport,
        transportOther: transport === 'その他' ? transportOther : undefined,
        privateCarReason: transport === '自家用車' ? privateCarReason : undefined,
        fundingSource,
        fundingSourceOther: fundingSource === 'その他' ? fundingSourceOther : undefined,
        isExpenseClaimed,
        isOralOrder,
        oralOrderIssuedAt: (isOralOrder && oralOrderIssuedAt) ? oralOrderIssuedAt : undefined,
      },
      careState: {
        careCaseId: selectedCareCaseId || undefined,
        carePeriodId: selectedCarePeriodId || undefined,
      },
      coverageState: {
        coverageStatus: coverageStatus || '',
        notRequiredReason: coverageStatus === 'NOT_REQUIRED' ? notRequiredReason : undefined,
        coverageItems: coverageStatus === 'REQUIRED' ? coverageItems : [],
      },
      isProxy: isProxyMode,
      subjectUserId: targetSubjectId,
      proxyReason,
      isBatchTrip: false,
      participantUserIds: [],
    };

    const rawWorkingState = assembleWorkingStateForProjection(state);
    return projectApplicationFormDataBySchema(rawWorkingState, activeSchema);
  };

  const handleSaveDraft = async () => {
    if (!title.trim()) {
      setError('件名を入力してください');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await api.saveDraft({
        id: effectiveMode === 'EDIT_DRAFT' && initialData ? initialData.id : undefined,
        expectedVersion: effectiveMode === 'EDIT_DRAFT' && initialData ? initialData.version : undefined,
        typeId: selectedTypeId,
        title,
        formData: buildFormData(),
        subjectUserId: isProxyMode && targetSubjectId ? Number(targetSubjectId) : undefined,
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('件名を入力してください');
      return;
    }
    if (isProxyMode && !targetSubjectId) {
      setError('代理申請の対象教職員を選択してください');
      return;
    }
    if (['LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT', 'TRAINING_SPECIAL_ACT_22_2', 'TRAINING_SPECIAL_ACT_22_3'].includes(selectedTypeId) && !reason.trim()) {
      setError('理由・研究題目の記入は必須です');
      return;
    }
    if (selectedTypeId === 'BUSINESS_TRIP' && !destination.trim()) {
      setError('出張先・用務場所を入力してください');
      return;
    }
    if (selectedTypeId === 'BUSINESS_TRIP' && isOralOrder && !oralOrderIssuedAt) {
      setError('口頭発令年月日を入力してください');
      return;
    }
    if (selectedTypeId.startsWith('TRAINING_') && !destination.trim()) {
      setError('研修場所（学校以外の場所／研究機関等）を入力してください');
      return;
    }

    setError('');
    setLoading(true);

    try {
      if (effectiveMode === 'RESUBMIT' && initialData) {
        await api.resubmitApplication(initialData.id, {
          expectedVersion: initialData.version,
          title,
          formData: buildFormData(),
        });
      } else if (isProxyMode && targetSubjectId) {
        await api.submitProxyApplication({
          id: effectiveMode === 'EDIT_DRAFT' && initialData ? initialData.id : undefined,
          expectedVersion: effectiveMode === 'EDIT_DRAFT' && initialData ? initialData.version : undefined,
          typeId: selectedTypeId,
          subjectUserId: Number(targetSubjectId),
          title,
          formData: buildFormData(),
          proxyReason,
        });
      } else {
        await api.submitApplication({
          id: effectiveMode === 'EDIT_DRAFT' && initialData ? initialData.id : undefined,
          expectedVersion: effectiveMode === 'EDIT_DRAFT' && initialData ? initialData.version : undefined,
          typeId: selectedTypeId,
          title,
          formData: buildFormData(),
        });
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]">
        {/* ヘッダー */}
        <div className="px-6 py-4 bg-slate-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-bold">
              {effectiveMode === 'RESUBMIT'
                ? '差戻し申請の修正・再提出'
                : effectiveMode === 'EDIT_DRAFT'
                ? '下書き申請の編集・決裁ルートへ提出'
                : '新規業務・休暇・研修申請の作成'}
            </h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* フォーム本体 */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}


          {/* 申請モード (本人 vs 代理) */}
          {canProxy && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-slate-700 font-medium">
                <Users className="w-4 h-4 text-indigo-600" />
                <span>申請モード:</span>
                <span className={isProxyMode ? 'text-amber-700 font-bold' : 'text-slate-900'}>
                  {isProxyMode ? '代理申請モード (管理職等代行)' : '本人申請モード'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsProxyMode(!isProxyMode);
                  if (isProxyMode) setTargetSubjectId('');
                }}
                className="text-xs px-2.5 py-1 bg-white border border-slate-300 rounded shadow-sm hover:bg-slate-50 text-slate-700 font-medium transition"
              >
                {isProxyMode ? '本人申請に戻す' : '代理申請に切替'}
              </button>
            </div>
          )}

          {/* 代理申請対象者選択 */}
          {isProxyMode && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
              <div>
                <label className="block text-xs font-bold text-amber-900 mb-1">
                  代理申請の対象教職員 (Subject) <span className="text-red-500">*</span>
                </label>
                <select
                  value={targetSubjectId}
                  onChange={(e) => setTargetSubjectId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full text-sm border-amber-300 rounded-md shadow-sm focus:border-amber-500 focus:ring-amber-500 bg-white"
                >
                  <option value="">対象教職員を選択してください</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ({m.department})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-amber-900 mb-1">代理起案の理由・経緯</label>
                <input
                  type="text"
                  value={proxyReason}
                  onChange={(e) => setProxyReason(e.target.value)}
                  placeholder="例: 本人病気療養のため教頭代行起案、出張先からの電話依頼代行"
                  className="w-full text-sm border-amber-300 rounded-md shadow-sm focus:border-amber-500 focus:ring-amber-500 bg-white"
                />
              </div>
            </div>
          )}

          {/* 二段階申請種別選択 (Two-Step Selection UI: Step 1 Category -> Step 2 Type) */}
          <div className="space-y-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            {/* Step 1: 申請カテゴリ選択 (Server DTO Projection) */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">1</span>
                <span>申請分類 (カテゴリ) を選択</span>
              </label>
              {(() => {
                // Server DTO に含まれるカテゴリ一覧を一意に抽出・表示順ソート
                const categoriesMap = new Map<string, { id: string; name: string; description: string; order: number }>();
                for (const t of types) {
                  if (t.categoryId && !categoriesMap.has(t.categoryId)) {
                    categoriesMap.set(t.categoryId, {
                      id: t.categoryId,
                      name: t.categoryName || t.categoryId,
                      description: t.categoryDescription || '',
                      order: t.categoryOrder || 99,
                    });
                  }
                }
                const categories = Array.from(categoriesMap.values()).sort((a, b) => a.order - b.order);

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {categories.map((cat) => {
                      const isSelected = selectedCategoryId === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => {
                            setSelectedCategoryId(cat.id);
                            // 選択カテゴリに属する最初の種別を自動選択
                            const firstType = types.find((t) => t.categoryId === cat.id);
                            if (firstType) {
                              handleTypeChange(firstType.id);
                            }
                          }}
                          className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                            isSelected
                              ? 'bg-indigo-50 border-indigo-500 ring-2 ring-indigo-200 shadow-sm'
                              : 'bg-white border-slate-300 hover:bg-slate-100/80 text-slate-700'
                          }`}
                        >
                          <div className={`font-bold text-xs ${isSelected ? 'text-indigo-900' : 'text-slate-800'}`}>
                            {cat.name}
                          </div>
                          {cat.description && (
                            <div className="text-[10px] text-slate-500 mt-1 line-clamp-1">
                              {cat.description}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Step 2: 選択カテゴリに属する申請種別の選択 */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">2</span>
                <span>申請種別を選択 <span className="text-red-500">*</span></span>
              </label>
              {(() => {
                const filteredTypes = selectedCategoryId
                  ? types.filter((t) => t.categoryId === selectedCategoryId)
                  : types;

                return (
                  <select
                    value={selectedTypeId}
                    onChange={(e) => handleTypeChange(e.target.value)}
                    className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500 font-medium bg-white"
                  >
                    {filteredTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                );
              })()}
            </div>
          </div>

          {/* 未確認ポリシー警告 */}
          {isTrainingUnconfirmed && (
            <div className="p-3 bg-amber-50 border border-amber-300 text-amber-900 text-xs rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span>
                【制度未確定】当該自治体の研修制度ポリシー（規程・出勤簿記載要領）が未確定のため、本番提出時は安全停止（Fail-Closed）されます。
              </span>
            </div>
          )}

          {/* 休暇残数サマリー表示 */}
          {['LEAVE_ANNUAL', 'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT'].includes(selectedTypeId) && summary && (
            <LeaveSummaryWidget summary={summary} compact={true} />
          )}

          {/* 件名 */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              件名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: 【年休】午前半日年休 / 【校外研修】教特法第22条第2項 / 【出張】地区研究協議会"
              className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          {/* Schema-Driven Form Renderer (Step 4: Orchestrated Unified Rendering) */}
          {activeSchema ? (
            <SchemaFormRenderer
              schema={activeSchema}
              state={{
                typeId: selectedTypeId,
                title,
                genericValues: {
                  unitType,
                  halfDayType: unitType === 'HALF_DAY' ? halfDayType : undefined,
                  startDate,
                  endDate,
                  targetDate,
                  startTime,
                  endTime,
                  calculatedDays,
                  selectedSpecialReasonCode,
                  specialReasonCode: selectedSpecialReasonCode,
                  reasonCode: selectedSpecialReasonCode,
                  relationship,
                  childBirthExpectedDate,
                  medicalCertificateAttached,
                  medicalInstitutionName,
                  reason,
                  purpose: reason,
                  organizer,
                  venue,
                  destination,
                  substituteTeacher,
                  patternType,
                },
                tripState: {
                  destination,
                  purpose: reason,
                  startDate,
                  endDate,
                  departurePlace,
                  arrivalPlace,
                  transport,
                  transportOther: transport === 'その他' ? transportOther : undefined,
                  privateCarReason: transport === '自家用車' ? privateCarReason : undefined,
                  fundingSource,
                  fundingSourceOther: fundingSource === 'その他' ? fundingSourceOther : undefined,
                  isExpenseClaimed,
                  isOralOrder,
                  oralOrderIssuedAt: (isOralOrder && oralOrderIssuedAt) ? oralOrderIssuedAt : undefined,
                },
                careState: {
                  careCaseId: selectedCareCaseId || undefined,
                  carePeriodId: selectedCarePeriodId || undefined,
                },
                coverageState: {
                  coverageStatus: coverageStatus || '',
                  notRequiredReason: coverageStatus === 'NOT_REQUIRED' ? notRequiredReason : undefined,
                  coverageItems: coverageStatus === 'REQUIRED' ? coverageItems : [],
                },
                isProxy: isProxyMode,
                subjectUserId: targetSubjectId,
                proxyReason,
                isBatchTrip: false,
                participantUserIds: [],
              }}
              onUpdateGeneric={(name, value) => {
                switch (name) {
                  case 'unitType':
                    setUnitType(value);
                    break;
                  case 'halfDayType':
                    setHalfDayType(value);
                    break;
                  case 'startDate':
                    setStartDate(value);
                    break;
                  case 'endDate':
                    setEndDate(value);
                    break;
                  case 'targetDate':
                    setTargetDate(value);
                    break;
                  case 'startTime':
                    setStartTime(value);
                    break;
                  case 'endTime':
                    setEndTime(value);
                    break;
                  case 'calculatedDays':
                    setCalculatedDays(value);
                    break;
                  case 'reasonCode':
                  case 'specialReasonCode':
                  case 'selectedSpecialReasonCode':
                    setSelectedSpecialReasonCode(value);
                    break;
                  case 'relationship':
                    setRelationship(value);
                    break;
                  case 'childBirthExpectedDate':
                    setChildBirthExpectedDate(value);
                    break;
                  case 'medicalCertificateAttached':
                    setMedicalCertificateAttached(Boolean(value));
                    break;
                  case 'medicalInstitutionName':
                    setMedicalInstitutionName(value);
                    break;
                  case 'reason':
                  case 'purpose':
                    setReason(value);
                    break;
                  case 'organizer':
                    setOrganizer(value);
                    break;
                  case 'venue':
                    setVenue(value);
                    break;
                  case 'destination':
                    setDestination(value);
                    break;
                  case 'substituteTeacher':
                    setSubstituteTeacher(value);
                    break;
                  case 'patternType':
                    setPatternType(value);
                    break;
                  default:
                    break;
                }
              }}
              onUpdateTrip={(updater) => {
                const current = {
                  destination,
                  purpose: reason,
                  startDate,
                  endDate,
                  departurePlace,
                  arrivalPlace,
                  transport,
                  transportOther,
                  privateCarReason,
                  fundingSource,
                  fundingSourceOther,
                  isExpenseClaimed,
                  isOralOrder,
                  oralOrderIssuedAt,
                };
                const next = typeof updater === 'function' ? updater(current) : updater;
                if (next.destination !== undefined && next.destination !== current.destination) setDestination(next.destination);
                if (next.purpose !== undefined && next.purpose !== current.purpose) setReason(next.purpose);
                if (next.startDate !== undefined && next.startDate !== current.startDate) setStartDate(next.startDate);
                if (next.endDate !== undefined && next.endDate !== current.endDate) setEndDate(next.endDate);
                if (next.departurePlace !== undefined && next.departurePlace !== current.departurePlace) setDeparturePlace(next.departurePlace);
                if (next.arrivalPlace !== undefined && next.arrivalPlace !== current.arrivalPlace) setArrivalPlace(next.arrivalPlace);
                if (next.transport !== undefined && next.transport !== current.transport) setTransport(next.transport);
                if (next.transportOther !== undefined && next.transportOther !== current.transportOther) setTransportOther(next.transportOther);
                if (next.privateCarReason !== undefined && next.privateCarReason !== current.privateCarReason) setPrivateCarReason(next.privateCarReason);
                if (next.fundingSource !== undefined && next.fundingSource !== current.fundingSource) setFundingSource(next.fundingSource);
                if (next.fundingSourceOther !== undefined && next.fundingSourceOther !== current.fundingSourceOther) setFundingSourceOther(next.fundingSourceOther);
                if (next.isExpenseClaimed !== undefined && next.isExpenseClaimed !== current.isExpenseClaimed) setIsExpenseClaimed(next.isExpenseClaimed);
                if (next.isOralOrder !== undefined && next.isOralOrder !== current.isOralOrder) setIsOralOrder(next.isOralOrder);
                if (next.oralOrderIssuedAt !== undefined && next.oralOrderIssuedAt !== current.oralOrderIssuedAt) setOralOrderIssuedAt(next.oralOrderIssuedAt);
              }}
              onUpdateCare={(updater) => {
                const current = {
                  careCaseId: selectedCareCaseId,
                  carePeriodId: selectedCarePeriodId,
                };
                const next = typeof updater === 'function' ? updater(current) : updater;
                if (next.careCaseId !== undefined) setSelectedCareCaseId(next.careCaseId);
                if (next.carePeriodId !== undefined) setSelectedCarePeriodId(next.carePeriodId);
              }}
              onUpdateCoverage={(updater) => {
                const current = {
                  coverageStatus,
                  notRequiredReason,
                  coverageItems,
                };
                const next = typeof updater === 'function' ? updater(current) : updater;
                if (next.coverageStatus !== undefined) setCoverageStatus(next.coverageStatus);
                if (next.notRequiredReason !== undefined) setNotRequiredReason(next.notRequiredReason);
                if (next.coverageItems !== undefined) setCoverageItems(next.coverageItems);
              }}
              careCases={careCases}
              carePeriods={careCases.find((c) => c.id === Number(selectedCareCaseId))?.periods || []}
              members={members}
              onOpenCareCaseModal={() => setIsCareCaseModalOpen(true)}
              onOpenCarePeriodModal={() => setIsCarePeriodModalOpen(true)}
            />
          ) : (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              フォーム定義を読み込み中、または定義が存在しません。
            </div>
          )}

          {/* リアルタイム計算プレビュー (DAY / TIME) */}
          {['LEAVE_ANNUAL', 'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT', 'TRAINING_SPECIAL_ACT_22_2'].includes(selectedTypeId) && (
            <div>
              {calculationError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                    <span>申請期間バリデーション: {calculationError}</span>
                  </div>
                  <p className="text-[11px] text-rose-600 pl-5.5">
                    ※ 申請内容または期間を修正してください。
                  </p>
                </div>
              )}

              {!calculationError && calculationPreview && (
                <div className="p-3 bg-indigo-50/70 border border-indigo-200 rounded-lg text-xs text-indigo-900 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-bold">
                      <Calendar className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                      <span>
                        申請期間: {unitType === 'DAY' ? `${startDate} 〜 ${endDate} (${calendarSpanDays}暦日)` : targetDate}
                      </span>
                    </div>
                    {calculationPreview.totalChargedDays !== undefined && unitType === 'DAY' && (
                      <span className="px-2 py-0.5 rounded bg-indigo-200/70 text-indigo-950 font-bold text-xs">
                        年休消費予定: {calculationPreview.totalChargedDays}日
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-indigo-800 space-y-0.5 border-t border-indigo-200/60 pt-1.5">
                    {calculationPreview.chargeableDaysCount !== undefined && calculationPreview.skippedNonWorkingDaysCount !== undefined && (
                      <p>
                        ・勤務義務日: <strong>{calculationPreview.chargeableDaysCount}日</strong> / 週休日・祝日等除外: <strong>{calculationPreview.skippedNonWorkingDaysCount}日</strong>
                      </p>
                    )}
                    {calculationPreview.detailsText && (
                      <p className="text-slate-600">
                        ・算定内訳: {calculationPreview.detailsText}
                      </p>
                    )}
                    {calculationPreview.currentRemainingDays !== undefined && (
                      <p className="text-slate-600">
                        ・現在残数: {calculationPreview.currentRemainingDays}日
                        {calculationPreview.totalChargedDays !== undefined && (
                          <span> ➔ 申請後推定残数: <strong>{Math.max(0, calculationPreview.currentRemainingDays - calculationPreview.totalChargedDays)}日</strong></span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="px-6 py-3.5 bg-slate-100 border-t border-slate-200 flex items-center justify-between">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={loading}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 flex items-center gap-1.5 transition shadow-sm"
          >
            <Save className="w-4 h-4 text-slate-500" />
            <span>下書き保存</span>
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 transition"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 transition shadow-sm"
            >
              <Send className="w-4 h-4" />
              <span>{isProxyMode ? '代理申請を提出' : '申請を提出'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 介護ケース登録モーダル */}
      <CareCaseModal
        isOpen={isCareCaseModalOpen}
        targetUserId={isProxyMode && targetSubjectId ? Number(targetSubjectId) : undefined}
        onClose={() => setIsCareCaseModalOpen(false)}
        onSuccess={(newCaseId, newPeriodId) => {
          const targetId = isProxyMode && targetSubjectId ? Number(targetSubjectId) : undefined;
          api.getCareCases(targetId).then((res) => {
            setCareCases(res.cases || []);
            setSelectedCareCaseId(newCaseId);
            if (newPeriodId) {
              setSelectedCarePeriodId(newPeriodId);
            }
          });
        }}
      />

      {/* 指定期間追加モーダル */}
      {selectedCareCaseId && (
        <CarePeriodModal
          isOpen={isCarePeriodModalOpen}
          caseId={Number(selectedCareCaseId)}
          caseInfoText={(() => {
            const c = careCases.find((x) => x.id === Number(selectedCareCaseId));
            return c ? `${c.recipient_relation}: ${c.recipient_name} (${c.condition_summary})` : '';
          })()}
          onClose={() => setIsCarePeriodModalOpen(false)}
          onSuccess={(newPeriodId) => {
            const targetId = isProxyMode && targetSubjectId ? Number(targetSubjectId) : undefined;
            api.getCareCases(targetId).then((res) => {
              setCareCases(res.cases || []);
              setSelectedCarePeriodId(newPeriodId);
            });
          }}
        />
      )}
    </div>
  );
};
