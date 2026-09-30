import bcrypt from 'bcryptjs';
import { getDb } from './database';
import { getServerIsoString } from '../utils/serverTime';

export function seedDatabase(): void {
  const db = getDb();
  const now = getServerIsoString();

  const runSeed = db.transaction(() => {
    // 1. ロール
    const insertRole = db.prepare('INSERT OR IGNORE INTO roles (id, name) VALUES (?, ?)');
    insertRole.run('TEACHER', '一般教職員');
    insertRole.run('VICE_PRINCIPAL', '教頭 (一次承認者)');
    insertRole.run('PRINCIPAL', '校長 (最終決裁者)');
    insertRole.run('OFFICE', '事務室 (出張・旅費・服務事務係)');
    insertRole.run('ADMIN', 'システム管理者 (IT運用・セキュリティ保守)');

    // 1.0.1 権限マスタ (Application Initiation Capability: HD-NAE-04)
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, description) VALUES (?, ?)');
    insertPerm.run('application.create.self', '本人自身の通常申請起案権限');
    insertPerm.run('application.create.proxy', '管理職・事務等による代理起案権限');
    insertPerm.run('application.create.batch', '複数名一括出張等の起案権限');
    insertPerm.run('user.credential.reset', '教職員アカウントのパスワード初期化・一時パスワード発行権限');
    insertPerm.run('job_title.master.manage', '正式職名マスタの作成・更新・新規割当停止の管理権限');
    insertPerm.run('job_title.assignment.manage', '教職員への正式職名発令・履歴登録・訂正権限');

    const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    // HD-NAE-04: TEACHER = SELF
    insertRolePerm.run('TEACHER', 'application.create.self');
    // HD-NAE-04: OFFICE = SELF + PROXY + BATCH
    insertRolePerm.run('OFFICE', 'application.create.self');
    insertRolePerm.run('OFFICE', 'application.create.proxy');
    insertRolePerm.run('OFFICE', 'application.create.batch');
    // HD-NAE-04: VICE_PRINCIPAL = SELF + PROXY + BATCH
    insertRolePerm.run('VICE_PRINCIPAL', 'application.create.self');
    insertRolePerm.run('VICE_PRINCIPAL', 'application.create.proxy');
    insertRolePerm.run('VICE_PRINCIPAL', 'application.create.batch');
    // HD-NAE-04: PRINCIPAL = SELF + PROXY + BATCH
    insertRolePerm.run('PRINCIPAL', 'application.create.self');
    insertRolePerm.run('PRINCIPAL', 'application.create.proxy');
    insertRolePerm.run('PRINCIPAL', 'application.create.batch');
    // HD-NAE-04: ADMIN = user.credential.reset + job_title.*
    insertRolePerm.run('ADMIN', 'user.credential.reset');
    insertRolePerm.run('ADMIN', 'job_title.master.manage');
    insertRolePerm.run('ADMIN', 'job_title.assignment.manage');

    // 1.0.2 正式職名マスタ (山口県公立学校向け初期デフォルト14職名)
    const insertJobTitle = db.prepare(`
      INSERT OR IGNORE INTO official_job_titles (id, code, display_name, sort_order, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    const initialTitles = [
      { id: 'JOB_TITLE_PRINCIPAL', code: 'PRINCIPAL', name: '校長', sort: 10, desc: '学校の校務をつかさどる' },
      { id: 'JOB_TITLE_VICE_PRINCIPAL', code: 'VICE_PRINCIPAL', name: '教頭', sort: 20, desc: '校長を助け、校務を整理し、及び必要に応じ授業をつかさどる' },
      { id: 'JOB_TITLE_TEACHER', code: 'TEACHER', name: '教諭', sort: 30, desc: '児童生徒の教育をつかさどる' },
      { id: 'JOB_TITLE_ASSISTANT_TEACHER', code: 'ASSISTANT_TEACHER', name: '助教諭', sort: 40, desc: '教諭の職務を助ける' },
      { id: 'JOB_TITLE_LECTURER', code: 'LECTURER', name: '講師', sort: 50, desc: '教諭又は助教諭に準ずる職務に従事する' },
      { id: 'JOB_TITLE_NURSE_TEACHER', code: 'NURSE_TEACHER', name: '養護教諭', sort: 60, desc: '児童生徒の養護をつかさどる' },
      { id: 'JOB_TITLE_ASSISTANT_NURSE_TEACHER', code: 'ASSISTANT_NURSE_TEACHER', name: '養護助教諭', sort: 70, desc: '養護教諭の職務を助ける' },
      { id: 'JOB_TITLE_NUTRITION_TEACHER', code: 'NUTRITION_TEACHER', name: '栄養教諭', sort: 80, desc: '児童生徒の栄養の指導及び学校給食の管理をつかさどる' },
      { id: 'JOB_TITLE_NUTRITIONIST', code: 'NUTRITIONIST', name: '学校栄養職員', sort: 90, desc: '学校給食に関する栄養管理等の専門的事務をつかさどる' },
      { id: 'JOB_TITLE_OFFICE_DIRECTOR', code: 'OFFICE_DIRECTOR', name: '事務長', sort: 100, desc: '学校事務を総括し、事務職員その他の職員を指揮監督する' },
      { id: 'JOB_TITLE_HEAD_CLERK', code: 'HEAD_CLERK', name: '主査', sort: 110, desc: '高度の専門的知識及び経験を必要とする学校事務をつかさどる' },
      { id: 'JOB_TITLE_CLERK_DIRECTOR', code: 'CLERK_DIRECTOR', name: '事務主任', sort: 120, desc: '特定の学校事務をつかさどり、事務を整理する' },
      { id: 'JOB_TITLE_SENIOR_CLERK', code: 'SENIOR_CLERK', name: '主任主事', sort: 130, desc: '専門的知識及び経験を必要とする学校事務をつかさどる' },
      { id: 'JOB_TITLE_CLERK', code: 'CLERK', name: '主事', sort: 140, desc: '学校事務をつかさどる' },
    ];
    for (const t of initialTitles) {
      insertJobTitle.run(t.id, t.code, t.name, t.sort, t.desc);
    }


    // 1.1 ポジション（役職・職階）
    const insertPos = db.prepare('INSERT OR REPLACE INTO positions (id, name, rank_order, description) VALUES (?, ?, ?, ?)');
    insertPos.run('CHIEF_TEACHER', '教務主任', 40, '校務分掌統括・教務管理');
    insertPos.run('VICE_PRINCIPAL_1', '第1教頭', 20, '主幹教頭・学校運営統括補佐');
    insertPos.run('VICE_PRINCIPAL_2', '第2教頭', 25, '副教頭・教務・生徒指導統括補佐');
    insertPos.run('PRINCIPAL', '校長', 10, '学校代表・最終決裁者');
    insertPos.run('OFFICE_HEAD', '事務主幹', 30, '事務室統括・財務服務管理');

    db.prepare('DELETE FROM user_positions').run();

    // 2. 承認ルートマスタ
    // ルート1: 休暇用2段階決裁ルート (教頭確認 → 校長決裁)
    const existingRoute1 = db.prepare('SELECT id FROM approval_routes WHERE id = 1').get();
    if (!existingRoute1) {
      db.prepare('INSERT INTO approval_routes (id, name, description) VALUES (?, ?, ?)').run(
        1,
        '休暇用2段階決裁ルート (教頭確認 → 校長決裁)',
        '休暇申請（年休・病休・特休・職専免）の標準2段階フロー'
      );
    }
    db.prepare('DELETE FROM approval_route_steps WHERE route_id = 1').run();
    const insertStep1 = db.prepare(`
      INSERT INTO approval_route_steps (route_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep1.run(1, 1, '教頭一次確認', 'VP_STEP', 'VICE_PRINCIPAL', 'ROLE', 'VICE_PRINCIPAL');
    insertStep1.run(1, 2, '校長最終決裁', 'PRINCIPAL_STEP', 'PRINCIPAL', 'ROLE', 'PRINCIPAL');

    // ルート2: 出張用3段階決裁ルート (教頭確認 → 校長決裁 → 事務係確認)
    const existingRoute2 = db.prepare('SELECT id FROM approval_routes WHERE id = 2').get();
    if (!existingRoute2) {
      db.prepare('INSERT INTO approval_routes (id, name, description) VALUES (?, ?, ?)').run(
        2,
        '出張用3段階決裁ルート (教頭確認 → 校長決裁 → 事務係確認)',
        '出張申請（旅行命令）の3段階決裁フロー'
      );
    }
    db.prepare('DELETE FROM approval_route_steps WHERE route_id = 2').run();
    const insertStep2 = db.prepare(`
      INSERT INTO approval_route_steps (route_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep2.run(2, 1, '教頭確認 (旅行命令権者)', 'VP_TRIP_STEP', 'VICE_PRINCIPAL', 'ROLE', 'VICE_PRINCIPAL');
    insertStep2.run(2, 2, '校長決裁 (旅行命令権者)', 'PRINCIPAL_TRIP_STEP', 'PRINCIPAL', 'ROLE', 'PRINCIPAL');
    insertStep2.run(2, 3, '事務係確認 (出張・旅費係)', 'OFFICE_STEP', 'OFFICE', 'ROLE', 'OFFICE');

    // ルート3: 大規模校用4段階決裁ルート (教務主任 → 第1教頭 → 第2教頭 → 校長)
    const existingRoute3 = db.prepare('SELECT id FROM approval_routes WHERE id = 3').get();
    if (!existingRoute3) {
      db.prepare('INSERT INTO approval_routes (id, name, description) VALUES (?, ?, ?)').run(
        3,
        '大規模校用4段階決裁ルート (教務主任 → 第1教頭 → 第2教頭 → 校長)',
        '大規模校における標準4段階決裁フロー'
      );
    }
    db.prepare('DELETE FROM approval_route_steps WHERE route_id = 3').run();
    const insertStep3 = db.prepare(`
      INSERT INTO approval_route_steps (route_id, step_order, step_name, step_key, required_role_id, selector_type, selector_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep3.run(3, 1, '教務主任確認', 'CHIEF_TEACHER_STEP', 'TEACHER', 'POSITION', 'CHIEF_TEACHER');
    insertStep3.run(3, 2, '第1教頭確認', 'VICE_PRINCIPAL_1_STEP', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_1');
    insertStep3.run(3, 3, '第2教頭確認', 'VICE_PRINCIPAL_2_STEP', 'VICE_PRINCIPAL', 'POSITION', 'VICE_PRINCIPAL_2');
    insertStep3.run(3, 4, '校長最終決裁', 'PRINCIPAL_STEP', 'PRINCIPAL', 'POSITION', 'PRINCIPAL');

    // 3. 申請種別マスタ
    const insertType = db.prepare(`
      INSERT OR REPLACE INTO application_types (id, name, description, default_route_id)
      VALUES (?, ?, ?, ?)
    `);
    insertType.run('LEAVE_ANNUAL', '年次有給休暇 (年休)', '1日単位または時間単位の年休申請', 1);
    insertType.run('LEAVE_SICK', '病気休暇 (病休)', '療養・病気通院等の休暇申請 (理由必須)', 1);
    insertType.run('LEAVE_SPECIAL', '特別休暇 (特休)', '忌引・結婚・出産・育児等の休暇申請 (理由必須)', 1);
    insertType.run('LEAVE_DUTY_EXEMPT', '職専免等', '職務専念義務免除等の申請 (研修・公務等 / 理由必須)', 1);
    insertType.run('BUSINESS_TRIP', '出張・校外業務申請', '別表第一 旅行命令・依頼簿 (3段階決裁＋復命書)', 2);
    insertType.run('LEAVE_CHILDCARE', '育児休業請求', '育児休業の請求 (発令連携・出勤簿非勤務)', 1);
    insertType.run('WORK_PATTERN_CHILDCARE', '育児短時間勤務請求', '育児短時間勤務パターンの割振り請求', 1);
    insertType.run('LEAVE_CHILDCARE_PARTIAL', '育児部分休業請求', '1日最大2時間等の部分休業請求 (時間単位)', 1);
    insertType.run('LEAVE_CARE', '介護休暇 (条例第15条)', '要介護状態にある家族を介護するための休暇 (日/半日/1時間単位)', 1);
    insertType.run('LEAVE_CARE_TIME', '介護時間 (条例第16条)', '要介護状態にある家族を介護するための時間 (30分単位 / 1日最大2時間)', 1);
    insertType.run('TRAINING_SPECIAL_ACT_22_2', '教育公務員特例法第22条第2項研修', '勤務場所を離れて行う研修（本属長承認）', 1);
    insertType.run('TRAINING_SPECIAL_ACT_22_3', '教育公務員特例法第22条第3項長期研修', '任命権者の定めるところにより現職のままで受ける長期研修', 1);
    insertType.run('LEAVE_LARGE_SCHOOL', '大規模校用休暇申請', '4段階承認テスト（教務主任→第1教頭→第2教頭→校長）', 3);

    // 3.1 ワークフローポリシー (新Policy基盤 初期シード)
    // 移行によって生成された LEGACY_MIGRATED またはテスト用 CUSTOM ポリシーを安全にクリーンアップ
    const legacyPolicies = db.prepare("SELECT id FROM workflow_policies WHERE policy_source IN ('LEGACY_MIGRATED', 'CUSTOM')").all() as { id: string }[];
    for (const lp of legacyPolicies) {
      const vers = db.prepare('SELECT id FROM workflow_policy_versions WHERE policy_id = ?').all(lp.id) as { id: string }[];
      for (const v of vers) {
        db.prepare('DELETE FROM workflow_policy_steps WHERE policy_version_id = ?').run(v.id);
      }
      db.prepare('DELETE FROM workflow_policy_versions WHERE policy_id = ?').run(lp.id);
      db.prepare('DELETE FROM workflow_policy_application_types WHERE policy_id = ?').run(lp.id);
      db.prepare('DELETE FROM workflow_policies WHERE id = ?').run(lp.id);
    }

    const insertPolicy = db.prepare(`
      INSERT INTO workflow_policies (id, policy_key, policy_name, description, policy_purpose, policy_source)
      VALUES (?, ?, ?, ?, ?, 'SYSTEM')
      ON CONFLICT(id) DO UPDATE SET
        policy_key = excluded.policy_key,
        policy_name = excluded.policy_name,
        description = excluded.description,
        policy_purpose = excluded.policy_purpose
    `);
    const insertNtoM = db.prepare(`
      INSERT OR IGNORE INTO workflow_policy_application_types (policy_id, app_type_id)
      VALUES (?, ?)
    `);
    const checkVersionExists = db.prepare('SELECT id, status FROM workflow_policy_versions WHERE id = ?');
    const checkStepsCount = db.prepare('SELECT COUNT(*) as count FROM workflow_policy_steps WHERE policy_version_id = ?');
    const insertVersion = db.prepare(`
      INSERT INTO workflow_policy_versions (id, policy_id, version, status, priority, effective_from, effective_to, conditions_json)
      VALUES (?, ?, ?, ?, 200, '2000-01-01', '9999-12-31', '{}')
    `);
    const deactivateOtherVersions = db.prepare(`
      UPDATE workflow_policy_versions
      SET status = 'INACTIVE'
      WHERE policy_id = ? AND id != ? AND status = 'ACTIVE'
    `);
    const insertPolicyStep = db.prepare(`
      INSERT INTO workflow_policy_steps (
        policy_version_id, step_order, step_name, step_key, action_type,
        required_role_id, selector_type, selector_value, is_final_decision_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    /**
     * ポリシーバージョンのイミュータブル登録ヘルパー (INV-SEED-EXISTING-ZERO-MUTATION)
     * - 既に存在しステップがある場合: 1バイトも触らず即座にリターン (ZERO MUTATION)
     * - 未存在の場合のみ: 1回限りの作成と移行を実行
     */
    const seedPolicyVersion = (params: {
      versionId: string;
      policyId: string;
      versionNumber: number;
      status: 'ACTIVE' | 'INACTIVE';
      steps: Array<{
        stepOrder: number;
        stepName: string;
        stepKey: string;
        actionType: string;
        requiredRoleId: string;
        selectorType: 'POSITION' | 'ROLE';
        selectorValue: string;
        isFinalDecisionStep: number;
      }>;
    }) => {
      const existing = checkVersionExists.get(params.versionId) as { id: string; status: string } | undefined;
      const stepCount = existing ? (checkStepsCount.get(params.versionId) as { count: number }).count : 0;

      // 1. Existing Check: 既に存在しステップが登録済みなら一切の操作を行わない (INV-SEED-EXISTING-ZERO-MUTATION)
      if (existing && stepCount > 0) {
        return;
      }

      // 2. Version Transition (ACTIVE 化する場合のみ、同一ポリシーの既存 ACTIVE を退役)
      if (params.status === 'ACTIVE') {
        deactivateOtherVersions.run(params.policyId, params.versionId);
      }

      // 3. 親バージョンの新規作成 (未存在時のみ)
      if (!existing) {
        insertVersion.run(params.versionId, params.policyId, params.versionNumber, params.status);
      }

      // 4. 子ステップの新規登録 (ステップ未存在時のみクリーンINSERT)
      if (stepCount === 0) {
        for (const s of params.steps) {
          insertPolicyStep.run(
            params.versionId,
            s.stepOrder,
            s.stepName,
            s.stepKey,
            s.actionType,
            s.requiredRoleId,
            s.selectorType,
            s.selectorValue,
            s.isFinalDecisionStep
          );
        }
      }
    };

    // ==========================================
    // 1. 承認用ポリシー (policy_purpose = 'APPROVAL')
    // ==========================================
    // LEAVE_ANNUAL_STANDARD (年休標準: 教頭審査 → 校長受領確認 - TYPE-B / TYPE-D 共通基盤)
    insertPolicy.run('LEAVE_ANNUAL_STANDARD', 'LEAVE_ANNUAL_STANDARD', '年次有給休暇承認・受領確認ポリシー (2段階)', '年休の請求・教頭審査・校長受領確認フロー (TYPE-B / TYPE-D 共通基盤)', 'APPROVAL');
    seedPolicyVersion({
      versionId: 'LEAVE_ANNUAL_STANDARD_V1',
      policyId: 'LEAVE_ANNUAL_STANDARD',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教頭審査', stepKey: 'VP_REVIEW', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '校長受領確認', stepKey: 'PRINCIPAL_ACK', actionType: 'ACK', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('LEAVE_ANNUAL_STANDARD', 'LEAVE_ANNUAL');

    // 既存DBで LEAVE_STANDARD -> LEAVE_ANNUAL が残っている場合のクリーンアップ (Existing DB Activation)
    db.prepare("DELETE FROM workflow_policy_application_types WHERE policy_id = 'LEAVE_STANDARD' AND app_type_id = 'LEAVE_ANNUAL'").run();

    // LEAVE_STANDARD (休暇系標準: 教頭確認 → 校長決裁 - 病休・特休・職免等 TYPE-A)
    insertPolicy.run('LEAVE_STANDARD', 'LEAVE_STANDARD', '標準休暇承認ポリシー (2段階)', '病休・特休・介護等の標準承認フロー (TYPE-A)', 'APPROVAL');
    seedPolicyVersion({
      versionId: 'LEAVE_STANDARD_V1',
      policyId: 'LEAVE_STANDARD',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教頭一次確認', stepKey: 'VP_REVIEW', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '校長最終決裁', stepKey: 'PRINCIPAL_DECIDE', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });

    const leaveAppTypes = [
      'LEAVE_SICK', 'LEAVE_SPECIAL', 'LEAVE_DUTY_EXEMPT',
      'LEAVE_CHILDCARE', 'WORK_PATTERN_CHILDCARE', 'LEAVE_CHILDCARE_PARTIAL',
      'LEAVE_CARE', 'LEAVE_CARE_TIME', 'TRAINING_SPECIAL_ACT_22_2', 'TRAINING_SPECIAL_ACT_22_3'
    ];
    for (const at of leaveAppTypes) {
      insertNtoM.run('LEAVE_STANDARD', at);
    }

    // TRIP_STANDARD (出張系標準)
    insertPolicy.run('TRIP_STANDARD', 'TRIP_STANDARD', '標準出張旅行命令ポリシー (3段階)', '別表第一 旅行命令・依頼簿の3段階決裁フロー', 'APPROVAL');
    // Historical V1: 教頭APPROVE → 校長DECIDE → 事務CHECK (INACTIVEとして永久保全)
    seedPolicyVersion({
      versionId: 'TRIP_STANDARD_V1',
      policyId: 'TRIP_STANDARD',
      versionNumber: 1,
      status: 'INACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教頭確認 (旅行命令権者)', stepKey: 'VP_TRIP_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '校長決裁 (旅行命令権者)', stepKey: 'PRINCIPAL_TRIP_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
        { stepOrder: 3, stepName: '事務係確認 (出張・旅費係)', stepKey: 'OFFICE_TRIP_STEP', actionType: 'CHECK', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
      ],
    });
    // Canonical V2: 事務REVIEW → 教頭APPROVE → 校長DECIDE (ACTIVE)
    seedPolicyVersion({
      versionId: 'TRIP_STANDARD_V2',
      policyId: 'TRIP_STANDARD',
      versionNumber: 2,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '事務係審査 (出張・旅費係)', stepKey: 'OFFICE_TRIP_STEP', actionType: 'REVIEW', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '教頭確認 (旅行命令権者)', stepKey: 'VP_TRIP_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '校長決裁 (旅行命令権者)', stepKey: 'PRINCIPAL_TRIP_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('TRIP_STANDARD', 'BUSINESS_TRIP');

    // TRIP_PRINCIPAL_STANDARD (校長出張旅行命令受領ポリシー: 3段階 TYPE-D)
    insertPolicy.run('TRIP_PRINCIPAL_STANDARD', 'TRIP_PRINCIPAL_STANDARD', '校長出張旅行命令受領ポリシー (3段階)', '校長本人の出張における事務審査・教頭確認・校長受領確認フロー (TYPE-D)', 'APPROVAL');
    seedPolicyVersion({
      versionId: 'TRIP_PRINCIPAL_STANDARD_V1',
      policyId: 'TRIP_PRINCIPAL_STANDARD',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '事務係審査 (出張・旅費係)', stepKey: 'OFFICE_TRIP_STEP', actionType: 'REVIEW', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '教頭確認', stepKey: 'VP_TRIP_REVIEW_STEP', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '校長受領確認', stepKey: 'PRINCIPAL_TRIP_ACK_STEP', actionType: 'ACK', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('TRIP_PRINCIPAL_STANDARD', 'BUSINESS_TRIP');

    // LEAVE_LARGE_SCHOOL (大規模校用: 教務主任 → 第1教頭 → 第2教頭 → 校長)
    insertPolicy.run('LARGE_SCHOOL_STANDARD', 'LARGE_SCHOOL_STANDARD', '大規模校承認ポリシー (4段階)', '教務主任・複数教頭・校長の4段階決裁フロー', 'APPROVAL');
    seedPolicyVersion({
      versionId: 'LARGE_SCHOOL_STANDARD_V1',
      policyId: 'LARGE_SCHOOL_STANDARD',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教務主任確認', stepKey: 'CHIEF_TEACHER_STEP', actionType: 'REVIEW', requiredRoleId: 'TEACHER', selectorType: 'POSITION', selectorValue: 'CHIEF_TEACHER', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '第1教頭確認', stepKey: 'VICE_PRINCIPAL_1_STEP', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '第2教頭確認', stepKey: 'VICE_PRINCIPAL_2_STEP', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_2', isFinalDecisionStep: 0 },
        { stepOrder: 4, stepName: '校長最終決裁', stepKey: 'PRINCIPAL_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('LARGE_SCHOOL_STANDARD', 'LEAVE_LARGE_SCHOOL');

    // ==========================================
    // 2. 取消用ポリシー (policy_purpose = 'CANCELLATION')
    // ==========================================
    // LEAVE_STANDARD_CANCEL (休暇取消: 教頭確認 → 校長決裁)
    insertPolicy.run('LEAVE_STANDARD_CANCEL', 'LEAVE_STANDARD_CANCEL', '標準休暇取消ポリシー (2段階)', '年休・病休・特休・介護等の承認後取消フロー', 'CANCELLATION');
    seedPolicyVersion({
      versionId: 'LEAVE_STANDARD_CANCEL_V1',
      policyId: 'LEAVE_STANDARD_CANCEL',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教頭取消確認', stepKey: 'VP_CANCEL_REVIEW', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '校長取消決裁', stepKey: 'PRINCIPAL_CANCEL_DECIDE', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });

    for (const at of leaveAppTypes) {
      insertNtoM.run('LEAVE_STANDARD_CANCEL', at);
    }
    insertNtoM.run('LEAVE_STANDARD_CANCEL', 'LEAVE_ANNUAL');

    // TRIP_STANDARD_CANCEL (出張取消)
    insertPolicy.run('TRIP_STANDARD_CANCEL', 'TRIP_STANDARD_CANCEL', '標準出張取消ポリシー (3段階)', '出張旅行命令の承認後取消フロー', 'CANCELLATION');
    // Historical V1: 教頭取消確認 → 校長取消決裁 → 事務係取消確認 (CHECK) (INACTIVEとして永久保全)
    seedPolicyVersion({
      versionId: 'TRIP_STANDARD_CANCEL_V1',
      policyId: 'TRIP_STANDARD_CANCEL',
      versionNumber: 1,
      status: 'INACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教頭取消確認', stepKey: 'VP_TRIP_CANCEL_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '校長取消決裁', stepKey: 'PRINCIPAL_TRIP_CANCEL_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
        { stepOrder: 3, stepName: '事務係取消確認', stepKey: 'OFFICE_CANCEL_STEP', actionType: 'CHECK', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
      ],
    });
    // Historical V2: 教頭取消確認 → 校長取消決裁 → 事務係取消受領確認 (ACK) (INACTIVEとして永久保全)
    seedPolicyVersion({
      versionId: 'TRIP_STANDARD_CANCEL_V2',
      policyId: 'TRIP_STANDARD_CANCEL',
      versionNumber: 2,
      status: 'INACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教頭取消確認', stepKey: 'VP_TRIP_CANCEL_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '校長取消決裁', stepKey: 'PRINCIPAL_TRIP_CANCEL_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
        { stepOrder: 3, stepName: '事務係取消受領確認', stepKey: 'OFFICE_CANCEL_STEP', actionType: 'ACK', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
      ],
    });
    // Canonical V3: 事務係審査 (出張・旅費係) → 教頭取消確認 → 校長取消決裁 (ACTIVE)
    seedPolicyVersion({
      versionId: 'TRIP_STANDARD_CANCEL_V3',
      policyId: 'TRIP_STANDARD_CANCEL',
      versionNumber: 3,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '事務係審査 (出張・旅費係)', stepKey: 'OFFICE_TRIP_CANCEL_STEP', actionType: 'REVIEW', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '教頭取消確認', stepKey: 'VP_TRIP_CANCEL_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '校長取消決裁', stepKey: 'PRINCIPAL_TRIP_CANCEL_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('TRIP_STANDARD_CANCEL', 'BUSINESS_TRIP');

    // TRIP_PRINCIPAL_STANDARD_CANCEL (校長出張取消ポリシー: 3段階 TYPE-D)
    insertPolicy.run(
      'TRIP_PRINCIPAL_STANDARD_CANCEL',
      'TRIP_PRINCIPAL_STANDARD_CANCEL',
      '校長出張取消ポリシー (3段階)',
      '校長本人の出張取消における事務審査・教頭確認・校長受領確認フロー (TYPE-D)',
      'CANCELLATION'
    );
    seedPolicyVersion({
      versionId: 'TRIP_PRINCIPAL_STANDARD_CANCEL_V1',
      policyId: 'TRIP_PRINCIPAL_STANDARD_CANCEL',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '事務係審査 (出張・旅費係)', stepKey: 'OFFICE_TRIP_CANCEL_STEP', actionType: 'REVIEW', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '教頭確認', stepKey: 'VP_TRIP_CANCEL_REVIEW_STEP', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '校長受領確認', stepKey: 'PRINCIPAL_TRIP_CANCEL_ACK_STEP', actionType: 'ACK', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('TRIP_PRINCIPAL_STANDARD_CANCEL', 'BUSINESS_TRIP');

    // LARGE_SCHOOL_CANCEL (大規模校用休暇取消: 教務主任 → 第1教頭 → 第2教頭 → 校長)
    insertPolicy.run('LARGE_SCHOOL_CANCEL', 'LARGE_SCHOOL_CANCEL', '大規模校取消ポリシー (4段階)', '大規模校における承認後取消フロー', 'CANCELLATION');
    seedPolicyVersion({
      versionId: 'LARGE_SCHOOL_CANCEL_V1',
      policyId: 'LARGE_SCHOOL_CANCEL',
      versionNumber: 1,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '教務主任取消確認', stepKey: 'CHIEF_TEACHER_CANCEL_STEP', actionType: 'REVIEW', requiredRoleId: 'TEACHER', selectorType: 'POSITION', selectorValue: 'CHIEF_TEACHER', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '第1教頭取消確認', stepKey: 'VICE_PRINCIPAL_1_CANCEL_STEP', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '第2教頭取消確認', stepKey: 'VICE_PRINCIPAL_2_CANCEL_STEP', actionType: 'REVIEW', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_2', isFinalDecisionStep: 0 },
        { stepOrder: 4, stepName: '校長取消決裁', stepKey: 'PRINCIPAL_CANCEL_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('LARGE_SCHOOL_CANCEL', 'LEAVE_LARGE_SCHOOL');

    // ==========================================
    // 3. 復命報告用ポリシー (policy_purpose = 'POST_TRIP_REPORT')
    // ==========================================
    // TRIP_REPORT_STANDARD (出張復命標準)
    insertPolicy.run('TRIP_REPORT_STANDARD', 'TRIP_REPORT_STANDARD', '標準出張復命承認ポリシー (3段階)', '出張復命書の3段階決裁フロー (事務審査→教頭確認→校長決裁)', 'POST_TRIP_REPORT');
    // Historical V1: 復命教頭確認 → 復命校長決裁 → 復命事務確認 (CHECK) (INACTIVEとして永久保全)
    seedPolicyVersion({
      versionId: 'TRIP_REPORT_STANDARD_V1',
      policyId: 'TRIP_REPORT_STANDARD',
      versionNumber: 1,
      status: 'INACTIVE',
      steps: [
        { stepOrder: 1, stepName: '復命 教頭確認', stepKey: 'VP_REPORT_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '復命 校長決裁', stepKey: 'PRINCIPAL_REPORT_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
        { stepOrder: 3, stepName: '復命 事務係確認', stepKey: 'OFFICE_REPORT_STEP', actionType: 'CHECK', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
      ],
    });
    // Canonical V2: 復命事務審査 (REVIEW) → 復命教頭確認 (APPROVE) → 復命校長決裁 (DECIDE) (ACTIVE)
    seedPolicyVersion({
      versionId: 'TRIP_REPORT_STANDARD_V2',
      policyId: 'TRIP_REPORT_STANDARD',
      versionNumber: 2,
      status: 'ACTIVE',
      steps: [
        { stepOrder: 1, stepName: '復命 事務係審査', stepKey: 'OFFICE_REPORT_STEP', actionType: 'REVIEW', requiredRoleId: 'OFFICE', selectorType: 'POSITION', selectorValue: 'OFFICE_HEAD', isFinalDecisionStep: 0 },
        { stepOrder: 2, stepName: '復命 教頭確認', stepKey: 'VP_REPORT_STEP', actionType: 'APPROVE', requiredRoleId: 'VICE_PRINCIPAL', selectorType: 'POSITION', selectorValue: 'VICE_PRINCIPAL_1', isFinalDecisionStep: 0 },
        { stepOrder: 3, stepName: '復命 校長決裁', stepKey: 'PRINCIPAL_REPORT_STEP', actionType: 'DECIDE', requiredRoleId: 'PRINCIPAL', selectorType: 'POSITION', selectorValue: 'PRINCIPAL', isFinalDecisionStep: 1 },
      ],
    });
    insertNtoM.run('TRIP_REPORT_STANDARD', 'BUSINESS_TRIP');

    // 4. 帳票テンプレートマスタ初期データ
    const insertTemplate = db.prepare(`
      INSERT OR REPLACE INTO official_form_templates (
        authority_id, form_code, form_name, form_type, version, effective_from, paper_size, orientation, template_definition, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    // 休暇簿テンプレート (A4縦)
    insertTemplate.run(
      'DEFAULT_MUNICIPALITY',
      'LEAVE_RECORD',
      '休暇簿 (第9号様式相当)',
      'LEAVE',
      '1.0',
      '2026-04-01',
      'A4',
      'PORTRAIT',
      JSON.stringify({
        title: '休 暇 簿',
        subtitle: '(第9号様式)',
        authority: '公立学校教職員服務規程',
        sections: ['header', 'annual_summary', 'leave_records', 'approval_stamps'],
      })
    );

    // 旅行命令簿テンプレート (A4横)
    insertTemplate.run(
      'DEFAULT_MUNICIPALITY',
      'TRIP_ORDER',
      '旅行命令・依頼簿 (別表第一相当)',
      'TRIP',
      '1.0',
      '2026-04-01',
      'A4',
      'LANDSCAPE',
      JSON.stringify({
        title: '旅 行 命 令 ・ 依 頼 簿',
        subtitle: '(別表第一)',
        authority: '公立学校教職員旅費取扱規程',
        sections: ['header', 'order_details', 'approval_stamps', 'report_details', 'report_stamps'],
      })
    );

    // 出勤簿テンプレート (A4縦)
    insertTemplate.run(
      'DEFAULT_MUNICIPALITY',
      'ATTENDANCE_BOOK',
      '出勤簿',
      'ATTENDANCE',
      '1.0',
      '2026-04-01',
      'A4',
      'PORTRAIT',
      JSON.stringify({
        title: '出 勤 簿',
        authority: '公立学校職員服務取扱規程',
        sections: ['header', 'calendar_grid', 'monthly_summary', 'principal_stamp'],
      })
    );

    // 5. 初期ユーザー
    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, family_name, given_name, stamp_name, department, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');

    const usersToSeed = [
        {
          username: 'teacher1',
          pass: 'teacher123',
          name: '山田 太郎 (教員A)',
          family: '山田',
          given: '太郎',
          stamp: '山田',
          dept: '1学年・国語科',
          roles: ['TEACHER'],
          jobTitleId: 'JOB_TITLE_TEACHER',
        },
        {
          username: 'teacher2',
          pass: 'teacher123',
          name: '佐藤 花子 (教員B)',
          family: '佐藤',
          given: '花子',
          stamp: '佐藤',
          dept: '2学年・数学科',
          roles: ['TEACHER'],
          jobTitleId: 'JOB_TITLE_TEACHER',
        },
        {
          username: 'vice_principal',
          pass: 'vice123',
          name: '田中 誠 (教頭B)',
          family: '田中',
          given: '誠',
          stamp: '田中',
          dept: '管理職',
          roles: ['VICE_PRINCIPAL', 'TEACHER'],
          position: 'VICE_PRINCIPAL_1',
          jobTitleId: 'JOB_TITLE_VICE_PRINCIPAL',
        },
        {
          username: 'principal',
          pass: 'principal123',
          name: '鈴木 健一 (校長C)',
          family: '鈴木',
          given: '健一',
          stamp: '鈴木',
          dept: '管理職',
          roles: ['PRINCIPAL', 'TEACHER'],
          position: 'PRINCIPAL',
          jobTitleId: 'JOB_TITLE_PRINCIPAL',
        },
        {
          username: 'office',
          pass: 'office123',
          name: '高橋 節子 (事務D)',
          family: '高橋',
          given: '節子',
          stamp: '高橋',
          dept: '事務室・旅費服務担当',
          roles: ['OFFICE', 'TEACHER'],
          position: 'OFFICE_HEAD',
          jobTitleId: 'JOB_TITLE_HEAD_CLERK',
        },
        {
          username: 'admin',
          pass: 'admin123',
          name: 'システム管理者E',
          family: '管理者',
          given: 'システム',
          stamp: '管理',
          dept: 'ICT情報管理室',
          roles: ['ADMIN'],
          jobTitleId: 'JOB_TITLE_CLERK',
        },
        {
          username: 'chief_teacher',
          pass: 'chief123',
          name: '小林 繁 (教務主任)',
          family: '小林',
          given: '繁',
          stamp: '小林',
          dept: '教務部',
          roles: ['TEACHER'],
          position: 'CHIEF_TEACHER',
          jobTitleId: 'JOB_TITLE_TEACHER',
        },
        {
          username: 'vice_principal_2',
          pass: 'vice123',
          name: '渡辺 洋子 (第2教頭)',
          family: '渡辺',
          given: '洋子',
          stamp: '渡辺',
          dept: '管理職',
          roles: ['VICE_PRINCIPAL', 'TEACHER'],
          position: 'VICE_PRINCIPAL_2',
          jobTitleId: 'JOB_TITLE_VICE_PRINCIPAL',
        },
      ];

      for (const u of usersToSeed) {
        let existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username) as any;
        let userId: number;
        if (!existingUser) {
          const hash = bcrypt.hashSync(u.pass, 10);
          const result = insertUser.run(u.username, hash, u.name, u.family, u.given, u.stamp, u.dept, now);
          userId = Number(result.lastInsertRowid);
          for (const r of u.roles) {
            insertUserRole.run(userId, r);
          }
        } else {
          userId = existingUser.id;
          db.prepare('UPDATE users SET display_name = ?, family_name = ?, given_name = ?, stamp_name = ?, department = ? WHERE id = ?').run(
            u.name,
            u.family,
            u.given,
            u.stamp,
            u.dept,
            userId
          );
          db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
          for (const r of u.roles) {
            insertUserRole.run(userId, r);
          }
        }

        if ((u as any).position) {
          db.prepare(`
            INSERT OR REPLACE INTO user_positions (user_id, position_id, is_primary, effective_from, effective_to)
            VALUES (?, ?, 1, '2000-01-01', '9999-12-31')
          `).run(userId, (u as any).position);
        }

        if ((u as any).jobTitleId) {
          const existingJt = db.prepare('SELECT id FROM user_job_titles WHERE user_id = ?').get(userId);
          if (!existingJt) {
            db.prepare(`
              INSERT INTO user_job_titles (user_id, job_title_id, effective_from, effective_to)
              VALUES (?, ?, '2000-01-01', '9999-12-31')
            `).run(userId, (u as any).jobTitleId);
          }
        }

        // 初期勤務パターン (2026-04-01基準)
        const existingWp = db.prepare('SELECT id FROM user_work_patterns WHERE user_id = ?').get(userId);
        if (!existingWp) {
          const defaultScheduleJson = JSON.stringify({
            "0": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null },
            "1": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
            "2": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
            "3": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
            "4": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
            "5": { "isWorkDay": true,  "workMinutes": 465, "startTime": "08:15", "endTime": "16:45", "intervals": [{ "startTime": "08:10", "endTime": "12:00" }, { "startTime": "12:45", "endTime": "16:40" }] },
            "6": { "isWorkDay": false, "workMinutes": 0, "startTime": null, "endTime": null }
          });
          db.prepare(`
            INSERT INTO user_work_patterns (
              user_id, pattern_name, pattern_type, effective_from, effective_to,
              weekly_off_days, schedule_details_json, weekly_total_minutes, record_origin,
              created_by_user_id, created_at, updated_by_user_id, updated_at, schedule_source
            ) VALUES (?, '通常フルタイム (週5日・土日週休)', 'STANDARD_FULLTIME', '2026-04-01', '9999-12-31', '0,6', ?, 2325, 'MIGRATION_INITIAL', ?, ?, ?, ?, 'INDIVIDUAL')
          `).run(userId, defaultScheduleJson, userId, now, userId, now);
        }
      }
  });

  runSeed();
}
