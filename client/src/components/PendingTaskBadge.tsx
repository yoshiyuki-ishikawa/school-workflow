import React from 'react';

interface Props {
  count: number;
}

export const PendingTaskBadge: React.FC<Props> = ({ count }) => {
  if (count <= 0) return null;
  return (
    <span
      data-testid="pending-task-badge"
      className="inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold leading-none text-white bg-amber-500 rounded-full shadow-xs animate-pulse"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
};
