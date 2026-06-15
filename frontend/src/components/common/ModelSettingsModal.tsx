"use client";

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, X, Image, Video, Film, Check, Layout, User, Building, Box, RefreshCw, Search } from 'lucide-react';
import { useProjectStore, ASPECT_RATIOS } from '@/store/projectStore';
import { resolveModelSettings, VIDEO_R2V_MODELS, DEFAULT_R2V_MODEL_ID, PROJECT_IMAGE_MODELS, PROJECT_I2V_MODELS } from '@/lib/modelCatalog';
import { api } from '@/lib/api';
import { useTranslations } from "next-intl";

interface ModelSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function ModelSettingsModal({ isOpen, onClose }: ModelSettingsModalProps) {
    const currentProject = useProjectStore((state) => state.currentProject);
    const t = useTranslations("models");
    const tc = useTranslations("common");
    const updateProject = useProjectStore((state) => state.updateProject);
    const resolvedSettings = resolveModelSettings(currentProject?.model_settings, 'project_settings');

    const [t2iModel, setT2iModel] = useState(resolvedSettings.t2i_model);
    const [i2iModel, setI2iModel] = useState(resolvedSettings.i2i_model);
    const [i2vModel, setI2vModel] = useState(resolvedSettings.i2v_model);
    const [r2vModel, setR2vModel] = useState(resolvedSettings.r2v_model || DEFAULT_R2V_MODEL_ID);
    const [characterAspectRatio, setCharacterAspectRatio] = useState(resolvedSettings.character_aspect_ratio);
    const [sceneAspectRatio, setSceneAspectRatio] = useState(resolvedSettings.scene_aspect_ratio);
    const [propAspectRatio, setPropAspectRatio] = useState(resolvedSettings.prop_aspect_ratio);
    const [storyboardAspectRatio, setStoryboardAspectRatio] = useState(resolvedSettings.storyboard_aspect_ratio);
    const [isSaving, setIsSaving] = useState(false);

    // ── Provider-aware model selection ──
    const [imageProvider, setImageProvider] = useState<string>("dashscope");
    const [videoProvider, setVideoProvider] = useState<string>("dashscope");
    const [openaiImageModels, setOpenaiImageModels] = useState<{id: string; name: string}[]>([]);
    const [openaiVideoModels, setOpenaiVideoModels] = useState<{id: string; name: string}[]>([]);
    const [syncingImageModels, setSyncingImageModels] = useState(false);
    const [syncingVideoModels, setSyncingVideoModels] = useState(false);
    const [imageModelFilter, setImageModelFilter] = useState("");
    const [videoModelFilter, setVideoModelFilter] = useState("");

    // Load global provider config when modal opens
    useEffect(() => {
        if (!isOpen) return;
        api.getEnvConfig().then((cfg) => {
            setImageProvider(String(cfg.IMAGE_PROVIDER || "dashscope"));
            setVideoProvider(String(cfg.VIDEO_PROVIDER || "dashscope"));
        }).catch(() => {});
    }, [isOpen]);

