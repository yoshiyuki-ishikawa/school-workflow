import React, { useState } from 'react';
import { Lock, ShieldCheck, ArrowRight, AlertCircle, Eye, EyeOff } from 'lucide-react';

interface SiteAccessGateProps {
  children: React.ReactNode;
}

const STORAGE_KEY = 'school_workflow_site_access_granted';
const DEFAULT_PASSWORD = 'y-school2026';

export const SiteAccessGate: React.FC<SiteAccessGateProps> = ({ children }) => {
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    return sessionStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [inputPassword, setInputPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 環境変数 VITE_SITE_ACCESS_PASSWORD があればそれを優先、なければ初期設定の y-school2026
  const targetPassword = (import.meta as any).env?.VITE_SITE_ACCESS_PASSWORD || DEFAULT_PASSWORD;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputPassword === targetPassword) {
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setIsUnlocked(true);
      setError(null);
    } else {
      setError('パスワードが正しくありません。再度ご確認ください。');
    }
  };

  if (isUnlocked) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8 border border-slate-200">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-4 shadow-sm border border-blue-100">
            <Lock className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">
            学校業務ワークフローシステム
          </h1>
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-widest mt-1">
            関係者専用アクセス認証
          </p>
        </div>

        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs px-4 py-3 rounded-lg mb-6 leading-relaxed flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>※関係者専用システムです。閲覧パスワードを入力してください</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              閲覧パスワード
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={inputPassword}
                onChange={(e) => {
                  setInputPassword(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="パスワードを入力してください"
                autoFocus
                className="w-full px-4 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-100">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-medium text-sm rounded-lg transition shadow-sm hover:shadow flex items-center justify-center gap-2"
          >
            <span>認証して入室</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-8 text-center text-[11px] text-slate-400">
          © 学校業務DX推進プロジェクト - 閉域運用環境
        </div>
      </div>
    </div>
  );
};
