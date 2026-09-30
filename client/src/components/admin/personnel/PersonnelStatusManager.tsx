import React, { useState, useEffect } from 'react';
import { api } from '../../../services/api';
import { User, PersonnelStatusRecord, PersonnelStatusType, AuthorityBasis } from '../../../types';
import { PlusCircle, Edit2, XCircle, RotateCcw, Calendar, FileText, AlertCircle, CheckCircle2, Clock } from 'lucide-react';

interface Props {
  currentUser?: User | null;
}

const STATUS_TYPE_LABELS: Record<string, string> = {
  CHILDCARE_LEAVE: '育児休業 (法第26条等)',
  SUSPENSION: '分限休職 (法第28条第2項)',
  DISCIPLINARY_SUSPENSION: '懲戒停職 (法第29条)',
  UNION_FULL_TIME_RELEASE: '専従休職 (法第55条の2)',
  GRADUATE_STUDY_LEAVE: '大学院修学休業 (教育公務員特例法第26条)',
  SELF_DEVELOPMENT_LEAVE: '自己啓発等休業 (法第26条の5)',
  SPOUSAL_ACCOMPANIMENT_LEAVE: '配偶者同行休業 (法第26条の6)',
  DISPATCH: '派遣 (公益的法人等派遣条例等)',
};

const AUTHORITY_BASIS_LABELS: Record<string, string> = {
  OFFICIAL_ORDER: '辞令書・人事発令通知 (OFFICIAL_ORDER)',
  OFFICIAL_NOTICE: '教育委員会公達・指令 (OFFICIAL_NOTICE)',
  ELECTRONIC_NOTICE: '電子辞令・校務通知 (ELECTRONIC_NOTICE)',
  UNVERIFIED_LEGACY: '過去レガシー取込 (UNVERIFIED_LEGACY)',
};

