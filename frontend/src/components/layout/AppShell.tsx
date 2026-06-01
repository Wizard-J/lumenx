"use client";

import GlobalSidebar, { type GlobalTab } from "./GlobalSidebar";

interface AppShellProps {
  activeTab: GlobalTab;
  onTabChange: (tab: GlobalTab) => void;
  onToggleLogs?: () => void;
  logsOpen?: boolean;
  children: React.ReactNode;
}

export default function AppShell({ activeTab, onTabChange, onToggleLogs, logsOpen, children }: AppShellProps) {
  return (
    <div className="flex h-full w-full">
      <GlobalSidebar activeTab={activeTab} onTabChange={onTabChange} onToggleLogs={onToggleLogs} logsOpen={logsOpen} />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
