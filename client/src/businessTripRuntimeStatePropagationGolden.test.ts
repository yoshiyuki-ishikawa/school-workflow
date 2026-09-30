import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Business Trip Single Application Runtime State Propagation Golden Test Suite
 * 
 * Formal Verification of Diff-Guarded State Propagation
 * Implementation Plan v1.0 FINAL (GT-BT-RUNTIME-01 〜 GT-BT-RUNTIME-05)
 */

interface TripState {
  destination: string;
  purpose: string;
  startDate: string;
  endDate: string;
  departurePlace: string;
  arrivalPlace: string;
  transport: string;
  transportOther: string;
  privateCarReason: string;
  fundingSource: string;
  fundingSourceOther: string;
  isExpenseClaimed: boolean;
  isOralOrder: boolean;
  oralOrderIssuedAt: string;
}

/**
 * React ライフサイクルと NewApplicationModal の State Propagation を再現するテストハーネス
 */
class ApplicationModalStateHarness {
  // Local useState variables in NewApplicationModal
  state: TripState;

  // React State Update Batch Queue
  queue: Array<{ field: keyof TripState; value: any }> = [];

  // Track invocation counts of each setter for GT-BT-RUNTIME-03
  setterCallCounts: Record<keyof TripState, number> = {
    destination: 0,
    purpose: 0,
    startDate: 0,
    endDate: 0,
    departurePlace: 0,
    arrivalPlace: 0,
    transport: 0,
    transportOther: 0,
    privateCarReason: 0,
    fundingSource: 0,
    fundingSourceOther: 0,
    isExpenseClaimed: 0,
    isOralOrder: 0,
    oralOrderIssuedAt: 0,
  };

  constructor(initialState?: Partial<TripState>) {
    this.state = {
      destination: '',
      purpose: '',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      departurePlace: '本校',
      arrivalPlace: '本校',
      transport: '公用車',
      transportOther: '',
      privateCarReason: '',
      fundingSource: '県費',
      fundingSourceOther: '',
      isExpenseClaimed: false,
      isOralOrder: false,
      oralOrderIssuedAt: '',
      ...initialState,
    };
  }

  /**
   * NewApplicationModal.tsx の onUpdateTrip 実装 (Diff-Guarded State Propagation)
   */
  onUpdateTrip(updater: (prev: TripState) => TripState) {
    // レンダリング時点のクロージャから current を構築
    const current: TripState = { ...this.state };
    const next = typeof updater === 'function' ? updater(current) : updater;

    // Diff-Guarded State Propagation (Line 1361-1374)
    if (next.destination !== undefined && next.destination !== current.destination) {
      this.setterCallCounts.destination++;
      this.queue.push({ field: 'destination', value: next.destination });
    }
    if (next.purpose !== undefined && next.purpose !== current.purpose) {
      this.setterCallCounts.purpose++;
      this.queue.push({ field: 'purpose', value: next.purpose });
    }
    if (next.startDate !== undefined && next.startDate !== current.startDate) {
      this.setterCallCounts.startDate++;
      this.queue.push({ field: 'startDate', value: next.startDate });
    }
    if (next.endDate !== undefined && next.endDate !== current.endDate) {
      this.setterCallCounts.endDate++;
      this.queue.push({ field: 'endDate', value: next.endDate });
    }
    if (next.departurePlace !== undefined && next.departurePlace !== current.departurePlace) {
      this.setterCallCounts.departurePlace++;
      this.queue.push({ field: 'departurePlace', value: next.departurePlace });
    }
    if (next.arrivalPlace !== undefined && next.arrivalPlace !== current.arrivalPlace) {
      this.setterCallCounts.arrivalPlace++;
      this.queue.push({ field: 'arrivalPlace', value: next.arrivalPlace });
    }
    if (next.transport !== undefined && next.transport !== current.transport) {
      this.setterCallCounts.transport++;
      this.queue.push({ field: 'transport', value: next.transport });
    }
    if (next.transportOther !== undefined && next.transportOther !== current.transportOther) {
      this.setterCallCounts.transportOther++;
      this.queue.push({ field: 'transportOther', value: next.transportOther });
    }
    if (next.privateCarReason !== undefined && next.privateCarReason !== current.privateCarReason) {
      this.setterCallCounts.privateCarReason++;
      this.queue.push({ field: 'privateCarReason', value: next.privateCarReason });
    }
    if (next.fundingSource !== undefined && next.fundingSource !== current.fundingSource) {
      this.setterCallCounts.fundingSource++;
      this.queue.push({ field: 'fundingSource', value: next.fundingSource });
    }
    if (next.fundingSourceOther !== undefined && next.fundingSourceOther !== current.fundingSourceOther) {
      this.setterCallCounts.fundingSourceOther++;
      this.queue.push({ field: 'fundingSourceOther', value: next.fundingSourceOther });
    }
    if (next.isExpenseClaimed !== undefined && next.isExpenseClaimed !== current.isExpenseClaimed) {
      this.setterCallCounts.isExpenseClaimed++;
      this.queue.push({ field: 'isExpenseClaimed', value: next.isExpenseClaimed });
    }
    if (next.isOralOrder !== undefined && next.isOralOrder !== current.isOralOrder) {
      this.setterCallCounts.isOralOrder++;
      this.queue.push({ field: 'isOralOrder', value: next.isOralOrder });
    }
    if (next.oralOrderIssuedAt !== undefined && next.oralOrderIssuedAt !== current.oralOrderIssuedAt) {
      this.setterCallCounts.oralOrderIssuedAt++;
      this.queue.push({ field: 'oralOrderIssuedAt', value: next.oralOrderIssuedAt });
    }
  }

