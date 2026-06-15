"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Save, Loader2, Key, ChevronDown, ChevronRight, Settings, MessageSquareCode, Palette, Globe, Upload, FileJson, CheckCircle, X, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { api, type EnvConfigPayload, type ProviderMode } from "@/lib/api";
import { ASPECT_RATIOS } from "@/store/projectStore";
import {
  DEFAULT_MODEL_SETTINGS,
  GLOBAL_I2V_MODELS,
  GLOBAL_IMAGE_MODELS,
  normalizeModelSettings,
} from "@/lib/modelCatalog";
import { useSettingsStore, type Locale, type Theme } from "@/store/settingsStore";
import { Image, Video, Layout, Check, User, Building, Box } from "lucide-react";

type EnvConfig = EnvConfigPayload & {
  DASHSCOPE_API_KEY: string;
  ALIBABA_CLOUD_ACCESS_KEY_ID: string;
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: string;
  OSS_BUCKET_NAME: string;
  OSS_ENDPOINT: string;
  OSS_BASE_PATH: string;
  KLING_PROVIDER_MODE: ProviderMode;
  VIDU_PROVIDER_MODE: ProviderMode;
  PIXVERSE_PROVIDER_MODE: ProviderMode;
  KLING_ACCESS_KEY: string;
  KLING_SECRET_KEY: string;
  VIDU_API_KEY: string;
  IMAGE_PROVIDER: string;
  IMAGE_API_KEY: string;
  IMAGE_BASE_URL: string;
  IMAGE_MODEL: string;
  VIDEO_PROVIDER: string;
  VIDEO_API_KEY: string;
  VIDEO_BASE_URL: string;
  VIDEO_MODEL: string;
  endpoint_overrides: Record<string, string>;
};

const ENDPOINT_PROVIDERS = [
  { key: "DASHSCOPE_BASE_URL", label: "DashScope", placeholder: "https://dashscope.aliyuncs.com" },
  { key: "KLING_BASE_URL", label: "Kling", placeholder: "https://api-beijing.klingai.com/v1" },
  { key: "VIDU_BASE_URL", label: "Vidu", placeholder: "https://api.vidu.cn/ent/v2" },
];

const DEFAULT_CONFIG: EnvConfig = {
  DASHSCOPE_API_KEY: "",
  ALIBABA_CLOUD_ACCESS_KEY_ID: "",
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: "",
  OSS_BUCKET_NAME: "",
  OSS_ENDPOINT: "",
  OSS_BASE_PATH: "",
  KLING_PROVIDER_MODE: "dashscope",
  VIDU_PROVIDER_MODE: "dashscope",
  PIXVERSE_PROVIDER_MODE: "dashscope",
  KLING_ACCESS_KEY: "",
  KLING_SECRET_KEY: "",
  VIDU_API_KEY: "",
  IMAGE_PROVIDER: "dashscope",
  IMAGE_API_KEY: "",
  IMAGE_BASE_URL: "",
  IMAGE_MODEL: "",
  VIDEO_PROVIDER: "dashscope",
  VIDEO_API_KEY: "",
  VIDEO_BASE_URL: "",
  VIDEO_MODEL: "",
  endpoint_overrides: {},
};

const normalizeProviderMode = (mode?: string): ProviderMode => (mode === "vendor" ? "vendor" : "dashscope");

const normalizeEnvConfig = (existing: EnvConfig, data?: EnvConfigPayload): EnvConfig => ({
  ...existing,
  ...data,
  KLING_PROVIDER_MODE: normalizeProviderMode(data?.KLING_PROVIDER_MODE ?? existing.KLING_PROVIDER_MODE),
  VIDU_PROVIDER_MODE: normalizeProviderMode(data?.VIDU_PROVIDER_MODE ?? existing.VIDU_PROVIDER_MODE),
  PIXVERSE_PROVIDER_MODE: normalizeProviderMode(data?.PIXVERSE_PROVIDER_MODE ?? existing.PIXVERSE_PROVIDER_MODE),
  endpoint_overrides: data?.endpoint_overrides ?? existing.endpoint_overrides ?? {},
});

const getValidationErrors = (env: EnvConfig): string[] => {
  const errors: string[] = [];

  if (!env.DASHSCOPE_API_KEY?.trim()) {
    errors.push("DashScope API Key");
  }
  if (env.KLING_PROVIDER_MODE === "vendor") {
    if (!env.KLING_ACCESS_KEY?.trim()) {
      errors.push("Kling Access Key (vendor mode)");
    }
    if (!env.KLING_SECRET_KEY?.trim()) {
      errors.push("Kling Secret Key (vendor mode)");
    }
  }
  if (env.VIDU_PROVIDER_MODE === "vendor" && !env.VIDU_API_KEY?.trim()) {
    errors.push("Vidu API Key (vendor mode)");
  }

  return errors;
};

const LS_KEY_MODEL = "lumenx_default_model_settings";
const LS_KEY_PROMPT = "lumenx_default_prompt_config";

interface DefaultModelSettings {
  t2i_model: string;
  i2i_model: string;
  i2v_model: string;
  character_aspect_ratio: string;
  scene_aspect_ratio: string;
  prop_aspect_ratio: string;
  storyboard_aspect_ratio: string;
}

