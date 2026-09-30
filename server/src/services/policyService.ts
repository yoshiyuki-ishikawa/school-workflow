import { getDb } from '../db/database';
import { PolicyRule } from '../types';

export class PolicyService {
  /**
   * 該当日に有効なPolicyRuleを取得
   */
  static getEffectiveRule(policyCode: string, targetDate: string, authorityId = 'DEFAULT_MUNICIPALITY'): PolicyRule | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM policy_rules
      WHERE policy_code = ? AND authority_id = ?
        AND effective_from <= ? AND effective_to >= ?
        AND is_active = 1
      ORDER BY version DESC LIMIT 1
    `).get(policyCode, authorityId, targetDate, targetDate) as PolicyRule | undefined;

    return row || null;
  }

  /**
   * ルール一覧取得
   */
  static getAllRules(authorityId = 'DEFAULT_MUNICIPALITY'): PolicyRule[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM policy_rules
      WHERE authority_id = ? AND is_active = 1
      ORDER BY policy_code, version DESC
    `).all(authorityId) as PolicyRule[];
  }

  /**
   * 新バージョンルールの登録 (原則Immutable: 既存更新ではなく新バージョン作成)
   */
  static createNewRuleVersion(rule: Omit<PolicyRule, 'id' | 'created_at' | 'is_active'>, previousRuleId?: number): number {
    const db = getDb();
    return db.transaction(() => {
      if (previousRuleId) {
        // 旧ルールの終了日を新ルールの開始日前日に設定
        const prev = db.prepare('SELECT * FROM policy_rules WHERE id = ?').get(previousRuleId) as PolicyRule | undefined;
        if (prev) {
          const prevEndDate = new Date(new Date(rule.effective_from).getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          db.prepare('UPDATE policy_rules SET effective_to = ? WHERE id = ?').run(prevEndDate, previousRuleId);
        }
      }

      const stmt = db.prepare(`
        INSERT INTO policy_rules (
          policy_code, authority_id, version, official_name, display_code,
          aggregation_category, max_minutes_per_day, effective_from, effective_to, rule_definition_json, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);

      const result = stmt.run(
        rule.policy_code,
        rule.authority_id,
        rule.version,
        rule.official_name,
        rule.display_code,
        rule.aggregation_category,
        rule.max_minutes_per_day,
        rule.effective_from,
        rule.effective_to,
        rule.rule_definition_json
      );

      return Number(result.lastInsertRowid);
    })();
  }
}