  /**
   * React Automatic Batching Flush (イベント完了後の再レンダリングをシミュレート)
   */
  flush() {
    for (const update of this.queue) {
      (this.state as any)[update.field] = update.value;
    }
    this.queue = [];
  }

  /**
   * DedicatedRendererRegistry.ts のバインディング
   */
  getDedicatedProps() {
    return {
      transport: this.state.transport,
      setTransport: (val: string) => this.onUpdateTrip((prev) => ({ ...prev, transport: val })),
      transportOther: this.state.transportOther || '',
      setTransportOther: (val: string) => this.onUpdateTrip((prev) => ({ ...prev, transportOther: val })),
      fundingSource: this.state.fundingSource || '県費',
      setFundingSource: (val: string) => this.onUpdateTrip((prev) => ({ ...prev, fundingSource: val })),
      fundingSourceOther: this.state.fundingSourceOther || '',
      setFundingSourceOther: (val: string) => this.onUpdateTrip((prev) => ({ ...prev, fundingSourceOther: val })),
      departurePlace: this.state.departurePlace,
      setDeparturePlace: (val: string) => this.onUpdateTrip((prev) => ({ ...prev, departurePlace: val })),
      isOralOrder: this.state.isOralOrder,
      setIsOralOrder: (val: boolean) => this.onUpdateTrip((prev) => ({ ...prev, isOralOrder: val })),
    };
  }
}

