import React, { ReactNode } from 'react';
import { classNames } from './class-names';
import { X } from 'lucide-react';
import { Button } from './button';

interface FilterBarProps {
  children: ReactNode;
  onReset?: () => void;
  className?: string;
}

export function FilterBar({ children, onReset, className }: FilterBarProps) {
  return (
    <div className={classNames(
      "flex items-center gap-4 p-3 bg-slate-900/40 border border-slate-800 rounded-xl backdrop-blur-sm",
      className
    )}>
      <div className="flex items-center gap-4 flex-1 overflow-x-auto no-scrollbar">
        {children}
      </div>
      {onReset && (
        <div className="pl-4 border-l border-slate-800 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={onReset} leftIcon={<X size={16} />}>
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}
