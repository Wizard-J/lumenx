import { create } from 'zustand';

interface LogStore {
  showLogs: boolean;
  toggleLogs: () => void;
  setShowLogs: (v: boolean) => void;
}

export const useLogStore = create<LogStore>((set) => ({
  showLogs: false,
  toggleLogs: () => set((s) => ({ showLogs: !s.showLogs })),
  setShowLogs: (v) => set({ showLogs: v }),
}));
