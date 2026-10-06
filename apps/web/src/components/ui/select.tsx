import React, { SelectHTMLAttributes } from 'react';
import { classNames } from './class-names';

interface Option {
  value: string;
  label: string;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  className?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, value, onChange, label, className, ...props }, ref) => {
    return (
      <div className={classNames("flex flex-col gap-1.5", className)}>
        {label && <label className="text-sm text-slate-400">{label}</label>}
        <select
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-slate-900 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50 appearance-none"
          {...props}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
);
Select.displayName = 'Select';
