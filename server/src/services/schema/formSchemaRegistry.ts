import {
  ApplicationFormSchema,
  FormSchemaSnapshot,
  FormFieldDefinition,
  FormSectionDefinition
} from '../../types/formSchema';

/**
 * Authoritative Application Form Schema Registry (SSOT)
 * Append-Only Immutable Registry (OPTION H3)
 */
class FormSchemaRegistryImpl {
  private schemas: Map<string, ApplicationFormSchema[]> = new Map();

  constructor() {
    this.registerBuiltinSchemas();
  }

  /**
   * スキーマ登録 (Append-Only: 同一typeId + versionの再登録/上書きは禁止)
   */
  public registerSchema(schema: ApplicationFormSchema): void {
    // GAP-09 Capability / Schema Invariant Check
    const hasCoverageSection = schema.sections.some(s => s.id === 'class_coverage');
    const isCoverageApplicable = schema.capabilities?.classCoverageApplicable === true;

    if (isCoverageApplicable && !hasCoverageSection) {
      throw new Error(`[FormSchemaRegistry] Configuration Error: Schema ${schema.typeId} has classCoverageApplicable=true but is missing 'class_coverage' section.`);
    }
    if (!isCoverageApplicable && hasCoverageSection) {
      throw new Error(`[FormSchemaRegistry] Configuration Error: Schema ${schema.typeId} has 'class_coverage' section but classCoverageApplicable is false or undefined.`);
    }

    const list = this.schemas.get(schema.typeId) || [];
    const exists = list.some(s => s.version === schema.version);
    if (exists) {
      throw new Error(`[FormSchemaRegistry] Schema version already registered: ${schema.typeId} v${schema.version}`);
    }

    // Invariant N Check: Canonical/Alias Namespace Isolation (C(S) ∩ A(S) = ∅)
    const canonicalNames = new Set<string>();
    const aliasMap = new Map<string, string>(); // aliasName -> canonicalName
    for (const section of schema.sections || []) {
      for (const field of section.fields || []) {
        canonicalNames.add(field.name);
        for (const alias of field.aliases || []) {
          if (alias === field.name) {
            throw new Error(`[FormSchemaRegistry] Configuration Error: Invariant N Violation: Self-alias detected for field '${field.name}' in schema '${schema.typeId}'.`);
          }
          if (aliasMap.has(alias)) {
            throw new Error(`[FormSchemaRegistry] Configuration Error: Invariant N Violation: Alias '${alias}' is owned by multiple fields ('${aliasMap.get(alias)}' and '${field.name}') in schema '${schema.typeId}'.`);
          }
          aliasMap.set(alias, field.name);
        }
      }
    }
    for (const [alias, owner] of aliasMap.entries()) {
      if (canonicalNames.has(alias)) {
        throw new Error(`[FormSchemaRegistry] Configuration Error: Invariant N Violation: Canonical/Alias collision detected. Alias '${alias}' (for field '${owner}') already exists as a canonical field in schema '${schema.typeId}'.`);
      }
    }

    list.push(schema);
    // effectiveFrom 降順でソート
    list.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    this.schemas.set(schema.typeId, list);
  }

  /**
   * 対象日・評価時点における Active な最新スキーマを解決
   */
  public resolveActiveSchema(typeId: string, targetDate?: string): ApplicationFormSchema | null {
    const list = this.schemas.get(typeId);
    if (!list || list.length === 0) return null;

    const date = targetDate || new Date().toISOString().split('T')[0];
    const matched = list.find(s => date >= s.effectiveFrom && (!s.effectiveTo || date <= s.effectiveTo));
    return matched || list[0]; // 見つからない場合は先頭（最新）を返却
  }

  /**
   * 特定バージョンのスキーマを取得
   */
  public getSchemaByVersion(typeId: string, version: string): ApplicationFormSchema | null {
    const list = this.schemas.get(typeId);
    if (!list) return null;
    return list.find(s => s.version === version) || null;
  }

