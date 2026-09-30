import React, { useState } from 'react';
import { api } from '../services/api';
import { User } from '../types';
import { FileText, Lock, User as UserIcon, AlertCircle } from 'lucide-react';

interface Props {
  onLoginSuccess: (user: User) => void;
  pocMode?: boolean;
}

export const LoginPage: React.FC<Props> = ({ onLoginSuccess, pocMode = true }) => {
  const [username, setUsername] = useState(pocMode ? 'teacher1' : '');
  const [password, setPassword] = useState(pocMode ? 'teacher123' : '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [publicSettings, setPublicSettings] = useState<{ schoolName: string; appTitle: string }>({
    schoolName: '校内LAN閉域運用基盤',
    appTitle: '学校業務ワークフローシステム',
  });

  React.useEffect(() => {
    api.getPublicSettings()
      .then((res) => {
        if (res.data) {
          setPublicSettings(res.data);
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.login(username, password);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'ログインに失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <div className="bg-blue-700 text-white p-3 rounded-2xl shadow-lg">
            <FileText className="w-8 h-8" />
          </div>
        </div>
        <h2 className="mt-4 text-center text-2xl font-bold tracking-tight text-slate-800">
          {publicSettings.appTitle}
        </h2>
        <p className="mt-1 text-center text-xs text-slate-500">
          {publicSettings.schoolName} (校内LAN閉域運用基盤)
        </p>
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-xl sm:px-10 border border-slate-200">
          {error && (
            <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 text-xs p-3 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                ユーザー名 (ID)
              </label>
              <div className="mt-1 relative rounded-md shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <UserIcon className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="例: teacher1"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                パスワード
              </label>
              <div className="mt-1 relative rounded-md shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="パスワード"
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
              >
                {loading ? '認証中...' : 'ログイン'}
              </button>
            </div>
          </form>

          {/* 初期アカウント案内 (POC_MODE=true のみ表示) */}
          {pocMode && (
            <div className="mt-6 border-t border-slate-100 pt-4">
              <h4 className="text-xs font-semibold text-slate-500 mb-2">検証用 初期アカウント:</h4>
              <div className="space-y-1 text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <div>・教員A: <code className="font-mono text-blue-600">teacher1</code> / <code className="font-mono">teacher123</code></div>
                <div>・教員B: <code className="font-mono text-blue-600">teacher2</code> / <code className="font-mono">teacher123</code></div>
                <div>・教頭B: <code className="font-mono text-blue-600">vice_principal</code> / <code className="font-mono">vice123</code></div>
                <div>・校長C: <code className="font-mono text-blue-600">principal</code> / <code className="font-mono">principal123</code></div>
                <div>・事務係D: <code className="font-mono text-emerald-600">office</code> / <code className="font-mono">office123</code></div>
                <div>・システム管理者E: <code className="font-mono text-purple-600">admin</code> / <code className="font-mono">admin123</code></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
