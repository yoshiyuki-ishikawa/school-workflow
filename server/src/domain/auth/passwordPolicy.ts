import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export interface PasswordValidationResult {
  isValid: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface ContextualIdentifiers {
  username?: string;
  familyName?: string;
  givenName?: string;
  displayName?: string;
}

// 57文字種 (0, O, 1, l, I を除外した視認性重視 Base58 alphabet)
const TEMP_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Blocklist Cache
let blocklistCache: Set<string> | null = null;
let blocklistLoadError: Error | null = null;

/**
 * Blocklist を安全にロード（Working Directory 依存を排除し、__dirname または dist から解決）
 */
function getBlocklistSet(): Set<string> {
  if (blocklistCache) {
    return blocklistCache;
  }
  if (blocklistLoadError) {
    throw blocklistLoadError;
  }

  const candidatePaths = [
    path.join(__dirname, 'blocklist', 'common-passwords-v1.json'),
    path.join(process.cwd(), 'server', 'src', 'domain', 'auth', 'blocklist', 'common-passwords-v1.json'),
    path.join(process.cwd(), 'src', 'domain', 'auth', 'blocklist', 'common-passwords-v1.json'),
    path.join(__dirname, '..', '..', 'domain', 'auth', 'blocklist', 'common-passwords-v1.json'),
  ];

  let loadedContent: string | null = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        loadedContent = fs.readFileSync(p, 'utf8');
        break;
      } catch (e) {
        // continue
      }
    }
  }

  if (!loadedContent) {
    blocklistLoadError = new Error('PASSWORD_POLICY_UNAVAILABLE: Blocklist file missing');
    throw blocklistLoadError;
  }

  try {
    const data = JSON.parse(loadedContent);
    if (!data || !Array.isArray(data.entries)) {
      throw new Error('Invalid blocklist JSON schema');
    }
    const set = new Set<string>();
    for (const item of data.entries) {
      if (typeof item === 'string') {
        const norm = item.normalize('NFKC').trim().toLowerCase();
        if (norm.length > 0) {
          set.add(norm);
        }
      }
    }
    blocklistCache = set;
    return blocklistCache;
  } catch (err: any) {
    blocklistLoadError = new Error(`PASSWORD_POLICY_UNAVAILABLE: ${err.message}`);
    throw blocklistLoadError;
  }
}

/**
 * テスト用: Blocklist キャッシュリセット
 */
export function _resetBlocklistCacheForTesting(): void {
  blocklistCache = null;
  blocklistLoadError = null;
}

/**
 * テスト用: 不正なパスを指定して Load Failure をシミュレート
 */
export function _setBlocklistLoadErrorForTesting(err: Error | null): void {
  blocklistCache = null;
  blocklistLoadError = err;
}

/**
 * UTF-8 バイト長が 72 バイト以内かを判定
 */
export function isExceedingBcryptByteLimit(password: string): boolean {
  return Buffer.byteLength(password, 'utf8') > 72;
}

/**
 * 暗号論的不偏サンプリングによる一時パスワード生成 (AD-PW-02 Model C)
 */
export function generateTemporaryCredential(): string {
  let result = '';
  const len = TEMP_CHARSET.length;
  // 必ず数字と英字が混在するように検証ループ
  while (true) {
    let candidate = '';
    for (let i = 0; i < 16; i++) {
      const randIdx = crypto.randomInt(0, len);
      candidate += TEMP_CHARSET[randIdx];
    }
    // 文字種多様性チェック（数字とアルファベット両方を含む）
    if (/[0-9]/.test(candidate) && /[A-Za-z]/.test(candidate)) {
      result = candidate;
      break;
    }
  }
  return result;
}

export const generateSecureTemporaryPassword = generateTemporaryCredential;

/**
 * Canonical Password Policy 検証 (Pure Domain Function)
 */
