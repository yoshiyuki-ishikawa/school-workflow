import { Application, User } from './index';
import { ApplicationFormSchema } from './formSchema';
import { ActionabilityState } from '../utils/applicationActionabilityResolver';

/**
 * detailPresentation.ts
 * 
 * Phase C: Schema-Driven Application Detail View 専用のプレゼンテーション型定義
 */

export interface DetailPresentationProps {
  application: Application;
  schema: ApplicationFormSchema | null;
  currentUser: User;
  actionability: ActionabilityState;
  onRefresh: () => void;
  onBack: () => void;
}

export interface ResidualFieldItem {
  key: string;
  value: any;
  formattedValue: string;
}
