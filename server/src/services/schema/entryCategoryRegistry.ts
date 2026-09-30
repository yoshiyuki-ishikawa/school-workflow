/**
 * Entry Category Registry (Server-side Single SSOT)
 * 
 * New Application Entry Architecture v1.2
 * HD-NAE-01: 4 Entry Categories (出張, 休暇・職専免, 育児・介護, その他の申請)
 * HD-NAE-02: LEAVE_LARGE_SCHOOL retirement from entry
 * Fail-Closed: UNKNOWN ≠ OTHER (Unregistered types are strictly rejected / hidden)
 */

export type EntryCategoryId =
  | 'TRAVEL'
  | 'LEAVE_DUTY_EXEMPT'
  | 'CHILDCARE_CARE'
  | 'OTHER';

export interface EntryCategoryDefinition {
  id: EntryCategoryId;
  name: string;
  description: string;
  displayOrder: number;
}

export interface ApplicationTypeCategoryMapping {
  typeId: string;
  categoryId: EntryCategoryId;
  isRetired?: boolean;
}

/**
 * 4 大分類カテゴリ定義 (HD-NAE-01 / Server SSOT)
 */
export const ENTRY_CATEGORIES: Record<EntryCategoryId, EntryCategoryDefinition> = {
  TRAVEL: {
    id: 'TRAVEL',
    name: '出張',
    description: '公務出張・校外業務等の旅行命令',
    displayOrder: 1,
  },
  LEAVE_DUTY_EXEMPT: {
    id: 'LEAVE_DUTY_EXEMPT',
    name: '休暇・職専免',
    description: '年休・病休・特休・職務専念義務免除等',
    displayOrder: 2,
  },
  CHILDCARE_CARE: {
    id: 'CHILDCARE_CARE',
    name: '育児・介護',
    description: '育児休業・育児短時間・介護休暇・介護時間等',
    displayOrder: 3,
  },
  OTHER: {
    id: 'OTHER',
    name: 'その他の申請',
    description: '各種研修・その他諸願届出',
    displayOrder: 4,
  },
};

/**
 * Application Type -> Category Mapping (Server Single SSOT)
 * 退役種別（LEAVE_LARGE_SCHOOL）や未知種別の扱いを決定論的に定義
 */
export const APPLICATION_TYPE_CATEGORY_MAPPINGS: Record<string, ApplicationTypeCategoryMapping> = {
  // 1. 出張 (TRAVEL)
  BUSINESS_TRIP: {
    typeId: 'BUSINESS_TRIP',
    categoryId: 'TRAVEL',
  },

  // 2. 休暇・職専免 (LEAVE_DUTY_EXEMPT)
  LEAVE_ANNUAL: {
    typeId: 'LEAVE_ANNUAL',
    categoryId: 'LEAVE_DUTY_EXEMPT',
  },
  LEAVE_SICK: {
    typeId: 'LEAVE_SICK',
    categoryId: 'LEAVE_DUTY_EXEMPT',
  },
  LEAVE_SPECIAL: {
    typeId: 'LEAVE_SPECIAL',
    categoryId: 'LEAVE_DUTY_EXEMPT',
  },
  LEAVE_DUTY_EXEMPT: {
    typeId: 'LEAVE_DUTY_EXEMPT',
    categoryId: 'LEAVE_DUTY_EXEMPT',
  },

  // 3. 育児・介護 (CHILDCARE_CARE)
  LEAVE_CHILDCARE: {
    typeId: 'LEAVE_CHILDCARE',
    categoryId: 'CHILDCARE_CARE',
  },
  WORK_PATTERN_CHILDCARE: {
    typeId: 'WORK_PATTERN_CHILDCARE',
    categoryId: 'CHILDCARE_CARE',
  },
  LEAVE_CHILDCARE_PARTIAL: {
    typeId: 'LEAVE_CHILDCARE_PARTIAL',
    categoryId: 'CHILDCARE_CARE',
  },
  LEAVE_CARE: {
    typeId: 'LEAVE_CARE',
    categoryId: 'CHILDCARE_CARE',
  },
  LEAVE_CARE_TIME: {
    typeId: 'LEAVE_CARE_TIME',
    categoryId: 'CHILDCARE_CARE',
  },

  // 4. その他の申請 (OTHER)
  TRAINING_SPECIAL_ACT_22_2: {
    typeId: 'TRAINING_SPECIAL_ACT_22_2',
    categoryId: 'OTHER',
  },
  TRAINING_SPECIAL_ACT_22_3: {
    typeId: 'TRAINING_SPECIAL_ACT_22_3',
    categoryId: 'OTHER',
  },

  // 退役種別 (HD-NAE-02: Entry から完全除外・新規起案禁止)
  LEAVE_LARGE_SCHOOL: {
    typeId: 'LEAVE_LARGE_SCHOOL',
    categoryId: 'LEAVE_DUTY_EXEMPT',
    isRetired: true,
  },
};

export class EntryCategoryRegistry {
  /**
   * カテゴリ定義一覧を取得（表示順ソート）
   */
  public static getAllCategories(): EntryCategoryDefinition[] {
    return Object.values(ENTRY_CATEGORIES).sort((a, b) => a.displayOrder - b.displayOrder);
  }

  /**
   * 種別IDからカテゴリメタデータを取得
   * UNKNOWN 種別の場合は null を返却 (UNKNOWN ≠ OTHER: Fail-Closed)
   */
  public static getCategoryForType(typeId: string): (EntryCategoryDefinition & { isRetired?: boolean }) | null {
    const mapping = APPLICATION_TYPE_CATEGORY_MAPPINGS[typeId];
    if (!mapping) {
      return null;
    }
    const cat = ENTRY_CATEGORIES[mapping.categoryId];
    if (!cat) {
      return null;
    }
    return {
      ...cat,
      isRetired: mapping.isRetired || false,
    };
  }

  /**
   * 種別が退役しているか判定
   */
  public static isRetiredType(typeId: string): boolean {
    const mapping = APPLICATION_TYPE_CATEGORY_MAPPINGS[typeId];
    return !!mapping?.isRetired;
  }
}
