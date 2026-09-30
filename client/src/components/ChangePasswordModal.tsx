import React, { useState } from 'react';
import { api } from '../services/api';
import { Lock, AlertCircle, CheckCircle } from 'lucide-react';

interface Props {
  isOpen: boolean;
  isForced?: boolean;
  onClose?: () => void;
  onSuccess: () => void;
}

export const ChangePasswordModal: React.FC<Props> = ({
  isOpen,
  isForced = false,
  onClose,
  onSuccess,
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (newPassword !== confirmPassword) {
      setError('新しいパスワードと確認用パスワードが一致しません');
      return;
    }

    if (newPassword.length < 15) {
      setError('パスワードは15文字以上で入力してください');
      return;
    }

    setLoading(true);
    try {
      await api.changePassword({
        currentPassword: isForced ? undefined : currentPassword,
        newPassword,
      });
      setSuccessMsg('パスワードを変更しました');
      setTimeout(() => {
        onSuccess();
        if (onClose) onClose();
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'パスワードの変更に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
        <div className="flex items-center gap-3 mb-4">
          <div className="bg-blue-100 text-blue-700 p-2.5 rounded-xl">
            <Lock className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">
              {isForced ? '初回パスワード変更 (必須)' : 'パスワードの変更'}
            </h3>
            <p className="text-xs text-slate-500">
              {isForced
                ? 'セキュリティのため、新しい恒久パスワードを設定してください'
                : '15文字以上の安全なパスフレーズを設定してください'}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 text-xs p-3 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="mb-4 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs p-3 rounded-lg flex items-center gap-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {!isForced && (
            <div>
              <label className="block font-semibold text-slate-700 mb-1">現在のパスワード *</label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="現在のパスワード"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-700 mb-1">新しいパスワード (15文字以上) *</label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="例: 私のお気に入りの学校2026年"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-slate-400 text-xs">
              ※15文字以上・64文字以内（英数字記号の組み合わせ制限なし、日本語フレーズ可）
            </p>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">新しいパスワード (確認) *</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="もう一度入力してください"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            {!isForced && onClose && (
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors font-medium"
              >
                キャンセル
              </button>
            )}
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold shadow-sm transition-colors disabled:opacity-50"
            >
              {loading ? '更新中...' : 'パスワードを変更する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};