  /**
   * 全登録スキーマ一覧を取得 (最新Active)
   */
  public getAllActiveSchemas(targetDate?: string): ApplicationFormSchema[] {
    const res: ApplicationFormSchema[] = [];
    for (const typeId of this.schemas.keys()) {
      const active = this.resolveActiveSchema(typeId, targetDate);
      if (active) res.push(active);
    }
    return res;
  }

  /**
   * スキーマ定義から不変スナップショットを生成 (OPTION H3)
   */
  public createSnapshot(schema: ApplicationFormSchema): FormSchemaSnapshot {
    return {
      typeId: schema.typeId,
      version: schema.version,
      capabilities: schema.capabilities ? { ...schema.capabilities } : undefined,
      sections: JSON.parse(JSON.stringify(schema.sections)),
      capturedAt: new Date().toISOString()
    };
  }

  /**
   * スナップショット内の全フィールド定義をフラットに抽出
   */
  public extractFlatFields(sections: FormSectionDefinition[]): Map<string, FormFieldDefinition> {
    const map = new Map<string, FormFieldDefinition>();
    for (const sec of sections) {
      for (const f of sec.fields) {
        map.set(f.name, f);
      }
    }
    return map;
  }

  /**
   * 授業引継ぎ・代替措置・自習監督 共通セクション定義 (GAP-09)
   */
  public static createClassCoverageSection(): FormSectionDefinition {
    return {
      id: 'class_coverage',
      title: '授業引継ぎ・代替措置・自習監督',
      description: '不在時の授業措置（代替授業、自習監督、時間割変更等）を確認・記録します',
      fields: [
        {
          name: 'coverageStatus',
          label: '授業措置の要否',
          type: 'SELECT',
          required: true,
          defaultValue: 'NOT_REQUIRED',
          options: [
            { label: '措置不要 (授業なし/放課後/休業日等)', value: 'NOT_REQUIRED' },
            { label: '措置が必要 (自習・代替・時間割変更あり)', value: 'REQUIRED' },
            { label: '教務・管理職へ確認中 (判断保留)', value: 'UNSURE' }
          ]
        },
        {
          name: 'notRequiredReason',
          label: '措置不要の理由・備考',
          type: 'TEXT',
          required: false,
          placeholder: '例: 担当授業のない時間帯のため / 長期休業期間のため',
          visibleCondition: { field: 'coverageStatus', operator: 'EQUALS', value: 'NOT_REQUIRED' }
        },
        {
          name: 'coverageItems',
          label: '授業代替措置明細',
          type: 'ARRAY',
          required: false,
          visibleCondition: { field: 'coverageStatus', operator: 'EQUALS', value: 'REQUIRED' },
          requiredCondition: { field: 'coverageStatus', operator: 'EQUALS', value: 'REQUIRED' }
        }
      ]
    };
  }