export function validatePermanentPassword(
  password: string,
  identifiers?: ContextualIdentifiers
): PasswordValidationResult {
  if (!password || typeof password !== 'string') {
    return {
      isValid: false,
      errorCode: 'PASSWORD_REQUIRED',
      errorMessage: 'パスワードを入力してください',
    };
  }

  // 1. Unicode Code Points 長 (15〜64 文字)
  const codePoints = Array.from(password);
  if (codePoints.length < 15) {
    return {
      isValid: false,
      errorCode: 'PASSWORD_TOO_SHORT',
      errorMessage: 'パスワードは15文字以上で入力してください',
    };
  }

  if (codePoints.length > 64) {
    return {
      isValid: false,
      errorCode: 'PASSWORD_TOO_LONG',
      errorMessage: 'パスワードは64文字以内で入力してください',
    };
  }

  // 2. UTF-8 バイト境界 (<= 72 bytes)
  if (isExceedingBcryptByteLimit(password)) {
    return {
      isValid: false,
      errorCode: 'PASSWORD_BYTE_LENGTH_EXCEEDED',
      errorMessage: 'パスワードのバイト長が制限（72バイト）を超えています。短いパスフレーズを指定してください',
    };
  }

  // 3. 単一文字の15文字以上連続 (例: 'aaaaaaaaaaaaaaa')
  const firstCp = codePoints[0];
  if (codePoints.every((cp) => cp === firstCp)) {
    return {
      isValid: false,
      errorCode: 'PASSWORD_REPEATED_CHARS',
      errorMessage: '同じ文字のみで構成されたパスワードは使用できません',
    };
  }

  // 4. Layer A: Local Blocklist 検査 (Fail-Closed)
  const blocklist = getBlocklistSet();
  const normalizedInput = password.normalize('NFKC').trim().toLowerCase();

  if (blocklist.has(normalizedInput)) {
    return {
      isValid: false,
      errorCode: 'PASSWORD_BLOCKLISTED',
      errorMessage: '推測されやすい一般的なパスワードは使用できません',
    };
  }

  // 5. Layer B: Contextual Identifier 検査
  if (identifiers) {
    // 5.1 Username (3文字以上): 完全一致または部分一致
    if (identifiers.username && identifiers.username.trim().length >= 3) {
      const normUser = identifiers.username.normalize('NFKC').trim().toLowerCase();
      if (normalizedInput.includes(normUser)) {
        return {
          isValid: false,
          errorCode: 'PASSWORD_CONTAINS_USERNAME',
          errorMessage: 'ユーザー名を含むパスワードは設定できません',
        };
      }
    }

    // 5.2 Family Name (2文字以上): 完全一致
    if (identifiers.familyName && identifiers.familyName.trim().length >= 2) {
      const normFam = identifiers.familyName.normalize('NFKC').trim().toLowerCase();
      if (normalizedInput === normFam) {
        return {
          isValid: false,
          errorCode: 'PASSWORD_CONTAINS_NAME',
          errorMessage: '氏名と同じパスワードは設定できません',
        };
      }
    }

    // 5.3 Given Name (2文字以上): 完全一致
    if (identifiers.givenName && identifiers.givenName.trim().length >= 2) {
      const normGiven = identifiers.givenName.normalize('NFKC').trim().toLowerCase();
      if (normalizedInput === normGiven) {
        return {
          isValid: false,
          errorCode: 'PASSWORD_CONTAINS_NAME',
          errorMessage: '氏名と同じパスワードは設定できません',
        };
      }
    }

    // 5.4 Display Name (4文字以上、空白除去): 完全一致
    if (identifiers.displayName && identifiers.displayName.trim().length >= 4) {
      const normDisp = identifiers.displayName.normalize('NFKC').replace(/[s　]+/g, '').toLowerCase();
      if (normalizedInput === normDisp) {
        return {
          isValid: false,
          errorCode: 'PASSWORD_CONTAINS_NAME',
          errorMessage: '氏名と同じパスワードは設定できません',
        };
      }
    }
  }

  return { isValid: true };
}