export const PersonnelStatusManager: React.FC<Props> = () => {
  const [statuses, setStatuses] = useState<PersonnelStatusRecord[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // 新規登録モーダル
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newUserId, setNewUserId] = useState<number | ''>('');
  const [newStatusType, setNewStatusType] = useState<PersonnelStatusType>('CHILDCARE_LEAVE');
  const [newEffectiveFrom, setNewEffectiveFrom] = useState('');
  const [newEffectiveTo, setNewEffectiveTo] = useState('');
  const [newDocumentRefNo, setNewDocumentRefNo] = useState('');
  const [newIssuedAt, setNewIssuedAt] = useState('');
  const [newAuthorityBasis, setNewAuthorityBasis] = useState<AuthorityBasis>('OFFICIAL_ORDER');
  const [newReasonCode, setNewReasonCode] = useState('LEGAL_STATUTORY');

  // 訂正モーダル
  const [amendTarget, setAmendTarget] = useState<PersonnelStatusRecord | null>(null);
  const [amendEffectiveFrom, setAmendEffectiveFrom] = useState('');
  const [amendEffectiveTo, setAmendEffectiveTo] = useState('');
  const [amendDocRefNo, setAmendDocRefNo] = useState('');
  const [amendIssuedAt, setAmendIssuedAt] = useState('');
  const [amendAuthorityBasis, setAmendAuthorityBasis] = useState<AuthorityBasis>('OFFICIAL_ORDER');
  const [amendmentReason, setAmendmentReason] = useState('');

  // 取消モーダル
  const [cancelTarget, setCancelTarget] = useState<PersonnelStatusRecord | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');

  // 復職モーダル
  const [returnTarget, setReturnTarget] = useState<PersonnelStatusRecord | null>(null);
  const [returnDate, setReturnDate] = useState('');
  const [returnComment, setReturnComment] = useState('');

  // 期間延長モーダル
  const [extendTarget, setExtendTarget] = useState<PersonnelStatusRecord | null>(null);
  const [newExtendTo, setNewExtendTo] = useState('');
  const [extendComment, setExtendComment] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [stRes, uRes] = await Promise.all([
        api.getPersonnelStatuses(),
        api.getMembers(),
      ]);
      setStatuses(stRes.data || []);
      setUsers(uRes.members || []);
    } catch (err: any) {
      setError(err.message || 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserId || !newStatusType || !newEffectiveFrom || !newReasonCode) {
      setError('必須項目を入力してください');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await api.createPersonnelStatus({
        userId: Number(newUserId),
        statusType: newStatusType,
        effectiveFrom: newEffectiveFrom,
        effectiveTo: newEffectiveTo.trim() || null,
        documentReferenceNo: newDocumentRefNo.trim() || undefined,
        issuedAt: newIssuedAt.trim() || undefined,
        authorityBasis: newAuthorityBasis,
        reasonCode: newReasonCode,
      });
      setSuccess('人事発令を登録しました');
      setIsCreateModalOpen(false);
      loadData();
    } catch (err: any) {
      setError(err.message || '登録に失敗しました');
    }
  };

  const handleAmend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amendTarget || !amendEffectiveFrom || !amendmentReason) {
      setError('新開始日と訂正理由は必須です');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await api.amendPersonnelStatus(amendTarget.id, {
        newEffectiveFrom: amendEffectiveFrom,
        newEffectiveTo: amendEffectiveTo.trim() || null,
        newDocumentReferenceNo: amendDocRefNo.trim() || undefined,
        newIssuedAt: amendIssuedAt.trim() || undefined,
        newAuthorityBasis: amendAuthorityBasis,
        amendmentReason,
      });
      setSuccess('人事発令を訂正しました (旧レコードはSUPERSEDED_BY_AMENDMENTに更新)');
      setAmendTarget(null);
      loadData();
    } catch (err: any) {
      setError(err.message || '訂正に失敗しました');
    }
  };

  const handleCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTarget || !cancellationReason) {
      setError('取消理由は必須です');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await api.cancelPersonnelStatus(cancelTarget.id, cancellationReason);
      setSuccess('人事発令を取り消しました (重複失効していた申請はExact-Reversal復元)');
      setCancelTarget(null);
      loadData();
    } catch (err: any) {
      setError(err.message || '取消に失敗しました');
    }
  };

  const handleReturnToDuty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnTarget || !returnDate) {
      setError('復職日は必須です');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await api.returnPersonnelStatusToDuty(returnTarget.id, returnDate, returnComment);
      setSuccess('復職発令を反映しました');
      setReturnTarget(null);
      loadData();
    } catch (err: any) {
      setError(err.message || '復職処理に失敗しました');
    }
  };

  const handleExtend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!extendTarget || !newExtendTo) {
      setError('新しい終了日は必須です');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await api.extendPersonnelStatusPeriod(extendTarget.id, newExtendTo, extendComment);
      setSuccess('期間を延長しました');
      setExtendTarget(null);
      loadData();
    } catch (err: any) {
      setError(err.message || '期間延長に失敗しました');
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
      <div className="flex justify-between items-center mb-6 pb-4 border-b border-slate-100">
        <div>
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <span>🏛️</span> 人事発令（休職・停職・育休等）管理
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            任命権者による人事異動・休職・停職・育休発令をServer-Authoritativeに登録・訂正・取消・出勤簿へ自動連動します。
          </p>
        </div>
        <button
          onClick={() => {
            setError('');
            setSuccess('');
            setNewUserId(users[0]?.id || '');
            setNewEffectiveFrom(new Date().toISOString().split('T')[0]);
            setNewEffectiveTo('');
            setNewIssuedAt(new Date().toISOString().split('T')[0]);
            setNewDocumentRefNo('');
            setIsCreateModalOpen(true);
          }}
          className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded shadow-sm flex items-center gap-1.5 transition"
        >
          <PlusCircle className="w-4 h-4" />
          <span>新規人事発令登録</span>
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-xs text-slate-400">データ読込中...</div>
      ) : statuses.length === 0 ? (
        <div className="py-12 text-center text-xs text-slate-400">登録されている人事発令はありません</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-y border-slate-200 text-slate-600">
                <th className="py-2.5 px-3 font-semibold">ID</th>
                <th className="py-2.5 px-3 font-semibold">対象職員</th>
                <th className="py-2.5 px-3 font-semibold">身分状態区分</th>
                <th className="py-2.5 px-3 font-semibold">発令期間</th>
                <th className="py-2.5 px-3 font-semibold">発令日 / 辞令番号</th>
                <th className="py-2.5 px-3 font-semibold">成立根拠 / 発令権者</th>
                <th className="py-2.5 px-3 font-semibold">状態</th>
                <th className="py-2.5 px-3 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {statuses.map((st) => (
                <tr key={st.id} className="hover:bg-slate-50/50 transition">
                  <td className="py-2.5 px-3 font-mono text-slate-500">#{st.id}</td>
                  <td className="py-2.5 px-3">
                    <span className="font-bold text-slate-800">{st.display_name}</span>
                    <span className="text-slate-400 text-[11px] block">{st.department}</span>
                  </td>
                  <td className="py-2.5 px-3">
                    <span className="font-medium text-slate-700">
                      {STATUS_TYPE_LABELS[st.status_type] || st.official_name || st.status_type}
                    </span>
                    <span className="text-[10px] bg-slate-100 text-slate-600 px-1 py-0.5 rounded ml-1.5 font-mono">
                      {st.display_code || st.status_type}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-700">
                    {st.effective_from} 〜 {st.effective_to || <span className="text-amber-600 font-semibold">(期間未定)</span>}
                  </td>
                  <td className="py-2.5 px-3 text-slate-600">
                    <div>{st.issued_at ? `発令: ${st.issued_at}` : <span className="text-slate-400 text-[11px]">(発令日未記載)</span>}</div>
                    {st.document_reference_no && <div className="text-[11px] text-slate-500 font-mono">第{st.document_reference_no}号</div>}
                  </td>
                  <td className="py-2.5 px-3 text-slate-600">
                    <div className="text-[11px]">{AUTHORITY_BASIS_LABELS[st.authority_basis] || st.authority_basis}</div>
                    <div className="text-[10px] text-slate-400 font-medium">{st.order_authority_snapshot}</div>
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${
                      st.status === 'CONFIRMED' || st.status === 'EFFECTIVE'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : st.status === 'SUPERSEDED_BY_AMENDMENT'
                        ? 'bg-purple-50 text-purple-700 border border-purple-200'
                        : st.status === 'CANCELLED'
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                      {st.status}
                    </span>
                    {st.superseded_by_status_id && (
                      <span className="text-[10px] text-purple-600 block mt-0.5">➔ #{st.superseded_by_status_id}へ訂正</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {!['CANCELLED', 'SUPERSEDED_BY_AMENDMENT', 'ENDED'].includes(st.status) && (
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            setAmendTarget(st);
                            setAmendEffectiveFrom(st.effective_from);
                            setAmendEffectiveTo(st.effective_to || '');
                            setAmendDocRefNo(st.document_reference_no || '');
                            setAmendIssuedAt(st.issued_at || '');
                            setAmendAuthorityBasis(st.authority_basis);
                            setAmendmentReason('');
                          }}
                          className="p-1 text-slate-500 hover:text-purple-600 rounded transition"
                          title="発令訂正 (AMEND)"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setExtendTarget(st);
                            setNewExtendTo(st.effective_to || '');
                            setExtendComment('');
                          }}
                          className="p-1 text-slate-500 hover:text-blue-600 rounded transition"
                          title="期間延長 (EXTEND)"
                        >
                          <Clock className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setReturnTarget(st);
                            setReturnDate(new Date().toISOString().split('T')[0]);
                            setReturnComment('');
                          }}
                          className="p-1 text-slate-500 hover:text-emerald-600 rounded transition"
                          title="復職 (RETURN_TO_DUTY)"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setCancelTarget(st);
                            setCancellationReason('');
                          }}
                          className="p-1 text-slate-500 hover:text-red-600 rounded transition"
                          title="発令取消 (CANCEL)"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 新規登録モーダル */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 text-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2">
              <PlusCircle className="w-4 h-4 text-purple-600" />
              <span>人事発令新規登録</span>
            </h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">対象職員 *</label>
                <select
                  value={newUserId}
                  onChange={(e) => setNewUserId(Number(e.target.value))}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 bg-white text-xs"
                  required
                >
                  <option value="">選択してください</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} ({u.department || '所属未定'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">身分状態種別 *</label>
                <select
                  value={newStatusType}
                  onChange={(e) => setNewStatusType(e.target.value as PersonnelStatusType)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 bg-white text-xs"
                >
                  {Object.entries(STATUS_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">開始日 (effective_from) *</label>
                  <input
                    type="date"
                    value={newEffectiveFrom}
                    onChange={(e) => setNewEffectiveFrom(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">終了日 (effective_to)</label>
                  <input
                    type="date"
                    value={newEffectiveTo}
                    onChange={(e) => setNewEffectiveTo(e.target.value)}
                    placeholder="期間未定時は空欄"
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">発令日 (issued_at)</label>
                  <input
                    type="date"
                    value={newIssuedAt}
                    onChange={(e) => setNewIssuedAt(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">辞令番号・文書番号</label>
                  <input
                    type="text"
                    value={newDocumentRefNo}
                    onChange={(e) => setNewDocumentRefNo(e.target.value)}
                    placeholder="例: 教人第123号"
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">成立根拠形式 (authority_basis) *</label>
                <select
                  value={newAuthorityBasis}
                  onChange={(e) => setNewAuthorityBasis(e.target.value as AuthorityBasis)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 bg-white text-xs"
                >
                  <option value="OFFICIAL_ORDER">辞令書・人事発令通知 (OFFICIAL_ORDER)</option>
                  <option value="OFFICIAL_NOTICE">教育委員会公達・指令 (OFFICIAL_NOTICE)</option>
                  <option value="ELECTRONIC_NOTICE">電子辞令・校務通知 (ELECTRONIC_NOTICE)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded text-xs shadow-sm"
                >
                  登録確定
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 発令訂正モーダル */}
      {amendTarget && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 text-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2">
              <Edit2 className="w-4 h-4 text-purple-600" />
              <span>人事発令訂正 (AMEND) — #{amendTarget.id}</span>
            </h3>
            <p className="text-slate-500 mb-4 text-[11px]">
              元レコードは <code>SUPERSEDED_BY_AMENDMENT</code> として永続保持され、新しい発令レコードが発行されます。
            </p>
            <form onSubmit={handleAmend} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">新開始日 *</label>
                  <input
                    type="date"
                    value={amendEffectiveFrom}
                    onChange={(e) => setAmendEffectiveFrom(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">新終了日</label>
                  <input
                    type="date"
                    value={amendEffectiveTo}
                    onChange={(e) => setAmendEffectiveTo(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">訂正理由 (必須) *</label>
                <input
                  type="text"
                  value={amendmentReason}
                  onChange={(e) => setAmendmentReason(e.target.value)}
                  placeholder="例: 県教委辞令日付誤記による訂正発令"
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setAmendTarget(null)}
                  className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded text-xs shadow-sm"
                >
                  訂正発行
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 発令取消モーダル */}
      {cancelTarget && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 text-xs">
            <h3 className="text-sm font-bold text-red-600 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2">
              <XCircle className="w-4 h-4" />
              <span>人事発令取消 (CANCEL) — #{cancelTarget.id}</span>
            </h3>
            <p className="text-slate-600 mb-4 text-[11px] leading-relaxed">
              この発令を取り消します。この発令によって失効していた服務申請は <strong>Exact Previous State</strong> に復元され、年休は再引当されます。
            </p>
            <form onSubmit={handleCancel} className="space-y-4">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">取消理由 (必須) *</label>
                <textarea
                  value={cancellationReason}
                  onChange={(e) => setCancellationReason(e.target.value)}
                  placeholder="例: 任命権者による発令撤回辞令 (教人第456号)"
                  rows={3}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCancelTarget(null)}
                  className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded text-xs"
                >
                  戻る
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded text-xs shadow-sm"
                >
                  取消実行
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 復職モーダル */}
      {returnTarget && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 text-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-emerald-600" />
              <span>復職発令反映 (RETURN_TO_DUTY) — #{returnTarget.id}</span>
            </h3>
            <form onSubmit={handleReturnToDuty} className="space-y-4">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">復職日 *</label>
                <input
                  type="date"
                  value={returnDate}
                  onChange={(e) => setReturnDate(e.target.value)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">備考 / 辞令番号</label>
                <input
                  type="text"
                  value={returnComment}
                  onChange={(e) => setReturnComment(e.target.value)}
                  placeholder="例: 復職辞令 (教人第789号)"
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setReturnTarget(null)}
                  className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-xs shadow-sm"
                >
                  復職反映
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 期間延長モーダル */}
      {extendTarget && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 text-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-600" />
              <span>期間延長 (EXTEND) — #{extendTarget.id}</span>
            </h3>
            <form onSubmit={handleExtend} className="space-y-4">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">新しい終了日 (effective_to) *</label>
                <input
                  type="date"
                  value={newExtendTo}
                  onChange={(e) => setNewExtendTo(e.target.value)}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">延長理由 / 辞令番号</label>
                <input
                  type="text"
                  value={extendComment}
                  onChange={(e) => setExtendComment(e.target.value)}
                  placeholder="例: 育児休業期間延長辞令"
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setExtendTarget(null)}
                  className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded text-xs"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded text-xs shadow-sm"
                >
                  延長反映
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
