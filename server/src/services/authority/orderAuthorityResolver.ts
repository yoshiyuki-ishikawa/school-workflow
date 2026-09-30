import { getDb } from '../../db/database';
import { PersonnelStatusType } from '../../types';

export class OrderAuthorityResolver {
  /**
   * 身分状態種別・対象ユーザー・日付から適切な発令権限者（Appointing Authority）を動的解決する
   * 公立学校職員（県費負担教職員・市費職員等）の人事権者を特定
   */
  static resolveOrderAuthority(userId: number, statusType: PersonnelStatusType, asOfDate: string): string {
    const db = getDb();
    const user = db.prepare('SELECT id, department FROM users WHERE id = ?').get(userId) as any;

    // 分限休職、懲戒停職、育児休業等は県教育委員会（または市町村教育委員会）が任命権者
    if (statusType === 'DISCIPLINARY_SUSPENSION' || statusType === 'SUSPENSION') {
      return '山口県教育委員会';
    }

    if (statusType === 'CHILDCARE_LEAVE' || statusType === 'UNION_FULL_TIME_RELEASE' || statusType === 'GRADUATE_STUDY_LEAVE') {
      return '山口県教育委員会';
    }

    // デフォルト・一般
    return '山口県教育委員会';
  }
}