    const syncModels = async (type: "image" | "video") => {
        if (type === "image") setSyncingImageModels(true);
        else setSyncingVideoModels(true);
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
            if (type === "image") setSyncingImageModels(false);
            else setSyncingVideoModels(false);
        }
    };

    // Sync state when project changes
    useEffect(() => {
        const normalizedSettings = resolveModelSettings(currentProject?.model_settings, 'project_settings');
        setT2iModel(normalizedSettings.t2i_model);
        setI2iModel(normalizedSettings.i2i_model);
        setI2vModel(normalizedSettings.i2v_model);
        setR2vModel(normalizedSettings.r2v_model || DEFAULT_R2V_MODEL_ID);
        setCharacterAspectRatio(normalizedSettings.character_aspect_ratio);
        setSceneAspectRatio(normalizedSettings.scene_aspect_ratio);
        setPropAspectRatio(normalizedSettings.prop_aspect_ratio);
        setStoryboardAspectRatio(normalizedSettings.storyboard_aspect_ratio);
    }, [currentProject?.model_settings]);

    const handleSave = async () => {
        if (!currentProject) return;
        setIsSaving(true);
        try {
            const updated = await api.updateModelSettings(
                currentProject.id,
                t2iModel,
                i2iModel,
                i2vModel,
                characterAspectRatio,
                sceneAspectRatio,
                propAspectRatio,
                storyboardAspectRatio,
                undefined,
                r2vModel,
            );
            updateProject(currentProject.id, updated);
            onClose();
        } catch (error) {
            console.error("Failed to save model settings:", error);
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
        return PROJECT_IMAGE_MODELS.map(m => ({ id: m.id, name: m.name }));
    };

    const resolveI2VModels = () => {
        if (videoProvider === "openai") {
            return openaiVideoModels.length > 0 ? openaiVideoModels : [
                { id: "sora-2", name: "Sora 2" },
                { id: "veo-3.1", name: "Veo 3.1" },
            ];
        }
        return PROJECT_I2V_MODELS.map(m => ({ id: m.id, name: m.name }));
    };

    const showImageSync = imageProvider === "openai";
    const showVideoSync = videoProvider === "openai";
    const showImageComfyUI = imageProvider === "comfyui";
    const showVideoComfyUI = videoProvider === "comfyui";

    const filteredImageModels = resolveImageModels().filter(m =>
        !imageModelFilter || m.id.toLowerCase().includes(imageModelFilter.toLowerCase()) || m.name.toLowerCase().includes(imageModelFilter.toLowerCase())
    );
    const filteredI2VModels = resolveI2VModels().filter(m =>
        !videoModelFilter || m.id.toLowerCase().includes(videoModelFilter.toLowerCase()) || m.name.toLowerCase().includes(videoModelFilter.toLowerCase())
    );

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
                                <h2 className="text-lg font-bold text-foreground">{t("genSettings")}</h2>
                                <p className="text-xs text-text-muted">
                                    {currentProject
                                        ? `Project: ${currentProject.name}`
                                        : t("noProjectSelected")}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 rounded-lg hover:bg-hover-bg transition-colors text-text-secondary hover:text-foreground"
                        >
                            <X size={20} />
                        </button>
                    </div>

                    {/* Content — scrollable */}
                    <div className="flex-1 overflow-y-auto p-5 space-y-6">
                        {/* T2I Section */}
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                <Image size={16} className="text-blue-400" />
                                <span>T2I · 文生图</span>
                            </div>
                            <p className="text-xs text-text-muted">
                                {t("t2iModelDesc")}
                            </p>
                            <div className="space-y-2">
                                <label className="text-xs text-text-secondary">{t("model")}</label>
                                {showImageComfyUI ? (
                                    <div className="bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
                                        <p className="text-sm text-text-secondary">Model determined by ComfyUI workflow.</p>
                                        <p className="text-xs text-text-muted mt-1">Upload workflow templates in Settings → ComfyUI.</p>
                                    </div>
                                ) : (
                                    <>
                                        {showImageSync && (
                                            <div className="flex items-center gap-2 mb-2">
                                                <button
                                                    type="button"
                                                    onClick={() => syncModels("image")}
                                                    disabled={syncingImageModels}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50"
                                                >
                                                    {syncingImageModels ? (
                                                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
                                                    ) : (
                                                        <RefreshCw size={12} />
                                                    )}
                                                    {syncingImageModels ? "Syncing..." : "Sync from API"}
                                                </button>
                                                <span className="text-[10px] text-text-muted">{openaiImageModels.length > 0 ? `${openaiImageModels.length} loaded` : "Defaults"}</span>
                                                {resolveImageModels().length > 10 && (
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
                                        <div className="grid grid-cols-2 gap-2">
                                            {filteredImageModels.map((model) => (
                                                <button
                                                    key={model.id}
                                                    onClick={() => {
                                                        setT2iModel(model.id);
                                                        setI2iModel(model.id);
                                                    }}
                                                    className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${
                                                        t2iModel === model.id
                                                            ? 'border-blue-500/50 bg-blue-500/10'
                                                            : 'border-glass-border hover:border-glass-border bg-glass'
                                                    }`}
                                                >
                                                    {t2iModel === model.id && (
                                                        <div className="absolute top-2 right-2">
                                                            <Check size={14} className="text-blue-400" />
                                                        </div>
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

                        <div className="border-t border-glass-border" />

                        {/* I2V Section */}
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                <Video size={16} className="text-purple-400" />
                                <span>I2V · 图生视频</span>
                            </div>
                            <p className="text-xs text-text-muted">
                                {t("i2vModelDesc")}
                            </p>
                            <div className="space-y-2">
                                <label className="text-xs text-text-secondary">{t("model")}</label>
                                {showVideoComfyUI ? (
                                    <div className="bg-surface/50 border border-glass-border rounded-lg p-4 text-center">
                                        <p className="text-sm text-text-secondary">Model determined by ComfyUI workflow.</p>
                                        <p className="text-xs text-text-muted mt-1">Upload workflow templates in Settings → ComfyUI.</p>
                                    </div>
                                ) : (
                                    <>
                                        {showVideoSync && (
                                            <div className="flex items-center gap-2 mb-2">
                                                <button
                                                    type="button"
                                                    onClick={() => syncModels("video")}
                                                    disabled={syncingVideoModels}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50"
                                                >
                                                    {syncingVideoModels ? (
                                                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
                                                    ) : (
                                                        <RefreshCw size={12} />
                                                    )}
                                                    {syncingVideoModels ? "Syncing..." : "Sync from API"}
                                                </button>
                                                <span className="text-[10px] text-text-muted">{openaiVideoModels.length > 0 ? `${openaiVideoModels.length} loaded` : "Defaults"}</span>
                                                {resolveI2VModels().length > 10 && (
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
                                        <div className="grid grid-cols-2 gap-2">
                                            {filteredI2VModels.map((model) => (
                                                <button
                                                    key={model.id}
                                                    onClick={() => setI2vModel(model.id)}
                                                    className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${
                                                        i2vModel === model.id
                                                            ? 'border-purple-500/50 bg-purple-500/10'
                                                            : 'border-glass-border hover:border-glass-border bg-glass'
                                                    }`}
                                                >
                                                    {i2vModel === model.id && (
                                                        <div className="absolute top-2 right-2">
                                                            <Check size={14} className="text-purple-400" />
                                                        </div>
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

                        <div className="border-t border-glass-border" />

                        {/* Aspect Ratio Section */}
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                <Layout size={16} className="text-emerald-400" />
                                <span>Aspect Ratios</span>
                            </div>
                            <p className="text-xs text-text-muted">
                                Default aspect ratios for different asset types. Can be overridden per asset in the storyboard.
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { label: "Character", icon: User, value: characterAspectRatio, setter: setCharacterAspectRatio, color: "text-cyan-400" },
                                    { label: "Scene", icon: Building, value: sceneAspectRatio, setter: setSceneAspectRatio, color: "text-emerald-400" },
                                    { label: "Prop", icon: Box, value: propAspectRatio, setter: setPropAspectRatio, color: "text-amber-400" },
                                    { label: "Storyboard", icon: Film, value: storyboardAspectRatio, setter: setStoryboardAspectRatio, color: "text-purple-400" },
                                ] as const).map((item) => (
                                    <div key={item.label} className="space-y-2">
                                        <div className="flex items-center gap-1.5">
                                            <item.icon size={14} className={item.color} />
                                            <span className="text-xs font-medium text-text-secondary">{item.label}</span>
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {ASPECT_RATIOS.map((ratio) => (
                                                <button
                                                    key={ratio.value}
                                                    onClick={() => item.setter(ratio.value)}
                                                    className={`px-2.5 py-1 text-xs rounded-md border transition-all ${
                                                        item.value === ratio.value
                                                            ? 'border-emerald-500/50 bg-emerald-500/10 text-foreground'
                                                            : 'border-glass-border hover:border-glass-border text-text-secondary'
                                                    }`}
                                                >
                                                    {ratio.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="border-t border-glass-border" />

                        {/* R2V Section */}
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                                <Film size={16} className="text-pink-400" />
                                <span>R2V · 参考生视频</span>
                            </div>
                            <p className="text-xs text-text-muted">
                                项目级 R2V 模型默认值。Storyboard 的 R2V tab 进入时按此初始化；用户在 storyboard 内的临时切换会保存在本地、不影响这里。
                            </p>

                            <div className="space-y-2">
                                <label className="text-xs text-text-secondary">{t("model")}</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {VIDEO_R2V_MODELS.map((model) => (
                                        <button
                                            key={model.id}
                                            onClick={() => setR2vModel(model.id)}
                                            className={`relative flex flex-col items-start p-3 rounded-lg border transition-all text-left ${
                                                r2vModel === model.id
                                                    ? 'border-pink-500/50 bg-pink-500/10'
                                                    : 'border-glass-border hover:border-glass-border bg-glass'
                                            }`}
                                        >
                                            {r2vModel === model.id && (
                                                <div className="absolute top-2 right-2">
                                                    <Check size={14} className="text-pink-400" />
                                                </div>
                                            )}
                                            <span className="text-sm font-medium text-foreground">{model.name}</span>
                                            <span className="text-xs text-text-muted">{model.description}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="flex justify-end gap-3 p-5 border-t border-glass-border bg-surface">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm text-text-secondary hover:text-foreground transition-colors"
                        >
                            {tc("cancel")}
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50"
                        >
                            {isSaving ? (
                                <>
                                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                                    {t("saving")}
                                </>
                            ) : (
                                <>
                                    <Check size={16} />
                                    {t("saveSettings")}
                                </>
                            )}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
