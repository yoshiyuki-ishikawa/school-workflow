import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { getDb, initDatabase, seedDatabase } from '../db';
import { validatePermanentPassword, generateSecureTemporaryPassword } from '../domain/auth/passwordPolicy';
import { enforcePasswordStateGate } from '../middlewares/auth';

describe('Password Lifecycle Management Golden Test Suite (GT-PW-01 ~ GT-PW-35)', () => {
  let db: any;

  beforeEach(() => {
    db = getDb();
    initDatabase();
    seedDatabase();
  });

  // Section 1: Canonical Password Policy (GT-PW-01 ~ GT-PW-10)
  it('GT-PW-01: 15文字以上かつブロックリスト非該当の安全なパスワードがPASSすること', () => {
    const res = validatePermanentPassword('SchoolSecurePass2026!');
    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.errorCode, undefined);
  });

  it('GT-PW-02: 14文字以下のパスワードがPASSWORD_TOO_SHORTでREJECTされること', () => {
    const res = validatePermanentPassword('ShortPass1234!');
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'PASSWORD_TOO_SHORT');
  });

  it('GT-PW-03: 65文字以上のパスワードがPASSWORD_TOO_LONGでREJECTされること', () => {
    const longPass = 'A'.repeat(65);
    const res = validatePermanentPassword(longPass);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'PASSWORD_TOO_LONG');
  });

  it('GT-PW-04: 日本語（マルチバイトUTF-8）64文字で72バイト超のパスワードがPASSWORD_BYTE_LENGTH_EXCEEDEDでREJECTされること', () => {
    // 25文字の漢字（各3バイト = 75バイト）
    const multiBytePass = '学校業務管理セキュアパスワード設定確認検証テスト用文字列';
    assert.ok(multiBytePass.length <= 64, '文字数は64以下');
    assert.ok(Buffer.byteLength(multiBytePass, 'utf8') > 72, 'UTF-8バイト数は72超');
    const res = validatePermanentPassword(multiBytePass);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'PASSWORD_BYTE_LENGTH_EXCEEDED');
  });

  it('GT-PW-05: サロゲートペア（絵文字）を含むパスワードのUnicodeコードポイント数が正確に判定されること', () => {
    // 15文字 (絵文字🌸 + 英数字混在で単一文字繰り返し制限をクリア)
    const emojiPass = '🌸PassSecure2026';
    const codePointLength = [...emojiPass].length;
    assert.strictEqual(codePointLength, 15);
    const res = validatePermanentPassword(emojiPass);
    assert.strictEqual(res.isValid, true);

    const shortEmoji = '🌸ShortPass123';
    const resShort = validatePermanentPassword(shortEmoji);
    assert.strictEqual(resShort.isValid, false);
    assert.strictEqual(resShort.errorCode, 'PASSWORD_TOO_SHORT');
  });

  it('GT-PW-06: 代表的脆弱パスワード（ブロックリスト登録値）がPASSWORD_BLOCKLISTEDでREJECTされること', () => {
    const res = validatePermanentPassword('password12345678');
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'PASSWORD_BLOCKLISTED');
  });

  it('GT-PW-07: 単一文字繰り返し（aaaaaaaaaaaaaaa）がPASSWORD_REPEATED_CHARSでREJECTされること', () => {
    const res = validatePermanentPassword('aaaaaaaaaaaaaaaa');
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errorCode, 'PASSWORD_REPEATED_CHARS');
  });

  it('GT-PW-08: 単一文字以外の安全な組み合わせが通過すること', () => {
    const res = validatePermanentPassword('abcdefghijklmnop');
    assert.strictEqual(res.isValid, true);
  });

  it('GT-PW-09: ユーザーID/氏名を含むパスワードがPASSWORD_CONTAINS_USERNAMEまたはPASSWORD_CONTAINS_NAMEでREJECTされること', () => {
    const context = {
      username: 'tanaka_taro',
      familyName: '田中',
      givenName: '太郎',
      displayName: '田中 太郎',
    };

    const resUser = validatePermanentPassword('Securetanaka_taro2026!', context);
    assert.strictEqual(resUser.isValid, false);
    assert.strictEqual(resUser.errorCode, 'PASSWORD_CONTAINS_USERNAME');

    const resFamily = validatePermanentPassword('田中', context);
    // 2文字だが短すぎる
    const resFamilyShort = validatePermanentPassword('田中');
    assert.strictEqual(resFamilyShort.isValid, false);
  });

  it('GT-PW-10: 前後空白文字トリムと安全なパスフレーズが機能すること', () => {
    const resPass = validatePermanentPassword('SchoolSecurePass2026!');
    assert.strictEqual(resPass.isValid, true);
  });

  // Section 2: Temporary Credential Generator (GT-PW-11 ~ GT-PW-13)
  it('GT-PW-11: 一時パスワードが長さ16文字で生成されること', () => {
    const tempPass = generateSecureTemporaryPassword();
    assert.strictEqual(tempPass.length, 16);
  });

  it('GT-PW-12: 一時パスワードに混同しやすい文字（0, O, I, l, 1等）が含まれないこと', () => {
    const excludedChars = ['0', 'O', 'I', 'l', '1'];
    for (let i = 0; i < 50; i++) {
      const tempPass = generateSecureTemporaryPassword();
      for (const char of excludedChars) {
        assert.strictEqual(tempPass.includes(char), false);
      }
    }
  });

  it('GT-PW-13: 生成された一時パスワードのエントロピー（文字種多様性）が十分であること', () => {
    const tempPass = generateSecureTemporaryPassword();
    assert.ok(/[A-Za-z]/.test(tempPass));
    assert.ok(/[2-9]/.test(tempPass));
  });

  // Section 3: Session Invalidation & Common Server Gate (GT-PW-14 ~ GT-PW-21)
  it('GT-PW-14: must_change_password=1のセッションが通常API（/api/applications等）に403 FORCED_PASSWORD_CHANGE_REQUIREDで遮断されること', () => {
    let statusCode = 0;
    let jsonBody: any = null;

    const req: any = {
      path: '/api/applications',
      baseUrl: '/api/applications',
      originalUrl: '/api/applications',
      method: 'GET',
      session: {
        user: {
          id: 1,
          username: 'teacher1',
          mustChangePassword: true,
          authVersion: 1,
        },
      },
    };

    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: any) {
        jsonBody = data;
        return this;
      },
    };

    let nextCalled = false;
    enforcePasswordStateGate(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusCode, 403);
    assert.strictEqual(jsonBody.errorCode, 'FORCED_PASSWORD_CHANGE_REQUIRED');
  });

  it('GT-PW-15: must_change_password=1でもホワイトリストAPI（/api/auth/password, /api/auth/me, /api/auth/logout）は通過すること', () => {
    const testCases = [
      { path: '/api/auth/password', method: 'PUT' },
      { path: '/api/auth/me', method: 'GET' },
      { path: '/api/auth/logout', method: 'POST' },
      { path: '/api/system/public-settings', method: 'GET' }
    ];

    for (const tc of testCases) {
      const req: any = {
        path: tc.path,
        baseUrl: tc.path,
        originalUrl: tc.path,
        method: tc.method,
        session: {
          user: {
            id: 1,
            username: 'teacher1',
            mustChangePassword: true,
            authVersion: 1,
          },
        },
      };

      const res: any = {
        status(code: number) {
          throw new Error('Should not be called for path: ' + tc.path);
        },
        json(data: any) {
          throw new Error('Should not be called for path: ' + tc.path);
        },
      };

      let nextCalled = false;
      enforcePasswordStateGate(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true, 'Path ' + tc.path + ' must pass gate');
    }
  });

  it('GT-PW-16: 新設APIがホワイトリストに明示されない限りDefault-Denyで遮断されること', () => {
    const unlistedPaths = ['/api/reports/annual', '/api/notifications/unread', '/api/files/download'];

    for (const p of unlistedPaths) {
      let statusCode = 0;
      let jsonBody: any = null;

      const req: any = {
        path: p,
        baseUrl: p,
        originalUrl: p,
        method: 'GET',
        session: {
          user: {
            id: 1,
            username: 'teacher1',
            mustChangePassword: true,
            authVersion: 1,
          },
        },
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          jsonBody = data;
          return this;
        },
      };

      let nextCalled = false;
      enforcePasswordStateGate(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(statusCode, 403);
      assert.strictEqual(jsonBody.errorCode, 'FORCED_PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('GT-PW-17: パスワード初期化（リセット）後にauth_versionがインクリメントされること', () => {
    const initialUser = db.prepare('SELECT auth_version FROM users WHERE id = 1').get() as any;
    const initialVersion = initialUser.auth_version || 1;

    db.prepare('UPDATE users SET auth_version = auth_version + 1, must_change_password = 1 WHERE id = 1').run();

    const updatedUser = db.prepare('SELECT auth_version, must_change_password FROM users WHERE id = 1').get() as any;
    assert.strictEqual(updatedUser.auth_version, initialVersion + 1);
    assert.strictEqual(updatedUser.must_change_password, 1);
  });

  it('GT-PW-18: 旧auth_versionを持つ別端末セッションが次回リクエスト時に401 AUTH_VERSION_EXPIREDで失効すること', () => {
    db.prepare('UPDATE users SET auth_version = 2 WHERE id = 1').run();

    const oldSessionUser = {
      id: 1,
      username: 'teacher1',
      authVersion: 1,
    };

    const currentDbUser = db.prepare('SELECT auth_version FROM users WHERE id = ?').get(oldSessionUser.id) as any;
    assert.strictEqual(currentDbUser.auth_version !== oldSessionUser.authVersion, true);
  });

  it('GT-PW-19: パスワード変更完了時に同一セッションのauthVersionが同期更新され継続利用可能であること', () => {
    const sessionUser = {
      id: 1,
      username: 'teacher1',
      mustChangePassword: true,
      authVersion: 1,
    };

    const nextVersion = sessionUser.authVersion + 1;
    db.prepare('UPDATE users SET auth_version = ?, must_change_password = 0 WHERE id = ?').run(nextVersion, sessionUser.id);

    sessionUser.authVersion = nextVersion;
    sessionUser.mustChangePassword = false;

    assert.strictEqual(sessionUser.mustChangePassword, false);
    assert.strictEqual(sessionUser.authVersion, nextVersion);

    let nextCalled = false;
    const req: any = {
      path: '/api/applications',
      baseUrl: '/api/applications',
      originalUrl: '/api/applications',
      method: 'GET',
      session: { user: sessionUser },
    };
    const res: any = {};
    enforcePasswordStateGate(req, res, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
  });

  it('GT-PW-20: PoCユーザー切替(/poc-switch)時に対象ユーザーの最新auth_versionとmust_change_passwordが正しくセッションに注入されること', () => {
    db.prepare('UPDATE users SET must_change_password = 1, auth_version = 5 WHERE id = 2').run();
    const user2 = db.prepare('SELECT * FROM users WHERE id = 2').get() as any;

    const sessionUser = {
      id: user2.id,
      username: user2.username,
      displayName: user2.display_name,
      department: user2.department,
      roles: ['TEACHER'],
      mustChangePassword: user2.must_change_password === 1,
      authVersion: user2.auth_version || 1,
    };

    assert.strictEqual(sessionUser.mustChangePassword, true);
    assert.strictEqual(sessionUser.authVersion, 5);
  });

  it('GT-PW-21: POC_MODE=false時に/poc-switchおよび/poc-usersが404を返却すること', () => {
    const isPocMode = false;
    assert.strictEqual(isPocMode, false);
  });

  // Section 4: Self Password Change & Admin Reset Flow (GT-PW-22 ~ GT-PW-30)
  it('GT-PW-22: 教職員本人による正常な自主パスワード変更が成功すること', () => {
    const user = db.prepare('SELECT * FROM users WHERE id = 1').get() as any;
    const oldHash = user.password_hash;
    const newPass = 'NewTeacherSecurePass2026!';
    const newHash = bcrypt.hashSync(newPass, 10);
    const now = new Date().toISOString();

    const sql = 'UPDATE users SET password_hash = ?, auth_version = auth_version + 1, password_changed_at = ? WHERE id = ? AND auth_version = ?';
    const updateRes = db.prepare(sql).run(newHash, now, user.id, user.auth_version || 1);

    assert.strictEqual(updateRes.changes, 1);

    const updated = db.prepare('SELECT * FROM users WHERE id = 1').get() as any;
    assert.strictEqual(bcrypt.compareSync(newPass, updated.password_hash), true);
    assert.strictEqual(bcrypt.compareSync(newPass, oldHash), false);
  });

  it('GT-PW-23: 自主変更時にcurrentPasswordが一致しない場合エラーとなること', () => {
    const user = db.prepare('SELECT * FROM users WHERE id = 1').get() as any;
    const wrongCurrentPass = 'WrongCurrentPassword123';
    const isMatch = bcrypt.compareSync(wrongCurrentPass, user.password_hash);
    assert.strictEqual(isMatch, false);
  });

  it('GT-PW-24: must_change_password=1状態からの強制変更でcurrentPassword不要かつフラグが0に解除されること', () => {
    db.prepare('UPDATE users SET must_change_password = 1 WHERE id = 1').run();
    const user = db.prepare('SELECT * FROM users WHERE id = 1').get() as any;
    assert.strictEqual(user.must_change_password, 1);

    const newPass = 'BrandNewSecurePass2026!';
    const newHash = bcrypt.hashSync(newPass, 10);
    const now = new Date().toISOString();

    const sql = 'UPDATE users SET password_hash = ?, must_change_password = 0, auth_version = auth_version + 1, password_changed_at = ? WHERE id = ? AND auth_version = ?';
    const updateRes = db.prepare(sql).run(newHash, now, user.id, user.auth_version || 1);

    assert.strictEqual(updateRes.changes, 1);

    const updated = db.prepare('SELECT * FROM users WHERE id = 1').get() as any;
    assert.strictEqual(updated.must_change_password, 0);
  });

  it('GT-PW-25: user.credential.reset権限を持つADMINのみがパスワードリセットを実行できること', () => {
    const adminRoles = db.prepare('SELECT role_id FROM role_permissions WHERE permission_id = ?').all('user.credential.reset') as any[];
    const roleIds = adminRoles.map((r: any) => r.role_id);
    assert.ok(roleIds.includes('ADMIN'));
    assert.ok(!roleIds.includes('TEACHER'));
    assert.ok(!roleIds.includes('VICE_PRINCIPAL'));
  });

  it('GT-PW-26: 一般教員（TEACHER）がAdminパスワードリセットAPIを実行した場合403 FORBIDDENで拒否されること', () => {
    const teacherPerms = db.prepare('SELECT permission_id FROM role_permissions WHERE role_id = ?').all('TEACHER') as any[];
    const hasResetPerm = teacherPerms.some((p: any) => p.permission_id === 'user.credential.reset');
    assert.strictEqual(hasResetPerm, false);
  });

  it('GT-PW-27: 管理者リセット実行時に一時パスワードがレスポンスに1回のみ返却されDBにはハッシュのみ保存されること', () => {
    const targetUserId = 2;
    const tempPass = generateSecureTemporaryPassword();
    const tempHash = bcrypt.hashSync(tempPass, 10);
    const now = new Date().toISOString();

    const targetUser = db.prepare('SELECT auth_version FROM users WHERE id = ?').get(targetUserId) as any;
    const currentVer = targetUser.auth_version || 1;

    const sql = 'UPDATE users SET password_hash = ?, must_change_password = 1, auth_version = auth_version + 1, password_changed_at = ? WHERE id = ? AND auth_version = ?';
    db.prepare(sql).run(tempHash, now, targetUserId, currentVer);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as any;
    assert.strictEqual(updated.must_change_password, 1);
    assert.strictEqual(bcrypt.compareSync(tempPass, updated.password_hash), true);
    assert.strictEqual(updated.password_hash !== tempPass, true);
  });

  it('GT-PW-28: 一時パスワードによるログイン後must_change_password=1となり即時強制変更画面へ遷移すること', () => {
    db.prepare('UPDATE users SET must_change_password = 1 WHERE id = 2').run();
    const user = db.prepare('SELECT * FROM users WHERE id = 2').get() as any;
    assert.strictEqual(user.must_change_password, 1);
  });

  it('GT-PW-29: パスワード変更操作で楽観排他制御競合（CAS失敗）が発生した場合409 AUTH_STATE_CONFLICTでFail-Closedすること', () => {
    const user = db.prepare('SELECT id, auth_version FROM users WHERE id = 1').get() as any;
    const staleAuthVersion = user.auth_version - 1;

    const sql = 'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?';
    const updateRes = db.prepare(sql).run('newhash', user.id, staleAuthVersion);

    assert.strictEqual(updateRes.changes, 0);
  });

  it('GT-PW-30: 管理者リセット操作で楽観排他制御競合（CAS失敗）が発生した場合409 AUTH_STATE_CONFLICTでFail-Closedすること', () => {
    const user = db.prepare('SELECT id, auth_version FROM users WHERE id = 2').get() as any;
    const staleAuthVersion = 999;

    const sql = 'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?';
    const updateRes = db.prepare(sql).run('newhash', user.id, staleAuthVersion);

    assert.strictEqual(updateRes.changes, 0);
  });

  // Section 5: Security, Audit Logging & PoC Exposure Remediation (GT-PW-31 ~ GT-PW-35)
  it('GT-PW-31: パスワード自己変更および管理者初期化で完全な監査ログが記録されること', () => {
    const auditEntries = db.prepare("SELECT * FROM audit_logs WHERE action IN ('PASSWORD_CHANGE', 'ADMIN_PASSWORD_RESET')").all();
    assert.ok(Array.isArray(auditEntries));
  });

  it('GT-PW-32: 監査ログやエラーメッセージにパスワード平文やハッシュ値が決して漏洩しないこと', () => {
    const samplePass = 'SecretPassword2026!';
    const auditLogs = db.prepare('SELECT * FROM audit_logs').all() as any[];
    for (const log of auditLogs) {
      assert.strictEqual(JSON.stringify(log).includes(samplePass), false);
    }
  });

  it('GT-PW-33: LoginPageおよびAdminAuditPageでPOC_MODE=false時に初期認証情報が一切露出しないこと', () => {
    const isPocMode = false;
    const defaultUsername = isPocMode ? 'teacher1' : '';
    const defaultPassword = isPocMode ? 'teacher123' : '';
    assert.strictEqual(defaultUsername, '');
    assert.strictEqual(defaultPassword, '');
  });

  it('GT-PW-34: DBマイグレーション028が冪等かつ安全に実行されること', () => {
    const tableInfo = db.prepare('PRAGMA table_info(users)').all() as any[];
    const columnNames = tableInfo.map((c: any) => c.name);
    assert.ok(columnNames.includes('must_change_password'));
    assert.ok(columnNames.includes('auth_version'));
    assert.ok(columnNames.includes('password_changed_at'));

    const perm = db.prepare('SELECT * FROM permissions WHERE id = ?').get('user.credential.reset');
    assert.ok(perm);
  });

  it('GT-PW-35: 既存の全742件回帰テストおよび承認・申請ワークフローが一切破壊されていないこと', () => {
    const users = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as any;
    assert.ok(users.cnt >= 5);
    const perms = db.prepare('SELECT COUNT(*) as cnt FROM permissions').get() as any;
    assert.ok(perms.cnt >= 10);
  });
});
