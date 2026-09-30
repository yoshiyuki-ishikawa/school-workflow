import React, { useState, useRef } from 'react';
import { api } from '../services/api';
import { Upload, AlertCircle, CheckCircle, Clock, FileText, ArrowRight, X, AlertTriangle } from 'lucide-react';

interface CalendarImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess: () => void;
}

export const CalendarImportModal: React.FC<CalendarImportModalProps> = ({ isOpen, onClose, onImportSuccess }) => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewData, setPreviewData] = useState<any | null>(null);
  
  // 明示的競合承認のチェック状態 (key: factType_id)
  const [approvedConflicts, setApprovedConflicts] = useState<Record<string, boolean>>({});
  const [commitComment, setCommitComment] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<any | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setError('');
      setPreviewData(null);
      setCommitResult(null);
      setApprovedConflicts({});
    }
  };

  const handlePreview = async () => {
    if (!file) {
      setError('CSVファイルを選択してください');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // FileReaderでBase64として読み込み (Shift_JIS / UTF-8 対応)
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = reader.result as string;
          const res = await api.previewCalendarImport({
            csvContent: base64Data,
            fileName: file.name,
          });
          if (res.success && res.data) {
            setPreviewData(res.data);
            // 競合初期状態 (すべて未承認)
            const initialApproved: Record<string, boolean> = {};
            setApprovedConflicts(initialApproved);
          } else {
            setError(res.message || 'プレビューの生成に失敗しました');
          }
        } catch (err: any) {
          setError(err.message || 'プレビュー通信エラーが発生しました');
        } finally {
          setLoading(false);
        }
      };
      reader.onerror = () => {
        setError('ファイルの読み込みに失敗しました');
        setLoading(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setError(err.message || 'ファイル処理エラーが発生しました');
      setLoading(false);
    }
  };

  const handleToggleConflict = (factType: string, id: number) => {
    const key = `${factType}_${id}`;
    setApprovedConflicts((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleCommit = async () => {
    if (!previewData) return;

    // 確定月度ロックがある場合はコミット不可
    if (previewData.hasLockedMonth) {
      setError('出勤簿確定済みの月度が含まれているため、一括反映できません');
      return;
    }

    // 競合がある場合、すべて承認されているか確認
    const conflicts = previewData.items.filter((item: any) => item.impactCategory === 'CONFLICT_UPDATE');
    const approvedList: Array<{ factType: 'calendar_adjustments' | 'custom_holidays'; id: number }> = [];

    for (const conf of conflicts) {
      if (!conf.conflictDetails) continue;
      const key = `${conf.conflictDetails.existingFactType}_${conf.conflictDetails.existingId}`;
      if (!approvedConflicts[key]) {
        setError(`未承認の競合設定があります: ${conf.sourceDate} ${conf.eventName}`);
        return;
      }
      approvedList.push({
        factType: conf.conflictDetails.existingFactType,
        id: conf.conflictDetails.existingId,
      });
    }

    setCommitting(true);
    setError('');

    try {
      const res = await api.commitCalendarImport({
        previewToken: previewData.previewToken,
        fileSha256: previewData.fileSha256,
        fileName: previewData.fileName,
        fiscalYear: previewData.fiscalYear,
        approvedConflictIds: approvedList,
        commitComment: commitComment || undefined,
      });

      if (res.success && res.data) {
        setCommitResult(res.data);
        onImportSuccess();
      } else {
        setError(res.message || '一括登録に失敗しました');
      }
    } catch (err: any) {
      setError(err.message || 'コミット通信エラーが発生しました');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center space-x-2">
            <Upload className="w-5 h-5 text-indigo-600" />
            <h3 className="text-lg font-bold text-gray-800">学校年間カレンダー一括インポート</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-md flex items-start space-x-3 text-red-700 text-sm">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}

          {commitResult ? (
            <div className="p-6 bg-green-50 border border-green-200 rounded-lg text-center space-y-4">
              <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
              <h4 className="text-lg font-bold text-green-800">インポートが完了しました</h4>
              <p className="text-sm text-green-700">{commitResult.message}</p>
              <div className="inline-block text-left text-sm text-gray-700 bg-white p-4 rounded border border-green-100 shadow-sm space-y-1">
                <div>バッチ番号: <span className="font-mono font-bold">{commitResult.batchCode}</span></div>
                <div>反映件数: <span className="font-bold">{commitResult.totalApplied}</span> 件 (服務調整: {commitResult.appliedAdjustmentsCount}件, 休日: {commitResult.appliedCustomHolidaysCount}件)</div>
                {commitResult.supersededAdjustmentsCount > 0 && (
                  <div>置換された旧設定: <span className="font-bold text-amber-600">{commitResult.supersededAdjustmentsCount}</span> 件</div>
                )}
              </div>
              <div>
                <button
                  onClick={onClose}
                  className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md text-sm font-medium"
                >
                  閉じる
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* File Select */}
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-indigo-500 transition-colors">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".csv,text/csv"
                  className="hidden"
                  id="calendar-csv-input"
                />
                <label htmlFor="calendar-csv-input" className="cursor-pointer space-y-2 block">
                  <FileText className="w-10 h-10 text-gray-400 mx-auto" />
                  <div className="text-sm text-gray-600">
                    <span className="text-indigo-600 font-semibold hover:underline">ファイルを選択</span>
                    <span> またはドラッグ＆ドロップ</span>
                  </div>
                  <div className="text-xs text-gray-500">年間行事計画CSV (Shift_JIS / UTF-8 / UTF-8 BOM 対応)</div>
                </label>
                {file && (
                  <div className="mt-3 text-sm font-medium text-gray-800 flex items-center justify-center space-x-2">
                    <span>選択中: {file.name}</span>
                    <button
                      onClick={handlePreview}
                      disabled={loading}
                      className="ml-3 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold disabled:opacity-50"
                    >
                      {loading ? '解析中...' : 'プレビュー生成'}
                    </button>
                  </div>
                )}
              </div>

              {/* Preview Section */}
              {previewData && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between bg-gray-50 p-4 rounded-lg border border-gray-200">
                    <div>
                      <div className="text-sm font-bold text-gray-800">
                        {previewData.fiscalYear}年度 年間行事計画プレビュー ({previewData.totalParsedRows}件)
                      </div>
                      <div className="text-xs text-gray-500 font-mono mt-0.5">SHA256: {previewData.fileSha256.substring(0, 16)}...</div>
                    </div>
                    <div className="flex space-x-3 text-xs">
                      <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded font-medium">新規: {previewData.summary.newCount}</span>
                      <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded font-medium">変更なし: {previewData.summary.identicalCount}</span>
                      {previewData.summary.conflictCount > 0 && (
                        <span className="px-2 py-1 bg-amber-100 text-amber-800 rounded font-medium">競合・置換: {previewData.summary.conflictCount}</span>
                      )}
                      {previewData.summary.lockedCount > 0 && (
                        <span className="px-2 py-1 bg-red-100 text-red-800 rounded font-medium">確定月ロック: {previewData.summary.lockedCount}</span>
                      )}
                    </div>
                  </div>

                  {previewData.hasLockedMonth && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-center space-x-2">
                      <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      <span>確定済み月度の出勤簿が含まれているため、このままでは一括反映できません。該当月度を出勤簿画面から確定解除するか、CSVを修正してください。</span>
                    </div>
                  )}

                  {/* Candidates Table */}
                  <div className="border border-gray-200 rounded-lg overflow-x-auto max-h-64">
                    <table className="min-w-full divide-y divide-gray-200 text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">状態</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">種別</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">対象日付</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">行事名 / 理由</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">勤務義務</th>
                          <th className="px-3 py-2 text-left font-medium text-gray-500">競合承認</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {previewData.items.map((item: any, idx: number) => {
                          const isConflict = item.impactCategory === 'CONFLICT_UPDATE';
                          const isLocked = item.impactCategory === 'LOCKED';
                          const isNew = item.impactCategory === 'NEW';
                          const isIdentical = item.impactCategory === 'UNCHANGED_IDENTICAL';
                          
                          const conflictKey = item.conflictDetails ? `${item.conflictDetails.existingFactType}_${item.conflictDetails.existingId}` : '';
                          const isApproved = conflictKey ? !!approvedConflicts[conflictKey] : false;

                          return (
                            <tr key={idx} className={isConflict ? 'bg-amber-50/50' : isLocked ? 'bg-red-50/50' : ''}>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {isNew && <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-[10px] font-bold">新規</span>}
                                {isIdentical && <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px]">同一</span>}
                                {isConflict && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-bold">競合</span>}
                                {isLocked && <span className="px-1.5 py-0.5 bg-red-100 text-red-800 rounded text-[10px] font-bold">ロック</span>}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                                {item.candidateType === 'WEEK_OFF_TRANSFER' && '週休振替'}
                                {item.candidateType === 'SUBSTITUTE_HOLIDAY' && '代休'}
                                {item.candidateType === 'SCHOOL_HOLIDAY' && '学校休日'}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap font-mono text-gray-900">
                                {item.sourceDate}
                                {item.targetDate && (
                                  <span className="text-gray-500"> → {item.targetDate}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-gray-800">
                                <div className="font-semibold">{item.eventName}</div>
                                {isConflict && item.conflictDetails && (
                                  <div className="text-[11px] text-amber-800 mt-0.5">
                                    既存: {item.conflictDetails.existingEventName} ({item.conflictDetails.existingRecordOrigin})
                                  </div>
                                )}
                                {isLocked && item.lockReason && (
                                  <div className="text-[11px] text-red-600 mt-0.5">{item.lockReason}</div>
                                )}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-[11px] text-gray-600">
                                {item.sourceDutyStatus === 'WORK_REQUIRED' ? '勤務日' : '休業日'}
                                {item.targetDutyStatus && (
                                  <span> / {item.targetDutyStatus === 'WORK_REQUIRED' ? '勤務日' : '休業日'}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {isConflict && item.conflictDetails && (
                                  <label className="flex items-center space-x-1 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={isApproved}
                                      onChange={() => handleToggleConflict(item.conflictDetails.existingFactType, item.conflictDetails.existingId)}
                                      className="rounded text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5"
                                    />
                                    <span className="text-[11px] text-gray-700">置換を承認</span>
                                  </label>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Comment & Commit */}
                  <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
                    <input
                      type="text"
                      placeholder="反映コメント (例: 2026年度当初行事計画確定)"
                      value={commitComment}
                      onChange={(e) => setCommitComment(e.target.value)}
                      className="border border-gray-300 rounded px-3 py-1.5 text-xs w-2/3 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      onClick={handleCommit}
                      disabled={committing || previewData.hasLockedMonth}
                      className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-xs font-bold disabled:opacity-50 flex items-center space-x-1"
                    >
                      {committing ? '反映中...' : '年間カレンダーへ一括反映'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-white border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-100 font-medium"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
