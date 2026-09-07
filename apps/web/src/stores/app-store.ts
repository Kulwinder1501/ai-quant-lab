import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type AppTheme = 'light' | 'dark';

interface AppState {
  selectedInstrument: string | null;
  selectedTimeframe: string | null;
  activeAccountId: string | null;
  apiConnected: boolean;
  sidebarCollapsed: boolean;
  theme: AppTheme;
  autoRefreshInterval: number;
  apiBaseUrl: string;
  setSelectedInstrument: (instrument: string | null) => void;
  setSelectedTimeframe: (timeframe: string | null) => void;
  setActiveAccountId: (id: string | null) => void;
  setApiConnected: (connected: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTheme: (theme: AppTheme) => void;
  setAutoRefreshInterval: (interval: number) => void;
  setApiBaseUrl: (url: string) => void;
}

const defaultApiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.trim() || 'http://localhost:4000/api/v1';

export const useAppStore = create<AppState>()(persist((set) => ({
  selectedInstrument: 'NIFTY50',
  selectedTimeframe: '1m',
  activeAccountId: null,
  apiConnected: false,
  sidebarCollapsed: false,
  theme: 'dark',
  autoRefreshInterval: 5,
  apiBaseUrl: defaultApiBaseUrl,
  setSelectedInstrument: (instrument) => set({ selectedInstrument: instrument }),
  setSelectedTimeframe: (timeframe) => set({ selectedTimeframe: timeframe }),
  setActiveAccountId: (id) => set({ activeAccountId: id }),
  setApiConnected: (connected) => set({ apiConnected: connected }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTheme: (theme) => set({ theme }),
  setAutoRefreshInterval: (interval) => set({ autoRefreshInterval: interval }),
  setApiBaseUrl: (url) => set({ apiBaseUrl: url }),
}), {
  name: 'ai-quant-lab-preferences',
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    selectedInstrument: state.selectedInstrument,
    selectedTimeframe: state.selectedTimeframe,
    activeAccountId: state.activeAccountId,
    sidebarCollapsed: state.sidebarCollapsed,
    theme: state.theme,
    autoRefreshInterval: state.autoRefreshInterval,
    apiBaseUrl: state.apiBaseUrl,
  }),
}));