interface DefaultPromptConfig {
  storyboard_polish: string;
  video_polish: string;
  r2v_polish: string;
}

type SettingsSection = "appearance" | "api" | "comfyui" | "legacy" | "models" | "prompts";

function loadFromLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { locale, theme, setLocale, setTheme } = useSettingsStore();

  // ── API Config ──
  const [config, setConfig] = useState<EnvConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endpointsOpen, setEndpointsOpen] = useState(false);
  const [workflowModes, setWorkflowModes] = useState<Record<string, boolean>>({});
  const [uploadMode, setUploadMode] = useState("t2i");
  const [dragOver, setDragOver] = useState(false);
  const [workflowUploading, setWorkflowUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("api");

  // ── OpenAI model sync ──
  const [openaiImageModels, setOpenaiImageModels] = useState<{id: string; name: string}[]>([]);
  const [openaiVideoModels, setOpenaiVideoModels] = useState<{id: string; name: string}[]>([]);
  const [syncingImageModels, setSyncingImageModels] = useState(false);
  const [syncingVideoModels, setSyncingVideoModels] = useState(false);
  const [imageModelFilter, setImageModelFilter] = useState("");
  const [videoModelFilter, setVideoModelFilter] = useState("");
  const [openaiLLMModels, setOpenaiLLMModels] = useState<{id: string; name: string}[]>([]);
  const [syncingLLMModels, setSyncingLLMModels] = useState(false);
  const [llmModelFilter, setLLmModelFilter] = useState("");

  const syncOpenaiModels = async (type: "image" | "video" | "llm") => {
    if (type === "image") setSyncingImageModels(true);
    else if (type === "video") setSyncingVideoModels(true);
    else setSyncingLLMModels(true);
    try {
      const res = await api.syncOpenAIModels(type);
      const models = (res.models || []).map((m: {id: string; owned_by: string}) => ({
        id: m.id,
        name: m.id,
      }));
      if (type === "image") setOpenaiImageModels(models);
      else if (type === "video") setOpenaiVideoModels(models);
      else setOpenaiLLMModels(models);
    } catch (e: any) {
      alert(`Failed to sync models: ${e?.message || e}`);
    } finally {
      if (type === "image") setSyncingImageModels(false);
      else if (type === "video") setSyncingVideoModels(false);
      else setSyncingLLMModels(false);
    }
  };

  // ── Default Model Settings ──
  const [modelSettings, setModelSettings] = useState<DefaultModelSettings>(() =>
    normalizeModelSettings(
      loadFromLS(LS_KEY_MODEL, DEFAULT_MODEL_SETTINGS),
      "global_settings"
    )
  );

  // ── Default Prompt Config ──
  const [promptConfig, setPromptConfig] = useState<DefaultPromptConfig>(() =>
    loadFromLS(LS_KEY_PROMPT, { storyboard_polish: "", video_polish: "", r2v_polish: "" })
  );

  useEffect(() => {
    loadConfig();
    fetchWorkflowStatus();
  }, []);

  const fetchWorkflowStatus = useCallback(async () => {
    try {
      const res = await api.getComfyUIWorkflows();
      // API returns { mode: { exists: true, node_count: N } }
      const modes: Record<string, boolean> = {};
      for (const [key, val] of Object.entries(res)) {
        if (val && typeof val === "object" && "exists" in val) {
          modes[key] = !!(val as any).exists;
        }
      }
      setWorkflowModes(modes);
    } catch {
      // endpoint not available or error - ignore
    }
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.getEnvConfig();
      setConfig((prev) => normalizeEnvConfig(prev, data));
    } catch {
      setLoadError("Failed to load configuration. Is the backend running?");
    } finally {
      setLoading(false);
    }
  };


  const handleWorkflowUpload = async (file: File) => {
    if (!file.name.endsWith(".json")) {
      alert("Please upload a .json workflow file.");
      return;
    }
    setWorkflowUploading(true);
    try {
      const text = await file.text();
      const workflow = JSON.parse(text);
      await api.uploadComfyUIWorkflow(uploadMode, workflow);
      await fetchWorkflowStatus();
    } catch (e: any) {
      alert("Upload failed: " + (e?.message ?? String(e)));
    } finally {
      setWorkflowUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleWorkflowUpload(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleWorkflowUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSaveApiConfig = async () => {
    const errors = getValidationErrors(config);
    if (errors.length > 0) {
      alert(`Please fill in required fields:\n- ${errors.join("\n- ")}`);
      return;
    }

    setSaving(true);
    try {
      await api.saveEnvConfig(config);
      alert("Configuration saved successfully!");
    } catch {
      alert("Failed to save configuration.");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: keyof EnvConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleEndpointChange = (envKey: string, value: string) => {
    setConfig((prev) => ({
      ...prev,
      endpoint_overrides: { ...prev.endpoint_overrides, [envKey]: value },
    }));
  };

  const handleSaveModelDefaults = () => {
    localStorage.setItem(
      LS_KEY_MODEL,
      JSON.stringify(normalizeModelSettings(modelSettings, "global_settings"))
    );
    alert("Default model settings saved!");
  };

  const handleSavePromptDefaults = () => {
    localStorage.setItem(LS_KEY_PROMPT, JSON.stringify(promptConfig));
    alert("Default prompt configuration saved!");
  };

  const inputClass =
    "w-full bg-input-bg border border-glass-border rounded-lg px-4 py-2 text-foreground placeholder-text-muted focus:outline-none focus:border-primary/50 transition-colors";
  const modeButtonClass = (active: boolean) =>
    `px-3 py-1.5 text-xs rounded-md border transition-colors font-medium ${active ? "bg-amber-500 text-white border-amber-500 shadow-sm" : "border-glass-border bg-surface text-text-secondary hover:text-foreground"}`;
  const sectionMeta: Record<SettingsSection, { title: string; description: string }> = {
    appearance: { title: "Appearance", description: "Language and theme preferences" },
    api: { title: "API Configuration", description: "Primary LLM, image, and video provider settings" },
    comfyui: { title: "ComfyUI", description: "Remote workflow server and workflow templates" },
    legacy: { title: "Legacy Providers", description: "DashScope, OSS mirror, and vendor-direct fallbacks" },
    models: { title: "Default Models", description: "Provider-aware defaults for LLM, image, and video models" },
    prompts: { title: "Default Prompts", description: "Reusable prompt defaults for generation workflows" },
  };
  const activeSectionMeta = sectionMeta[activeSection];

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* ── Left Sidebar ── */}
      <nav className="w-52 shrink-0 border-r border-glass-border bg-surface/30 overflow-y-auto p-3 space-y-1 flex flex-col">
        <div className="px-2 pb-3 mb-2 border-b border-glass-border">
          <h1 className="text-sm font-display font-bold text-foreground">{t("title")}</h1>
        </div>
        {([
          { id: "appearance", label: "Appearance", icon: Palette },
          { id: "api", label: "API Configuration", icon: Key },
          { id: "comfyui", label: "ComfyUI", icon: Upload },
          { id: "legacy", label: "Legacy Providers", icon: ChevronDown },
          { id: "models", label: "Default Models", icon: Settings },
          { id: "prompts", label: "Default Prompts", icon: MessageSquareCode },
        ] as const).map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveSection(item.id)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all text-left ${
              activeSection === item.id
                ? "bg-primary/15 text-primary font-medium"
                : "text-text-secondary hover:text-foreground hover:bg-glass"
            }`}
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </button>
        ))}

      </nav>

      {/* ── Right Content ── */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-5xl mx-auto">
          <div className="sticky top-0 z-20 -mx-8 -mt-6 mb-6 px-8 py-5 bg-background/90 backdrop-blur-md border-b border-glass-border">
            <div className="max-w-5xl mx-auto flex items-center justify-between gap-6">
              <div>
                <h1 className="text-xl font-display font-bold text-foreground">{activeSectionMeta.title}</h1>
                <p className="mt-1 text-xs text-text-secondary">{activeSectionMeta.description}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  handleSaveApiConfig();
                  handleSaveModelDefaults();
                  localStorage.setItem("lumenx_default_prompt_config", JSON.stringify(promptConfig));
                }}
                disabled={saving}
                className="shrink-0 flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-all disabled:opacity-50 shadow-lg shadow-primary/20"
              >
                {saving ? (
                  <><Loader2 size={15} className="animate-spin" /> Saving...</>
                ) : (
                  <><Save size={15} /> Save All Settings</>
                )}
              </button>
            </div>
          </div>

          <div className="space-y-8 pb-10">
          {activeSection === "appearance" && (
            <>
      {/* ── Section 0: Appearance ── */}
      <section className="glass-panel rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 rounded-lg">
            <Palette size={20} className="text-violet-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">{t("appearance")}</h2>
          </div>
        </div>

        {/* Language */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Globe size={14} className="text-text-secondary" />
            <label className="text-sm font-medium text-foreground">{t("language")}</label>
          </div>
          <p className="text-xs text-text-secondary">{t("languageDesc")}</p>
          <div className="flex gap-2 mt-2">
            {([["zh", t("chinese")], ["en", t("english")]] as [Locale, string][]).map(([loc, label]) => (
              <button
                key={loc}
                onClick={() => setLocale(loc)}
                className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                  locale === loc
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-glass-border bg-hover-bg text-text-secondary hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Theme */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Palette size={14} className="text-text-secondary" />
            <label className="text-sm font-medium text-foreground">{t("theme")}</label>
          </div>
          <p className="text-xs text-text-secondary">{t("themeDesc")}</p>
          <div className="flex gap-2 mt-2">
            {([["dark", t("themeDark")], ["light", t("themeLight")]] as [Theme, string][]).map(([th, label]) => (
              <button
                key={th}
                onClick={() => setTheme(th)}
                className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                  theme === th
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-glass-border bg-hover-bg text-text-secondary hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
            </>
          )}
          {activeSection === "api" && (
            <>
      {/* ── Section 1: API Configuration ── */}
      <section className="glass-panel rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-amber-500/20 to-orange-500/20 rounded-lg">
            <Key size={20} className="text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">{t("apiConfig")}</h2>
            <p className="text-xs text-text-secondary">DashScope-first setup with optional OSS mirror and provider-direct routing</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-amber-400" />
            <span className="ml-2 text-text-secondary">Loading configuration...</span>
          </div>
        ) : loadError ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm text-red-300">
            {loadError}
          </div>
        ) : (
          <>
            <div className="pt-4 border-t border-glass-border">
              <h3 className="text-sm font-bold text-foreground mb-4">LLM Provider</h3>
              <div className="bg-surface border border-glass-border rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleChange("LLM_PROVIDER", "dashscope")} className={modeButtonClass(config.LLM_PROVIDER === "dashscope")}>
                    DashScope
                  </button>
                  <button type="button" onClick={() => handleChange("LLM_PROVIDER", "openai")} className={modeButtonClass(config.LLM_PROVIDER === "openai")}>
                    OpenAI Compatible
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  DashScope: Default, uses Alibaba DashScope API (requires DashScope API Key).
                  {" "}OpenAI Compatible: Connect to any OpenAI‑standard API (OpenAI, DeepSeek, Ollama, etc.).
                </p>
                {config.LLM_PROVIDER === "openai" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary mb-2">API Key <span className="text-red-500">*</span></label>
                      <input type="password" value={config.LLM_API_KEY} onChange={(e) => handleChange("LLM_API_KEY", e.target.value)} placeholder="sk-..." className={inputClass} />
                    </div>
                    <div>
                      <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                        <span>Base URL</span>
                        <span className="text-text-muted font-normal text-xs">override endpoint</span>
                      </label>
                      <input type="text" value={config.endpoint_overrides?.LLM_BASE_URL ?? ""} onChange={(e) => handleEndpointChange("LLM_BASE_URL", e.target.value)} placeholder="https://api.openai.com/v1" className={inputClass} />
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-glass-border">
              <h3 className="text-sm font-bold text-foreground mb-4">Image Generation Provider</h3>
              <div className="bg-surface border border-glass-border rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleChange("IMAGE_PROVIDER", "dashscope")} className={modeButtonClass(config.IMAGE_PROVIDER === "dashscope")}>
                    DashScope
                  </button>
                  <button type="button" onClick={() => handleChange("IMAGE_PROVIDER", "openai")} className={modeButtonClass(config.IMAGE_PROVIDER === "openai")}>
                    OpenAI Compatible
                  </button>
                  <button type="button" onClick={() => handleChange("IMAGE_PROVIDER", "comfyui")} className={modeButtonClass(config.IMAGE_PROVIDER === "comfyui")}>
                    ComfyUI
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  DashScope (Wan 2.7) · OpenAI Compatible (DALL·E etc.) · ComfyUI (remote workflow server).
                </p>
                {config.IMAGE_PROVIDER === "openai" && (
                <>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">API Key</label>
                  <input type="password" value={config.IMAGE_API_KEY} onChange={(e) => handleChange("IMAGE_API_KEY", e.target.value)} placeholder="sk-..." className={inputClass} />
                </div>
                <div>
                  <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                    <span>Base URL</span>
                    <span className="text-text-muted font-normal text-xs">https://api.openai.com/v1</span>
                  </label>
                  <input type="text" value={config.IMAGE_BASE_URL} onChange={(e) => handleChange("IMAGE_BASE_URL", e.target.value)} placeholder="https://api.openai.com/v1" className={inputClass} />
                </div>

                </>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-glass-border">
              <h3 className="text-sm font-bold text-foreground mb-4">Video Generation Provider</h3>
              <div className="bg-surface border border-glass-border rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleChange("VIDEO_PROVIDER", "dashscope")} className={modeButtonClass(config.VIDEO_PROVIDER === "dashscope")}>
                    DashScope
                  </button>
                  <button type="button" onClick={() => handleChange("VIDEO_PROVIDER", "openai")} className={modeButtonClass(config.VIDEO_PROVIDER === "openai")}>
                    OpenAI Compatible
                  </button>
                  <button type="button" onClick={() => handleChange("VIDEO_PROVIDER", "comfyui")} className={modeButtonClass(config.VIDEO_PROVIDER === "comfyui")}>
                    ComfyUI
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  DashScope (Wan I2V) · OpenAI Compatible · ComfyUI (remote workflow server).
                </p>
                {config.VIDEO_PROVIDER === "openai" && (
                <>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">API Key</label>
                  <input type="password" value={config.VIDEO_API_KEY} onChange={(e) => handleChange("VIDEO_API_KEY", e.target.value)} placeholder="sk-..." className={inputClass} />
                </div>
                <div>
                  <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                    <span>Base URL</span>
                    <span className="text-text-muted font-normal text-xs">https://api.openai.com/v1</span>
                  </label>
                  <input type="text" value={config.VIDEO_BASE_URL} onChange={(e) => handleChange("VIDEO_BASE_URL", e.target.value)} placeholder="https://api.openai.com/v1" className={inputClass} />
                </div>

                </>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-glass-border">
              <button type="button" onClick={() => setEndpointsOpen(!endpointsOpen)} className="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-foreground transition-colors">
                {endpointsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                Advanced: API Endpoints
              </button>
              {endpointsOpen && (
                <div className="mt-4 space-y-4">
                  <p className="text-xs text-text-muted">Custom API endpoint URLs. Leave empty to use defaults. Overrides are preserved regardless of provider mode.</p>
                  {ENDPOINT_PROVIDERS.map(({ key, label, placeholder }) => (
                    <div key={key}>
                      <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                        <span>{label} Base URL</span>
                        <span className="text-text-muted font-normal text-xs">{placeholder}</span>
                      </label>
                      <input type="text" value={config.endpoint_overrides[key] || ""} onChange={(e) => handleEndpointChange(key, e.target.value)} placeholder={placeholder} className={inputClass + " text-sm"} />
                    </div>
                  ))}
                </div>
              )}
            </div>

          </>
        )}
      </section>
            </>
          )}
          {activeSection === "comfyui" && (
            <>
      {/* ── Section 2: ComfyUI Provider ── */}
      <section className="glass-panel rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-purple-500/20 to-pink-500/20 rounded-lg">
            <Upload size={20} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">ComfyUI Provider</h2>
            <p className="text-xs text-text-secondary">Connect to a remote ComfyUI server for custom workflow-based image and video generation.</p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
              <span>ComfyUI Base URL</span>
              <span className="text-text-muted font-normal text-xs">http://localhost:8188</span>
            </label>
            <input type="text" value={config.COMFYUI_BASE_URL ?? ""} onChange={(e) => handleChange("COMFYUI_BASE_URL", e.target.value)} placeholder="http://localhost:8188" className={inputClass} />
          </div>
          <div>
            <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
              <span>API Key (Optional)</span>
              <span className="text-text-muted font-normal text-xs">If server requires auth</span>
            </label>
            <input type="password" value={config.COMFYUI_API_KEY ?? ""} onChange={(e) => handleChange("COMFYUI_API_KEY", e.target.value)} placeholder="Optional API key" className={inputClass} />
          </div>
        </div>

        {/* Workflow Upload */}
        <div className="pt-4 border-t border-glass-border">
          <h3 className="text-sm font-bold text-foreground mb-3">Workflow Templates</h3>
          <p className="text-xs text-text-muted mb-3">
            Drag &amp; drop or select a ComfyUI workflow JSON exported from your ComfyUI server (API format). Each mode (T2I / I2I / T2V / I2V) can have its own workflow.
          </p>

          {/* Mode Tabs */}
          <div className="flex gap-1 mb-3">
            {(["t2i","i2i","t2v","i2v"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setUploadMode(mode)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors font-medium ${
                  uploadMode === mode
                    ? "bg-primary/20 border-primary/50 text-primary"
                    : "border-glass-border bg-surface text-text-secondary hover:text-foreground"
                }`}
              >
                {mode.toUpperCase()}
                {workflowModes[mode] && <CheckCircle size={12} className="text-green-400" />}
              </button>
            ))}
          </div>

          {/* Drop Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
              dragOver
                ? "border-primary/50 bg-primary/5"
                : "border-glass-border hover:border-text-muted bg-surface/50"
            }`}
          >
            {workflowUploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 size={24} className="text-primary animate-spin" />
                <span className="text-xs text-text-secondary">Uploading workflow...</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload size={24} className="text-text-muted" />
                <div>
                  <p className="text-sm text-text-secondary font-medium">
                    {workflowModes[uploadMode]
                      ? `Replace ${uploadMode.toUpperCase()} workflow`
                      : `Upload ${uploadMode.toUpperCase()} workflow`}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    Drop a .json file here or click to browse
                  </p>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* Status */}
          <div className="mt-3 flex flex-wrap gap-2">
            {(["t2i","i2i","t2v","i2v"] as const).map((mode) => (
              <span
                key={mode}
                className={`text-[10px] px-2 py-0.5 rounded-full border ${
                  workflowModes[mode]
                    ? "border-green-500/30 bg-green-500/10 text-green-400"
                    : "border-glass-border bg-surface text-text-muted"
                }`}
              >
                {workflowModes[mode] ? (
                  <CheckCircle size={10} className="inline mr-1" />
                ) : (
                  <X size={10} className="inline mr-1" />
                )}
                {mode.toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      </section>
            </>
          )}
          {activeSection === "legacy" && (
            <>
      {/* ── Section 3: Cloud & Vendor Providers ── */}
      <section className="glass-panel rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-slate-500/20 to-slate-600/20 rounded-lg">
            <Key size={20} className="text-slate-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">Cloud & Vendor Providers</h2>
            <p className="text-xs text-text-secondary">DashScope, OSS storage, and legacy vendor-direct routing</p>
          </div>
        </div>
        <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-foreground mb-4">DashScope API Key</h3>
              <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                <span>API Key <span className="text-red-500">*</span></span>
                <span className="text-text-muted font-normal text-xs">e.g. sk-xxx</span>
              </label>
              <input type="password" value={config.DASHSCOPE_API_KEY} onChange={(e) => handleChange("DASHSCOPE_API_KEY", e.target.value)} placeholder="Required for DashScope-first model routing" className={inputClass} />
            </div>

            <div className="pt-4 border-t border-glass-border">
              <h3 className="text-sm font-bold text-foreground mb-4">OSS Mirror (Optional)</h3>
              <p className="text-xs text-text-muted mb-3">Storage is local-first by default. Configure OSS for optional cloud mirror.</p>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-2">Alibaba Cloud Access Key ID</label>
                <input type="password" value={config.ALIBABA_CLOUD_ACCESS_KEY_ID} onChange={(e) => handleChange("ALIBABA_CLOUD_ACCESS_KEY_ID", e.target.value)} placeholder="Optional, for OSS mirror" className={inputClass} />
              </div>
              <div className="mt-3">
                <label className="block text-sm font-medium text-text-secondary mb-2">Alibaba Cloud Access Key Secret</label>
                <input type="password" value={config.ALIBABA_CLOUD_ACCESS_KEY_SECRET} onChange={(e) => handleChange("ALIBABA_CLOUD_ACCESS_KEY_SECRET", e.target.value)} placeholder="Optional, for OSS mirror" className={inputClass} />
              </div>
              <div className="mt-3">
                <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                  <span>OSS Bucket Name</span>
                </label>
                <input type="text" value={config.OSS_BUCKET_NAME} onChange={(e) => handleChange("OSS_BUCKET_NAME", e.target.value)} placeholder="your_bucket_name (optional)" className={inputClass} />
              </div>
              <div className="mt-3">
                <label className="flex items-center justify-between text-sm font-medium text-text-secondary mb-2">
                  <span>OSS Endpoint</span>
                </label>
                <input type="text" value={config.OSS_ENDPOINT} onChange={(e) => handleChange("OSS_ENDPOINT", e.target.value)} placeholder="oss-cn-beijing.aliyuncs.com (optional)" className={inputClass} />
              </div>
              <div className="mt-3">
                <label className="block text-sm font-medium text-text-secondary mb-2">OSS Base Path</label>
                <input type="text" value={config.OSS_BASE_PATH} onChange={(e) => handleChange("OSS_BASE_PATH", e.target.value)} placeholder="lumenx" className={inputClass} />
              </div>
            </div>

            <div className="pt-4 border-t border-glass-border">
              <h3 className="text-sm font-bold text-foreground mb-4">Kling Provider</h3>
              <div className="bg-surface border border-glass-border rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleChange("KLING_PROVIDER_MODE", "dashscope")} className={modeButtonClass(config.KLING_PROVIDER_MODE === "dashscope")}>
                    DashScope
                  </button>
                  <button type="button" onClick={() => handleChange("KLING_PROVIDER_MODE", "vendor")} className={modeButtonClass(config.KLING_PROVIDER_MODE === "vendor")}>
                    Vendor Direct
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  DashScope mode uses your DashScope API key. Vendor-direct mode requires Kling Access Key and Secret Key.
                </p>
                {config.KLING_PROVIDER_MODE === "vendor" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary mb-2">Kling Access Key <span className="text-red-500">*</span></label>
                      <input type="password" value={config.KLING_ACCESS_KEY} onChange={(e) => handleChange("KLING_ACCESS_KEY", e.target.value)} placeholder="Kling API Access Key" className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary mb-2">Kling Secret Key <span className="text-red-500">*</span></label>
                      <input type="password" value={config.KLING_SECRET_KEY} onChange={(e) => handleChange("KLING_SECRET_KEY", e.target.value)} placeholder="Kling API Secret Key" className={inputClass} />
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-glass-border">
              <h3 className="text-sm font-bold text-foreground mb-4">Vidu Provider</h3>
              <div className="bg-input-bg border border-glass-border rounded-lg p-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleChange("VIDU_PROVIDER_MODE", "dashscope")} className={modeButtonClass(config.VIDU_PROVIDER_MODE === "dashscope")}>
                    DashScope
                  </button>
                  <button type="button" onClick={() => handleChange("VIDU_PROVIDER_MODE", "vendor")} className={modeButtonClass(config.VIDU_PROVIDER_MODE === "vendor")}>
                    Vendor Direct
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  DashScope mode uses your DashScope API key. Vendor-direct mode requires a Vidu API key.
                </p>
                {config.VIDU_PROVIDER_MODE === "vendor" && (
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">Vidu API Key <span className="text-red-500">*</span></label>
                    <input type="password" value={config.VIDU_API_KEY} onChange={(e) => handleChange("VIDU_API_KEY", e.target.value)} placeholder="Vidu API Key" className={inputClass} />
                  </div>
                )}
              </div>
            </div>
        </div>
      </section>
            </>
          )}
          {activeSection === "models" && (
            <>
      {/* ── Section 4: Default Model Settings ── */}
      <section className="glass-panel rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-lg">
            <Settings size={20} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">{t("defaultModels")}</h2>
            <p className="text-xs text-text-secondary">
              Default models for LLM, image, and video. Models shown depend on the active provider selected above.
            </p>
          </div>
        </div>

        <div className="space-y-5">
          {/* ── LLM Models ── */}
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-foreground mb-3">
              <MessageSquareCode size={16} className="text-amber-400" />
              <span>Language Model</span>
              <span className="text-[10px] text-text-muted font-normal ml-1">(LLM)</span>
            </div>
            {config.LLM_PROVIDER === "dashscope" ? (
              <div className="bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
                <p className="text-sm text-text-secondary">DashScope LLM model is auto-selected by the backend.</p>
                <p className="text-xs text-text-muted mt-1">Switch to OpenAI Compatible to select a specific model.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => syncOpenaiModels("llm")}
                    disabled={syncingLLMModels}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {syncingLLMModels ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {syncingLLMModels ? "Syncing..." : "Sync from API"}
                  </button>
                  <span className="text-[10px] text-text-muted">{openaiLLMModels.length > 0 ? `${openaiLLMModels.length} loaded` : "Defaults"}</span>
                  {openaiLLMModels.length > 10 && (
                    <div className="relative flex-1 max-w-[200px] ml-auto">
                      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                      <input
                        type="text"
                        value={llmModelFilter}
                        onChange={(e) => setLLmModelFilter(e.target.value)}
                        placeholder="Filter models..."
                        className="w-full pl-7 pr-2 py-1 text-[11px] bg-input-bg border border-glass-border rounded-md text-text-secondary placeholder-text-muted focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  )}
                </div>
                <div className="max-h-[280px] overflow-y-auto pr-1 grid grid-cols-2 gap-2">
                  {(openaiLLMModels.length > 0
                    ? openaiLLMModels.filter(m => !llmModelFilter || m.id.toLowerCase().includes(llmModelFilter.toLowerCase()) || m.name.toLowerCase().includes(llmModelFilter.toLowerCase()))
                    : [
                        { id: "gpt-4o", name: "GPT-4o" },
                        { id: "gpt-4o-mini", name: "GPT-4o Mini" },
                        { id: "deepseek-chat", name: "DeepSeek Chat" },
                        { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
                      ]
                  ).map((model) => (
                    <button
                      key={model.id}
                      onClick={() => {
                        // Update both modelSettings and env config
                        setConfig((prev) => ({ ...prev, LLM_MODEL: model.id }));
                      }}
                      className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${
                        config.LLM_MODEL === model.id
                          ? "border-amber-500/50 bg-amber-500/10"
                          : "border-glass-border hover:border-glass-border bg-glass"
                      }`}
                    >
                      {config.LLM_MODEL === model.id && (
                        <div className="absolute top-2 right-2"><Check size={14} className="text-amber-400" /></div>
                      )}
                      <span className="text-sm font-medium text-foreground">{model.name}</span>
                      <span className="text-xs text-text-muted">{model.id}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ── Image Models ── */}
          <div className="border-t border-glass-border pt-4">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Image size={16} className="text-green-400" />
              <span>Image Generation Model</span>
              <span className="text-[10px] text-text-muted font-normal ml-1">(T2I / I2I)</span>
            </div>

          {config.IMAGE_PROVIDER === "comfyui" ? (
            <div className="bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
              <p className="text-sm text-text-secondary">Image model is determined by the ComfyUI workflow.</p>
              <p className="text-xs text-text-muted mt-1">Switch to DashScope or OpenAI Compatible to select a specific model.</p>
            </div>
          ) : (
            <>
              {config.IMAGE_PROVIDER === "openai" && (
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => syncOpenaiModels("image")}
                    disabled={syncingImageModels}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    {syncingImageModels ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {syncingImageModels ? "Syncing..." : "Sync from API"}
                  </button>
                  <span className="text-[10px] text-text-muted">{openaiImageModels.length > 0 ? `${openaiImageModels.length} loaded` : "Defaults"}</span>
                  {openaiImageModels.length > 10 && (
                    <div className="relative flex-1 max-w-[200px] ml-auto">
                      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                      <input
                        type="text"
                        value={imageModelFilter}
                        onChange={(e) => setImageModelFilter(e.target.value)}
                        placeholder="Filter models..."
                        className="w-full pl-7 pr-2 py-1 text-[11px] bg-input-bg border border-glass-border rounded-md text-text-secondary placeholder-text-muted focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  )}
                </div>
              )}
              <div className="max-h-[280px] overflow-y-auto pr-1 grid grid-cols-2 gap-2">
                {(config.IMAGE_PROVIDER === "openai"
                  ? (openaiImageModels.length > 0 ? openaiImageModels.filter(m => !imageModelFilter || m.id.toLowerCase().includes(imageModelFilter.toLowerCase()) || m.name.toLowerCase().includes(imageModelFilter.toLowerCase())) : [
                      { id: "dall-e-3", name: "DALL·E 3" },
                      { id: "gpt-image-1", name: "GPT Image 1" },
                      { id: "gpt-image-2-pro", name: "GPT Image 2 Pro" },
                    ])
                  : GLOBAL_IMAGE_MODELS
                ).map((model) => (
                  <button
                    key={model.id}
                    onClick={() => {
                      setModelSettings((s) => ({ ...s, t2i_model: model.id, i2i_model: model.id }));
                      setConfig((prev) => ({ ...prev, IMAGE_MODEL: model.id }));
                    }}
                    className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${
                      modelSettings.t2i_model === model.id
                        ? "border-green-500/50 bg-green-500/10"
                        : "border-glass-border hover:border-glass-border bg-glass"
                    }`}
                  >
                    {modelSettings.t2i_model === model.id && (
                      <div className="absolute top-2 right-2"><Check size={14} className="text-green-400" /></div>
                    )}
                    <span className="text-sm font-medium text-foreground">{model.name}</span>
                    <span className="text-xs text-text-muted">{model.id}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          </div>

          <div className="grid grid-cols-3 gap-4">
            {(
              [
                { key: "character_aspect_ratio" as const, label: "Character", icon: User },
                { key: "scene_aspect_ratio" as const, label: "Scene", icon: Building },
                { key: "prop_aspect_ratio" as const, label: "Prop", icon: Box },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <div key={key} className="space-y-2">
                <div className="flex items-center gap-1 text-xs text-text-secondary"><Icon size={12} /><label>{label}</label></div>
                <div className="space-y-1">
                  {ASPECT_RATIOS.map((ratio) => (
                    <button key={ratio.id} onClick={() => setModelSettings((s) => ({ ...s, [key]: ratio.id }))} className={`w-full flex flex-col items-center py-2 px-2 rounded border transition-all ${modelSettings[key] === ratio.id ? "border-green-500/50 bg-green-500/10" : "border-glass-border hover:border-glass-border bg-glass"}`}>
                      <span className="text-xs font-medium text-foreground">{ratio.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* ── Video Models ── */}
          <div className="border-t border-glass-border pt-4">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Video size={16} className="text-purple-400" />
              <span>Video Generation Model</span>
              <span className="text-[10px] text-text-muted font-normal ml-1">(I2V / T2V / R2V)</span>
            </div>

            {config.VIDEO_PROVIDER === "comfyui" ? (
              <div className="mt-3 bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
                <p className="text-sm text-text-secondary">Video model is determined by the ComfyUI workflow.</p>
                <p className="text-xs text-text-muted mt-1">Switch to DashScope or OpenAI Compatible to select a specific model.</p>
              </div>
            ) : (
              <>
                {config.VIDEO_PROVIDER === "openai" && (
                  <div className="flex items-center gap-2 mt-3 mb-2">
                    <button
                      type="button"
                      onClick={() => syncOpenaiModels("video")}
                      disabled={syncingVideoModels}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      {syncingVideoModels ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      {syncingVideoModels ? "Syncing..." : "Sync from API"}
                    </button>
                    <span className="text-[10px] text-text-muted">{openaiVideoModels.length > 0 ? `${openaiVideoModels.length} loaded` : "Defaults"}</span>
                    {openaiVideoModels.length > 10 && (
                      <div className="relative flex-1 max-w-[200px] ml-auto">
                        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                        <input
                          type="text"
                          value={videoModelFilter}
                          onChange={(e) => setVideoModelFilter(e.target.value)}
                          placeholder="Filter models..."
                          className="w-full pl-7 pr-2 py-1 text-[11px] bg-input-bg border border-glass-border rounded-md text-text-secondary placeholder-text-muted focus:outline-none focus:border-primary/50"
                        />
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-3 max-h-[280px] overflow-y-auto pr-1 grid grid-cols-2 gap-2">
                  {(config.VIDEO_PROVIDER === "openai"
                    ? (openaiVideoModels.length > 0 ? openaiVideoModels.filter(m => !videoModelFilter || m.id.toLowerCase().includes(videoModelFilter.toLowerCase()) || m.name.toLowerCase().includes(videoModelFilter.toLowerCase())) : [
                        { id: "sora-2", name: "Sora 2" },
                        { id: "veo-3.1", name: "Veo 3.1" },
                      ])
                    : GLOBAL_I2V_MODELS
                  ).map((model) => (
                    <button
                      key={model.id}
                      onClick={() => {
                        setModelSettings((s) => ({ ...s, i2v_model: model.id }));
                        setConfig((prev) => ({ ...prev, VIDEO_MODEL: model.id }));
                      }}
                      className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${
                        modelSettings.i2v_model === model.id
                          ? "border-purple-500/50 bg-purple-500/10"
                          : "border-glass-border hover:border-glass-border bg-glass"
                      }`}
                    >
                      {modelSettings.i2v_model === model.id && (
                        <div className="absolute top-2 right-2"><Check size={14} className="text-purple-400" /></div>
                      )}
                      <span className="text-sm font-medium text-foreground">{model.name}</span>
                      <span className="text-xs text-text-muted">{model.id}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

      </section>
            </>
          )}
          {activeSection === "prompts" && (
            <>
      {/* ── Section 5: Default Prompt Config ── */}
      <section className="glass-panel rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <MessageSquareCode size={20} className="text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">{t("defaultPrompts")}</h2>
            <p className="text-xs text-text-secondary">Default system prompts for new projects (leave empty for built-in defaults)</p>
          </div>
        </div>

        {(
          [
            { key: "storyboard_polish" as const, label: "Storyboard Polish", desc: "System prompt for storyboard/image prompt polishing" },
            { key: "video_polish" as const, label: "Video I2V Polish", desc: "System prompt for Image-to-Video prompt polishing" },
            { key: "r2v_polish" as const, label: "Video R2V Polish", desc: "System prompt for Reference-to-Video prompt polishing" },
          ] as const
        ).map((section) => (
          <div key={section.key} className="space-y-2">
            <h3 className="text-sm font-bold text-foreground">{section.label}</h3>
            <p className="text-[10px] text-text-muted">{section.desc}</p>
            <textarea
              value={promptConfig[section.key]}
              onChange={(e) => setPromptConfig((prev) => ({ ...prev, [section.key]: e.target.value }))}
              placeholder="Leave empty to use system default..."
              className="w-full h-32 bg-input-bg border border-glass-border rounded-lg p-3 text-xs text-text-secondary resize-y focus:outline-none focus:border-purple-500/50 font-mono placeholder-text-muted"
            />
          </div>
        ))}

      </section>
            </>
          )}
          </div>
        </div>
      </main>
    </div>
  );
}
