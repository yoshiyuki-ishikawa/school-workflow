/**
 * Canonical Domain Types for School Workflow
 * Canonical Service Fact Architecture — Phase B
 */

/**
 * 25のCanonicalな服務状態 (出勤簿に最終集約される正規ステータス)
 */
export type CanonicalServiceStatus =
  | 'TRAINING'                           // 1. 研修
  | 'ANNUAL_LEAVE'                      // 2. 年次有給休暇
  | 'SICK_LEAVE'                        // 3. 病気休暇
  | 'SPECIAL_MATERNITY_LEAVE'           // 4. 産前産後の特別休暇
  | 'SPECIAL_LEAVE_GENERAL'             // 5. 特別休暇（産前産後を除く）
  | 'CARE_LEAVE'                        // 6. 介護休暇
  | 'CARE_TIME'                         // 7. 介護時間
  | 'CHILDCARE_SUPPORT_PARTIAL_LEAVE'   // 8. 子育て支援部分休暇
  | 'DUTY_EXEMPTION'                    // 9. 職務専念義務の免除
  | 'ABSENCE'                           // 10. 欠勤
  | 'OFFICIAL_BUSINESS_TRIP'            // 11. 公務旅行（出張）
  | 'SELF_DEVELOPMENT_LEAVE'            // 12. 自己啓発等休業
  | 'SPOUSAL_ACCOMPANIMENT_LEAVE'       // 13. 配偶者同行休業
  | 'CHILDCARE_LEAVE'                   // 14. 育児休業
  | 'CHILDCARE_SHORT_TIME'              // 15. 育児短時間勤務
  | 'CHILDCARE_PARTIAL_LEAVE'           // 16. 部分休業（育児）
  | 'STUDY_PARTIAL_LEAVE'               // 17. 修学部分休業
  | 'ADMINISTRATIVE_LEAVE_SUSPENSION'   // 18. 分限休職
  | 'UNION_FULL_TIME_SUSPENSION'        // 19. 専従休職
  | 'DISCIPLINARY_SUSPENSION'           // 20. 停職
  | 'HOLIDAY'                           // 21. 休日
  | 'SUBSTITUTE_HOLIDAY'                // 22. 休日の代休日
  | 'WEEKLY_OFF'                        // 23. 週休日
  | 'CONCURRENT_APPOINTMENT'            // 24. 兼務
  | 'DISPATCH'                          // 25. 派遣（外国・国内・自治法派遣を包含）
  | 'FOREIGN_DISPATCH';                 // 派遣の互換エイリアス（subtype: FOREIGN）

/**
 * 服務事象の形態
 */
export type ServiceFactType =
  | 'DAY_EVENT'       // 終日・半日単位の個別事象
  | 'TIME_EVENT'      // 時間帯指定事象
  | 'PERIOD_STATUS'   // 長期身分状態
  | 'WORK_PATTERN'    // 勤務パターン・短縮勤務
  | 'CALENDAR_STATUS';// カレンダー・勤務割免除

/**
 * 服務事実の発生源区分
 */
export type ServiceFactSourceType =
  | 'INTERNAL_APPLICATION' // 内部申請・決裁 (applications)
  | 'EXTERNAL_DECISION'    // 外部決定通知・教育委員会承認 (external_records: Phase D予定)
  | 'PERSONNEL_ORDER'      // 任命権者人事発令 (personnel_statuses)
  | 'CALENDAR'             // 祝日・行事 (custom_holidays / system holiday)
  | 'WORK_SCHEDULE'        // 勤務割・週休 (user_work_patterns / adjustments)
  | 'ADMIN_REGISTRATION';  // 管理者直接登録・欠勤 (absences)

/**
 * 調停機構アクション (Architecture Rule)
 */
export type ConflictArchitectureAction =
  | 'OVERRIDE_ALL'          // 他の全事象を無効化 (例: 停職・休職)
  | 'COEXIST_AND_ACCUMULATE'// 双方を併記・時間を積算 (例: 休日＋出張)
  | 'COEXIST_AND_DEDUCT'    // 基礎時間を維持し交差時間を控除 (例: 育短＋時間年休)
  | 'EXCLUSIVE_ERROR'       // 同一日時の重複を排他エラー (例: 終日年休＋終日特休)
  | 'DISPLAY_PRECEDENCE'    // 計算は双方維持し表示記号のみ優先側を表示
  | 'FAIL_CLOSED';          // 未定義・矛盾のため安全停止

/**
 * Layer 1: 服務事実そのもの (何が起きたか)
 * ※ 計算結果や表示制御値を含まない純粋な業務事実DTO
 */
export interface CanonicalServiceFact {
  factId: string; // 決定論的Identity
  userId: number;
  canonicalStatus: CanonicalServiceStatus;
  factType: ServiceFactType;
  
  sourceType: ServiceFactSourceType;
  sourceTable: 'applications' | 'personnel_statuses' | 'absences' | 'custom_holidays' | 'calendar_adjustments' | 'user_work_patterns' | 'external_records';
  sourceId: number | string;
  sourceVersion?: number | null;
  workflowCycleId?: number | null;
  
  targetDate: string;        // YYYY-MM-DD
  effectiveFrom?: string;    // 期間型用 YYYY-MM-DD
  effectiveTo?: string;      // 期間型用 YYYY-MM-DD
  startTime?: string;        // HH:MM (時間単位用)
  endTime?: string;          // HH:MM (時間単位用)
  quantityUnits?: number;    // 取得単位数 (日数または分数)
  
  isRestricted: boolean;     // センシティブ情報フラグ
  legalBasisReference?: string;
  supportingReferenceId?: string; // trip_event_id, care_case_id 等
  details?: Record<string, any>;
}

/**
 * Layer 3: 出勤簿ドメイン評価結果 (出勤簿上どう扱うか)
 * ※ 勤務パターン・カレンダー・競合調停を適用した決定論的計算結果
 */
export interface AttendanceDomainResult {
  userId: number;
  date: string;
  dayOfWeek: string;
  
  // 基礎勤務評価
  isScheduledWorkDay: boolean; // 所定勤務日か否か
  dutyStatus: 'WORK_REQUIRED' | 'NO_WORK_REQUIRED' | 'EXEMPT';
  
  // 時間計算結果 (分数)
  scheduledWorkMinutes: number; // 当日の所定勤務時間 (通常465分、育短240分等)
  countedWorkMinutes: number;   // 実働勤務算入時間 (通常勤務、出張、研修等)
  deductionMinutes: number;     // 所定時間からの免除・控除時間 (年休、病休等)
  effectiveWorkMinutes: number; // 最終実労働時間 (scheduled - deduction)
  
  // 服務状態・競合解決結果
  primaryCanonicalStatus: CanonicalServiceStatus;
  secondaryCanonicalStatuses: CanonicalServiceStatus[];
  appliedConflictAction: ConflictArchitectureAction;
  aggregationCategory: string;  // 月次集計列カテゴリ
  
  // 発生根拠リンク
  contributingFactIds: string[];
  isPersonnelStatusOverridden: boolean;
  explanations: Array<{ layer: number; ruleApplied: string }>;
}
