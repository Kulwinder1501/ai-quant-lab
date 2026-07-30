import React, { ReactNode } from 'react';
import { classNames } from './class-names';

interface Column {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  render?: (row: any) => ReactNode;
}

interface DataTableProps {
  columns: Column[];
  data: any[];
  emptyMessage?: string;
  loading?: boolean;
}

export function DataTable({ columns, data, emptyMessage = "No data available", loading = false }: DataTableProps) {
  return (
    <div className="w-full overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-sm">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-slate-800/50 text-slate-400 font-semibold uppercase text-xs border-b border-slate-800">
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
                    {col.render ? col.render(row) : row[col.key]}
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
