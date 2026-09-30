/**
 * schemaResolutionDateResolver.ts
 * 
 * Historical Schema 解決のための基準日（targetDate）を決定論的に導出する Pure Engine。
 * 
 * 【Architecture Invariant】
 * 1. Today Fallback = 0: new Date() / Date.now() 等の現在日付へのフォールバックは完全禁止。
 * 2. Client Application-Type Allowlist = 0: 申請種別による条件分岐（if typeId === ...）は禁止。
 * 3. Canonical Field Priority: startDate -> targetDate -> startAt -> created_at -> ''
 * 4. Timezone / Locale Independent: 文字列正規表現による安全な YYYY-MM-DD 抽出。
 */

export function determineHistoricalSchemaResolutionDate(
  formData: Record<string, any> | null | undefined,
  createdAt: string | null | undefined
): string {
  const data = formData || {};

  // 1. 期間開始日 (Canonical Priority 1)
  if (typeof data.startDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.startDate)) {
    return data.startDate.substring(0, 10);
  }

  // 2. 単一対象日 (Canonical Priority 2)
  if (typeof data.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.targetDate)) {
    return data.targetDate.substring(0, 10);
  }

  // 3. ISOタイムスタンプ (Canonical Priority 3: startAt / tripStartAt 等)
  if (typeof data.startAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.startAt)) {
    return data.startAt.substring(0, 10);
  }
  if (typeof data.tripStartAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.tripStartAt)) {
    return data.tripStartAt.substring(0, 10);
  }

  // 4. 申請レコード作成日 (created_at: 最終 Authoritative Fallback)
  if (typeof createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(createdAt)) {
    return createdAt.substring(0, 10);
  }

  // 5. 異常系・解決不能時: 空文字を返却（現在日付へのフォールバックは絶対禁止）
  //    ※ 空文字返却時は Schema 解決を行わず、Fact Preservation（Residual View）へ委譲
  return '';
}
