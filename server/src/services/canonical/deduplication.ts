import { CanonicalServiceFact } from './types';

export interface DeduplicationDiagnosticInfo {
  existingFact: CanonicalServiceFact;
  duplicateFact: CanonicalServiceFact;
  factId: string;
  targetDate: string;
  adapterName?: string;
  sourceTable: string;
  sourceId: string | number;
}

export class DuplicateCanonicalFactError extends Error {
  public readonly diagnostic: DeduplicationDiagnosticInfo;

  constructor(diagnostic: DeduplicationDiagnosticInfo) {
    super(
      `[DUPLICATE_CANONICAL_FACT_ERROR] Canonical Fact Identity 重複を検知しました (Fail-Closed)。` +
      ` FactId: ${diagnostic.factId}, Date: ${diagnostic.targetDate}, Source: ${diagnostic.sourceTable}#${diagnostic.sourceId}`
    );
    this.name = 'DuplicateCanonicalFactError';
    this.diagnostic = diagnostic;
  }
}

/**
 * Fail-Closed Canonical Fact 重複排除・検知レジストリ
 */
export class CanonicalFactDeduplicationRegistry {
  private factMap = new Map<string, CanonicalServiceFact>();

  /**
   * Fact を登録 (重複時は即座に Fail-Closed エラーをスローし、Silent Drop を禁止)
   */
  public register(fact: CanonicalServiceFact, adapterName?: string): void {
    if (this.factMap.has(fact.factId)) {
      const existing = this.factMap.get(fact.factId)!;
      throw new DuplicateCanonicalFactError({
        existingFact: existing,
        duplicateFact: fact,
        factId: fact.factId,
        targetDate: fact.targetDate,
        adapterName,
        sourceTable: fact.sourceTable,
        sourceId: fact.sourceId
      });
    }

    this.factMap.set(fact.factId, fact);
  }

  /**
   * 複数 Fact を一括登録 (重複検知時は Fail-Closed)
   */
  public registerAll(facts: CanonicalServiceFact[], adapterName?: string): void {
    for (const f of facts) {
      this.register(f, adapterName);
    }
  }

  /**
   * 登録済み Fact の一覧を取得
   */
  public getFacts(): CanonicalServiceFact[] {
    return Array.from(this.factMap.values());
  }

  /**
   * 指定日の Fact のみを取得
   */
  public getFactsForDate(targetDate: string): CanonicalServiceFact[] {
    return this.getFacts().filter(f => f.targetDate === targetDate);
  }

  /**
   * レジストリをクリア
   */
  public clear(): void {
    this.factMap.clear();
  }
}
