export class AuthorizationInvariantError extends Error {
  statusCode: number;
  errorCode: string;

  constructor(errorCode: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AuthorizationInvariantError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export interface CanonicalPositionAssignment {
  assignmentId?: number;
  positionId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  isPrimary?: boolean;
}

export interface UserAuthorizationState {
  userId: number;
  roles: string[];
  positions: CanonicalPositionAssignment[];
  referenceDate?: string; // YYYY-MM-DD (Defaults to today)
}

/**
 * Shared Server-Side Authorization Invariant
 * 
 * 全Server-Side Mutation Path (Unified Command, PUT roles, POST positions, end, correct) で
 * 共通して実行される認可・組織役職不変条件バリデーター。
 * 
 * Frozen Invariants (v1.1):
 * 1. PRINCIPAL 役職保持者 -> PRINCIPAL ロール必須
 * 2. VICE_PRINCIPAL_1 役職保持者 -> VICE_PRINCIPAL ロール必須
 * 3. VICE_PRINCIPAL_2 役職保持者 -> VICE_PRINCIPAL ロール必須
 * 4. CHIEF_TEACHER 役職保持者 -> TEACHER ロール必須 (CT-A)
 * 5. OFFICE_HEAD 役職保持者 -> OFFICE ロール必須
 * 6. ロールは最低1つ必須 (空配列禁止)
 * 7. ADMIN ロールと学校業務役職の兼務は技術的に許可 (SoD現行ポリシー)
 */
export function validateUserAuthorizationInvariant(state: UserAuthorizationState): void {
  const { roles, positions, referenceDate } = state;

  // I-00: ロールは1つ以上必須
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new AuthorizationInvariantError('INVALID_ROLE', '保有ロールを1つ以上指定してください');
  }

  const today = referenceDate || new Date().toISOString().split('T')[0];

  // 基準日時点で現在有効なPositionのみを抽出して適合性を検証
  const activePositions = positions.filter((p) => {
    const from = p.effectiveFrom;
    const to = p.effectiveTo;
    return from <= today && (!to || to === '9999-12-31' || to >= today);
  });

  for (const pos of activePositions) {
    if (pos.positionId === 'PRINCIPAL') {
      if (!roles.includes('PRINCIPAL')) {
        throw new AuthorizationInvariantError(
          'AUTHORIZATION_INCOMPATIBLE',
          '役職「校長（PRINCIPAL）」には PRINCIPAL ロールが必要です'
        );
      }
    } else if (pos.positionId === 'VICE_PRINCIPAL_1' || pos.positionId === 'VICE_PRINCIPAL_2') {
      if (!roles.includes('VICE_PRINCIPAL')) {
        throw new AuthorizationInvariantError(
          'AUTHORIZATION_INCOMPATIBLE',
          `役職「${pos.positionId === 'VICE_PRINCIPAL_1' ? '第1教頭' : '第2教頭'}」には VICE_PRINCIPAL ロールが必要です`
        );
      }
    } else if (pos.positionId === 'CHIEF_TEACHER') {
      if (!roles.includes('TEACHER')) {
        throw new AuthorizationInvariantError(
          'AUTHORIZATION_INCOMPATIBLE',
          '役職「教務主任（CHIEF_TEACHER）」には TEACHER ロールが必要です'
        );
      }
    } else if (pos.positionId === 'OFFICE_HEAD') {
      if (!roles.includes('OFFICE')) {
        throw new AuthorizationInvariantError(
          'AUTHORIZATION_INCOMPATIBLE',
          '役職「事務主幹（OFFICE_HEAD）」には OFFICE ロールが必要です'
        );
      }
    }
  }
}
