import React, { ReactNode } from 'react';
import { classNames } from './class-names';

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  emptyMessage?: string;
  loading?: boolean;
}

/** Columns without a `render` are expected to hold scalars. */
function renderCell(value: unknown): ReactNode {
  return value === null || value === undefined ? null : String(value);
}

// `object` rather than `Record<string, unknown>`: callers pass interfaces, which
// have no implicit index signature and so are not assignable to that constraint.
export function DataTable<T extends object>({ columns, data, emptyMessage = "No data available", loading = false }: DataTableProps<T>) {
  return (
    <div className="w-full overflow-x-auto overflow-y-auto max-h-[600px] rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-sm scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
      <table className="w-full text-left border-collapse">
        <thead className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border-b border-slate-800 shadow-sm">
          <tr className="text-slate-400 font-semibold uppercase text-xs">
            {columns.map((col) => (
              <th 
                key={col.key} 
                className={classNames(
                  "p-4 whitespace-nowrap",
                  col.align === 'center' ? 'text-center' : col.align === 'right' ? 'text-right' : 'text-left'
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="p-8 text-center text-slate-500">
                Loading...
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="p-8 text-center text-slate-500">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr key={i} className="hover:bg-slate-800/30 transition-colors group">
                {columns.map((col) => (
                  <td 
                    key={col.key} 
                    className={classNames(
                      "p-4 text-sm text-slate-300",
                      col.align === 'center' ? 'text-center' : col.align === 'right' ? 'text-right' : 'text-left'
                    )}
                  >
                    {col.render ? col.render(row) : renderCell((row as Record<string, unknown>)[col.key])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
