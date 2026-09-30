import { getDb } from '../db/database';

export interface PositionResolveParams {
  positionCode: string;
  effectiveDate: string; // YYYY-MM-DD
  excludeUserIds?: number[];
}

export interface PositionResolveResult {
  userId: number;
  displayName: string;
  positionCode: string;
  positionName: string;
}

export class PositionResolverError extends Error {
  statusCode: number;
  errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.name = 'PositionResolverError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/**
 * Canonical Position Resolver
 * 
 * 組織役職（Position）から有効な担当者ユーザーを決定論的に解決する。
 * 
 * Invariants:
 * 1. holder_type = 'SINGLE_HOLDER' のPositionのみ単一承認者として解決可能。
 *    MULTIPLE_HOLDER 指定時は POSITION_CARDINALITY_MISMATCH で Fail-Closed。
 * 2. 有効担当者 0名 -> POSITION_HOLDER_NOT_FOUND (Fail-Closed)
 * 3. 有効担当者 1名 -> 対象Userを返却 (Success)
 * 4. 有効担当者 2名以上 -> POSITION_HOLDER_AMBIGUOUS (Fail-Closed)
 * 5. LIMIT 1、先頭暗黙選択、Role/ADMINへの暗黙フォールバックは完全禁止。
 */
export function resolvePositionHolder(params: PositionResolveParams): PositionResolveResult {
  const db = getDb();
  const { positionCode, effectiveDate, excludeUserIds = [] } = params;

  // 1. Position マスタ取得と holder_type 検証
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionCode) as any;
  if (!position) {
    throw new PositionResolverError(404, 'POSITION_NOT_FOUND', `役職が見つかりません: ${positionCode}`);
  }

  if (position.holder_type !== 'SINGLE_HOLDER') {
    throw new PositionResolverError(
      400,
      'POSITION_CARDINALITY_MISMATCH',
      `単一承認者ルートに複数担当可能役職（${position.name}）は指定できません。`
    );
  }

  // 2. 有効担当者の検索 (effective_from <= effectiveDate AND (effective_to IS NULL OR effective_to >= effectiveDate))
  const holders = db.prepare(`
    SELECT u.id, u.display_name, p.id as position_code, p.name as position_name
    FROM user_positions up
    JOIN users u ON up.user_id = u.id
    JOIN positions p ON up.position_id = p.id
    WHERE up.position_id = ?
      AND up.effective_from <= ?
      AND (up.effective_to IS NULL OR up.effective_to >= ?)
      AND u.is_active = 1
    ORDER BY up.is_primary DESC, up.id ASC
  `).all(positionCode, effectiveDate, effectiveDate) as any[];

  const activeHolders = holders.filter((h) => !excludeUserIds.includes(h.id));

  if (activeHolders.length === 0) {
    throw new PositionResolverError(
      400,
      'POSITION_HOLDER_NOT_FOUND',
      `承認ルートを生成できません。役職「${position.name}」に有効な担当者が設定されていません。`
    );
  }

  if (activeHolders.length > 1) {
    throw new PositionResolverError(
      400,
      'POSITION_HOLDER_AMBIGUOUS',
      `承認ルートを生成できません。役職「${position.name}」に有効な担当者が複数名存在します（一意に決定できません）。`
    );
  }

  return {
    userId: activeHolders[0].id,
    displayName: activeHolders[0].display_name,
    positionCode: activeHolders[0].position_code,
    positionName: activeHolders[0].position_name,
  };
}
