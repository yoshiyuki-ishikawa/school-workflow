import React, { useState, useEffect } from 'react';
import { api } from '../../../services/api';
import { OfficialJobTitle } from '../../../types';
import { PlusCircle, Lock, Edit2, Trash2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

const CATEGORY_LABELS: Record<string, string> = {
  TEACHING: '主幹教諭・教諭・講師・実習助手等',
  NURSING: '養護教諭・養護助教諭等',
  NUTRITION: '栄養教諭・学校栄養職員等',
  ADMINISTRATION: '事務長・主査・事務主任・主事等',
  OTHER: 'その他職名',
};

export const OfficialJobTitleManager: React.FC = () => {
  const [jobTitles, setJobTitles] = useState<OfficialJobTitle[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 新規・編集モーダル状態
  const [editingTitle, setEditingTitle] = useState<OfficialJobTitle | null>(null);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [formData, setFormData] = useState<{
    id?: string;
    code: string;
    displayName: string;
    category: 'TEACHING' | 'NURSING' | 'NUTRITION' | 'ADMINISTRATION' | 'OTHER';
    sortOrder: number;
    description: string;
    isActive: number;
  }>({
    code: '',
    displayName: '',
    category: 'TEACHING',
    sortOrder: 10,
    description: '',
    isActive: 1,
  });

  const loadJobTitles = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getOfficialJobTitles();
      if (res.success && res.jobTitles) {
        setJobTitles(res.jobTitles);
      }
    } catch (err: any) {
      setError(err.message || '職名マスタの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobTitles();
  }, []);

  const handleOpenCreate = () => {
    setIsCreating(true);
    setEditingTitle(null);
    setFormData({
      code: '',
      displayName: '',
      category: 'TEACHING',
      sortOrder: (jobTitles.length + 1) * 10,
      description: '',
      isActive: 1,
    });
  };

  const handleOpenEdit = (title: OfficialJobTitle) => {
    setIsCreating(false);
    setEditingTitle(title);
    setFormData({
      id: title.id,
      code: title.code,
      displayName: title.display_name,
      category: title.category,
      sortOrder: title.sort_order,
      description: title.description || '',
      isActive: title.is_active,
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    try {
      if (isCreating) {
        await api.createOfficialJobTitle({
          code: formData.code,
          displayName: formData.displayName,
          category: formData.category,
          sortOrder: Number(formData.sortOrder),
          description: formData.description,
          isActive: formData.isActive,
        });
        setSuccessMessage(`職名マスタ「${formData.displayName}」を新規登録しました`);
      } else if (editingTitle) {
        await api.updateOfficialJobTitle(editingTitle.id, {
          code: formData.code,
          displayName: formData.displayName,
          category: formData.category,
          sortOrder: Number(formData.sortOrder),
          description: formData.description,
          isActive: formData.isActive,
        });
        setSuccessMessage(`職名マスタ「${formData.displayName}」を更新しました`);
      }
      setIsCreating(false);
      setEditingTitle(null);
      await loadJobTitles();
    } catch (err: any) {
      setError(err.message || '保存に失敗しました');
    }
  };

  const handleDelete = async (title: OfficialJobTitle) => {
    if (!confirm(`職名マスタ「${title.display_name} (${title.code})」を物理削除しますか？\n※ 教職員への発令実績がある場合は削除できません（新規割当停止を推奨）。`)) {
      return;
    }
    setError(null);
    setSuccessMessage(null);
    try {
      await api.deleteOfficialJobTitle(title.id);
      setSuccessMessage(`職名マスタ「${title.display_name}」を削除しました`);
      await loadJobTitles();
    } catch (err: any) {
      setError(err.message || '削除に失敗しました');
    }
  };

  return (
    <div className="space-y-6">
      {/* ヘッダー説明 */}
      <div className="bg-white rounded-xl p-6 border border-slate-200 shadow-sm">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <span>正式職名マスタ管理 (Official Job Title SSOT)</span>
              <span className="px-2.5 py-0.5 text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full">
                条例・人事発令準拠
              </span>
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              教職員の人事発令（辞令）に基づく正式職名を一元管理します。出勤簿・旅行命令簿・復命書等の公文書へServer-Authoritativeに出力されます。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadJobTitles}
              className="p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg border border-slate-200 transition"
              title="再読み込み"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleOpenCreate}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg shadow-sm transition"
            >
              <PlusCircle className="w-4 h-4" />
              <span>新規職名マスタ登録</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMessage && (
          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}
      </div>

      {/* マスタ一覧テーブル */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <span className="text-sm font-bold text-slate-700">登録済み職名一覧 ({jobTitles.length}件)</span>
          <span className="text-xs text-slate-500">※ 使用実績がある職名の名称・コード変更はセマンティック改変防止（INV-JT-11）により保護されます</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">順序</th>
                <th className="px-4 py-3 text-left font-semibold">識別コード (Code)</th>
                <th className="px-4 py-3 text-left font-semibold">公文書表示名 (Display Name)</th>
                <th className="px-4 py-3 text-left font-semibold">職種区分 (Category)</th>
                <th className="px-4 py-3 text-left font-semibold">状態</th>
                <th className="px-4 py-3 text-left font-semibold">説明・根拠規程</th>
                <th className="px-4 py-3 text-right font-semibold">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {jobTitles.map((title) => (
                <tr key={title.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-slate-500">{title.sort_order}</td>
                  <td className="px-4 py-3 font-mono font-bold text-slate-800">{title.code}</td>
                  <td className="px-4 py-3 font-bold text-slate-900 text-sm">{title.display_name}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                      {CATEGORY_LABELS[title.category] || title.category}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {title.is_active === 1 ? (
                      <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                        利用可能
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-50 text-amber-700 border border-amber-200">
                        新規割当停止
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 max-w-xs truncate">{title.description || '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => handleOpenEdit(title)}
                        className="p-1.5 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                        title="編集"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(title)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                        title="物理削除 (実績なしのみ)"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 新規・編集モーダル */}
      {(isCreating || editingTitle) && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full shadow-2xl overflow-hidden border border-slate-200 animate-fadeIn">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">
                {isCreating ? '新規職名マスタの登録' : `職名マスタ編集: ${editingTitle?.display_name}`}
              </h3>
              <button
                onClick={() => {
                  setIsCreating(false);
                  setEditingTitle(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  職名識別コード (Code) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例: TEACHER, CHIEF_CLERK"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
                <p className="text-[11px] text-slate-400 mt-1">※ 一意の英数字識別子。使用実績がある場合は変更不可</p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  公文書正式表示名 (Display Name) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例: 教諭, 主査, 主任主事"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-bold text-slate-900 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
                <p className="text-[11px] text-slate-400 mt-1">※ 出勤簿等の帳票に直接印字される正式名称</p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  職種区分 (Category) <span className="text-rose-500">*</span>
                </label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value as any })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="TEACHING">教員系 (主幹教諭・教諭・助教諭・講師等)</option>
                  <option value="NURSING">養護系 (養護教諭・養護助教諭等)</option>
                  <option value="NUTRITION">栄養系 (栄養教諭・学校栄養職員等)</option>
                  <option value="ADMINISTRATION">事務系 (事務長・主査・主任・主事等)</option>
                  <option value="OTHER">その他</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">表示順序 (Sort Order)</label>
                  <input
                    type="number"
                    value={formData.sortOrder}
                    onChange={(e) => setFormData({ ...formData, sortOrder: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">状態 (Active Status)</label>
                  <select
                    value={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  >
                    <option value={1}>利用可能 (Active)</option>
                    <option value={0}>新規割当停止 (Retired)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">説明・法規根拠 (任意)</label>
                <textarea
                  rows={2}
                  placeholder="例: 学校教育法第37条第16項、山口県公立学校職員給与条例等"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsCreating(false);
                    setEditingTitle(null);
                  }}
                  className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm transition"
                >
                  {isCreating ? '登録する' : '変更を保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
