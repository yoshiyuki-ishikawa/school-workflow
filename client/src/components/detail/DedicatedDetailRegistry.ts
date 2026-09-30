import React from 'react';
import { FormSectionDefinition } from '../../types/formSchema';
import { BusinessTripDetailView } from './views/BusinessTripDetailView';
import { CareDetailView } from './views/CareDetailView';
import { ClassCoverageDetailSection } from './views/ClassCoverageDetailSection';

export interface DedicatedDetailSectionProps {
  section: FormSectionDefinition;
  formData: Record<string, any>;
  canResolveCoverage?: boolean;
  onOpenCoverageModal?: () => void;
  careCases?: any[];
  carePeriods?: any[];
}

export type DedicatedDetailRenderer = React.FC<DedicatedDetailSectionProps>;

export interface DedicatedDetailRegistration {
  renderer: DedicatedDetailRenderer;
  consumedKeys: string[];
}

/**
 * DEDICATED_DETAIL_REGISTRY
 * 
 * Phase C: Read-Only Detail View 専用の Dedicated Section Registry。
 * 
 * 【Architecture Invariant】
 * 1. Read-Only Pure Presentation: Phase B 入力用 Registry と完全分離。
 * 2. Explicit Consumed Keys Contract: 各ドメインレンダラーが消費するキーを明示し、
 *    computeResidualFacts と同期して SILENT DROP = 0 および二重表示（Duplicate）を防止。
 */
export const DEDICATED_DETAIL_REGISTRY: Record<string, DedicatedDetailRegistration> = {
  trip_details: {
    consumedKeys: [
      'destination',
      'venue',
      'transport',
      'transportationMethod',
      'departurePlace',
      'arrivalPlace',
      'privateCarReason',
      'isExpenseClaimed',
      'isOralOrder',
      'oralOrderIssuedAt',
      'startDate',
      'targetDate',
      'endDate',
      'calculatedDays',
      'reportDate',
      'reportResult',
      'reportRemarks',
      'actualMatchesPlan',
      'actualDeparturePlace',
      'actualArrivalPlace',
      'actualTransportMode',
      'vehicleUsageType',
      'actualDistanceKm',
      'communicationCostBorne',
      'actualTripStartAt',
      'actualTripEndAt',
      'travelExpenseRemarks',
    ],
    renderer: ({ formData }) => React.createElement(BusinessTripDetailView, { formData }),
  },

  care_details: {
    consumedKeys: [
      'careCaseId',
      'selectedCareCaseId',
      'carePeriodId',
      'selectedCarePeriodId',
      'careRecipientRelation',
      'careRecipientName',
      'careConditionSummary',
    ],
    renderer: ({ formData, careCases, carePeriods }) =>
      React.createElement(CareDetailView, { formData, careCases, carePeriods }),
  },

  class_coverage: {
    consumedKeys: [
      'coverageStatus',
      'notRequiredReason',
      'coverageItems',
      'substituteTeacher',
    ],
    renderer: ({ formData, canResolveCoverage, onOpenCoverageModal }) =>
      React.createElement(ClassCoverageDetailSection, {
        formData,
        canResolveCoverage,
        onOpenCoverageModal,
      }),
  },
};
