"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Plus, Settings2, Sparkles, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api } from "@/lib/api";
import { getR2vRouteModelId, isR2vImageBased, VIDEO_I2V_MODELS, DEFAULT_I2V_MODEL_ID } from "@/lib/modelCatalog";
import ShotCard, { type ShotNode } from "./storyboard-r2v/ShotCard";
import AssetDrawer from "./storyboard-r2v/AssetDrawer";
import VideoConfigModal, { type VideoConfig, DEFAULT_VIDEO_CONFIG } from "./storyboard-r2v/VideoConfigModal";

export default function StoryboardR2V() {
    const currentProject = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const t = useTranslations("storyboardR2V");
    const ts = useTranslations("storyboard");

    // Derive shots from project frames or initialize empty
    const [shots, setShots] = useState<ShotNode[]>(() => {
        if (currentProject?.frames && currentProject.frames.length > 0) {
            // Build asset lookups for tag reconstruction
            const charById: Record<string, string> = {};
            for (const c of (currentProject.characters || [])) charById[c.id] = c.name;
            const sceneById: Record<string, string> = {};
            for (const s of (currentProject.scenes || [])) sceneById[s.id] = s.name;
            const propById: Record<string, string> = {};
            for (const p of (currentProject.props || [])) propById[p.id] = p.name;

            return currentProject.frames.map((frame: any) => {
                // Rebuild asset tags from frame data (survives page refresh)
                const tags: string[] = [];
                if (frame.scene_id && sceneById[frame.scene_id]) {
                    tags.push(`[scene:${sceneById[frame.scene_id]}]`);
                }
                if (frame.character_ids) {
                    for (const cid of frame.character_ids) {
                        if (charById[cid]) tags.push(`[character:${charById[cid]}]`);
                    }
                }
                if (frame.prop_ids) {
                    for (const pid of frame.prop_ids) {
                        if (propById[pid]) tags.push(`[prop:${propById[pid]}]`);
                    }
                }

                const actionDesc = frame.action_description || "";
                const visualAtm = frame.visual_atmosphere || "";
                const dialogue = frame.dialogue ? ` 对话: ${frame.dialogue}` : "";
                // prompt = clean description (no tags); tags saved separately
                const fullPrompt = [visualAtm, actionDesc, dialogue].filter(Boolean).join(" ");

                return {
                    id: frame.id,
                    prompt: fullPrompt || frame.action_description || "",
                    tabMode: "direct_r2v" as const,
                    videoUrl: frame.video_url || undefined,
                    videoStatus: frame.video_url ? ("completed" as const) : undefined,
                    imageUrl: frame.rendered_image_url || frame.image_url || undefined,
                };
            });
        }
        return [{ id: `shot_${Date.now()}`, prompt: "", tabMode: "direct_r2v" }];
    });

    // Global video config (with localStorage persistence for model selection)
    const [videoConfig, setVideoConfig] = useState<VideoConfig>(() => {
        const savedModel = typeof window !== 'undefined' ? localStorage.getItem('storyboard-r2v-model') : null;
        const projectModel = currentProject?.model_settings?.i2v_model || DEFAULT_I2V_MODEL_ID;
        const modelId = savedModel || projectModel;
        const modelConfig = VIDEO_I2V_MODELS.find(m => m.id === modelId);
        const dc = modelConfig?.duration;
        const defaultDuration = dc ? (dc.type === 'fixed' ? dc.value : dc.default) : 5;
        return { ...DEFAULT_VIDEO_CONFIG, model: modelId, duration: defaultDuration };
    });

    const handleConfigChange = useCallback((config: VideoConfig) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('storyboard-r2v-model', config.model);
        }
        setVideoConfig(config);
    }, []);

    // Modal & drawer state
    const [configModalOpen, setConfigModalOpen] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [drawerState, setDrawerState] = useState<{ isOpen: boolean; targetShotIndex: number | null }>({
        isOpen: false,
        targetShotIndex: null,
    });

    // Refs map for textareas (for asset insertion from drawer)
    const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());

    const characters = currentProject?.characters || [];
    const scenes = currentProject?.scenes || [];
    const props = currentProject?.props || [];

    // Add a new shot after the given index
    const addShot = useCallback((afterIndex: number) => {
        const newShot: ShotNode = {
            id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            prompt: "",
            tabMode: "direct_r2v",
        };
        setShots(prev => {
            const updated = [...prev];
            updated.splice(afterIndex + 1, 0, newShot);
            return updated;
        });
    }, []);

    // Delete a shot
    const deleteShot = useCallback((index: number) => {
        setShots(prev => prev.filter((_, i) => i !== index));
    }, []);

    // Move shot up/down
    const moveShot = useCallback((index: number, direction: "up" | "down") => {
        setShots(prev => {
            const updated = [...prev];
            const targetIndex = direction === "up" ? index - 1 : index + 1;
            if (targetIndex < 0 || targetIndex >= updated.length) return prev;
            [updated[index], updated[targetIndex]] = [updated[targetIndex], updated[index]];
            return updated;
        });
    }, []);

    // Duplicate a shot
    const duplicateShot = useCallback((index: number) => {
        setShots(prev => {
            const source = prev[index];
            const newShot: ShotNode = {
                ...source,
                id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                videoUrl: undefined,
                videoTaskId: undefined,
                videoStatus: undefined,
                t2iImageUrl: undefined,
                t2iTaskId: undefined,
                t2iStatus: undefined,
            };
            const updated = [...prev];
            updated.splice(index + 1, 0, newShot);
            return updated;
        });
    }, []);

    // Analyze script text to generate storyboard frames with asset tags
    const handleAnalyzeToStoryboard = useCallback(async () => {
        if (!currentProject) return;

        const text = currentProject.originalText;
        if (!text || !text.trim()) {
            alert(ts("enterScriptFirst"));
            return;
        }

        if (shots.length > 1 || (shots.length === 1 && shots[0].prompt.trim())) {
            if (!confirm(ts("overwriteConfirm"))) return;
        }

        setIsAnalyzing(true);
        try {
            const updatedProject = await api.analyzeToStoryboard(currentProject.id, text);
            const frames = updatedProject.frames || [];
            if (frames.length === 0) {
                alert(ts("aiInvalidOutput"));
                return;
            }

            // Build lookups: asset ID -> name for character/scene/prop
            const charById: Record<string, string> = {};
            for (const c of (updatedProject.characters || characters)) {
                charById[c.id] = c.name;
            }
            const sceneById: Record<string, string> = {};
            for (const s of (updatedProject.scenes || scenes)) {
                sceneById[s.id] = s.name;
            }
            const propById: Record<string, string> = {};
            for (const p of (updatedProject.props || props)) {
                propById[p.id] = p.name;
            }

            // Convert frames to shots with auto-filled asset tags
            const newShots: ShotNode[] = frames.map((frame: any) => {
                const tags: string[] = [];
                if (frame.scene_id && sceneById[frame.scene_id]) {
                    tags.push(`[scene:${sceneById[frame.scene_id]}]`);
                }
                if (frame.character_ids) {
                    for (const cid of frame.character_ids) {
                        if (charById[cid]) {
                            tags.push(`[character:${charById[cid]}]`);
                        }
                    }
                }
                if (frame.prop_ids) {
                    for (const pid of frame.prop_ids) {
                        if (propById[pid]) {
                            tags.push(`[prop:${propById[pid]}]`);
                        }
                    }
                }

                const actionDesc = frame.action_description || "";
                const visualAtm = frame.visual_atmosphere || "";
                const dialogue = frame.dialogue ? ` 对话: ${frame.dialogue}` : "";
                // prompt = clean description (no tags); tags saved separately
                const fullPrompt = [visualAtm, actionDesc, dialogue].filter(Boolean).join(" ");


                return {
                    id: frame.id || `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    prompt: fullPrompt,
                    tabMode: "direct_r2v" as const,
                    imageUrl: frame.rendered_image_url || frame.image_url || undefined,
                    videoUrl: frame.video_url || undefined,
                    videoStatus: frame.video_url ? ("completed" as const) : undefined,
                };
            });

            setShots(newShots);
            updateProject(currentProject.id, updatedProject);
            alert(ts("framesGenerated", { count: newShots.length }));
        } catch (error: any) {
            console.error("Analyze to storyboard failed:", error);
            const msg = error?.response?.data?.detail || error?.message || t("genFailedDetail", { detail: "" });
            alert(ts("genFailedDetail", { detail: msg }));
        } finally {
            setIsAnalyzing(false);
        }
    }, [currentProject, shots, characters, scenes, props, updateProject]);


    // Update shot prompt
    const updatePrompt = useCallback((index: number, prompt: string) => {
        setShots(prev => prev.map((s, i) => i === index ? { ...s, prompt } : s));
    }, []);

    // Set shot tab mode
    const setTabMode = useCallback((index: number, mode: "t2i_i2v" | "direct_r2v") => {
        setShots(prev => prev.map((s, i) => i === index ? { ...s, tabMode: mode } : s));
    }, []);

    // Resolve asset URLs from frame data (independent of prompt tags)
    // Cached Series asset data (loaded on demand)
    const [seriesAssets, setSeriesAssets] = useState<{ characters: any[]; scenes: any[]; props: any[] } | null>(null);
    useEffect(() => {
        const sid = currentProject?.series_id;
        if (sid) {
            console.log('[r2v-video] Loading seriesAssets for sid:', sid);
            import("@/lib/api").then(({ default: api }) => {
                api.getSeries(sid).then((s: any) => {
                    console.log('[r2v-video] seriesAssets loaded:', s.characters?.length, 'chars,', s.scenes?.length, 'scenes,', s.props?.length, 'props');
                    console.log('[r2v-video] First char variants:', s.characters?.[0]?.full_body_asset?.variants?.length);
                    setSeriesAssets({ characters: s.characters || [], scenes: s.scenes || [], props: s.props || [] });
                }).catch(() => {});
            });
        }
    }, [currentProject?.series_id]);

    const resolveAssetUrls = useCallback((shotIndex: number): string[] => {
        const urls: string[] = [];
        const frame = currentProject?.frames?.[shotIndex];
        if (!frame) return urls;

        // Prefer Series-level assets (which have generated images) over Episode-level copies
        const hasSeriesCharVariants = seriesAssets?.characters?.some((c: any) => c.full_body_asset?.variants?.length);
        const hasEpCharVariants = characters.some((c: any) => c.full_body_asset?.variants?.length);
        const allChars = hasSeriesCharVariants ? (seriesAssets?.characters || characters) : (hasEpCharVariants ? characters : (seriesAssets?.characters || characters));
        const allScenes = seriesAssets?.scenes?.length ? seriesAssets.scenes : scenes;
        const allProps = seriesAssets?.props?.length ? seriesAssets.props : props;
        
        console.log('[r2v-video] resolveAssetUrls for shot', shotIndex, '- allChars:', allChars.length, 'seriesChars variants:', hasSeriesCharVariants, 'epChars variants:', hasEpCharVariants);

        // Characters from frame.character_ids
        if (frame.character_ids) {
            for (const cid of frame.character_ids) {
                const char = allChars.find((c: any) => c.id === cid);
                if (char?.full_body_asset?.variants?.length) {
                    const asset = char.full_body_asset;
                    const selected = asset.selected_id
                        ? asset.variants.find((v: any) => v.id === asset.selected_id)
                        : asset.variants[0];
                    if (selected?.url) urls.push(selected.url);
                }
            }
        }
        // Scene from frame.scene_id
        if (frame.scene_id) {
            const scene = allScenes.find((s: any) => s.id === frame.scene_id);
            if (scene?.image_asset?.variants?.[0]?.url) {
                urls.push(scene.image_asset.variants[0].url);
            }
        }
        // Props from frame.prop_ids
        if (frame.prop_ids) {
            for (const pid of frame.prop_ids) {
                const prop = allProps.find((p: any) => p.id === pid);
                if (prop?.image_asset?.variants?.[0]?.url) {
                    urls.push(prop.image_asset.variants[0].url);
                }
            }
        }
        return urls;
    }, [characters, scenes, props, currentProject, seriesAssets]);

    // Strip tags from prompt for clean text
    const cleanPrompt = (prompt: string): string => {
        return prompt.replace(/\[(character\d+|scene|prop):[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
    };

    // Generate T2I image for a shot (t2i_i2v mode stage 1)
    const generateT2I = useCallback(async (index: number) => {
        const shot = shots[index];
        if (!currentProject || !shot.prompt.trim()) return;

        setShots(prev => prev.map((s, i) =>
            i === index ? { ...s, t2iStatus: "pending" } : s
        ));

        try {
            const result = await api.renderFrame(
                currentProject.id,
                shot.id,
                {},  // compositionData (empty for now)
                cleanPrompt(shot.prompt),
                1    // batchSize
            );

            if (result?.task_id || result?.id) {
                const taskId = result.task_id || result.id;
                setShots(prev => prev.map((s, i) =>
                    i === index ? { ...s, t2iTaskId: taskId, t2iStatus: "processing" } : s
                ));
            } else if (result?.image_url || result?.rendered_image_url) {
                // Immediate result (synchronous render)
                const imageUrl = result.image_url || result.rendered_image_url;
                setShots(prev => prev.map((s, i) =>
                    i === index ? { ...s, t2iImageUrl: imageUrl, t2iStatus: "completed" } : s
                ));
            }
        } catch (error) {
            console.error("Failed to generate T2I for shot:", error);
            setShots(prev => prev.map((s, i) =>
                i === index ? { ...s, t2iStatus: "failed" } : s
            ));
        }
    }, [shots, currentProject]);

    // Generate video for a shot
    const generateVideo = useCallback(async (index: number) => {
        const shot = shots[index];
        if (!currentProject || !shot.prompt.trim()) return;

        const promptText = cleanPrompt(shot.prompt);

        setShots(prev => prev.map((s, i) =>
            i === index ? { ...s, videoStatus: "pending" } : s
        ));

        try {
            if (shot.tabMode === "direct_r2v") {
                // R2V mode: use reference assets
                const referenceUrls = resolveAssetUrls(index);
                console.log('[r2v-video] referenceUrls for shot', index, ':', referenceUrls.length, 'urls', referenceUrls.map(u => typeof u === 'string' ? u.substring(0, 50) : u));
                console.log('[r2v-video] allChars count:', characters.length, 'seriesAssets chars:', seriesAssets?.characters?.length);
                console.log('[r2v-video] frame character_ids:', currentProject?.frames?.[index]?.character_ids);
                const routeModelId = getR2vRouteModelId(videoConfig.model);
                const imageBased = isR2vImageBased(routeModelId);

                const task = await api.createVideoTask(
                    currentProject.id,
                    "",  // no image_url for R2V
                    promptText,
                    videoConfig.duration,
                    undefined, // seed
                    videoConfig.resolution,
                    false, // generateAudio
                    "", // audioUrl
                    videoConfig.promptExtend,
                    videoConfig.negativePrompt,
                    1, // batchSize
                    routeModelId,  // use routed R2V model
                    shot.id, // frameId
                    "multi", // shotType
                    "r2v", // generationMode
                    !imageBased ? referenceUrls : undefined, // referenceVideoUrls (Wan 2.6 legacy)
                    undefined, undefined, undefined, // kling params
                    undefined, undefined, // vidu params
                    imageBased ? referenceUrls : undefined, // referenceImageUrls
                );

                const createdTask = Array.isArray(task) ? task[0] : task;
                if (createdTask && createdTask.id) {
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoTaskId: createdTask.id, videoStatus: "processing" } : s
                    ));
                }
            } else {
                // I2V mode: use T2I image as first frame
                const imageUrl = shot.t2iImageUrl || shot.imageUrl || "";

                const task = await api.createVideoTask(
                    currentProject.id,
                    imageUrl,
                    promptText,
                    videoConfig.duration,
                    undefined, // seed
                    videoConfig.resolution,
                    false, // generateAudio
                    "", // audioUrl
                    videoConfig.promptExtend,
                    videoConfig.negativePrompt,
                    1, // batchSize
                    videoConfig.model, // direct I2V model
                    shot.id, // frameId
                    "multi", // shotType
                    "i2v", // generationMode
                    undefined, // referenceVideoUrls
                    // Kling params
                    videoConfig.mode,
                    videoConfig.sound,
                    videoConfig.cfgScale,
                    // Vidu params
                    videoConfig.viduAudio,
                    videoConfig.movementAmplitude,
                    // HappyHorse
                    undefined,
                );

                const createdTask = Array.isArray(task) ? task[0] : task;
                if (createdTask && createdTask.id) {
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoTaskId: createdTask.id, videoStatus: "processing" } : s
                    ));
                }
            }
        } catch (error) {
            console.error("Failed to generate video for shot:", error);
            setShots(prev => prev.map((s, i) =>
                i === index ? { ...s, videoStatus: "failed" } : s
            ));
        }
    }, [shots, currentProject, videoConfig, resolveAssetUrls]);

    // Poll for task completion (both T2I and video)
    // When VIDEO_PROVIDER is openai, use the configured VIDEO_MODEL name
    useEffect(() => {
        const loadVideoProviderModel = async () => {
            try {
                const envConfig = await api.getEnvConfig();
                if (envConfig?.VIDEO_PROVIDER === 'openai' && envConfig?.VIDEO_MODEL) {
                    setVideoConfig(prev => {
                        if (prev.model === envConfig.VIDEO_MODEL) return prev;
                        return { ...prev, model: envConfig.VIDEO_MODEL };
                    });
                }
            } catch {}
        };
        loadVideoProviderModel();
    }, []);

    useEffect(() => {
        const processingShots = shots.filter(s =>
            (s.videoTaskId && (s.videoStatus === "processing" || s.videoStatus === "pending")) ||
            (s.t2iTaskId && (s.t2iStatus === "processing" || s.t2iStatus === "pending"))
        );
        console.log('[video-poll] processing shots:', processingShots.length, processingShots.map(s => ({ id: s.id, videoStatus: s.videoStatus, videoTaskId: s.videoTaskId })));
        if (processingShots.length === 0) return;

        const interval = setInterval(async () => {
            for (const shot of processingShots) {
                // Poll video task
                if (shot.videoTaskId && (shot.videoStatus === "processing" || shot.videoStatus === "pending")) {
                    try {
                        const status = await api.getTaskStatus(shot.videoTaskId);
                        console.log('[video-poll] task status:', status.status, 'video_url:', !!status.video_url, 'for shot:', shot.id);
                        if (status.status === "completed" && status.video_url) {
                            console.log('[video-poll] SETTING completed for shot:', shot.id);
                            setShots(prev => prev.map(s =>
                                s.id === shot.id ? { ...s, videoStatus: "completed", videoUrl: status.video_url } : s
                            ));
                        } else if (status.status === "failed") {
                            console.log('[video-poll] SETTING failed for shot:', shot.id);
                            setShots(prev => prev.map(s =>
                                s.id === shot.id ? { ...s, videoStatus: "failed" } : s
                            ));
                        }
                    } catch (error) {
                        console.error("Video poll failed for shot:", shot.id, error);
                    }
                }
                // Poll T2I task
                if (shot.t2iTaskId && (shot.t2iStatus === "processing" || shot.t2iStatus === "pending")) {
                    try {
                        const status = await api.getTaskStatus(shot.t2iTaskId);
                        if (status.status === "completed") {
                            const imageUrl = status.image_url || status.video_url || status.result_url;
                            if (imageUrl) {
                                setShots(prev => prev.map(s =>
                                    s.id === shot.id ? { ...s, t2iStatus: "completed", t2iImageUrl: imageUrl } : s
                                ));
                            }
                        } else if (status.status === "failed") {
                            setShots(prev => prev.map(s =>
                                s.id === shot.id ? { ...s, t2iStatus: "failed" } : s
                            ));
                        }
                    } catch (error) {
                        console.error("T2I poll failed for shot:", shot.id, error);
                    }
                }
            }
        }, 5000);

        return () => clearInterval(interval);
    }, [shots]);

    // Insert asset tag from drawer into target shot
    const insertAssetFromDrawer = useCallback((type: string, name: string) => {
        const shotIndex = drawerState.targetShotIndex;
        if (shotIndex === null || shotIndex === undefined) return;

        const tag = `[${type}:${name}]`;
        const textarea = textareaRefs.current.get(shotIndex) ?? null;
        if (textarea) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const currentPrompt = shots[shotIndex].prompt;
            const newPrompt = currentPrompt.slice(0, start) + tag + currentPrompt.slice(end);
            updatePrompt(shotIndex, newPrompt);
            setTimeout(() => {
                textarea.selectionStart = textarea.selectionEnd = start + tag.length;
                textarea.focus();
            }, 0);
        } else {
            updatePrompt(shotIndex, shots[shotIndex].prompt + " " + tag);
        }
    }, [drawerState.targetShotIndex, shots, updatePrompt]);

    // Get model display name for toolbar (supports both built-in and OpenAI models)
    const currentModelName = (() => {
        const builtin = VIDEO_I2V_MODELS.find(m => m.id === videoConfig.model);
        if (builtin) return builtin.name;
        // For OpenAI/external models, show a readable label
        if (videoConfig.model) return videoConfig.model.replace(/_/g, ' ');
        return videoConfig.model || 'Unknown';
    })();

    return (
        <div className="h-full flex flex-col overflow-hidden relative">
            {/* Top Toolbar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-foreground">
                        {shots.length} {shots.length === 1 ? "Shot" : "Shots"}
                    </span>
                    <motion.button
                        whileHover={{ scale: 1.04 }}
                        whileTap={{ scale: 0.96 }}
                        onClick={handleAnalyzeToStoryboard}
                        disabled={isAnalyzing}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-400 hover:text-amber-300 disabled:opacity-50 transition-colors"
                        title="从剧本自动生成分镜"
                    >
                        {isAnalyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} strokeWidth={2} />}
                        {isAnalyzing ? "生成中..." : "生成分镜"}
                    </motion.button>

                    <motion.button
                        whileHover={{ scale: 1.04 }}
                        whileTap={{ scale: 0.96 }}
                        onClick={() => addShot(shots.length - 1)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                    >
                        <Plus size={14} strokeWidth={2} />
                        {t("addShot")}
                    </motion.button>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-[11px] text-text-secondary tracking-wide">{t("currentModel")}: <span className="text-foreground font-medium">{currentModelName}</span></span>
                    <motion.button
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.92 }}
                        onClick={() => setConfigModalOpen(true)}
                        className="flex items-center justify-center w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/[0.10] text-text-secondary hover:text-foreground transition-all"
                        title={t("videoSettings")}
                    >
                        <Settings2 size={13} />
                    </motion.button>
                </div>
            </div>

            {/* Shot List (Timeline) */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                {shots.map((shot, index) => (
                    <motion.div
                        key={shot.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                            type: "spring",
                            stiffness: 100,
                            damping: 20,
                            delay: Math.min(index * 0.03, 0.3),
                        }}
                    >
                        <ShotCard
                            shot={shot}
                            index={index}
                            totalShots={shots.length}
                            characters={characters}
                            scenes={scenes}
                            props={props}
                            onUpdatePrompt={(prompt) => updatePrompt(index, prompt)}
                            onGenerateT2I={() => generateT2I(index)}
                            onGenerateVideo={() => generateVideo(index)}
                            onDelete={() => deleteShot(index)}
                            onMoveUp={() => moveShot(index, "up")}
                            onMoveDown={() => moveShot(index, "down")}
                            onDuplicate={() => duplicateShot(index)}
                            onSetTabMode={(mode) => setTabMode(index, mode)}
                            onOpenDrawer={() => setDrawerState({ isOpen: true, targetShotIndex: index })}
                            onInsertAsset={(type, name) => {
                                // Direct chip insert (same as chip bar logic, delegated to chip bar)
                                const tag = `[${type}:${name}]`;
                                updatePrompt(index, shots[index].prompt + " " + tag);
                            }}
                        />
                    </motion.div>
                ))}

                {/* Add shot at end */}
                <motion.button
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(shots.length * 0.03, 0.3) }}
                    whileHover={{ scale: 1.005 }}
                    whileTap={{ scale: 0.995 }}
                    onClick={() => addShot(shots.length - 1)}
                    className="w-full py-3.5 border border-dashed border-white/[0.08] hover:border-primary/40 rounded-xl text-text-secondary hover:text-primary text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 bg-white/[0.01] hover:bg-white/[0.03]"
                >
                    <Plus size={16} strokeWidth={1.5} />
                    {t("addShot")}
                </motion.button>
            </div>

            {/* Asset Drawer (fixed overlay) */}
            <AssetDrawer
                isOpen={drawerState.isOpen}
                onClose={() => setDrawerState({ isOpen: false, targetShotIndex: null })}
                characters={characters}
                scenes={scenes}
                props={props}
                onSelectAsset={insertAssetFromDrawer}
            />

            {/* Video Config Modal */}
            <VideoConfigModal
                isOpen={configModalOpen}
                onClose={() => setConfigModalOpen(false)}
                config={videoConfig}
                onConfigChange={handleConfigChange}
            />
        </div>
    );
}
