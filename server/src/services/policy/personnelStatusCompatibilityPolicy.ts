import { PersonnelStatusType } from '../../types';

export type OverlapPolicy = 'EXCLUSIVE' | 'COMPATIBLE' | 'FAIL_CLOSED';

export type TransitionPolicy =
  | 'REPLACE_CURRENT'
  | 'EXTEND_CURRENT'
  | 'SHORTEN_CURRENT'
  | 'RETURN_TO_DUTY'
  | 'EXPLICIT_END_REQUIRED'
  | 'DISALLOWED';

export type OpenEndedPolicy =
  | 'EXPLICIT_END_REQUIRED'
  | 'ALLOW_INDEFINITE'
  | 'DISALLOWED';

export class PersonnelStatusCompatibilityPolicy {
  /**
   * 2つの人事身分状態が同日・同期間に重複可能か判定 (Overlap Policy)
   * 地方公務員法・学校職員勤務条例上、身分状態は原則排他 (EXCLUSIVE)
   */
  static getOverlapPolicy(typeA: PersonnelStatusType, typeB: PersonnelStatusType): OverlapPolicy {
    if (typeA === typeB) {
      return 'EXCLUSIVE';
    }
    // 全ての人事身分状態は排他
    return 'EXCLUSIVE';
  }

  /**
   * 身分状態間の遷移ルール判定 (Transition Policy)
   */
  static getTransitionPolicy(currentType: PersonnelStatusType, nextType: PersonnelStatusType): TransitionPolicy {
    if (currentType === nextType) {
      return 'EXTEND_CURRENT';
    }

    // 例: 停職と育休の切り替えや、休職から他休職への直接移行は通常明示的終了が必要
    return 'EXPLICIT_END_REQUIRED';
  }

  /**
   * effective_to = NULL (無期限/終了日未定) の身分状態に対する遷移・後続登録ポリシー
   * Default: EXPLICIT_END_REQUIRED
   */
  static getOpenEndedTransitionPolicy(statusType: PersonnelStatusType): OpenEndedPolicy {
    // 専従休職や特定の休職で終了日未定の場合、後続登録には明示的終了 (ENDED/RETURN_TO_DUTY) または AMEND が必要
    return 'EXPLICIT_END_REQUIRED';
  }
}
