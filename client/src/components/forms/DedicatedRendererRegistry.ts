import React from 'react';
import { TypedApplicationFormState } from '../../types/formState';
import { FormSectionDefinition } from '../../types/formSchema';
import { BusinessTripFormSection } from './BusinessTripFormSection';
import { CareFormSection } from './CareFormSection';
import { ClassCoverageFormSection } from './ClassCoverageFormSection';

export class UnsupportedDedicatedRendererError extends Error {
  public sectionId: string;

  constructor(sectionId: string) {
    super(`[UnsupportedDedicatedRendererError] Dedicated section "${sectionId}" is required by schema contract but no renderer is registered.`);
    this.name = 'UnsupportedDedicatedRendererError';
    this.sectionId = sectionId;
  }
}

export interface DedicatedSectionProps {
  section: FormSectionDefinition;
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

export type DedicatedSectionRenderer = React.FC<DedicatedSectionProps>;

/**
 * Dedicated Renderer Registry (Presentation Boundary SSOT)
 */
export const DEDICATED_RENDERER_REGISTRY: Record<string, DedicatedSectionRenderer> = {
  trip_details: ({ state, onUpdateTrip, disabled }) => {
    const trip = state.tripState || {
      destination: '',
      purpose: '',
      startDate: '',
      endDate: '',
      transport: '公用車',
      transportOther: '',
      departurePlace: '本校',
      arrivalPlace: '本校',
      fundingSource: '県費',
      fundingSourceOther: '',
      isOralOrder: false,
      oralOrderIssuedAt: '',
    };
    return React.createElement(BusinessTripFormSection, {
      destination: trip.destination,
      setDestination: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, destination: val })),
      purpose: trip.purpose || '',
      setPurpose: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, purpose: val })),
      startDate: trip.startDate || '',
      setStartDate: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, startDate: val })),
      endDate: trip.endDate || '',
      setEndDate: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, endDate: val })),
      transport: trip.transport,
      setTransport: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, transport: val })),
      transportOther: trip.transportOther || '',
      setTransportOther: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, transportOther: val })),
      departurePlace: trip.departurePlace,
      setDeparturePlace: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, departurePlace: val })),
      arrivalPlace: trip.arrivalPlace,
      setArrivalPlace: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, arrivalPlace: val })),
      fundingSource: trip.fundingSource || '県費',
      setFundingSource: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, fundingSource: val })),
      fundingSourceOther: trip.fundingSourceOther || '',
      setFundingSourceOther: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, fundingSourceOther: val })),
      isOralOrder: trip.isOralOrder,
      setIsOralOrder: (val: boolean) => onUpdateTrip((prev: any) => ({ ...prev, isOralOrder: val })),
      oralOrderIssuedAt: trip.oralOrderIssuedAt || '',
      setOralOrderIssuedAt: (val: string) => onUpdateTrip((prev: any) => ({ ...prev, oralOrderIssuedAt: val })),
    });
  },

  care_details: ({ state, onUpdateCare, careCases, carePeriods, onOpenCareCaseModal, onOpenCarePeriodModal, disabled }) => {
    const care = state.careState || { careCaseId: '', carePeriodId: '' };
    return React.createElement(CareFormSection, {
      sectionId: 'care_details',
      state: care,
      onChange: onUpdateCare,
      careCases,
      carePeriods,
      onOpenCareCaseModal,
      onOpenCarePeriodModal,
      disabled,
    });
  },

  class_coverage: ({ state, onUpdateCoverage, members, disabled }) => {
    const cov = state.coverageState || { coverageStatus: '', coverageItems: [] };
    return React.createElement(ClassCoverageFormSection, {
      sectionId: 'class_coverage',
      state: cov,
      onChange: onUpdateCoverage,
      members,
      disabled,
    });
  },
};