describe('Business Trip Single Application Runtime State Propagation Golden Suite (GT-BT-RUNTIME-01〜05)', () => {
  // =========================================================================
  // GT-BT-RUNTIME-01: Transport Change-Event Batch Race Protection
  // =========================================================================
  it('GT-BT-RUNTIME-01: 交通手段を公用車から自家用車へ変更時、同一同期イベントでsetTransportOtherが発火しても最終stateが自家用車として保持されること', () => {
    const harness = new ApplicationModalStateHarness({ transport: '公用車', transportOther: '' });
    const props = harness.getDedicatedProps();

    // ユーザーが BusinessTripFormSection の <select> で「自家用車」を選択した瞬間のイベントハンドラ挙動 (L167-173)
    const val: string = '自家用車';
    // 1st callback
    props.setTransport(val);
    // 2nd callback in same synchronous event (val !== 'その他' && setTransportOther)
    if (val !== 'その他' && props.setTransportOther) {
      props.setTransportOther('');
    }

    // イベント終了後の React バッチ処理フラッシュ
    harness.flush();

    // 最終ステートが '自家用車' として保持されていることを確認
    assert.strictEqual(
      harness.state.transport,
      '自家用車',
      'Final transport state must remain 自家用車 and NOT be reverted to 公用車'
    );
    assert.strictEqual(harness.state.transportOther, '');
  });

  // =========================================================================
  // GT-BT-RUNTIME-02: Funding Source Change-Event Batch Race Protection
  // =========================================================================
  it('GT-BT-RUNTIME-02: 旅費財源を県費から市費へ変更時、同一同期イベントでsetFundingSourceOtherが発火しても最終stateが市費として保持されること', () => {
    const harness = new ApplicationModalStateHarness({ fundingSource: '県費', fundingSourceOther: '' });
    const props = harness.getDedicatedProps();

    // ユーザーが BusinessTripFormSection の <select> で「市費」を選択した瞬間のイベントハンドラ挙動 (L211-217)
    const val: string = '市費';
    // 1st callback
    props.setFundingSource(val);
    // 2nd callback in same synchronous event (val !== 'その他' && setFundingSourceOther)
    if (val !== 'その他' && props.setFundingSourceOther) {
      props.setFundingSourceOther('');
    }

    // イベント終了後の React バッチ処理フラッシュ
    harness.flush();

    // 最終ステートが '市費' として保持されていることを確認
    assert.strictEqual(
      harness.state.fundingSource,
      '市費',
      'Final fundingSource state must remain 市費 and NOT be reverted to 県費'
    );
    assert.strictEqual(harness.state.fundingSourceOther, '');
  });

  // =========================================================================
  // GT-BT-RUNTIME-03: Diff-Guarded Execution Invariant
  // =========================================================================
  it('GT-BT-RUNTIME-03: 単一フィールドのみ変更時、変更されていない他13フィールドのsetterが不要に呼び出されないこと', () => {
    const harness = new ApplicationModalStateHarness();

    // destination のみを更新
    harness.onUpdateTrip((prev) => ({ ...prev, destination: '山口市教育センター' }));

    // destination の setter のみが呼び出され、他フィールドは 0 回であること
    assert.strictEqual(harness.setterCallCounts.destination, 1, 'destination setter must be called once');
    assert.strictEqual(harness.setterCallCounts.transport, 0, 'transport setter must NOT be called');
    assert.strictEqual(harness.setterCallCounts.fundingSource, 0, 'fundingSource setter must NOT be called');
    assert.strictEqual(harness.setterCallCounts.departurePlace, 0, 'departurePlace setter must NOT be called');
    assert.strictEqual(harness.setterCallCounts.isOralOrder, 0, 'isOralOrder setter must NOT be called');
    assert.strictEqual(harness.setterCallCounts.startDate, 0, 'startDate setter must NOT be called');
  });

  // =========================================================================
  // GT-BT-RUNTIME-04: OTHER Transition and Input Stability
  // =========================================================================
  it('GT-BT-RUNTIME-04: その他選択後に詳細を入力し、その後別フィールドを変更しても交通手段および詳細値が保持されること', () => {
    const harness = new ApplicationModalStateHarness();
    const props = harness.getDedicatedProps();

    // Step 1: 交通手段を「その他」に選択
    props.setTransport('その他');
    harness.flush();
    assert.strictEqual(harness.state.transport, 'その他');

    // Step 2: 詳細に「定期船」を入力
    props.setTransportOther('定期船');
    harness.flush();
    assert.strictEqual(harness.state.transportOther, '定期船');

    // Step 3: 別フィールド（出発地）を「自宅」に変更
    props.setDeparturePlace('自宅');
    harness.flush();

    // 交通手段および詳細入力値が初期化されずに保持されていること
    assert.strictEqual(harness.state.transport, 'その他', 'transport must remain その他');
    assert.strictEqual(harness.state.transportOther, '定期船', 'transportOther must remain 定期船');
    assert.strictEqual(harness.state.departurePlace, '自宅', 'departurePlace must be updated to 自宅');
  });

  // =========================================================================
  // GT-BT-RUNTIME-05: Falsy / Empty Clear Preservation
  // =========================================================================
  it('GT-BT-RUNTIME-05: isOralOrder の true -> false 変更および transportOther の空文字クリアが Diff Guard により阻害されないこと', () => {
    const harness = new ApplicationModalStateHarness({
      isOralOrder: true,
      oralOrderIssuedAt: '2026-06-15T09:00',
      transport: 'その他',
      transportOther: 'タクシー',
    });
    const props = harness.getDedicatedProps();

    // 1. isOralOrder: true -> false への変更 (Falsy 値)
    props.setIsOralOrder(false);
    harness.flush();
    assert.strictEqual(harness.state.isOralOrder, false, 'isOralOrder must be updated to false');

    // 2. transportOther: 'タクシー' -> '' へのクリア (Empty String)
    props.setTransportOther('');
    harness.flush();
    assert.strictEqual(harness.state.transportOther, '', 'transportOther must be cleared to empty string');
  });
});
