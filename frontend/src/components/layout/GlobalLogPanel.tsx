"use client";

import { useState, useEffect, useCallback } from "react";
import { Terminal, Trash2, RefreshCw, CheckCircle, XCircle, Loader2, X, ChevronDown, ChevronRight } from "lucide-react";

interface OpEntry {
  id?: number;
  ts: number;
  type: string;
  status: string;
  detail: string;
  model: string;
  duration_ms: number;
  extra: Record<string, unknown>;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:17177";

async function fetchLogs(): Promise<{ entries: OpEntry[]; total: number }> {
  const res = await fetch(`${API_URL}/debug/operations?limit=100`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function clearLogs(): Promise<void> {
  const res = await fetch(`${API_URL}/debug/operations/clear`, { method: "POST" });
  if (!res.ok) throw new Error(`Clear failed: HTTP ${res.status}`);
}

interface GlobalLogSidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function GlobalLogSidebar({ open, onClose }: GlobalLogSidebarProps) {
  const [entries, setEntries] = useState<OpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeTab, setActiveTab] = useState<"all" | "llm" | "image" | "video">("all");
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchLogs();
      setEntries(data.entries);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    if (!autoRefresh) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, autoRefresh, load]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const handleClear = async () => {
    try {
      await clearLogs();
    } catch (e) {
      console.error("Failed to clear logs:", e);
    }
    setEntries([]);
    // Re-fetch to confirm cleared state
    load();
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "success": return <CheckCircle size={12} className="text-green-400 shrink-0" />;
      case "error": return <XCircle size={12} className="text-red-400 shrink-0" />;
      case "pending": return <Loader2 size={12} className="text-amber-400 animate-spin shrink-0" />;
      default: return <span className="w-3 shrink-0" />;
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  };

  const filteredEntries = activeTab === "all" ? entries : entries.filter((e) => e.type === (activeTab === "llm" ? "llm_call" : activeTab));
  const successCount = filteredEntries.filter((e) => e.status === "success").length;
  const errorCount = filteredEntries.filter((e) => e.status === "error").length;

  const formatExtra = (extra: Record<string, unknown>) => {
    try {
      return JSON.stringify(extra, null, 2);
    } catch {
      return String(extra);
    }
  };

  const hasExtra = (extra: Record<string, unknown>) => extra && Object.keys(extra).length > 0;

  if (!open) return null;

  return (
    <div className="fixed right-0 top-0 bottom-0 z-50 w-[520px] max-w-[90vw] h-full flex flex-col bg-[#0d1117] border-l border-glass-border shadow-2xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-glass-border/30 shrink-0">
        <Terminal size={16} className="text-purple-400" />
        <span className="text-sm font-semibold text-foreground">Request Log</span>
        <span className="text-[11px] text-text-muted ml-2">
          {successCount} ok / {errorCount} err
        </span>
        <div className="flex-1" />

        {/* Tab filters */}
        <div className="flex gap-0.5 bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
          {(["all", "llm", "image", "video"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
                activeTab === tab
                  ? "bg-purple-500/20 text-purple-300"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {tab === "all" ? "All" : tab === "llm" ? "LLM" : tab === "image" ? "Img" : "Vid"}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1 text-[10px] text-text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded"
          />
          Auto
        </label>
        <button
          onClick={load}
          disabled={loading}
          className="p-1.5 rounded hover:bg-white/10 text-text-muted hover:text-foreground transition-colors"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          onClick={handleClear}
          className="p-1.5 rounded hover:bg-white/10 text-text-muted hover:text-red-400 transition-colors"
        >
          <Trash2 size={14} />
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-white/10 text-text-muted hover:text-foreground transition-colors ml-1"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1 font-mono text-[11px] leading-relaxed">
        {filteredEntries.length === 0 ? (
          <div className="px-4 py-10 text-center text-text-muted">
            {loading ? "加载中..." : activeTab === "all" ? "暂无请求记录" : "暂无" + (activeTab === "llm" ? "LLM" : activeTab === "image" ? "Img" : "Vid") + "调用"}
          </div>
        ) : (
          filteredEntries.map((e, i) => (
            (() => {
              const rowKey = String(e.id ?? `${e.ts}-${i}`);
              const expanded = !!expandedKeys[rowKey];
              const expandable = hasExtra(e.extra);
              return (
            <div
              key={rowKey}
              className={`px-3 py-2 border-b border-glass-border/20 hover:bg-white/[0.02] transition-colors ${
                e.status === "error" ? "bg-red-500/[0.04]" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-text-muted shrink-0 w-14">{formatTime(e.ts)}</span>
                {statusIcon(e.status)}
                <span className={`shrink-0 font-semibold ${
                  e.status === "success" ? "text-green-400" : e.status === "error" ? "text-red-400" : "text-amber-400"
                }`}>
                  {e.status.toUpperCase()}
                </span>
                <span className="text-blue-300 shrink-0 truncate" title={e.model}>{e.model}</span>
                <span className="text-text-muted shrink-0 text-right">
                  {e.duration_ms > 0 ? `${e.duration_ms}ms` : "-"}
                </span>
                {expandable && (
                  <button
                    onClick={() => setExpandedKeys((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }))}
                    className="ml-auto flex items-center gap-1 text-[10px] text-text-muted hover:text-foreground transition-colors"
                  >
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    详情
                  </button>
                )}
              </div>
              <div className="text-text-secondary break-all mt-1 pl-[172px]">{e.detail}</div>
              {expanded && expandable && (
                <div className="mt-2 pl-[172px]">
                  <div className="text-[10px] uppercase tracking-wide text-purple-300/80 mb-1">Extra</div>
                  <pre className="whitespace-pre-wrap break-all rounded-md bg-black/25 border border-white/5 p-2 text-[10px] leading-relaxed text-slate-300 overflow-x-auto">
                    {formatExtra(e.extra)}
                  </pre>
                </div>
              )}
            </div>
              );
            })()
          ))
        )}
      </div>
    </div>
  );
}