  /**
   * ビルトイン公立小中学校 服務申請スキーマ定義
   */
  private registerBuiltinSchemas(): void {
    // 1. 年次有給休暇 (LEAVE_ANNUAL)
    this.registerSchema({
      typeId: 'LEAVE_ANNUAL',
      version: '2026.1',
      title: '年次有給休暇 (年休) 申請書',
      description: '1日単位、半日単位、または時間単位の年次有給休暇申請',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'basic',
          title: '基本申請情報',
          fields: [
            {
              name: 'unitType',
              label: '取得単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '終日 (1日)', value: 'DAY' },
                { label: '半日 (午前/午後)', value: 'HALF_DAY' },
                { label: '時間単位 (1時間〜)', value: 'TIME' }
              ]
            },
            {
              name: 'halfDayType',
              label: '半日区分',
              type: 'SELECT',
              required: false,
              defaultValue: 'MORNING',
              options: [
                { label: '午前半日', value: 'MORNING' },
                { label: '午後半日', value: 'AFTERNOON' }
              ],
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' }
            },
            {
              name: 'targetDate',
              label: '取得対象日',
              type: 'DATE',
              required: false,
              description: '休暇を取得する日付',
              visibleCondition: { field: 'unitType', operator: 'IN', value: ['HALF_DAY', 'TIME'] },
              requiredCondition: { field: 'unitType', operator: 'IN', value: ['HALF_DAY', 'TIME'] }
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'DAY' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'DAY' }
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'DAY' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'DAY' }
            },
            {
              name: 'calculatedDays',
              label: '取得日数',
              type: 'NUMBER',
              required: false,
              defaultValue: 1,
              validation: { min: 0.5, max: 40 },
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'DAY' }
            },
            {
              name: 'startTime',
              label: '開始時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'endTime',
              label: '終了時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'reason',
              label: '事由・備考',
              type: 'TEXT',
              required: false,
              placeholder: '私事都合 等 (任意)'
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 2. 出張・校外用務 (BUSINESS_TRIP) - Wave 1 代表拡張ユースケース
    this.registerSchema({
      typeId: 'BUSINESS_TRIP',
      version: '2026.1',
      title: '旅行命令・校外用務申請書 (別表第一)',
      description: '公務出張、校外研修、大会引率等の旅行命令申請',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'trip_details',
          title: '旅行命令事項',
          fields: [
            {
              name: 'purpose',
              label: '出張用務名・目的',
              type: 'TEXT',
              required: true,
              placeholder: '例: 第1回市教育研究会総会 出席',
              aliases: ['reason']
            },
            {
              name: 'destination',
              label: '用務先・目的地',
              type: 'TEXT',
              required: false,
              defaultValue: '用務先',
              placeholder: '例: 山口市教育センター 大研修室'
            },
            {
              name: 'departurePlace',
              label: '出発地',
              type: 'SELECT',
              required: true,
              defaultValue: '本校',
              options: [
                { label: '本校', value: '本校' },
                { label: '自宅 (直行)', value: '自宅' },
                { label: 'その他', value: 'その他' }
              ]
            },
            {
              name: 'arrivalPlace',
              label: '帰着地',
              type: 'SELECT',
              required: true,
              defaultValue: '本校',
              options: [
                { label: '本校', value: '本校' },
                { label: '自宅 (直帰)', value: '自宅' },
                { label: 'その他', value: 'その他' }
              ]
            },
            {
              name: 'startAt',
              label: '出発日時',
              type: 'DATETIME',
              required: false
            },
            {
              name: 'endAt',
              label: '帰着日時',
              type: 'DATETIME',
              required: false
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: false
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: false
            },
            {
              name: 'unitType',
              label: '単位',
              type: 'SELECT',
              required: false,
              defaultValue: 'DAY',
              options: [
                { label: '終日', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'transport',
              label: '交通手段',
              type: 'SELECT',
              required: true,
              defaultValue: '公用車',
              options: [
                { label: '公共交通機関', value: '公共交通機関' },
                { label: '公用車', value: '公用車' },
                { label: '自家用車 (公務使用承認)', value: '自家用車' },
                { label: '貸切バス', value: '貸切バス' },
                { label: '徒歩', value: '徒歩' },
                { label: 'その他', value: 'その他' }
              ]
            },
            {
              name: 'transportOther',
              label: '交通手段 (その他詳細)',
              type: 'TEXT',
              required: false,
              placeholder: '例: タクシー、船舶等',
              visibleCondition: { field: 'transport', operator: 'EQUALS', value: 'その他' },
              requiredCondition: { field: 'transport', operator: 'EQUALS', value: 'その他' }
            },
            {
              name: 'privateCarReason',
              label: '自家用車使用理由',
              type: 'TEXT',
              required: false,
              placeholder: '例: 多量の教材・器具運搬のため',
              visibleCondition: { field: 'transport', operator: 'EQUALS', value: '自家用車' }
            },
            {
              name: 'fundingSource',
              label: '旅費財源',
              type: 'SELECT',
              required: true,
              defaultValue: '県費',
              options: [
                { label: '県費', value: '県費' },
                { label: '県費別枠', value: '県費別枠' },
                { label: '市費', value: '市費' },
                { label: '主催者負担', value: '主催者負担' },
                { label: '旅費不要', value: '旅費不要' },
                { label: 'その他', value: 'その他' }
              ]
            },
            {
              name: 'fundingSourceOther',
              label: '旅費財源 (その他詳細)',
              type: 'TEXT',
              required: false,
              placeholder: '例: PTA会費、研究会負担等',
              visibleCondition: { field: 'fundingSource', operator: 'EQUALS', value: 'その他' },
              requiredCondition: { field: 'fundingSource', operator: 'EQUALS', value: 'その他' }
            },
            {
              name: 'isOralOrder',
              label: '口頭発令済 (緊急等)',
              type: 'BOOLEAN',
              required: false,
              defaultValue: false,
              description: '緊急時または近距離等で事前に口頭発令を受けた出張の場合チェック'
            },
            {
              name: 'oralOrderIssuedAt',
              label: '口頭発令年月日',
              type: 'DATE',
              required: false,
              visibleCondition: { field: 'isOralOrder', operator: 'IS_TRUE' },
              requiredCondition: { field: 'isOralOrder', operator: 'IS_TRUE' },
              description: '旅行命令権者（校長等）より口頭で旅行命令を受けた日付'
            },
            {
              name: 'isExpenseClaimed',
              label: '旅費支給申請',
              type: 'BOOLEAN',
              required: false,
              defaultValue: false,
              description: '日当・宿泊料・実費交通費等の請求を行う場合チェック'
            },
            {
              name: 'remarks',
              label: '連絡事項・備考',
              type: 'TEXTAREA',
              required: false
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection(),
        {
          id: 'report_details',
          title: '復命書・旅行実績情報 (事後報告)',
          fields: [
            {
              name: 'reportDate',
              label: '復命年月日',
              type: 'DATE',
              required: false,
              description: '復命書を提出する日付'
            },
            {
              name: 'reportResult',
              label: '結果又は状況 (復命本文)',
              type: 'TEXTAREA',
              required: false,
              placeholder: '出張用務の処理結果、研修の成果等を記入してください'
            },
            {
              name: 'reportRemarks',
              label: '復命備考',
              type: 'TEXTAREA',
              required: false
            },
            {
              name: 'actualMatchesPlan',
              label: '旅行実績は計画どおり',
              type: 'BOOLEAN',
              required: false,
              defaultValue: true,
              description: '出発地・帰着地・交通手段が申請計画と同一の場合チェック'
            },
            {
              name: 'actualDeparturePlace',
              label: '実績出発地',
              type: 'SELECT',
              required: false,
              options: [
                { label: '本校', value: '本校' },
                { label: '自宅 (直行)', value: '自宅' },
                { label: 'その他', value: 'その他' }
              ],
              visibleCondition: { field: 'actualMatchesPlan', operator: 'IS_FALSE' }
            },
            {
              name: 'actualArrivalPlace',
              label: '実績帰着地',
              type: 'SELECT',
              required: false,
              options: [
                { label: '本校', value: '本校' },
                { label: '自宅 (直帰)', value: '自宅' },
                { label: 'その他', value: 'その他' }
              ],
              visibleCondition: { field: 'actualMatchesPlan', operator: 'IS_FALSE' }
            },
            {
              name: 'actualTransportMode',
              label: '実績交通手段',
              type: 'SELECT',
              required: false,
              options: [
                { label: '公用車', value: '公用車' },
                { label: '自家用車 (公務使用承認)', value: '自家用車' },
                { label: '公共交通機関 (電車・バス)', value: '公共交通機関' },
                { label: '徒歩・自転車', value: '徒歩' }
              ],
              visibleCondition: { field: 'actualMatchesPlan', operator: 'IS_FALSE' }
            },
            {
              name: 'vehicleUsageType',
              label: '自家用車利用区分',
              type: 'SELECT',
              required: false,
              options: [
                { label: '運転 (自車)', value: 'DRIVER' },
                { label: '同乗 (他車)', value: 'PASSENGER' }
              ]
            },
            {
              name: 'actualDistanceKm',
              label: '自家用車実測距離 (km)',
              type: 'NUMBER',
              required: false,
              description: '自家用車公務使用時の実走行距離 (小数可)'
            },
            {
              name: 'communicationCostBorne',
              label: '通信運送費負担',
              type: 'SELECT',
              required: false,
              options: [
                { label: 'なし (負担なし)', value: 'false' },
                { label: 'あり (負担あり)', value: 'true' }
              ],
              description: '公務通信運送費の自己負担有無'
            },
            {
              name: 'actualTripStartAt',
              label: '実績出発日時',
              type: 'DATETIME',
              required: false
            },
            {
              name: 'actualTripEndAt',
              label: '実績帰着日時',
              type: 'DATETIME',
              required: false
            },
            {
              name: 'travelExpenseRemarks',
              label: '旅費関係特記事項',
              type: 'TEXTAREA',
              required: false
            }
          ]
        }
      ]
    });

    // 3. 特別休暇 (LEAVE_SPECIAL) - 事由コード別拡張
    this.registerSchema({
      typeId: 'LEAVE_SPECIAL',
      version: '2026.1',
      title: '特別休暇 (特休) 申請書',
      description: '条例第14条に規定される特別休暇 (忌引・結婚・出産等)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'special_details',
          title: '特別休暇申請内容',
          fields: [
            {
              name: 'reasonCode',
              label: '特別休暇事由',
              type: 'SELECT',
              required: true,
              defaultValue: 'SPECIAL_BEREAVEMENT',
              options: [
                { label: '忌引 (第14条第1項)', value: 'SPECIAL_BEREAVEMENT' },
                { label: '結婚 (第14条第2項)', value: 'SPECIAL_MARRIAGE' },
                { label: '産前産後休暇 (第14条第6項・第7項)', value: 'SPECIAL_MATERNITY' },
                { label: '配偶者出産休暇 (第14条第8項)', value: 'SPECIAL_SPOUSE_BIRTH' },
                { label: '男性職員の育児参加休暇 (第14条第9項)', value: 'SPECIAL_CHILDCARE_PARTICIPATION' },
                { label: 'ボランティア休暇 (第14条第14項)', value: 'SPECIAL_VOLUNTEER' },
                { label: 'その他特別休暇', value: 'SPECIAL_OTHER' }
              ]
            },
            {
              name: 'relationship',
              label: '本人との続柄・故人氏名',
              type: 'TEXT',
              required: false,
              placeholder: '例: 実父（山田 一郎）',
              visibleCondition: { field: 'reasonCode', operator: 'EQUALS', value: 'SPECIAL_BEREAVEMENT' },
              requiredCondition: { field: 'reasonCode', operator: 'EQUALS', value: 'SPECIAL_BEREAVEMENT' }
            },
            {
              name: 'childBirthExpectedDate',
              label: '出産（予定）日',
              type: 'DATE',
              required: false,
              visibleCondition: { field: 'reasonCode', operator: 'IN', value: ['SPECIAL_MATERNITY', 'SPECIAL_SPOUSE_BIRTH', 'SPECIAL_CHILDCARE_PARTICIPATION'] },
              requiredCondition: { field: 'reasonCode', operator: 'IN', value: ['SPECIAL_MATERNITY', 'SPECIAL_SPOUSE_BIRTH', 'SPECIAL_CHILDCARE_PARTICIPATION'] }
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: true
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: true
            },
            {
              name: 'targetDate',
              label: '対象日',
              type: 'DATE',
              required: false
            },
            {
              name: 'unitType',
              label: '取得単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '終日 (日単位)', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'startTime',
              label: '開始時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'endTime',
              label: '終了時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'calculatedDays',
              label: '日数',
              type: 'NUMBER',
              required: false,
              defaultValue: 1
            },
            {
              name: 'reason',
              label: '事由詳細',
              type: 'TEXTAREA',
              required: true,
              placeholder: '事由の詳細を記入してください'
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 4. 病気休暇 (LEAVE_SICK)
    this.registerSchema({
      typeId: 'LEAVE_SICK',
      version: '2026.1',
      title: '病気休暇 (病休) 承認申請書',
      description: '条例第13条に規定される病気休暇 (療養・病気通院等)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'sick_details',
          title: '病気休暇申請内容',
          fields: [
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: true
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: true
            },
            {
              name: 'unitType',
              label: '取得単位',
              type: 'SELECT',
              required: false,
              defaultValue: 'DAY',
              options: [
                { label: '終日 (日単位)', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'targetDate',
              label: '対象日',
              type: 'DATE',
              required: false
            },
            {
              name: 'calculatedDays',
              label: '申請日数',
              type: 'NUMBER',
              required: true,
              defaultValue: 1
            },
            {
              name: 'reason',
              label: '病名・症状・受診理由',
              type: 'TEXT',
              required: true,
              placeholder: '病名または療養理由を記入'
            },
            {
              name: 'medicalCertificateAttached',
              label: '医師の診断書添付',
              type: 'BOOLEAN',
              required: false,
              defaultValue: false,
              description: '連続8日以上の場合は医師の診断書添付が必須です'
            },
            {
              name: 'medicalInstitutionName',
              label: '医療機関名',
              type: 'TEXT',
              required: false,
              placeholder: '受診・療養を行う医療機関'
            },
            {
              name: 'diseaseContinuityDecision',
              label: '同一疾病認定 (管理用)',
              type: 'SELECT',
              required: false,
              defaultValue: 'UNRESOLVED',
              options: [
                { label: '同一疾病 (90日通算)', value: 'SAME_DISEASE' },
                { label: '別疾病 (新規起算)', value: 'SEPARATE_DISEASE' },
                { label: '未確定 (要判定)', value: 'UNRESOLVED' }
              ]
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 5. 特例法第22条第2項研修 (TRAINING_SPECIAL_ACT_22_2)
    this.registerSchema({
      typeId: 'TRAINING_SPECIAL_ACT_22_2',
      version: '2026.1',
      title: '教育公務員特例法第22条第2項研修 承認申請書',
      description: '勤務場所を離れて行う自主的研修 (本属長承認)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'training_details',
          title: '研修内容',
          fields: [
            {
              name: 'purpose',
              label: '研修題目・目的',
              type: 'TEXT',
              required: true,
              placeholder: '例: 中学校数学科指導法及びICT活用に関する自主研修',
              aliases: ['reason']
            },
            {
              name: 'organizer',
              label: '研修主催者・研究会名',
              type: 'TEXT',
              required: false,
              defaultValue: '自主研修',
              placeholder: '例: 山口県数学教育研究会 / 個人研修'
            },
            {
              name: 'venue',
              label: '研修場所',
              type: 'TEXT',
              required: false,
              placeholder: '例: 自宅 / 県立図書館'
            },
            {
              name: 'destination',
              label: '目的地・研修場所',
              type: 'TEXT',
              required: false,
              placeholder: '例: 自宅 / 県立図書館'
            },
            {
              name: 'targetDate',
              label: '研修実施日',
              type: 'DATE',
              required: true
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: false
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: false
            },
            {
              name: 'unitType',
              label: '単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '終日', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'halfDayType',
              label: '半日区分',
              type: 'SELECT',
              required: false,
              defaultValue: 'MORNING',
              options: [
                { label: '午前半日', value: 'MORNING' },
                { label: '午後半日', value: 'AFTERNOON' }
              ],
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' }
            },
            {
              name: 'startTime',
              label: '開始時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'endTime',
              label: '終了時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'durationMinutes',
              label: '所要時間(分)',
              type: 'NUMBER',
              required: false
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 5.1 特例法第22条第3項長期研修 (TRAINING_SPECIAL_ACT_22_3)
    this.registerSchema({
      typeId: 'TRAINING_SPECIAL_ACT_22_3',
      version: '2026.1',
      title: '教育公務員特例法第22条第3項長期研修 承認申請書',
      description: '任命権者の定めるところにより現職のままで受ける長期研修',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'training_22_3_details',
          title: '長期研修内容',
          fields: [
            {
              name: 'purpose',
              label: '研修題目・目的',
              type: 'TEXT',
              required: true,
              placeholder: '例: 長期派遣研修',
              aliases: ['reason']
            },
            {
              name: 'destination',
              label: '研修派遣先・用務先',
              type: 'TEXT',
              required: false,
              placeholder: '例: 県教育センター'
            },
            {
              name: 'targetDate',
              label: '対象日',
              type: 'DATE',
              required: false
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: true
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: true
            },
            {
              name: 'unitType',
              label: '単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '終日', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'startTime',
              label: '開始時刻',
              type: 'TIME',
              required: false
            },
            {
              name: 'endTime',
              label: '終了時刻',
              type: 'TIME',
              required: false
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 6. 職務専念義務免除 (LEAVE_DUTY_EXEMPT)
    this.registerSchema({
      typeId: 'LEAVE_DUTY_EXEMPT',
      version: '2026.1',
      title: '職務専念義務免除 (職専免) 承認申請書',
      description: '研修・公務・厚生行事等に伴う職務専念義務免除申請',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'duty_exempt_details',
          title: '職専免申請内容',
          fields: [
            {
              name: 'purpose',
              label: '用務・免除理由',
              type: 'TEXT',
              required: true,
              placeholder: '例: 教員免許更新講習受講 / 学校保健委員会出席',
              aliases: ['reason']
            },
            {
              name: 'targetDate',
              label: '対象日',
              type: 'DATE',
              required: true
            },
            {
              name: 'startDate',
              label: '開始日',
              type: 'DATE',
              required: false
            },
            {
              name: 'endDate',
              label: '終了日',
              type: 'DATE',
              required: false
            },
            {
              name: 'unitType',
              label: '単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '終日', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'startTime',
              label: '開始時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            },
            {
              name: 'endTime',
              label: '終了時刻',
              type: 'TIME',
              required: false,
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'TIME' }
            }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 7. 育児休業 (LEAVE_CHILDCARE)
    this.registerSchema({
      typeId: 'LEAVE_CHILDCARE',
      version: '2026.1',
      title: '育児休業 請求書',
      description: '地方公務員の育児休業等に関する法律に基づく育児休業請求',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'childcare_details',
          title: '育児休業請求内容',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
            { name: 'reason', label: '請求事由', type: 'TEXT', required: false }
          ]
        }
      ]
    });

    // 8. 育児短時間勤務 (WORK_PATTERN_CHILDCARE)
    this.registerSchema({
      typeId: 'WORK_PATTERN_CHILDCARE',
      version: '2026.1',
      title: '育児短時間勤務 請求書',
      description: '育児短時間勤務パターンの割振り請求',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'work_pattern_childcare_details',
          title: '育児短時間勤務請求内容',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
            { name: 'patternType', label: '勤務形態パターン', type: 'TEXT', required: false },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        }
      ]
    });

    // 9. 育児部分休業 (LEAVE_CHILDCARE_PARTIAL)
    this.registerSchema({
      typeId: 'LEAVE_CHILDCARE_PARTIAL',
      version: '2026.1',
      title: '育児部分休業 承認請求書',
      description: '1日最大2時間等の部分休業請求 (時間単位)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      sections: [
        {
          id: 'partial_childcare_details',
          title: '育児部分休業内容',
          fields: [
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: false },
            { name: 'endDate', label: '終了日', type: 'DATE', required: false },
            { name: 'unitType', label: '単位', type: 'SELECT', required: false, defaultValue: 'TIME' },
            { name: 'startTime', label: '開始時刻', type: 'TIME', required: true },
            { name: 'endTime', label: '終了時刻', type: 'TIME', required: true },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        }
      ]
    });

    // 10. 介護休暇 (LEAVE_CARE)
    this.registerSchema({
      typeId: 'LEAVE_CARE',
      version: '2026.1',
      title: '介護休暇 承認申請書',
      description: '要介護状態にある家族を介護するための休暇 (日/半日/時間単位)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'care_details',
          title: '介護休暇内容',
          fields: [
            { name: 'careCaseId', label: '対象家族事案ID', type: 'NUMBER', required: false },
            { name: 'carePeriodId', label: '通算指定期間ID', type: 'NUMBER', required: false },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: false },
            { name: 'endDate', label: '終了日', type: 'DATE', required: false },
            {
              name: 'unitType',
              label: '単位',
              type: 'SELECT',
              required: true,
              defaultValue: 'DAY',
              options: [
                { label: '終日', value: 'DAY' },
                { label: '半日', value: 'HALF_DAY' },
                { label: '時間単位', value: 'TIME' }
              ]
            },
            {
              name: 'halfDayType',
              label: '半日区分',
              type: 'SELECT',
              required: false,
              defaultValue: 'MORNING',
              options: [
                { label: '午前半日', value: 'MORNING' },
                { label: '午後半日', value: 'AFTERNOON' }
              ],
              visibleCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' },
              requiredCondition: { field: 'unitType', operator: 'EQUALS', value: 'HALF_DAY' }
            },
            { name: 'startTime', label: '開始時刻', type: 'TIME', required: false },
            { name: 'endTime', label: '終了時刻', type: 'TIME', required: false },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 11. 介護時間 (LEAVE_CARE_TIME)
    this.registerSchema({
      typeId: 'LEAVE_CARE_TIME',
      version: '2026.1',
      title: '介護時間 承認申請書',
      description: '要介護状態にある家族を介護するための時間 (30分単位 / 1日最大2時間)',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'care_time_details',
          title: '介護時間内容',
          fields: [
            { name: 'careCaseId', label: '対象家族事案ID', type: 'NUMBER', required: false },
            { name: 'carePeriodId', label: '通算指定期間ID', type: 'NUMBER', required: false },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: true },
            { name: 'startDate', label: '開始日', type: 'DATE', required: false },
            { name: 'endDate', label: '終了日', type: 'DATE', required: false },
            { name: 'unitType', label: '単位', type: 'SELECT', required: false, defaultValue: 'TIME' },
            { name: 'startTime', label: '開始時刻', type: 'TIME', required: true },
            { name: 'endTime', label: '終了時刻', type: 'TIME', required: true },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });

    // 12. 大規模校用休暇申請 (LEAVE_LARGE_SCHOOL)
    this.registerSchema({
      typeId: 'LEAVE_LARGE_SCHOOL',
      version: '2026.1',
      title: '大規模校用休暇申請書',
      description: '大規模校多段階承認用休暇申請',
      effectiveFrom: '2026-01-01',
      effectiveTo: '9999-12-31',
      capabilities: {
        classCoverageApplicable: true
      },
      sections: [
        {
          id: 'large_school_details',
          title: '申請内容',
          fields: [
            { name: 'startDate', label: '開始日', type: 'DATE', required: true },
            { name: 'endDate', label: '終了日', type: 'DATE', required: true },
            { name: 'targetDate', label: '対象日', type: 'DATE', required: false },
            { name: 'calculatedDays', label: '日数', type: 'NUMBER', required: false, defaultValue: 1 },
            { name: 'reason', label: '事由', type: 'TEXT', required: false }
          ]
        },
        FormSchemaRegistryImpl.createClassCoverageSection()
      ]
    });
  }
}

export const FormSchemaRegistry = new FormSchemaRegistryImpl();
