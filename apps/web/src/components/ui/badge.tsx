import React, { ReactNode } from 'react';
import { classNames } from './class-names';

interface BadgeProps {
  variant?: 'bullish' | 'bearish' | 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'default';
  size?: 'sm' | 'md';
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = 'default', size = 'sm', children, className }: BadgeProps) {
  const variants = {
    bullish: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    bearish: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    neutral: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    danger: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    info: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    default: 'bg-slate-800 text-slate-300 border-slate-700'
  };

  const sizes = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-2.5 py-1'
  };

  return (
    <span className={classNames(
      "inline-flex items-center justify-center rounded-full border font-medium whitespace-nowrap",
      variants[variant],
      sizes[size],
      className
    )}>
      {children}
    </span>
  );
}
