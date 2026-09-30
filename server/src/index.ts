import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from './config';
import { initDatabase, seedDatabase, getDb, createBackup, checkIntegrity } from './db';
import authRoutes from './routes/auth';
import applicationRoutes from './routes/applications';
import adminRoutes from './routes/admin';
import attendanceRoutes from './routes/attendance';
import formsRoutes from './routes/forms';
import systemRoutes from './routes/system';
import personnelRoutes from './routes/personnelStatuses';
import absencesRoutes from './routes/absences';
import careCasesRoutes from './routes/careCases';
import schemaRoutes from './routes/schemas';
import { enforcePasswordStateGate } from './middlewares/auth';

const app = express();

// 基本ミドルウェア
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// セッション設定 (HttpOnly Cookie, SameSite=Lax)
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // PoC環境(HTTP)ではfalse、本番HTTPS化時にtrue
    maxAge: 1000 * 60 * 60 * 24, // 24時間
  },
}));

// API ルーティング (Layer 1: Public / Auth Routes)
app.use('/api/system', systemRoutes);
app.use('/api/auth', authRoutes);

// Forced Password Change Gate (Layer 3: Default-Deny for all subsequent business routes)
app.use('/api', enforcePasswordStateGate);

// API ルーティング (Layer 4: Protected Business Routers)
app.use('/api/applications', applicationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/forms', formsRoutes);
app.use('/api/personnel-statuses', personnelRoutes);
app.use('/api/absences', absencesRoutes);
app.use('/api/care-cases', careCasesRoutes);
app.use('/api/schemas', schemaRoutes);

// グローバルエラーハンドラー
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[Express Error] ${req.method} ${req.url}:`, err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '内部サーバーエラーが発生しました',
  });
});

// クライアント静的ファイル配信 (Vite build成果物)
if (fs.existsSync(config.CLIENT_DIST)) {
  app.use(express.static(config.CLIENT_DIST));
  // SPA fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(config.CLIENT_DIST, 'index.html'));
  });
}

let isDbInitialized = false;

export function ensureDatabaseInitialized(): void {
  if (!isDbInitialized) {
    try {
      initDatabase();
      seedDatabase();
      isDbInitialized = true;
      console.log('[Server] Database initialized and seeded successfully.');
    } catch (err: any) {
      console.error('[Server] Database initialization failed:', err.message);
      throw err;
    }
  }
}

// サーバーレス環境（Vercel）でも初回リクエスト時にDB初期化が保証されるミドルウェア
app.use((req, res, next) => {
  try {
    ensureDatabaseInitialized();
    next();
  } catch (err) {
    next(err);
  }
});

// サーバー起動処理 (ローカル・コンテナ実行用)
function startServer() {
  ensureDatabaseInitialized();

  // サーバー待受開始
  const server = app.listen(config.PORT, () => {
    console.log(`=========================================`);
    console.log(`  学校業務ワークフロー 服務管理システム`);
    console.log(`  PoC Server Running on port: ${config.PORT}`);
    console.log(`  Environment: ${config.NODE_ENV}`);
    console.log(`  PoC Mode: ${config.POC_MODE ? 'ENABLED (Multi-Account Switch Active)' : 'DISABLED'}`);
    console.log(`=========================================`);
  });

  // グレースフルシャットダウン
  const shutdown = () => {
    console.log('\n[Server] Shutting down gracefully...');
    server.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 直接実行時のみサーバー起動
if (require.main === module) {
  startServer();
}

export default app;
