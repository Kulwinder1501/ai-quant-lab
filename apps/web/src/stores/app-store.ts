import { create } from 'zustand';

interface AppState {
  selectedInstrument: string | null;
  selectedTimeframe: string | null;
  activeAccountId: string | null;
  apiConnected: boolean;
  sidebarCollapsed: boolean;
  theme: 'light' | 'dark' | 'system';
  autoRefreshInterval: number;
  apiBaseUrl: string;
  setSelectedInstrument: (instrument: string | null) => void;
  setSelectedTimeframe: (timeframe: string | null) => void;
  setActiveAccountId: (id: string | null) => void;
  setApiConnected: (connected: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setAutoRefreshInterval: (interval: number) => void;
  setApiBaseUrl: (url: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedInstrument: 'NIFTY50',
  selectedTimeframe: '1m',
  activeAccountId: null,
  apiConnected: false,
  sidebarCollapsed: false,
  theme: 'system',
  autoRefreshInterval: 5,
  apiBaseUrl: 'http://localhost:8000',
  setSelectedInstrument: (instrument) => set({ selectedInstrument: instrument }),
  setSelectedTimeframe: (timeframe) => set({ selectedTimeframe: timeframe }),
  setActiveAccountId: (id) => set({ activeAccountId: id }),
  setApiConnected: (connected) => set({ apiConnected: connected }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTheme: (theme) => set({ theme }),
  setAutoRefreshInterval: (interval) => set({ autoRefreshInterval: interval }),
  setApiBaseUrl: (url) => set({ apiBaseUrl: url }),
}));
