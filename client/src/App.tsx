import React, { useState, useEffect } from 'react';
import { api } from './services/api';
import { User } from './types';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { ApplicationDetailPage } from './pages/ApplicationDetailPage';
import { AdminAuditPage } from './pages/AdminAuditPage';
import { AttendanceBookPage } from './pages/AttendanceBookPage';
import { NewApplicationModal } from './pages/NewApplicationModal';
import { Header } from './components/Header';
import { PoCUserSwitcher } from './components/PoCUserSwitcher';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { SiteAccessGate } from './components/SiteAccessGate';

export default function App() {
  return (
    <SiteAccessGate>
      <MainApp />
    </SiteAccessGate>
  );
}

function MainApp() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [pocMode, setPocMode] = useState(true);
  const [activeTab, setActiveTab] = useState<'my' | 'pending_approval' | 'all' | 'attendance' | 'admin'>('my');
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [publicSettings, setPublicSettings] = useState<{ schoolName: string; appTitle: string }>({
    schoolName: '校内LAN閉域運用システム',
    appTitle: '学校業務ワークフロー',
  });

  const loadPublicSettings = () => {
    api.getPublicSettings()
      .then((res) => {
        if (res.data) {
          setPublicSettings(res.data);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadPublicSettings();
    api.getMe()
      .then((res) => {
        setCurrentUser(res.user);
        setPocMode(res.pocMode);
      })
      .catch(() => {
        setCurrentUser(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      setCurrentUser(null);
      setSelectedAppId(null);
      setActiveTab('my');
    }
  };

  const handleUserSwitched = (newUser: User) => {
    setCurrentUser(newUser);
    setSelectedAppId(null);
    if (!newUser.roles.includes('ADMIN') && activeTab === 'admin') {
      setActiveTab('my');
    }
    setRefreshTrigger((prev) => prev + 1);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center text-xs text-slate-500">
        システム初期化中...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginPage
        pocMode={pocMode}
        onLoginSuccess={(user) => {
          setCurrentUser(user);
          setSelectedAppId(null);
          if (!user.roles.includes('ADMIN') && activeTab === 'admin') {
            setActiveTab('my');
          }
          setRefreshTrigger((prev) => prev + 1);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans">
      {/* PoC検証用 クイックユーザー切替バー (POC_MODE=true のみ有効) */}
      {pocMode && (
        <PoCUserSwitcher
          currentUser={currentUser}
          onUserSwitched={handleUserSwitched}
        />
      )}

      {/* システムヘッダー */}
      <Header
        user={currentUser}
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setActiveTab(tab);
          setSelectedAppId(null);
        }}
        onLogout={handleLogout}
        onOpenNewModal={() => setIsNewModalOpen(true)}
        onOpenPasswordModal={() => setIsPasswordModalOpen(true)}
        appTitle={publicSettings.appTitle}
        schoolName={publicSettings.schoolName}
        refreshTrigger={refreshTrigger}
      />

      {/* メインコンテンツエリア */}
      <main className="flex-1 pb-12">
        <ErrorBoundary
          fallbackTitle="画面表示エラー"
          onReset={() => {
            setSelectedAppId(null);
            setActiveTab('my');
          }}
        >
          {selectedAppId ? (
            <ApplicationDetailPage
              applicationId={selectedAppId}
              currentUser={currentUser}
              onBack={() => setSelectedAppId(null)}
              onRefresh={() => setRefreshTrigger((prev) => prev + 1)}
            />
          ) : activeTab === 'attendance' ? (
            <AttendanceBookPage
              currentUser={currentUser}
              onSelectApplication={(id) => setSelectedAppId(id)}
            />
          ) : activeTab === 'admin' && currentUser.roles.includes('ADMIN') ? (
            <AdminAuditPage onSettingsUpdated={loadPublicSettings} />
          ) : (
            <DashboardPage
              currentUser={currentUser}
              activeTab={activeTab === 'admin' ? 'my' : activeTab}
              onSelectApplication={(id) => setSelectedAppId(id)}
              onOpenNewModal={() => setIsNewModalOpen(true)}
              refreshTrigger={refreshTrigger}
            />
          )}
        </ErrorBoundary>
      </main>

      {/* 新規申請モーダル */}
      <ErrorBoundary
        fallbackTitle="申請フォームエラー"
        onReset={() => setIsNewModalOpen(false)}
      >
        <NewApplicationModal
          isOpen={isNewModalOpen}
          currentUser={currentUser}
          onClose={() => setIsNewModalOpen(false)}
          onSuccess={() => {
            setRefreshTrigger((prev) => prev + 1);
            setActiveTab('my');
          }}
        />
      </ErrorBoundary>

      {/* パスワード変更モーダル (自己変更 & 初回/リセット強制変更) */}
      <ChangePasswordModal
        isOpen={isPasswordModalOpen || currentUser?.mustChangePassword === true}
        isForced={currentUser?.mustChangePassword === true}
        onClose={() => setIsPasswordModalOpen(false)}
        onSuccess={() => {
          setIsPasswordModalOpen(false);
          api.getMe().then((res) => {
            if (res.user) {
              setCurrentUser(res.user);
            }
          });
        }}
      />
    </div>
  );
}
