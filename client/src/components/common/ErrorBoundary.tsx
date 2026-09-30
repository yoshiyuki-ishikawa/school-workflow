import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // 内部コンソールにのみ記録（機微情報やスタックトレースは UI に露出しない）
    console.error('[ErrorBoundary Captured]', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 my-4 bg-rose-50 border border-rose-200 rounded-lg text-rose-900 shadow-sm max-w-2xl mx-auto">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-bold text-sm text-rose-950">
                {this.props.fallbackTitle || '画面の表示中にエラーが発生しました'}
              </h3>
              <p className="text-xs text-rose-700 mt-1">
                データの形式またはスキーマ定義の検証に失敗したため、安全のために表示を中断しました（Fail-Closed）。
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={this.handleReset}
                  className="px-3 py-1.5 bg-white border border-rose-300 text-rose-800 text-xs rounded font-medium hover:bg-rose-100 flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> 再試行
                </button>
                <button
                  type="button"
                  onClick={() => {
                    this.handleReset();
                    window.location.href = '/';
                  }}
                  className="px-3 py-1.5 bg-rose-700 text-white text-xs rounded font-medium hover:bg-rose-800 flex items-center gap-1.5 transition-colors"
                >
                  <Home className="w-3.5 h-3.5" /> ダッシュボードへ戻る
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
