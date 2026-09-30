import { ClassCoverageItem, ClassCoverageStatus } from './formSchema';

/**
 * 1. プリミティブおよび構造化値の Union (Projection Input Value)
 */
export type ProjectionInputValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[]
  | number[]
  | ClassCoverageItem[];

/**
 * 2. 型安全な Projection Input Map
 */
export type TypedProjectionInput = Record<string, ProjectionInputValue>;

/**
 * 3. 汎用標準項目ステート
 */
export type GenericFieldValues = Record<string, string | number | boolean | null | undefined>;

/**
 * 4. ドメイン専用サブステート群
 */
export interface BusinessTripDomainState {
  destination: string;
  purpose?: string;
  startDate?: string;
  endDate?: string;
  transport: string;
  transportOther?: string;
  departurePlace: string;
  arrivalPlace: string;
  privateCarReason?: string;
  fundingSource?: string;
  fundingSourceOther?: string;
  isExpenseClaimed: boolean;
  isOralOrder: boolean;
  oralOrderIssuedAt?: string;
}

export interface CareDomainState {
  careCaseId?: number | '';
  carePeriodId?: number | '';
}

export interface ClassCoverageDomainState {
  coverageStatus: ClassCoverageStatus | '';
  notRequiredReason?: string;
  coverageItems: ClassCoverageItem[];
}

/**
 * 5. 統合 Typed Application Form State
 */
export interface TypedApplicationFormState {
  typeId: string;
  title: string;
  genericValues: GenericFieldValues;
  tripState?: BusinessTripDomainState;
  careState?: CareDomainState;
  coverageState?: ClassCoverageDomainState;
  isProxy: boolean;
  subjectUserId?: number | '';
  proxyReason?: string;
  isBatchTrip: boolean;
  participantUserIds: number[];
}
