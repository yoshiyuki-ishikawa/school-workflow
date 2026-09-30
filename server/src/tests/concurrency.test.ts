import { getDb, initDatabase, seedDatabase } from '../db';
import { WorkflowEngine, UserContext } from '../workflow/engine';

/**
 * D. Concurrency Test
 * 楽観的排他制御 (Optimistic Locking / version) によるロストアップデート防止と 409 Conflict を検証
 */
export function runConcurrencyTest(): boolean {
  console.log('--- [Test D: Concurrency Test] 開始 ---');
  initDatabase();
  seedDatabase();
  const db = getDb();

  const teacherA: UserContext = {
    id: 1,
    username: 'teacher1',
    displayName: '山田 太郎 (教員A)',
    roles: ['TEACHER'],
    ipAddress: '127.0.0.1',
  };

  const vicePrincipal: UserContext = {
    id: 3,
    username: 'vice_principal',
    displayName: '田中 誠 (教頭B)',
    roles: ['VICE_PRINCIPAL', 'TEACHER'],
    ipAddress: '127.0.0.1',
  };

  // 1. 申請作成
  const submitRes = WorkflowEngine.submitApplication(teacherA, {
    typeId: 'LEAVE_ANNUAL',
    title: '【競合テスト用年休】',
    formData: { startDate: '2026-10-01', endDate: '2026-10-01', unitType: 'DAY', calculatedDays: 1 },
  });
  const appId = submitRes.data.id;
  const initialApp = db.prepare('SELECT version FROM applications WHERE id = ?').get(appId) as any;
  const initialVersion = initialApp.version;

  console.log(`✔ 初期申請作成完了 (申請ID: ${appId}, 初期version: ${initialVersion})`);

  // 2. 先行更新: 教頭による承認操作 (version 照合: 1 -> 2)
  const firstAction = WorkflowEngine.approveApplication(vicePrincipal, {
    applicationId: appId,
    expectedVersion: initialVersion, // 1
    comment: '先行クライアントによる承認',
  });
  if (!firstAction.success) {
    throw new Error(`先行更新に失敗しました: ${firstAction.message}`);
  }
  console.log('✔ 先行更新 (承認): 成功 (version がインクリメントされました)');

  // 3. 後続更新: 古いバージョン (1) を持ったまま別の操作（差戻し等）を試行 -> 409 Conflict
  const conflictAction = WorkflowEngine.returnApplication(vicePrincipal, {
    applicationId: appId,
    expectedVersion: initialVersion, // 1 (古いversion)
    comment: '遅れて到着した差戻しリクエスト',
  });

  if (conflictAction.statusCode !== 409) {
    throw new Error(`後続競合リクエストが 409 Conflict で遮断されませんでした (status: ${conflictAction.statusCode})`);
  }
  console.log('✔ 後続更新 (古いversion指定): 409 Conflict で確実に遮断されました');

  // 4. 複数名一括出張における整合性検証
  const batchRes = WorkflowEngine.submitBatchTrip(vicePrincipal, {
    title: '修学旅行引率 (競合検証)',
    purpose: '修学旅行指導',
    destination: '京都・奈良',
    startAt: '2026-10-15T08:00:00',
    endAt: '2026-10-17T17:00:00',
    transport: '新幹線・貸切バス',
    participantUserIds: [1, 2],
  });
  if (!batchRes.success) {
    throw new Error(`一括出張作成に失敗しました: ${batchRes.message}`);
  }
  const tripEventId = batchRes.data.tripEventId;
  const generatedAppIds = batchRes.data.generatedAppIds;

  console.log(`✔ 一括出張作成成功 (Event ID: ${tripEventId}, 生成申請数: ${generatedAppIds.length})`);

  // 各生成申請の独立したバージョン検証
  for (const aId of generatedAppIds) {
    const aRecord = db.prepare('SELECT * FROM applications WHERE id = ?').get(aId) as any;
    if (aRecord.version !== 1 || aRecord.trip_event_id !== tripEventId) {
      throw new Error(`一括生成申請の整合性不正: ${JSON.stringify(aRecord)}`);
    }
  }
  console.log('✔ 一括出張生成申請の独立 version 整合性完全 (OK)');

  console.log('--- [Test D: Concurrency Test] 合格 (PASS) ---\n');
  return true;
}

if (require.main === module) {
  runConcurrencyTest();
}
