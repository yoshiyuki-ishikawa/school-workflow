import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { PendingTaskItem } from '../types';

export interface PendingTaskState {
  pendingCount: number;
  tasks: PendingTaskItem[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function usePendingTasks(refreshTrigger?: number): PendingTaskState {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [tasks, setTasks] = useState<PendingTaskItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchPendingData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [countRes, tasksRes] = await Promise.all([
        api.getPendingCount(),
        api.getPendingTasks(5),
      ]);
      setPendingCount(countRes.data.pending_count);
      setTasks(tasksRes.data.tasks);
      setError(null);
    } catch (err: any) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPendingData();

    // Focus & Visibility Change Refetch (HD-W6-10: Event-driven refetch, no interval polling)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchPendingData();
      }
    };
    const handleFocus = () => {
      fetchPendingData();
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [fetchPendingData, refreshTrigger]);

  return { pendingCount, tasks, isLoading, error, refetch: fetchPendingData };
}
