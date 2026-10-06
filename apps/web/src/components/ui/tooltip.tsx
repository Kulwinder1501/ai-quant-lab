"use client";

import React, { ReactNode, useState } from 'react';
import { classNames } from './class-names';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export function Tooltip({ content, children, position = 'top', className }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);

  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2.5',
  };

  const arrows = {
    top: 'top-full left-1/2 -translate-x-1/2 border-t-slate-900 border-x-transparent border-b-transparent border-[5px]',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-slate-900 border-x-transparent border-t-transparent border-[5px]',
    left: 'left-full top-1/2 -translate-y-1/2 border-l-slate-900 border-y-transparent border-r-transparent border-[5px]',
    right: 'right-full top-1/2 -translate-y-1/2 border-r-slate-900 border-y-transparent border-l-transparent border-[5px]',
  };

  return (
    <div 
      className={classNames("relative inline-flex items-center group", className)}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={() => setIsVisible(true)}
      onBlur={() => setIsVisible(false)}
    >
      {children}
      {isVisible && content && (
        <div 
          role="tooltip"
          className={classNames(
            "absolute z-50 pointer-events-none min-w-[140px] max-w-xs",
            "rounded-xl border border-cyan-500/20 bg-slate-950/95 px-3 py-2 text-xs font-medium text-slate-200",
            "shadow-2xl shadow-black/80 backdrop-blur-md",
            "animate-in fade-in zoom-in-95 duration-150 leading-relaxed text-left",
            positions[position]
          )}
        >
          {content}
          <div className={classNames("absolute w-0 h-0 pointer-events-none", arrows[position])} />
        </div>
      )}
    </div>
  );
}
