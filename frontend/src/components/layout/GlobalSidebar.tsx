"use client";

import { FolderOpen, Library, Settings, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import clsx from "clsx";
import LumenXBranding from "./LumenXBranding";

export type GlobalTab = "workspace" | "library" | "settings";

interface GlobalSidebarProps {
  activeTab: GlobalTab;
  onTabChange: (tab: GlobalTab) => void;
  onToggleLogs?: () => void;
  logsOpen?: boolean;
}

const NAV_ITEMS: { id: GlobalTab; icon: typeof FolderOpen; hash: string }[] = [
  { id: "workspace", icon: FolderOpen, hash: "#/" },
  { id: "library", icon: Library, hash: "#/library" },
  { id: "settings", icon: Settings, hash: "#/settings" },
];

export default function GlobalSidebar({ activeTab, onTabChange, onToggleLogs, logsOpen }: GlobalSidebarProps) {
  const t = useTranslations("nav");

  const handleNav = (item: (typeof NAV_ITEMS)[number]) => {
    onTabChange(item.id);
    window.location.hash = item.hash;
  };

  return (
    <aside className="w-56 flex-shrink-0 h-full border-r border-glass-border bg-surface backdrop-blur-xl flex flex-col">
      {/* Branding */}
      <div className="p-5 border-b border-glass-border">
        <LumenXBranding size="sm" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              className={clsx(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 relative overflow-hidden",
                isActive
                  ? "bg-primary/10 text-foreground"
                  : "text-text-secondary hover:text-foreground hover:bg-hover-bg"
              )}
            >
              {isActive && (
                <div className="absolute left-0 w-1 h-full bg-primary rounded-r" />
              )}
              <Icon size={18} className={isActive ? "text-primary" : ""} />
              <span className="text-sm font-medium">{t(item.id)}</span>
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-glass-border space-y-1">
        {onToggleLogs && (
          <button
            onClick={onToggleLogs}
            className={clsx(
              "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200",
              logsOpen
                ? "bg-purple-500/10 text-purple-400"
                : "text-text-secondary hover:text-purple-400 hover:bg-hover-bg"
            )}
          >
            <Terminal size={18} />
            <span className="text-sm font-medium">Request Log</span>
            {logsOpen && <span className="ml-auto w-2 h-2 rounded-full bg-purple-400 animate-pulse" />}
          </button>
        )}
        <span className="text-xs text-text-muted px-4 block">v0.1.0</span>
      </div>
    </aside>
  );
}
