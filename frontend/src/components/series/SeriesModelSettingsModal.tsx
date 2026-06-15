"use client";

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, X, Image, Video, Layout, Check, User, Building, Box, Loader2, RefreshCw, Search } from 'lucide-react';
import { ASPECT_RATIOS } from '@/store/projectStore';
import {
    SERIES_IMAGE_MODELS,
    SERIES_I2V_MODELS,
    resolveModelSettings,
} from '@/lib/modelCatalog';
import { api } from '@/lib/api';
import { useTranslations } from "next-intl";

interface SeriesModelSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    seriesId: string;
    onSaved?: () => void;
}

export default function SeriesModelSettingsModal({ isOpen, onClose, seriesId, onSaved }: SeriesModelSettingsModalProps) {
    const t = useTranslations("models");
    const tc = useTranslations("common");
    const defaultSettings = resolveModelSettings(undefined, 'series_settings');
    const [t2iModel, setT2iModel] = useState(defaultSettings.t2i_model);
    const [i2iModel, setI2iModel] = useState(defaultSettings.i2i_model);
    const [i2vModel, setI2vModel] = useState(defaultSettings.i2v_model);
    const [characterAspectRatio, setCharacterAspectRatio] = useState(defaultSettings.character_aspect_ratio);
    const [sceneAspectRatio, setSceneAspectRatio] = useState(defaultSettings.scene_aspect_ratio);
    const [propAspectRatio, setPropAspectRatio] = useState(defaultSettings.prop_aspect_ratio);
    const [storyboardAspectRatio, setStoryboardAspectRatio] = useState(defaultSettings.storyboard_aspect_ratio);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    // ── Provider-aware model selection ──
    const [imageProvider, setImageProvider] = useState<string>("dashscope");
    const [videoProvider, setVideoProvider] = useState<string>("dashscope");
    const [openaiImageModels, setOpenaiImageModels] = useState<{id: string; name: string}[]>([]);
    const [openaiVideoModels, setOpenaiVideoModels] = useState<{id: string; name: string}[]>([]);
    const [syncingImage, setSyncingImage] = useState(false);
    const [syncingVideo, setSyncingVideo] = useState(false);
    const [imageFilter, setImageFilter] = useState("");
    const [videoFilter, setVideoFilter] = useState("");

    useEffect(() => {
        if (isOpen && seriesId) {
            setIsLoading(true);
            setLoadError(null);
            // Load provider config + series settings in parallel
            Promise.all([
                api.getEnvConfig().catch(() => ({})),
                api.getSeriesModelSettings(seriesId),
            ]).then(([cfg, data]) => {
                setImageProvider(String(cfg.IMAGE_PROVIDER || "dashscope"));
                setVideoProvider(String(cfg.VIDEO_PROVIDER || "dashscope"));
                // Auto-sync if openai
                if (String(cfg.IMAGE_PROVIDER || "") === "openai") syncModels("image");
                if (String(cfg.VIDEO_PROVIDER || "") === "openai") syncModels("video");
                
                // Merge global settings from localStorage as base, series overrides on top.
                // The backend Pydantic ModelSettings always fills hardcoded defaults for new series,
                // so we strip values that match DEFAULT_MODEL_SETTINGS to avoid overriding global prefs.
                const stored = typeof window !== 'undefined' ? localStorage.getItem("lumenx_default_model_settings") : null;
                let globalSettings: any = {};
                if (stored) { try { globalSettings = JSON.parse(stored); } catch {} }
                // Strip series settings that match hardcoded defaults (never explicitly saved)
                const cleaned: any = {};
                if (data) {
                    for (const key of Object.keys(data)) {
                        if (data[key] !== (DEFAULT_MODEL_SETTINGS as any)[key]) {
                            cleaned[key] = data[key];
                        }
                    }
                }
                const mergedData = { ...globalSettings, ...cleaned };
                const resolvedSettings = resolveModelSettings(mergedData, 'series_settings');
                setT2iModel(resolvedSettings.t2i_model);
                setI2iModel(resolvedSettings.i2i_model);
                setI2vModel(resolvedSettings.i2v_model);
                setCharacterAspectRatio(resolvedSettings.character_aspect_ratio);
                setSceneAspectRatio(resolvedSettings.scene_aspect_ratio);
                setPropAspectRatio(resolvedSettings.prop_aspect_ratio);
                setStoryboardAspectRatio(resolvedSettings.storyboard_aspect_ratio);
            }).catch((err) => {
                console.error("Failed to load series model settings:", err);
                setLoadError(t("loadSettingsFailed"));
            }).finally(() => setIsLoading(false));
        }
    }, [isOpen, seriesId]);

    const syncModels = async (type: "image" | "video") => {
        if (type === "image") setSyncingImage(true);
        else setSyncingVideo(true);
        try {
            const res = await api.syncOpenAIModels(type);
            const models = (res.models || []).map((m: {id: string; owned_by: string}) => ({
                id: m.id,
                name: m.id,
            }));
            if (type === "image") setOpenaiImageModels(models);
            else setOpenaiVideoModels(models);
        } catch (e: any) {
            alert(`Failed to sync models: ${e?.message || e}`);
        } finally {
            if (type === "image") setSyncingImage(false);
            else setSyncingVideo(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await api.updateSeriesModelSettings(seriesId, {
                t2i_model: t2iModel,
                i2i_model: i2iModel,
                i2v_model: i2vModel,
                character_aspect_ratio: characterAspectRatio,
                scene_aspect_ratio: sceneAspectRatio,
                prop_aspect_ratio: propAspectRatio,
                storyboard_aspect_ratio: storyboardAspectRatio,
            });
            onSaved?.();
            onClose();
        } catch (error) {
            console.error("Failed to save series model settings:", error);
            alert(t("saveSettingsFailed"));
        } finally {
            setIsSaving(false);
        }
    };

    if (!isOpen) return null;

    // ── Resolve model lists per provider ──
    const resolveImageModels = () => {
        if (imageProvider === "openai") {
            return openaiImageModels.length > 0 ? openaiImageModels : [
                { id: "dall-e-3", name: "DALL·E 3" },
                { id: "dall-e-2", name: "DALL·E 2" },
            ];
        }
        return SERIES_IMAGE_MODELS.map(m => ({ id: m.id, name: m.name, description: (m as any).description || "" }));
    };
    const resolveI2VModels = () => {
        if (videoProvider === "openai") {
            return openaiVideoModels.length > 0 ? openaiVideoModels : [
                { id: "sora-2", name: "Sora 2" },
                { id: "veo-3.1", name: "Veo 3.1" },
            ];
        }
        return SERIES_I2V_MODELS.map(m => ({ id: m.id, name: m.name, description: (m as any).description || "" }));
    };

    const showImageSync = imageProvider === "openai";
    const showVideoSync = videoProvider === "openai";
    const showImageComfyUI = imageProvider === "comfyui";
    const showVideoComfyUI = videoProvider === "comfyui";

    const filteredImageModels = (() => {
        let models = resolveImageModels().filter(m =>
            !imageFilter || m.id.toLowerCase().includes(imageFilter.toLowerCase()) || m.name.toLowerCase().includes(imageFilter.toLowerCase())
        );
        if (t2iModel && !models.some(m => m.id === t2iModel)) {
            models.unshift({ id: t2iModel, name: t2iModel, description: "" });
        }
        return models;
    })();
    const filteredI2VModels = (() => {
        let models = resolveI2VModels().filter(m =>
            !videoFilter || m.id.toLowerCase().includes(videoFilter.toLowerCase()) || m.name.toLowerCase().includes(videoFilter.toLowerCase())
        );
        if (i2vModel && !models.some(m => m.id === i2vModel)) {
            models.unshift({ id: i2vModel, name: i2vModel, description: "" });
        }
        return models;
    })();

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm flex items-center justify-center p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-elevated rounded-2xl border border-glass-border w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-5 border-b border-glass-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-lg">
                                <Settings size={20} className="text-blue-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-foreground">{t("seriesGenSettings")}</h2>
                                <p className="text-xs text-text-muted">{t("seriesLevelDesc") || "Series-level model defaults"}</p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 rounded-lg hover:bg-hover-bg transition-colors text-text-secondary hover:text-foreground"
                        >
                            <X size={20} />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 size={24} className="animate-spin text-blue-400" />
                            </div>
                        ) : loadError ? (
                            <div className="text-center py-12 text-red-400">{loadError}</div>
                        ) : (
                            <>
                                {/* T2I / I2I Section */}
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                        <Image size={16} className="text-blue-400" />
                                        <span>T2I / I2I · 文生图 / 图生图</span>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs text-text-secondary">{t("model")}</label>
                                        {showImageComfyUI ? (
                                            <div className="bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
                                                <p className="text-sm text-text-secondary">Model determined by ComfyUI workflow.</p>
                                            </div>
                                        ) : (
                                            <>
                                                {showImageSync && (
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <button type="button" onClick={() => syncModels("image")} disabled={syncingImage}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50">
                                                            {syncingImage ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                                            {syncingImage ? "Syncing..." : "Sync from API"}
                                                        </button>
                                                        <span className="text-[10px] text-text-muted">{openaiImageModels.length > 0 ? `${openaiImageModels.length} loaded` : "Defaults"}</span>
                                                        {resolveImageModels().length > 10 && (
                                                            <div className="relative flex-1 max-w-[200px] ml-auto">
                                                                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                                                                <input type="text" value={imageFilter} onChange={(e) => setImageFilter(e.target.value)}
                                                                    placeholder="Filter models..." className="w-full pl-7 pr-2 py-1 text-[11px] bg-input-bg border border-glass-border rounded-md text-text-secondary placeholder-text-muted focus:outline-none focus:border-primary/50" />
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="max-h-[280px] overflow-y-auto pr-1 grid grid-cols-2 gap-2">
                                                    {filteredImageModels.map((model) => (
                                                        <button key={model.id} onClick={() => { setT2iModel(model.id); setI2iModel(model.id); }}
                                                            className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${t2iModel === model.id ? 'border-blue-500/50 bg-blue-500/10' : 'border-glass-border hover:border-glass-border bg-glass'}`}>
                                                            {t2iModel === model.id && (<div className="absolute top-2 right-2"><Check size={14} className="text-blue-400" /></div>)}
                                                            <span className="text-sm font-medium text-foreground">{model.name}</span>
                                                            <span className="text-xs text-text-muted">{(model as any).description || model.id}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <div className="border-t border-glass-border" />

                                {/* I2V Section */}
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                        <Video size={16} className="text-purple-400" />
                                        <span>I2V · 图生视频</span>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs text-text-secondary">{t("model")}</label>
                                        {showVideoComfyUI ? (
                                            <div className="bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
                                                <p className="text-sm text-text-secondary">Model determined by ComfyUI workflow.</p>
                                            </div>
                                        ) : (
                                            <>
                                                {showVideoSync && (
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <button type="button" onClick={() => syncModels("video")} disabled={syncingVideo}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50">
                                                            {syncingVideo ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                                            {syncingVideo ? "Syncing..." : "Sync from API"}
                                                        </button>
                                                        <span className="text-[10px] text-text-muted">{openaiVideoModels.length > 0 ? `${openaiVideoModels.length} loaded` : "Defaults"}</span>
                                                        {resolveI2VModels().length > 10 && (
                                                            <div className="relative flex-1 max-w-[200px] ml-auto">
                                                                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                                                                <input type="text" value={videoFilter} onChange={(e) => setVideoFilter(e.target.value)}
                                                                    placeholder="Filter models..." className="w-full pl-7 pr-2 py-1 text-[11px] bg-input-bg border border-glass-border rounded-md text-text-secondary placeholder-text-muted focus:outline-none focus:border-primary/50" />
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="max-h-[280px] overflow-y-auto pr-1 grid grid-cols-2 gap-2">
                                                    {filteredI2VModels.map((model) => (
                                                        <button key={model.id} onClick={() => setI2vModel(model.id)}
                                                            className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${i2vModel === model.id ? 'border-purple-500/50 bg-purple-500/10' : 'border-glass-border hover:border-glass-border bg-glass'}`}>
                                                            {i2vModel === model.id && (<div className="absolute top-2 right-2"><Check size={14} className="text-purple-400" /></div>)}
                                                            <span className="text-sm font-medium text-foreground">{model.name}</span>
                                                            <span className="text-xs text-text-muted">{(model as any).description || model.id}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <div className="border-t border-glass-border" />

                                {/* Aspect Ratios */}
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                        <Layout size={16} className="text-emerald-400" />
                                        <span>Aspect Ratios</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { label: "Character", icon: User, value: characterAspectRatio, setter: setCharacterAspectRatio, color: "text-cyan-400" },
                                            { label: "Scene", icon: Building, value: sceneAspectRatio, setter: setSceneAspectRatio, color: "text-emerald-400" },
                                            { label: "Prop", icon: Box, value: propAspectRatio, setter: setPropAspectRatio, color: "text-amber-400" },
                                            { label: "Storyboard", icon: Layout, value: storyboardAspectRatio, setter: setStoryboardAspectRatio, color: "text-purple-400" },
                                        ] as const).map((item) => (
                                            <div key={item.label} className="space-y-2">
                                                <div className="flex items-center gap-1.5">
                                                    <item.icon size={14} className={item.color} />
                                                    <span className="text-xs font-medium text-text-secondary">{item.label}</span>
                                                </div>
                                                <div className="flex flex-wrap gap-1">
                                                    {ASPECT_RATIOS.map((ratio) => (
                                                        <button key={ratio.id} onClick={() => item.setter(ratio.id)}
                                                            className={`px-2.5 py-1 text-xs rounded-md border transition-all ${item.value === ratio.id ? 'border-emerald-500/50 bg-emerald-500/10 text-foreground' : 'border-glass-border hover:border-glass-border text-text-secondary'}`}>
                                                            {ratio.name}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex justify-end gap-3 p-5 border-t border-glass-border bg-surface">
                        <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-foreground transition-colors">
                            {tc("cancel")}
                        </button>
                        <button onClick={handleSave} disabled={isSaving || isLoading || !!loadError}
                            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50">
                            {isSaving ? (<><Loader2 size={16} className="animate-spin" />{t("saving")}</>) : (<><Check size={16} />{t("saveSettings")}</>)}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
