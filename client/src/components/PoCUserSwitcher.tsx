import React, { useEffect, useState } from 'react';
import { User } from '../types';
import { api } from '../services/api';
import { ShieldAlert, UserCheck } from 'lucide-react';

interface Props {
  currentUser: User;
  onUserSwitched: (user: User) => void;
}

function getRoleBadge(roles: string[] | string) {
  const rList = Array.isArray(roles) ? roles : typeof roles === 'string' ? (roles as string).split(',') : [];
  if (rList.includes('ADMIN')) return { label: '管理者', bg: 'bg-purple-700 text-white' };
  if (rList.includes('OFFICE')) return { label: '事務係', bg: 'bg-emerald-700 text-white' };
  if (rList.includes('PRINCIPAL')) return { label: '校長', bg: 'bg-amber-700 text-white' };
  if (rList.includes('VICE_PRINCIPAL')) return { label: '教頭', bg: 'bg-blue-700 text-white' };
  return { label: '教員', bg: 'bg-slate-700 text-white' };
}

export const PoCUserSwitcher: React.FC<Props> = ({ currentUser, onUserSwitched }) => {
  const [pocUsers, setPocUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getPocUsers()
      .then((res) => setPocUsers(res.users))
      .catch(() => setPocUsers([]));
  }, []);

  if (pocUsers.length === 0) return null;

  const handleSwitch = async (userId: number) => {
    if (userId === currentUser.id || loading) return;
    try {
      setLoading(true);
      const res = await api.pocSwitch(userId);
      onUserSwitched(res.user);
    } catch (err: any) {
      alert(`ユーザー切替失敗: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-amber-500 text-slate-900 px-4 py-2 text-xs border-b border-amber-600 shadow-sm flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 font-bold">
        <ShieldAlert className="w-4 h-4 text-slate-900" />
        <span>【PoC検証モード】クイックユーザー切替:</span>
        <span className="font-normal text-slate-800 text-[11px]">（POC_MODE=false 時は完全非表示）</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {pocUsers.map((u) => {
          const isCurrent = u.id === currentUser.id;
          const badge = getRoleBadge(u.roles);
          return (
            <button
              key={u.id}
              onClick={() => handleSwitch(u.id)}
              disabled={isCurrent || loading}
              className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 text-xs ${
                isCurrent
                  ? 'bg-slate-900 text-amber-400 ring-2 ring-slate-900 shadow-sm'
                  : 'bg-amber-100/90 hover:bg-white text-slate-900 border border-amber-300 shadow-2xs'
              }`}
            >
              <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${badge.bg}`}>
                {badge.label}
              </span>
              <span>{u.displayName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
