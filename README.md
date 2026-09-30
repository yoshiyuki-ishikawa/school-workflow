# 学校業務ワークフローシステム (School Workflow Engine PoC)

> **校内LAN閉域運用向け 自律型学校業務申請・承認ワークフロー基盤**

---

## 概要

本システムは、学校現場の厳しい個人情報保護・閉域網セキュリティ要件に適合するため、**外部クラウドに一切依存せず校内LAN完結で動作するワークフロー基盤**です。

休暇申請（年次有給休暇・特別休暇）や出張申請をはじめ、将来的なあらゆる校内決裁（服務・備品購入・修繕・施設利用等）へ拡張可能な最小核として設計されています。

---

## 主な特徴

* 🛡️ **完全ローカル自律動作**: 外部CDN、クラウド認証、外部フォント等への通信ゼロ。完全オフライン環境で100%動作。
* 👑 **多段階承認 ＆ 自己承認禁止**:
  - `申請（教員）` → `一次確認（教頭）` → `最終決裁（校長）`
  - 申請者自身による自己承認・自己決裁をサーバーサイドで厳格に遮断。
* 🔄 **厳格なホワイトリスト状態遷移**: 承認順序のスキップや決裁済み申請の直接改変をAPIレベルで完全ブロック。
* 🔒 **独立監査ログ (AuditLog)**: 不正アクセスや自己承認試行など、業務ロールバックが発生しても失敗ログを確実に独立永続化。
* 💾 **整合性保証バックアップ ＆ 6段階復元**: SQLite WALモード + `VACUUM INTO` による安全な世代バックアップと簡単復元ツール。
* 💻 **Windows高ポータビリティ**: 学校現場のWindows PC親機に配置し、`start-windows.bat` をダブルクリックするだけで即LAN公開。

---

## ディレクトリ構成

```text
school-workflow/
├── ai/                        # AI自律開発・自己監査マスタープロトコル
│   └── SCHOOL_WORKFLOW_AI_MASTER_PROTOCOL.md  # 【最重要】Canonical AI Master Protocol
├── constitution/              # プロジェクト憲法・コア防護統治規程
├── policies/                  # 服務・休暇・ワークフロー・認可ポリシー (SSOT)
├── specs/                     # ドメインモデル・DB・API・帳票仕様書 (SSOT)
├── tests/                     # 不変条件・ゴールデンケース・回帰カタログ (SSOT)
├── audit/                     # 独立品質監査プロトコル・チェックリスト・監査履歴
├── quality-gates/             # リリースゲート・DoD・重大度定義・CI/CDゲート
├── server/                    # バックエンド (Node.js / Express / TypeScript)
├── client/                    # フロントエンド (React / TypeScript / Vite / Tailwind)
├── data/                      # SQLite本番データベース (/data/school_workflow.db)
├── backups/                   # 自動バックアップファイル格納ディレクトリ
├── logs/                      # サーバー稼働ログ
├── scripts/                   # 運用・起動スクリプト (start-windows.bat, restore.bat 等)
├── docs/                      # 各種手順書・法規定義書
│   ├── REGULATION_COMPLIANCE_GUIDE.md  # 【最重要】条例・人事委員会規則 準拠定義書
│   ├── 01_windows_setup.md
│   ├── 02_firewall_guide.md
│   └── 03_recovery_guide.md
├── .env                       # 環境設定
└── README.md
```

---

## AI Development & Quality Governance

* **AI Development Protocol**: [`/ai/SCHOOL_WORKFLOW_AI_MASTER_PROTOCOL.md`](file:///Users/ishikawayoshiyuki/Documents/Antigravity/school-workflow/ai/SCHOOL_WORKFLOW_AI_MASTER_PROTOCOL.md)
* **Quality Foundation (SSOT)**: `/constitution`, `/policies`, `/specs`, `/tests`, `/audit`, `/quality-gates`

---

---

## クイックスタート (Mac / Windows 共通)

### 1. 依存パッケージのインストール
```bash
npm install
```

### 2. ビルド＆起動
```bash
# フロントエンドのビルド
npm run build:client

# サーバーの起動
npm run dev:server
# または
npm start
```

### 3. ブラウザでアクセス
起動時にコンソールに表示されたアドレス（例: `http://localhost:3000` または `http://192.168.x.x:3000`）へアクセスします。

---

## 検証用初期アカウント (PoC)

| ユーザー名 (ID) | パスワード | 氏名 | ロール |
|:---|:---|:---|:---|
| `teacher1` | `teacher123` | 山田 太郎 | 一般教職員 (`TEACHER`) |
| `teacher2` | `teacher123` | 佐藤 花子 | 一般教職員 (`TEACHER`) |
| `vice_principal` | `vice123` | 田中 誠 | 教頭・一次承認者 (`VICE_PRINCIPAL`) |
| `principal` | `principal123` | 鈴木 健一 | 校長・最終決裁者 (`PRINCIPAL`) |
| `admin` | `admin123` | システム管理者D | 管理者 (`ADMIN`) |

※ PoCモード有効時（`POC_MODE=true`）は、画面上部のクイック切替バーからワンクリックでアカウントを切り替えて検証できます。
