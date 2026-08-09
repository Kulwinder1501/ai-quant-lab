"use client";

import React from 'react';
import { PageHeader } from '../../../components/layout/page-header';
import { GlassPanel } from '../../../components/ui/glass-panel';
import { Select } from '../../../components/ui/select';
import { ThemeToggle } from '../../../components/theme/theme-toggle';
import { useAppStore } from '../../../stores/app-store';

const INSTRUMENT_OPTIONS = [
  { value: 'NIFTY50', label: 'NIFTY 50' },
  { value: 'BANKNIFTY', label: 'NIFTY BANK' },
  { value: 'RELIANCE', label: 'RELIANCE' },
  { value: 'HDFCBANK', label: 'HDFC BANK' },
  { value: 'INFY', label: 'INFOSYS' },
];

const TIMEFRAME_OPTIONS = [
  { value: '1m', label: '1 Minute' },
  { value: '5m', label: '5 Minutes' },
  { value: '15m', label: '15 Minutes' },
  { value: '1h', label: '1 Hour' },
  { value: '1d', label: '1 Day' },
];

export function SettingsDashboard() {
  const {
    selectedInstrument,
    setSelectedInstrument,
    selectedTimeframe,
    setSelectedTimeframe,
    autoRefreshInterval,
    setAutoRefreshInterval,
    apiBaseUrl,
    setApiBaseUrl,
  } = useAppStore();

  return (
    <div className="flex flex-col h-full space-y-6 p-6">
      <PageHeader 
        eyebrow="Application Configuration"
        title="Settings" 
        description="Configure your AI Quant Lab preferences and system settings."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
        <GlassPanel className="p-6 flex flex-col gap-6">
          <div>
            <h3 className="text-lg font-medium text-slate-200 mb-1">Trading Preferences</h3>
            <p className="text-sm text-slate-400 mb-4">Set your default viewing options for charts and data.</p>
            
            <div className="space-y-4">
              <Select
                label="Default Instrument"
                value={selectedInstrument || 'NIFTY50'}
                onChange={setSelectedInstrument}
                options={INSTRUMENT_OPTIONS}
              />

              <Select
                label="Default Timeframe"
                value={selectedTimeframe || '1m'}
                onChange={setSelectedTimeframe}
                options={TIMEFRAME_OPTIONS}
              />
            </div>
          </div>
        </GlassPanel>

        <GlassPanel className="p-6 flex flex-col gap-6">
          <div>
            <h3 className="text-lg font-medium text-slate-200 mb-1">System Settings</h3>
            <p className="text-sm text-slate-400 mb-4">Configure application behavior and connectivity.</p>
            
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-slate-400">Auto-refresh Interval (seconds)</label>
                <input
                  type="number"
                  value={autoRefreshInterval}
                  onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
                  className="bg-slate-900 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
                  min={1}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-slate-400">API Base URL</label>
                <input
                  type="url"
                  value={apiBaseUrl}
                  onChange={(e) => setApiBaseUrl(e.target.value)}
                  className="bg-slate-900 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-500/50"
                  placeholder="http://localhost:4000/api/v1"
                />
              </div>

              <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4">
                <ThemeToggle />
              </div>
            </div>
          </div>
        </GlassPanel>
      </div>

      <div className="flex justify-end max-w-4xl">
        <p className="text-xs text-slate-500">Changes are saved automatically in this browser.</p>
      </div>
    </div>
  );
}
