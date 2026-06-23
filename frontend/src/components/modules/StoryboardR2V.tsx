"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { Plus, Palette, Film, Loader2, Link2, Sparkles, RefreshCw } from "lucide-react";
import StepHeader from "@/components/shared/StepHeader";
import PreviousEpisodeFramesRail from "./storyboard-r2v/PreviousEpisodeFramesRail";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api, crudApi, type VideoTask, type RefineSSEEvent, type RenderSSEEvent } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { debugLog } from "@/lib/debugLog";
import type { BatchSummary } from "./storyboard-r2v/shot-panel/CandidatesSection";
import { getR2vRouteModelId, isR2vImageBased, VIDEO_I2V_MODELS, VIDEO_R2V_MODELS, DEFAULT_I2V_MODEL_ID, DEFAULT_R2V_MODEL_ID, DEFAULT_MODEL_SETTINGS, type I2VModelConfig } from "@/lib/modelCatalog";
import ShotCard, { type ShotNode } from "./storyboard-r2v/ShotCard";
import { buildAssembledPrompt, buildPromptWithReferenceTags, resolveAssetReferenceImage } from "./storyboard-r2v/buildAssembledPrompt";
import DialogueAudioRow from "./storyboard-r2v/DialogueAudioRow";
import StoryboardGenerateDialog from "./storyboard-r2v/StoryboardGenerateDialog";
import { toast } from "@/store/toastStore";
import { Wand2 } from "lucide-react";
import AssetDrawer from "./storyboard-r2v/AssetDrawer";
import { type VideoConfig, DEFAULT_VIDEO_CONFIG } from "./storyboard-r2v/VideoConfigModal";
import {
    migrateShotNode,
    appendT2IImage,
    setActiveT2IIndex,
    removeT2IImage,
    getActiveT2IImageUrl,
} from "./storyboard-r2v/shotNodeHelpers";
import { overridePanelSectionState } from "./storyboard-r2v/shot-panel/usePanelSectionState";
import ParamsSection, { type ParamsState } from "./storyboard-r2v/shot-panel/ParamsSection";
import T2ISubsection from "./storyboard-r2v/shot-panel/T2ISubsection";
import CandidatesSection from "./storyboard-r2v/shot-panel/CandidatesSection";
import CompareModal from "./storyboard-r2v/shot-panel/CompareModal";
import TaskQueueButton from "./storyboard-r2v/shot-panel/TaskQueueButton";
import TaskQueuePanel from "./storyboard-r2v/shot-panel/TaskQueuePanel";
import { GenerationBanner, type BannerState } from "./storyboard-r2v/GenerationBanner";

type StoredModelSettings = Partial<typeof DEFAULT_MODEL_SETTINGS>;

type VideoProviderConfig = {
    VIDEO_PROVIDER?: string;
    VIDEO_MODEL?: string;
};

const EXTERNAL_VIDEO_MODEL_PARAMS = {
    duration: { type: "buttons" as const, options: [4, 6, 8], default: 8 },
    params: {
        ratio: { options: ["16:9", "9:16", "1:1"], default: "16:9" },
        seed: true,
        promptExtend: true,
    },
};

function readStoredGlobalModelSettings(ls: Storage | null): StoredModelSettings {
    if (!ls) return {};
    const stored = ls.getItem("lumenx_default_model_settings");
    if (!stored) return {};
    try {
        return JSON.parse(stored) as StoredModelSettings;
    } catch {
        return {};
    }
}

function isExplicitModelSetting(key: keyof StoredModelSettings, value?: string | null): value is string {
    return !!value && value !== (DEFAULT_MODEL_SETTINGS as any)[key];
}

function getVisibleI2vModelId(candidate?: string | null): string {
    return VIDEO_I2V_MODELS.some((model) => model.id === candidate)
        ? candidate as string
        : DEFAULT_I2V_MODEL_ID;
}

function getVisibleR2vModelId(candidate?: string | null): string {
    return VIDEO_R2V_MODELS.some((model) => model.id === candidate)
        ? candidate as string
        : (VIDEO_R2V_MODELS[0]?.id ?? DEFAULT_R2V_MODEL_ID);
}

function isExternalVideoProvider(env?: VideoProviderConfig | null): boolean {
    const provider = env?.VIDEO_PROVIDER?.toLowerCase();
    return provider === "openai" || provider === "comfyui";
}

function getExternalVideoModelId(env?: VideoProviderConfig | null): string | null {
    return isExternalVideoProvider(env) && env?.VIDEO_MODEL ? env.VIDEO_MODEL : null;
}

function buildExternalVideoModelOption(modelId: string): I2VModelConfig {
    return {
        id: modelId,
        name: modelId,
        description: "Global video model from Settings",
        badges: ["Global"],
        family: "external",
        duration: EXTERNAL_VIDEO_MODEL_PARAMS.duration,
        params: EXTERNAL_VIDEO_MODEL_PARAMS.params,
    };
}

function mergeExternalModel(modelList: I2VModelConfig[], modelId?: string | null): I2VModelConfig[] {
    if (!modelId || modelList.some((model) => model.id === modelId)) return modelList;
    return [buildExternalVideoModelOption(modelId), ...modelList];
}

function deriveT2IStatus(frame: any): ShotNode["t2iStatus"] {
    if (frame?.status === "processing") return "processing";
    if (frame?.status === "failed") return "failed";
    if (frame?.rendered_image_url || frame?.image_url || (Array.isArray(frame?.t2i_image_urls) && frame.t2i_image_urls.length > 0)) {
        return "completed";
    }
    return undefined;
}

function frameToBaseShotNode(frame: any, defaultMode: "t2i_i2v" | "direct_r2v"): ShotNode {
    return migrateShotNode({
        id: frame.id,
        prompt: frame.visual_description || frame.action_description || "",
        tabMode: (frame.workbench_tab_mode as "t2i_i2v" | "direct_r2v" | undefined) ?? defaultMode,
        videoUrl: frame.dubbed_video_url || frame.video_url || undefined,
        videoStatus: (frame.dubbed_video_url || frame.video_url) ? ("completed" as const) : undefined,
        imageUrl: frame.rendered_image_url || frame.image_url || undefined,
        sceneId: frame.scene_id ?? null,
        characterIds: Array.isArray(frame.character_ids) ? frame.character_ids : [],
        propIds: Array.isArray(frame.prop_ids) ? frame.prop_ids : [],
        characterStageRefs: frame.character_stage_refs || {},
        sceneStageRef: frame.scene_stage_ref ?? null,
        t2iImageUrls: Array.isArray(frame.t2i_image_urls) ? frame.t2i_image_urls : [],
        t2iSelectedIndex: typeof frame.t2i_selected_index === "number" ? frame.t2i_selected_index : 0,
        t2iStatus: deriveT2IStatus(frame),
        duration: frame.duration ?? null,
        visualDescription: frame.visual_description ?? null,
        assembledPrompt: frame.assembled_prompt ?? null,
        dialogueStructured: frame.dialogue_structured ?? null,
        cameraMovementStructured: frame.camera_movement_structured ?? null,
        shotSize: frame.shot_size ?? null,
        cameraAngle: frame.camera_angle ?? null,
        transitionHint: frame.transition_hint ?? null,
    });
}

function resolveStoryboardVideoDefaults(
    currentProject: any,
    ls: Storage | null,
    env?: VideoProviderConfig | null,
): VideoConfig {
    const savedI2v = ls?.getItem("storyboard-r2v-model") ?? null;
    const savedR2v = ls?.getItem("storyboard-r2v-r2v-model") ?? null;
    const globalSettings = readStoredGlobalModelSettings(ls);
    const externalVideoModelId = getExternalVideoModelId(env);

    const projectI2v = currentProject?.model_settings?.i2v_model;
    const i2vModelId = getVisibleI2vModelId(
        isExplicitModelSetting("i2v_model", projectI2v)
            ? projectI2v
            : globalSettings.i2v_model || savedI2v || DEFAULT_I2V_MODEL_ID,
    );

    if (savedI2v && savedI2v !== i2vModelId && !VIDEO_I2V_MODELS.some((model) => model.id === savedI2v)) {
        ls?.removeItem("storyboard-r2v-model");
        debugLog.warn("Studio", `Removed stale cached I2V model "${savedI2v}".`);
    }

    const projectR2v = currentProject?.model_settings?.r2v_model;
    const derivedR2v = getR2vRouteModelId(i2vModelId);
    const staleDefaultR2v = savedR2v === (DEFAULT_MODEL_SETTINGS as any).r2v_model;
    const savedR2vCandidate = staleDefaultR2v ? null : savedR2v;
    const globalR2v = isExplicitModelSetting("r2v_model", globalSettings.r2v_model)
        ? globalSettings.r2v_model
        : null;
    const r2vCandidate = isExplicitModelSetting("r2v_model", projectR2v)
        ? projectR2v
        : externalVideoModelId || globalR2v || savedR2vCandidate || derivedR2v || DEFAULT_R2V_MODEL_ID;
    const r2vModelId = r2vCandidate === externalVideoModelId
        ? r2vCandidate
        : getVisibleR2vModelId(r2vCandidate);

    if (savedR2v && (staleDefaultR2v || !VIDEO_R2V_MODELS.some((model) => model.id === savedR2v))) {
        ls?.removeItem("storyboard-r2v-r2v-model");
        debugLog.warn("Studio", `Removed stale cached R2V model "${savedR2v}".`);
    }

    const finalConfig = VIDEO_I2V_MODELS.find((model) => model.id === i2vModelId);
    const dc = finalConfig?.duration;
    const defaultDuration = dc ? (dc.type === "fixed" ? dc.value : dc.default) : 5;
    return {
        ...DEFAULT_VIDEO_CONFIG,
        model: i2vModelId,
        r2vModel: r2vModelId,
        duration: defaultDuration,
    };
}

export default function StoryboardR2V() {
    const currentProject = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const t = useTranslations("storyboardR2V");
    const tStep = useTranslations("stepHeader");

    // Derive shots from project frames. Workbench state (T2I 抽卡
    // history, last-active tab, batch count) now comes from backend-
    // persisted frame fields (added in commit 9149b06) instead of
    // React-only state, so cross-refresh / cross-device users see the
    // same panel state. migrateShotNode still runs as a defensive
    // belt-and-suspenders for very old localStorage drafts.
    const [shots, setShots] = useState<ShotNode[]>(() => {
        if (currentProject?.frames && currentProject.frames.length > 0) {
            const videoTasks: any[] = (currentProject as any).video_tasks ?? [];
            const defaultMode = currentProject.default_generation_mode === "i2v" ? "t2i_i2v" : "direct_r2v";
            return currentProject.frames.map((frame: any) => {
                const frameTasks = videoTasks.filter((t: any) => t.frame_id === frame.id);
                const inFlightTask = frameTasks.find((t: any) =>
                    t.status === "pending" || t.status === "processing"
                );
                const latestCompleted = frameTasks.find((t: any) =>
                    t.status === "completed" && t.video_url
                );
                let videoStatus: "pending" | "processing" | "completed" | "failed" | undefined;
                let videoUrl: string | undefined = frame.dubbed_video_url || frame.video_url || undefined;
                let videoTaskId: string | undefined;
                if (inFlightTask) {
                    videoStatus = inFlightTask.status;
                    videoTaskId = inFlightTask.id;
                } else if (videoUrl || latestCompleted) {
                    videoStatus = "completed";
                    videoUrl = videoUrl || latestCompleted?.video_url;
                } else if (frameTasks.some((t: any) => t.status === "failed")) {
                    videoStatus = "failed";
                }
                return {
                    ...frameToBaseShotNode(frame, defaultMode),
                    videoUrl,
                    videoStatus,
                    videoTaskId,
                };
            });
        }
        return [migrateShotNode({ id: `shot_${Date.now()}`, prompt: "", tabMode: "direct_r2v", sceneId: null, characterIds: [], propIds: [] })];
    });

    // Global video config (with localStorage persistence for model selection)
    const [envModelName, setEnvModelName] = useState<string>("");
    const [videoEnvConfig, setVideoEnvConfig] = useState<VideoProviderConfig | null>(null);
    const [videoConfig, setVideoConfig] = useState<VideoConfig>(() => {
        const ls = typeof window !== "undefined" ? window.localStorage : null;
        return resolveStoryboardVideoDefaults(currentProject, ls);
    });

    // Modal & drawer state (configModalOpen retired with the gear; the
    // old VideoConfigModal mount is gone, replaced by per-shot
    // ParamsSection panels under each ShotCard. handleConfigChange is
    // also gone — model writes now flow through handleShotParamsChange
    // below, which mirrors them to localStorage.)
    // Sync videoConfig when currentProject loads (may be null on initial mount)
    useEffect(() => {
        if (!currentProject) return;
        const ls = typeof window !== "undefined" ? window.localStorage : null;
        const resolved = resolveStoryboardVideoDefaults(currentProject, ls, videoEnvConfig);
        setVideoConfig(prev => {
            // Only update if the resolved model differs from current
            if (prev.model === resolved.model && prev.r2vModel === resolved.r2vModel) return prev;
            return resolved;
        });
    }, [currentProject, videoEnvConfig]);

    // Fetch env video model name for display
  useEffect(() => {
    api.getEnvConfig().then(cfg => {
      setVideoEnvConfig({
        VIDEO_PROVIDER: cfg.VIDEO_PROVIDER ? String(cfg.VIDEO_PROVIDER) : undefined,
        VIDEO_MODEL: cfg.VIDEO_MODEL ? String(cfg.VIDEO_MODEL) : undefined,
      });
      if (cfg.VIDEO_PROVIDER === "openai" && cfg.VIDEO_MODEL) {
        setEnvModelName(cfg.VIDEO_MODEL as string);
      }
    }).catch(() => {});
  }, []);

  const [drawerState, setDrawerState] = useState<{ isOpen: boolean; targetShotIndex: number | null }>({
        isOpen: false,
        targetShotIndex: null,
    });

    // Task-queue side panel state. Persisted across renders only; we
    // intentionally don't localStorage this — it's transient "I want
    // to peek at queue" UI affordance, not a saved layout preference.
    const [queueOpen, setQueueOpen] = useState(false);

    // Compare-mode selection: a Set of task ids the user shift-clicked
    // in any shot's candidate panel. Multi-shot compare is a future
    // feature; for now the same Set is shared across shots so user
    // can only effectively compare within one shot at a time. Cleared
    // on Compare modal close.
    const [compareSelectedIds, setCompareSelectedIds] = useState<Set<string>>(() => new Set());
    const [compareModalOpen, setCompareModalOpen] = useState(false);

    // Refs map for textareas (for asset insertion from drawer)
    const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());
    // Refs to each shot's outer wrapper so the task-queue panel can
    // jump-scroll the canvas to a specific frame.
    const shotWrapperRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
    // Per-shot submission lockout (Issue 17) — debounce double-clicks and
    // strict-mode double-effects. Holds shot.id strings; entries auto-expire
    // after 500ms via setTimeout in generateVideoBatch.
    const submittingShotsRef = useRef<Set<string>>(new Set());

    // Inline per-shot validation error messages (shown by ParamsSection
    // below the Generate CTA). Used for pre-flight failures like
    // "R2V needs reference images" that we catch before hitting the
    // backend, so the user gets immediate feedback instead of a
    // task that queues, fails, and shows up only in the diagnose log.
    const [shotErrors, setShotErrors] = useState<Record<string, string>>({});
    const externalVideoModelId = getExternalVideoModelId(videoEnvConfig);
    const r2vModelList = useMemo(
        () => mergeExternalModel(VIDEO_R2V_MODELS, externalVideoModelId || videoConfig.r2vModel),
        [externalVideoModelId, videoConfig.r2vModel],
    );
    const i2vModelList = useMemo(
        () => mergeExternalModel(VIDEO_I2V_MODELS, externalVideoModelId && videoConfig.model === externalVideoModelId ? externalVideoModelId : null),
        [externalVideoModelId, videoConfig.model],
    );

    const isExternalVideoModel = useCallback(
        (modelId?: string | null) => !!modelId && !!externalVideoModelId && modelId === externalVideoModelId,
        [externalVideoModelId],
    );

    const findR2vModel = useCallback(
        (modelId?: string | null) => r2vModelList.find((model) => model.id === modelId),
        [r2vModelList],
    );

    // Per-shot seed override. The Seed advanced param doesn't live in
    // videoConfig (seeds are inherently per-generation; sharing one
    // across shots would defeat the "different shots = different
    // creative takes" expectation). Without this state the seed
    // input + dice button would appear to do nothing because
    // ParamsSection.set("seed", N) flowed up to handleShotParamsChange,
    // which silently dropped it, so the next paramsStateForShot()
    // call would always rebuild params.seed = undefined.
    //
    // `undefined` means "no explicit seed" (provider picks). Any
    // number means "use this exact seed" — same for all takes in a
    // batch (intentional: ×N with a fixed seed = N runs at that seed
    // for ablation testing). Users who want N varied takes leave it
    // empty.
    const [shotSeeds, setShotSeeds] = useState<Record<string, number | undefined>>({});

    // Per-shot batch count (the "抽卡 ×N" knob). Decoupled from
    // videoConfig because users typically pick the model + duration
    // once and vary count per shot. Keyed by shot.id so insert/move
    // don't shuffle counts onto the wrong shot. Seeded from backend
    // workbench_generate_count so user choices survive refresh.
    const [shotCounts, setShotCounts] = useState<Record<string, number>>(() => {
        const out: Record<string, number> = {};
        const frames: any[] = currentProject?.frames ?? [];
        for (const f of frames) {
            if (typeof f.workbench_generate_count === "number") {
                out[f.id] = f.workbench_generate_count;
            }
        }
        return out;
    });

    // Issue 16 — per-shot expand state (P plan). Default: all collapsed
    // (browse mode). Set persists per project to localStorage so coming back
    // to the project restores the user's last working layout.
    const expandStorageKey = currentProject ? `storyboard-r2v-expanded-${currentProject.id}` : null;
    const [expandedShots, setExpandedShots] = useState<Set<string>>(() => {
        if (typeof window === "undefined" || !expandStorageKey) return new Set();
        try {
            const raw = window.localStorage.getItem(expandStorageKey);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) return new Set(arr.filter(x => typeof x === "string"));
            }
        } catch { /* corrupt localStorage value — ignore */ }
        return new Set();
    });
    // Persist on change.
    useEffect(() => {
        if (typeof window === "undefined" || !expandStorageKey) return;
        try {
            window.localStorage.setItem(expandStorageKey, JSON.stringify(Array.from(expandedShots)));
        } catch { /* quota exceeded — ignore */ }
    }, [expandedShots, expandStorageKey]);

    const toggleShotExpanded = useCallback((shotId: string) => {
        setExpandedShots(prev => {
            const next = new Set(prev);
            if (next.has(shotId)) next.delete(shotId);
            else next.add(shotId);
            return next;
        });
    }, []);
    const expandAllShots = useCallback(() => {
        const ids = shots.map(s => s.id);
        // Force every inner section open — overrides each shot's sticky
        // preference. Section keys must match what ParamsSection /
        // CandidatesSection register inside their SectionShells.
        overridePanelSectionState(ids, ["params", "candidates"], true);
        setExpandedShots(new Set(ids));
    }, [shots]);
    const collapseAllShots = useCallback(() => {
        // Don't reset section preferences here — sticky memory should
        // survive a global collapse so re-expanding a shot returns to
        // the user's chosen drawer state.
        setExpandedShots(new Set());
    }, []);

    // Debounced backend writer for workbench state. Coalesces rapid
    // changes (e.g. user clicking through T2I thumbs) into one PATCH
    // per shot per second. Per-shot map ensures one shot's pending
    // write doesn't get overwritten by another's.
    const workbenchPendingRef = useRef<Map<string, {
        timer: number;
        patch: Parameters<typeof api.updateFrameWorkbench>[2];
    }>>(new Map());
    const persistWorkbench = useCallback((
        shotId: string,
        patch: Parameters<typeof api.updateFrameWorkbench>[2],
    ) => {
        if (!currentProject?.id) return;
        // Synthetic shot id (not yet materialized on backend) — skip; the
        // workbench state will be re-applied after createFrame swaps the id.
        if (shotId.startsWith("shot_")) return;
        const projectId = currentProject.id;
        const map = workbenchPendingRef.current;
        const existing = map.get(shotId);
        const merged = { ...(existing?.patch ?? {}), ...patch };
        if (existing) {
            window.clearTimeout(existing.timer);
        }
        const timer = window.setTimeout(() => {
            map.delete(shotId);
            api.updateFrameWorkbench(projectId, shotId, merged)
                .then(() => {
                    // Sync store so other tabs (or remount on tab switch)
                    // see the latest workbench state. Read store live to
                    // avoid stale closure.
                    const proj = useProjectStore.getState().currentProject;
                    if (!proj || proj.id !== projectId) return;
                    const nextFrames = (proj.frames ?? []).map((f: any) =>
                        f.id === shotId ? { ...f, ...merged } : f,
                    );
                    updateProject(projectId, { frames: nextFrames });
                })
                .catch((err) => {
                    debugLog.warn("Studio", "Failed to persist workbench state:", err);
                });
        }, 1000);
        map.set(shotId, { timer, patch: merged });
    }, [currentProject?.id, updateProject]);

    // Prompt edits hit a different endpoint (POST /frames/update with
    // action_description) — debounced separately from workbench so a
    // user typing fast doesn't push 6 PATCH /workbench every keystroke.
    const promptPendingRef = useRef<Map<string, { timer: number; prompt: string }>>(new Map());
    const persistPrompt = useCallback((shotId: string, prompt: string) => {
        if (!currentProject?.id) return;
        if (shotId.startsWith("shot_")) return;
        const projectId = currentProject.id;
        const map = promptPendingRef.current;
        const existing = map.get(shotId);
        if (existing) window.clearTimeout(existing.timer);
        const timer = window.setTimeout(() => {
            map.delete(shotId);
            api.updateFrame(projectId, shotId, { action_description: prompt })
                .then(() => {
                    const proj = useProjectStore.getState().currentProject;
                    if (!proj || proj.id !== projectId) return;
                    const nextFrames = (proj.frames ?? []).map((f: any) =>
                        f.id === shotId ? { ...f, action_description: prompt } : f,
                    );
                    updateProject(projectId, { frames: nextFrames });
                })
                .catch((err) => debugLog.warn("Studio", "persistPrompt failed", err));
        }, 800);
        map.set(shotId, { timer, prompt });
    }, [currentProject?.id, updateProject]);

    // Flush all pending writes on unmount (e.g. user switches step tab)
    // so the last keystroke / param change isn't stranded in the debounce
    // window. All queues (workbench, prompt, field) drain in parallel.
    useEffect(() => {
        const wbMap = workbenchPendingRef.current;
        const pMap = promptPendingRef.current;
        const fMap = fieldPendingRef.current;
        return () => {
            const projectId = currentProject?.id;
            if (!projectId) return;
            for (const [shotId, entry] of Array.from(wbMap.entries())) {
                window.clearTimeout(entry.timer);
                api.updateFrameWorkbench(projectId, shotId, entry.patch).catch(() => {});
            }
            wbMap.clear();
            for (const [shotId, entry] of Array.from(pMap.entries())) {
                window.clearTimeout(entry.timer);
                api.updateFrame(projectId, shotId, { action_description: entry.prompt }).catch(() => {});
            }
            pMap.clear();
            for (const [shotId, entry] of Array.from(fMap.entries())) {
                window.clearTimeout(entry.timer);
                api.updateFrame(projectId, shotId, entry.fields).catch(() => {});
            }
            fMap.clear();
        };
    }, [currentProject?.id]);

    // beforeunload guard: warn when structured field edits are pending
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (fieldPendingRef.current.size > 0 || promptPendingRef.current.size > 0) {
                e.preventDefault();
            }
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, []);

    const characters = currentProject?.characters || [];
    const scenes = currentProject?.scenes || [];
    const props = currentProject?.props || [];

    // ────────────────────────────────────────────────────────────────────
    // Shot mutations — Optimistic UI + 异步同步后端 + store 更新
    //   Pattern: 立即改本地 state（无闪烁），后台 fire-and-forget call
    //   到 backend，成功后 swap synthetic id with real id（addShot/duplicate）
    //   并 updateProject(store) 让 currentProject.frames 保持权威。
    //   失败仅 log warn，不回滚（避免 UI 闪烁；用户可重试）。
    //   切 step tab → unmount 时 useEffect cleanup 已经 flush pending
    //   debounce writes，所以打字到一半切走也不丢字。
    // ────────────────────────────────────────────────────────────────────

    // Add a new shot after the given index
    const addShot = useCallback(async (afterIndex: number) => {
        const synthId = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // PR-3e · pick default tabMode from project preference (inherited from
        // series). "i2v" (画面优先) → t2i_i2v; "r2v" (节奏优先, default) → direct_r2v.
        const defaultMode = currentProject?.default_generation_mode === "i2v" ? "t2i_i2v" : "direct_r2v";
        const newShot: ShotNode = {
            id: synthId,
            prompt: "",
            tabMode: defaultMode,
            sceneId: null,
            characterIds: [],
            propIds: [],
        };
        setShots(prev => {
            const updated = [...prev];
            updated.splice(afterIndex + 1, 0, newShot);
            return updated;
        });
        // Issue 16 — newly-created shots default to expanded so the user
        // can immediately operate on them. Existing shots keep their state.
        setExpandedShots(prev => {
            const next = new Set(prev);
            next.add(synthId);
            return next;
        });
        if (!currentProject?.id) return;
        try {
            const resp = await crudApi.createFrame(currentProject.id, {
                scene_id: "",
                action_description: "",
                insert_at: afterIndex + 1,
            });
            const frames = Array.isArray(resp?.frames) ? resp.frames : null;
            const realFrame = frames?.[Math.min(afterIndex + 1, frames.length - 1)];
            if (realFrame?.id) {
                setShots(prev => prev.map(s => s.id === synthId ? { ...s, id: realFrame.id } : s));
                setExpandedShots(prev => {
                    if (!prev.has(synthId)) return prev;
                    const next = new Set(prev);
                    next.delete(synthId);
                    next.add(realFrame.id);
                    return next;
                });
            }
            if (frames) updateProject(currentProject.id, { frames });
        } catch (err) {
            debugLog.warn("Studio", "addShot backend persist failed", err);
        }
    }, [currentProject, updateProject]);

    // PR-3 followup · LLM storyboard generation. State + handler live at
    // the StoryboardR2V level (not in a sub-component) because the toast
    // lifecycle survives the dialog closing and we need the parent to
    // setShots() when the new frames come back.
    const [genDialogOpen, setGenDialogOpen] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [refining, setRefining] = useState(false);
    const [renderingFrames, setRenderingFrames] = useState(false);
    const [isLinking, setIsLinking] = useState(false);

    const [bannerState, setBannerState] = useState<BannerState>(
        () => (currentProject?.frames?.length ?? 0) > 0 ? "summary" : "idle"
    );
    const [refineProgress, setRefineProgress] = useState<{ current: number; total: number } | null>(null);
    const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);
    const [dialogueProgress, setDialogueProgress] = useState<{ current: number; total: number } | null>(null);

    const PHASE1_CAPTIONS = useMemo(() => [
        "正在分析剧本结构…",
        "识别场景切换点…",
        "拆分镜头与动作…",
        "琢磨每帧的构图和节奏…",
        "快了，安排景别和运镜…",
        "最后润色一下…",
    ], []);

    const frameToShotNode = useCallback((frame: any): ShotNode => frameToBaseShotNode(
        frame,
        currentProject?.default_generation_mode === "i2v" ? "t2i_i2v" : "direct_r2v",
    ), [currentProject?.default_generation_mode]);

    const bannerSummary = useMemo(() => {
        if (!currentProject?.frames?.length) return null;
        const frames = currentProject.frames as any[];
        const frameCount = frames.length;
        const withDialogue = frames.filter((f: any) =>
            f.dialogue_structured?.line || f.dialogue
        );
        const charsWithVoice = new Set(
            (currentProject as any).characters?.filter((c: any) => c.voice_id).map((c: any) => c.id) ?? []
        );
        const charNameToVoice = new Map<string, boolean>(
            (currentProject as any).characters?.filter((c: any) => c.voice_id).map((c: any) => [c.name?.toLowerCase(), true]) ?? []
        );
        const hasVoiceBinding = (f: any): boolean => {
            if (f.character_ids?.[0] && charsWithVoice.has(f.character_ids[0])) return true;
            const speaker = f.dialogue_structured?.speaker || f.speaker;
            return !!(speaker && charNameToVoice.has(speaker.toLowerCase()));
        };
        const dialogueReady = withDialogue.filter((f: any) =>
            hasVoiceBinding(f) && !f.audio_url
        ).length;
        const dialogueMissing = withDialogue.filter((f: any) => !hasVoiceBinding(f)).length;
        return { frameCount, dialogueReady, dialogueMissing };
    }, [currentProject?.frames, (currentProject as any)?.characters]);

    const refineStats = useMemo(() => {
        const frames = (currentProject?.frames as any[] | undefined) ?? [];
        const refined = frames.filter((frame: any) =>
            frame.assembled_prompt && frame.visual_description
        ).length;
        const total = frames.length || shots.length;
        return {
            refined,
            total,
            remaining: Math.max(0, total - refined),
        };
    }, [currentProject?.frames, shots.length]);

    const renderStats = useMemo(() => {
        const frames = (currentProject?.frames as any[] | undefined) ?? [];
        const rendered = frames.filter((frame: any) =>
            frame.rendered_image_url
            || frame.image_url
            || (Array.isArray(frame.t2i_image_urls) && frame.t2i_image_urls.length > 0)
        ).length;
        const total = frames.length || shots.length;
        return {
            rendered,
            total,
            remaining: Math.max(0, total - rendered),
        };
    }, [currentProject?.frames, shots.length]);

    const refreshProjectFrames = useCallback(async () => {
        if (!currentProject?.id) return;
        const refreshed = await api.getProject(currentProject.id);
        if (refreshed?.frames) {
            updateProject(currentProject.id, { frames: refreshed.frames });
            setShots(refreshed.frames.map(frameToShotNode));
        }
    }, [currentProject?.id, frameToShotNode, updateProject]);

    const handleBatchDialogue = useCallback(async () => {
        if (!currentProject?.id) return;
        setBannerState("dialogue");
        setDialogueProgress(null);
        try {
            const frames = currentProject.frames as any[] ?? [];
            const totalWithDialogue = frames.filter((f: any) => f.dialogue_structured?.line || f.dialogue).length;
            setDialogueProgress({ current: 0, total: totalWithDialogue });
            const result = await api.generateDialogueAudioBatch(currentProject.id);
            const stats = result._batch_stats;
            if (stats.failed > 0) {
                toast.warning(`对白生成完成：${stats.generated} 条成功，${stats.failed} 条失败`);
            } else if (stats.generated > 0) {
                toast.success(`已生成 ${stats.generated} 条对白音频`);
            } else if (stats.no_voice > 0 && stats.skipped === 0) {
                toast.warning(`${stats.no_voice} 条对白的角色尚未绑定语音`);
            } else if (stats.skipped > 0) {
                toast.success("所有对白音频已是最新");
            } else {
                toast.warning("未找到可生成的对白");
            }
            const updated = await api.getProject(currentProject.id);
            if (updated?.frames) updateProject(currentProject.id, { frames: updated.frames });
        } catch (e) {
            debugLog.error("Studio", "batch dialogue audio failed", e);
            toast.error("对白批量生成失败，请重试");
        } finally {
            setBannerState("summary");
            setDialogueProgress(null);
        }
    }, [currentProject, updateProject]);

    const handleSmartGenerate = useCallback(async () => {
        if (!currentProject?.id) return;
        const projectId = currentProject.id;
        const scriptText = (currentProject as any).originalText || (currentProject as any).original_text || "";
        if (!scriptText.trim()) {
            toast.warning(t("genToastNoScript"));
            return;
        }

        const existingCount = currentProject?.frames?.length || 0;

        setGenerating(true);
        setBannerState("phase1");
        if (existingCount === 0) {
            setShots([]);
        }
        try {
            // Phase 1: generate coarse frames (backend preserves existing frames by default)
            const updated = await api.analyzeToStoryboard(projectId, scriptText);
            const newFrameCount = Array.isArray(updated?.frames) ? updated.frames.length : 0;
            updateProject(projectId, updated);
            if (Array.isArray(updated?.frames)) {
                setShots(updated.frames.map(frameToShotNode));
            }
            setBannerState("summary");
            if (newFrameCount > 0) {
                const source = existingCount > 0 && newFrameCount === existingCount ? '解析' : '生成';
                toast.success(`${source} ${newFrameCount} 帧分镜，可点击「全部润色」继续精修。`);
            } else {
                toast.warning("暂未生成分镜，请检查剧本内容。");
            }
        } catch (err: any) {
            const detail = err?.response?.data?.detail || err?.message || t("genToastErrUnknown");
            toast.error(`${t("genToastErr")}: ${String(detail).slice(0, 200)}`);
        } finally {
            setGenerating(false);
            setRefineProgress(null);
            // Determine final banner state based on actual current shots
            setShots(currentShots => {
                setBannerState(currentShots.length > 0 ? "summary" : "idle");
                return currentShots;
            });
        }
    }, [currentProject, frameToShotNode, updateProject, t]);

    const handleBatchRefineFrames = useCallback(async () => {
        if (!currentProject?.id) return;
        const projectId = currentProject.id;
        const frameCount = currentProject.frames?.length ?? shots.length;
        if (frameCount <= 0) {
            toast.warning("暂无可润色的分镜，请先生成分镜。");
            return;
        }

        setRefining(true);
        setBannerState("phase2");
        const targetTotal = refineStats.remaining || frameCount;
        setRefineProgress({ current: 0, total: targetTotal });
        let keepTrackingExistingRun = false;
        try {
            const batchResult = { total: targetTotal, success: 0, failed: 0, skipped: 0 };
            let receivedBatchComplete = false;
            await api.refineBatchFrames(projectId, (event: RefineSSEEvent) => {
                if (event.type === "frame_refine_complete" || event.type === "frame_refine_error") {
                    setRefineProgress({
                        current: event.completed ?? ((event.success ?? 0) + (event.failed ?? 0)),
                        total: event.total ?? targetTotal,
                    });
                    void refreshProjectFrames();
                } else if (event.type === "batch_complete") {
                    receivedBatchComplete = true;
                    batchResult.total = event.total ?? targetTotal;
                    batchResult.success = event.success ?? 0;
                    batchResult.failed = event.failed ?? 0;
                    batchResult.skipped = event.skipped ?? 0;
                    setRefineProgress({
                        current: (event.success ?? 0) + (event.failed ?? 0),
                        total: event.total ?? targetTotal,
                    });
                }
            });
            if (!receivedBatchComplete) {
                const status = await api.getRefineBatchStatus(projectId);
                batchResult.total = status.total ?? targetTotal;
                batchResult.success = status.success ?? 0;
                batchResult.failed = status.failed ?? 0;
                batchResult.skipped = status.skipped ?? 0;
            }
            await refreshProjectFrames();
            setBannerState("summary");
            const failed = batchResult.failed;
            const success = batchResult.success;
            const skipped = batchResult.skipped;
            if (batchResult.total === 0 && skipped > 0) {
                toast.success("所有分镜都已润色完成");
            } else if (failed > 0) {
                toast.warning(`润色完成：${success} 帧成功，${failed} 帧失败`);
            } else if (success > 0) {
                toast.success(`润色完成：${success} 帧成功`);
            } else if (skipped > 0) {
                toast.success("所有分镜都已润色完成");
            } else {
                toast.error("润色未产生有效结果，请查看请求日志后重试");
            }
        } catch (err: any) {
            if (err?.status === 409) {
                keepTrackingExistingRun = true;
                setRefining(true);
                setBannerState("phase2");
                toast.warning("已有批量润色正在运行，已切换为跟踪进度。");
                return;
            }
            const detail = err?.response?.data?.detail || err?.message || "未知错误";
            toast.error(`全部润色失败：${String(detail).slice(0, 200)}`);
            debugLog.warn("Studio", "batch frame refine failed", err);
            setBannerState(shots.length > 0 ? "summary" : "idle");
        } finally {
            if (!keepTrackingExistingRun) {
                setRefining(false);
                setRefineProgress(null);
            }
        }
    }, [currentProject, shots.length, refineStats.remaining, refreshProjectFrames]);


    const handleBatchAutoLink = useCallback(async () => {
        if (!currentProject?.id) return;
        try {
            setIsLinking(true);
            const updated = await api.autoLinkFrameAssets(currentProject.id);
            updateProject(currentProject.id, updated);
            if (Array.isArray(updated?.frames)) {
                setShots(updated.frames.map(frameToShotNode));
            }
            toast.success("已自动引用资源");
        } catch (err) {
            console.error("Auto-link assets failed", err);
            toast.error("自动引用资源失败");
        } finally {
            setIsLinking(false);
        }
    }, [currentProject, frameToShotNode, updateProject]);

    const handleBatchRenderFrames = useCallback(async () => {
        if (!currentProject?.id) return;
        const projectId = currentProject.id;

        const frameCount = currentProject.frames?.length ?? shots.length;
        if (frameCount <= 0) {
            toast.warning("暂无可生成分镜图的分镜，请先生成分镜。");
            return;
        }

        setRenderingFrames(true);
        const targetTotal = renderStats.remaining || frameCount;
        setRenderProgress({ current: 0, total: targetTotal });
        let keepTrackingExistingRun = false;
        try {
            const batchResult = { total: targetTotal, success: 0, failed: 0, skipped: 0, firstError: "" };
            await api.renderBatchFrames(projectId, (event: RenderSSEEvent) => {
                if (event.type === "frame_render_complete" || event.type === "frame_render_error") {
                    if (event.type === "frame_render_error" && event.error && !batchResult.firstError) {
                        batchResult.firstError = event.error;
                    }
                    setRenderProgress({
                        current: event.completed ?? ((event.success ?? 0) + (event.failed ?? 0)),
                        total: event.total ?? targetTotal,
                    });
                    void refreshProjectFrames();
                } else if (event.type === "batch_complete") {
                    batchResult.total = event.total ?? targetTotal;
                    batchResult.success = event.success ?? 0;
                    batchResult.failed = event.failed ?? 0;
                    batchResult.skipped = event.skipped ?? 0;
                    setRenderProgress({
                        current: (event.success ?? 0) + (event.failed ?? 0),
                        total: event.total ?? targetTotal,
                    });
                }
            });
            await refreshProjectFrames();
            const failed = batchResult.failed;
            const success = batchResult.success;
            const skipped = batchResult.skipped;
            if (batchResult.total === 0 && skipped > 0) {
                toast.success("所有分镜图都已生成");
            } else if (failed > 0) {
                toast.warning(`分镜图生成完成：${success} 帧成功，${failed} 帧失败${batchResult.firstError ? `：${batchResult.firstError.slice(0, 120)}` : ""}`);
            } else {
                toast.success(`分镜图生成完成：${success} 帧成功`);
            }
        } catch (err: any) {
            if (err?.status === 409) {
                keepTrackingExistingRun = true;
                setRenderingFrames(true);
                toast.warning("已有批量分镜图生成正在运行，已切换为跟踪进度。");
                return;
            }
            const detail = err?.response?.data?.detail || err?.message || "未知错误";
            toast.error(`批量生成分镜图失败：${String(detail).slice(0, 200)}`);
            debugLog.warn("Studio", "batch frame render failed", err);
        } finally {
            if (!keepTrackingExistingRun) {
                setRenderingFrames(false);
                setRenderProgress(null);
            }
        }
    }, [currentProject, shots.length, renderStats.remaining, refreshProjectFrames]);

    useEffect(() => {
        if (!currentProject?.id) return;
        let cancelled = false;

        const syncBatchStatuses = async () => {
            if (generating) return;
            try {
                const status = await api.getRefineBatchStatus(currentProject.id);
                if (cancelled) return;
                if (status.running) {
                    setRefining(true);
                    setBannerState("phase2");
                    setRefineProgress({
                        current: status.completed ?? 0,
                        total: status.total ?? 0,
                    });
                    void refreshProjectFrames();
                } else {
                    setRefining(false);
                    setRefineProgress(null);
                    setBannerState(shots.length > 0 ? "summary" : "idle");
                }
            } catch (err) {
                debugLog.warn("Studio", "sync refine batch status failed", err);
            }

            try {
                const status = await api.getRenderBatchStatus(currentProject.id);
                if (cancelled) return;
                if (status.running) {
                    setRenderingFrames(true);
                    setRenderProgress({
                        current: status.completed ?? 0,
                        total: status.total ?? 0,
                    });
                    void refreshProjectFrames();
                } else {
                    setRenderingFrames(false);
                    setRenderProgress(null);
                }
            } catch (err) {
                debugLog.warn("Studio", "sync render batch status failed", err);
            }
        };

        void syncBatchStatuses();
        const timer = window.setInterval(syncBatchStatuses, 3000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [currentProject?.id, generating, refreshProjectFrames, shots.length]);

    const handleRefineFrame = useCallback(async (frameId: string) => {
        if (!currentProject?.id) return;
        try {
            await api.refineSingleFrame(currentProject.id, frameId);
            const updated = await api.getProject(currentProject.id);
            if (updated?.frames) {
                updateProject(currentProject.id, { frames: updated.frames });
                setShots(
                    updated.frames.map((frame: any) =>
                        migrateShotNode({
                            id: frame.id,
                            prompt: frame.visual_description || frame.action_description || "",
                            tabMode: (frame.workbench_tab_mode as "t2i_i2v" | "direct_r2v" | undefined)
                                ?? (currentProject.default_generation_mode === "i2v" ? "t2i_i2v" : "direct_r2v"),
                            videoUrl: frame.dubbed_video_url || frame.video_url || undefined,
                            videoStatus: (frame.dubbed_video_url || frame.video_url) ? ("completed" as const) : undefined,
                            imageUrl: frame.rendered_image_url || frame.image_url || undefined,
                            sceneId: frame.scene_id ?? null,
                            characterIds: Array.isArray(frame.character_ids) ? frame.character_ids : [],
                            propIds: Array.isArray(frame.prop_ids) ? frame.prop_ids : [],
                            characterStageRefs: frame.character_stage_refs || {},
                            sceneStageRef: frame.scene_stage_ref ?? null,
                            t2iImageUrls: Array.isArray(frame.t2i_image_urls) ? frame.t2i_image_urls : [],
                            t2iSelectedIndex: typeof frame.t2i_selected_index === "number"
                                ? frame.t2i_selected_index : 0,
                            duration: frame.duration ?? null,
                            visualDescription: frame.visual_description ?? null,
                            assembledPrompt: frame.assembled_prompt ?? null,
                            dialogueStructured: frame.dialogue_structured ?? null,
                            cameraMovementStructured: frame.camera_movement_structured ?? null,
                            shotSize: frame.shot_size ?? null,
                            cameraAngle: frame.camera_angle ?? null,
                            transitionHint: frame.transition_hint ?? null,
                        }),
                    ),
                );
            }
            toast.success("精修完成");
        } catch (err) {
            toast.error("精修失败");
            debugLog.warn("Studio", "single frame refine failed", err);
        }
    }, [currentProject, updateProject]);

    // Delete a shot
    const deleteShot = useCallback(async (index: number) => {
        const target = shots[index];
        if (!target) return;
        setShots(prev => prev.filter((_, i) => i !== index));
        setExpandedShots(prev => {
            if (!prev.has(target.id)) return prev;
            const next = new Set(prev);
            next.delete(target.id);
            return next;
        });
        if (!currentProject?.id) return;
        // Synthetic id never reached backend → nothing to delete remotely.
        if (target.id.startsWith("shot_")) return;
        try {
            const resp = await crudApi.deleteFrame(currentProject.id, target.id);
            const frames = Array.isArray(resp?.frames) ? resp.frames : null;
            if (frames) updateProject(currentProject.id, { frames });
        } catch (err) {
            debugLog.warn("Studio", "deleteShot backend persist failed", err);
        }
    }, [shots, currentProject, updateProject]);

    // Move shot up/down
    const moveShot = useCallback(async (index: number, direction: "up" | "down") => {
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= shots.length) return;
        const updated = [...shots];
        [updated[index], updated[targetIndex]] = [updated[targetIndex], updated[index]];
        setShots(updated);
        if (!currentProject?.id) return;
        const ids = updated.map(s => s.id);
        // Reorder requires every id to be backed on backend — if any
        // are still synthetic (createFrame in-flight), defer; the next
        // move after createFrame settles will reconcile.
        if (ids.some(id => id.startsWith("shot_"))) return;
        try {
            const resp = await crudApi.reorderFrames(currentProject.id, ids);
            const frames = Array.isArray(resp?.frames) ? resp.frames : null;
            if (frames) updateProject(currentProject.id, { frames });
        } catch (err) {
            debugLog.warn("Studio", "moveShot backend persist failed", err);
        }
    }, [shots, currentProject, updateProject]);

    // Duplicate a shot
    const duplicateShot = useCallback(async (index: number) => {
        const source = shots[index];
        if (!source) return;
        const synthId = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const newShot: ShotNode = {
            ...source,
            id: synthId,
            // Generated artifacts don't carry over; user duplicates
            // the *intent* of the shot, not the output.
            videoUrl: undefined,
            videoTaskId: undefined,
            videoStatus: undefined,
            t2iImageUrl: undefined,
            t2iTaskId: undefined,
            t2iStatus: undefined,
        };
        setShots(prev => {
            const updated = [...prev];
            updated.splice(index + 1, 0, newShot);
            return updated;
        });
        setExpandedShots(prev => {
            const next = new Set(prev);
            next.add(synthId);
            return next;
        });
        if (!currentProject?.id) return;
        // Source itself isn't on backend yet — best-effort: skip remote
        // copy, the next workbench/prompt write will materialize it.
        if (source.id.startsWith("shot_")) return;
        try {
            const resp = await crudApi.copyFrame(currentProject.id, source.id, index + 1);
            const frames = Array.isArray(resp?.frames) ? resp.frames : null;
            const realFrame = frames?.[index + 1];
            if (realFrame?.id) {
                setShots(prev => prev.map(s => s.id === synthId ? { ...s, id: realFrame.id } : s));
                setExpandedShots(prev => {
                    if (!prev.has(synthId)) return prev;
                    const next = new Set(prev);
                    next.delete(synthId);
                    next.add(realFrame.id);
                    return next;
                });
            }
            if (frames) updateProject(currentProject.id, { frames });
        } catch (err) {
            debugLog.warn("Studio", "duplicateShot backend persist failed", err);
        }
    }, [shots, currentProject, updateProject]);

    // Update shot prompt — local immediate + debounced backend write
    const updatePrompt = useCallback((index: number, prompt: string) => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            persistPrompt(s.id, prompt);
            return { ...s, prompt };
        }));
    }, [persistPrompt]);

    // Set shot tab mode + persist so the user's last-active tab
    // survives refresh.
    const setTabMode = useCallback((index: number, mode: "t2i_i2v" | "direct_r2v") => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            persistWorkbench(s.id, { workbench_tab_mode: mode });
            return { ...s, tabMode: mode };
        }));
    }, [persistWorkbench]);

    // Structured field updates — local immediate + debounce 3s auto-save
    const fieldPendingRef = useRef<Map<string, { timer: number; fields: Record<string, any> }>>(new Map());
    const handleUpdateField = useCallback((index: number, field: string, value: string | number | null) => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            if (field === "duration") return { ...s, duration: typeof value === "number" ? value : null };
            if (field === "shotSize") return { ...s, shotSize: typeof value === "string" ? value : null };
            if (field === "cameraAngle") return { ...s, cameraAngle: typeof value === "string" ? value : null };
            if (field === "cameraMovement") {
                const desc = typeof value === "string" ? value : "固定镜头";
                return {
                    ...s,
                    cameraMovementStructured: {
                        primary: desc,
                        speed: s.cameraMovementStructured?.speed ?? "normal",
                        description: desc,
                        secondary: s.cameraMovementStructured?.secondary ?? null,
                    },
                };
            }
            if (field === "transitionHint") return { ...s, transitionHint: typeof value === "string" ? value : null };
            return s;
        }));
        // Debounce 3s persist to backend
        const shotId = shots[index]?.id;
        if (!shotId || shotId.startsWith("shot_") || !currentProject?.id) return;
        const projectId = currentProject.id;
        const map = fieldPendingRef.current;
        const existing = map.get(shotId);
        if (existing) window.clearTimeout(existing.timer);
        const backendField: Record<string, any> = {};
        if (field === "duration") backendField.duration = typeof value === "number" ? value : undefined;
        if (field === "shotSize") backendField.shot_size = typeof value === "string" ? value : undefined;
        if (field === "cameraAngle") backendField.camera_angle = typeof value === "string" ? value : undefined;
        if (field === "cameraMovement") backendField.camera_movement_description = typeof value === "string" ? value : undefined;
        if (field === "transitionHint") backendField.transition_hint = typeof value === "string" ? value : undefined;
        const merged = { ...(existing?.fields ?? {}), ...backendField };
        const timer = window.setTimeout(() => {
            map.delete(shotId);
            api.updateFrame(projectId, shotId, merged)
                .then(() => {
                    const proj = useProjectStore.getState().currentProject;
                    if (!proj || proj.id !== projectId) return;
                    const nextFrames = (proj.frames ?? []).map((f: any) =>
                        f.id === shotId ? { ...f, ...merged } : f,
                    );
                    updateProject(projectId, { frames: nextFrames });
                })
                .catch((err) => debugLog.warn("Studio", "persistField failed", err));
        }, 3000);
        map.set(shotId, { timer, fields: merged });
    }, [shots, currentProject?.id, updateProject]);

    // Duration editor config — derived from active R2V model's catalog entry
    const durationEditorCfg = useMemo(() => {
        const r2vModel = findR2vModel(videoConfig.r2vModel);
        const dc = r2vModel?.duration;
        if (!dc) return { min: 3, max: 15, step: 1 };
        if (dc.type === "slider") return { min: dc.min, max: dc.max, step: dc.step };
        if (dc.type === "buttons") return { min: Math.min(...dc.options), max: Math.max(...dc.options), step: 1 };
        return { min: dc.value, max: dc.value, step: 1 };
    }, [findR2vModel, videoConfig.r2vModel]);

    // Cached Series asset data (loaded on demand) - fallback when Episode assets lack variants
    const [seriesAssets, setSeriesAssets] = useState<{ characters: any[]; scenes: any[]; props: any[] } | null>(null);
    useEffect(() => {
        const sid = currentProject?.series_id;
        if (sid) {
            import("@/lib/api").then(({ api }) => {
                api.getSeries(sid).then((s: any) => {
                    setSeriesAssets({ characters: s.characters || [], scenes: s.scenes || [], props: s.props || [] });
                }).catch(() => {});
            });
        }
    }, [currentProject?.series_id]);

    // Parse asset tags from prompt and resolve to URLs
    const parseAssetTags = useCallback((prompt: string, shot?: ShotNode): string[] => {
        // HappyHorse uses [characterN:name] as generic reference-image slots.
        // N determines the position in the URL array: character1 → image[0], etc.
        // The "name" can be a character, scene, or prop — we look up all three.
        const slots: { idx: number; url: string }[] = [];
        const tagPattern = /\[character(\d+):([^\]]+)\]/g;
        let match;
        while ((match = tagPattern.exec(prompt)) !== null) {
            const slotNum = parseInt(match[1], 10);
            const name = match[2];
            let url: string | undefined;

            // Try character first (Episode-level, then Series-level fallback)
            const char = characters.find((c: any) => c.name === name)
                || seriesAssets?.characters?.find((c: any) => c.name === name);
            if (char) {
                url = resolveAssetReferenceImage(
                    char,
                    "character",
                    shot?.characterStageRefs?.[char.id],
                );
            }
            // Try scene (Episode-level, then Series-level fallback)
            if (!url) {
                const scene = scenes.find((s: any) => s.name === name)
                    || seriesAssets?.scenes?.find((s: any) => s.name === name);
                url = resolveAssetReferenceImage(scene, "scene", shot?.sceneStageRef);
            }
            // Try prop (Episode-level, then Series-level fallback)
            if (!url) {
                const prop = props.find((p: any) => p.name === name)
                    || seriesAssets?.props?.find((p: any) => p.name === name);
                url = resolveAssetReferenceImage(prop, "prop");
            }

            if (url) slots.push({ idx: slotNum, url });
        }
        // Sort by slot number so URL array matches HappyHorse's positional mapping
        slots.sort((a, b) => a.idx - b.idx);
        return slots.map(s => s.url);
    }, [characters, scenes, props, seriesAssets]);

    const hasAssetTags = useCallback((prompt: string): boolean => {
        return /\[character\d+:[^\]]+\]/.test(prompt);
    }, []);

    const getUnresolvedAssetNames = useCallback((prompt: string): string[] => {
        const unresolved: string[] = [];
        const tagPattern = /\[character\d+:([^\]]+)\]/g;
        let match;
        while ((match = tagPattern.exec(prompt)) !== null) {
            const name = match[1];
            let hasImage = false;
            // Check character
            const char = characters.find((c: any) => c.name === name);
            if (char) {
                hasImage = !!(char.full_body_asset?.variants?.length);
            }
            // Check scene
            if (!hasImage) {
                const scene = scenes.find((s: any) => s.name === name);
                hasImage = !!(scene?.image_asset?.variants?.length);
            }
            // Check prop
            if (!hasImage) {
                const prop = props.find((p: any) => p.name === name);
                hasImage = !!(prop?.image_asset?.variants?.length);
            }
            if (!hasImage) unresolved.push(name);
        }
        return unresolved;
    }, [characters, scenes, props, seriesAssets]);

    // Strip tags from prompt for clean text
    const cleanPrompt = (prompt: string): string => {
        return prompt.replace(/\[character\d+:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
    };

    // Generate T2I image for a shot (t2i_i2v mode stage 1)
    const generateT2I = useCallback(async (index: number) => {
        const shot = shots[index];
        if (!currentProject || !shot.prompt.trim()) return;
        const taggedPrompt = buildPromptWithReferenceTags(shot, characters, scenes, props);

        setShots(prev => prev.map((s, i) =>
            i === index ? { ...s, t2iStatus: "pending" } : s
        ));

        // Build reference_image_urls from R2V asset tags
        const refUrls = parseAssetTags(taggedPrompt, shot);
        const compositionData: any = {};
        if (refUrls.length > 0) {
            compositionData.reference_image_urls = refUrls;
        }

        try {
            const result = await api.renderFrame(
                currentProject.id,
                shot.id,
                compositionData,
                cleanPrompt(taggedPrompt),
                1    // batchSize
            );

            const returnedFrame = Array.isArray(result?.frames)
                ? result.frames.find((frame: any) => frame.id === shot.id)
                : null;
            if (returnedFrame) {
                updateProject(currentProject.id, result);
            }
            const imageUrl = returnedFrame?.rendered_image_url
                || returnedFrame?.image_url
                || result?.image_url
                || result?.rendered_image_url;

            if (result?.task_id && !imageUrl) {
                setShots(prev => prev.map((s, i) =>
                    i === index ? { ...s, t2iTaskId: result.task_id, t2iStatus: "processing" } : s
                ));
                return;
            }

            if (imageUrl) {
                // Immediate result (synchronous render). Append to T2I
                // history + auto-select so the new image becomes the
                // active首帧 used by downstream I2V generation.
                setShots(prev => prev.map((s, i) => {
                    if (i !== index) return s;
                    const updated = appendT2IImage({
                        ...s,
                        imageUrl: returnedFrame?.rendered_image_url || returnedFrame?.image_url || s.imageUrl,
                        t2iTaskId: undefined,
                        t2iStatus: "completed",
                    }, imageUrl);
                    persistWorkbench(s.id, {
                        t2i_image_urls: updated.t2iImageUrls ?? [],
                        t2i_selected_index: updated.t2iSelectedIndex ?? 0,
                    });
                    return updated;
                }));
            } else {
                throw new Error("Render returned an empty response");
            }
        } catch (error) {
            debugLog.error("Studio", "Failed to generate T2I for shot:", error);
            setShots(prev => prev.map((s, i) =>
                i === index ? { ...s, t2iStatus: "failed" } : s
            ));
        }
    }, [shots, currentProject, characters, scenes, props, updateProject, persistWorkbench, parseAssetTags]);

    // Generate video for a shot
    const generateVideo = useCallback(async (index: number) => {
        const shot = shots[index];
        if (!currentProject || !shot.prompt.trim()) return;

        const taggedPrompt = buildPromptWithReferenceTags(shot, characters, scenes, props);
        const promptText = shot.tabMode === "direct_r2v" ? taggedPrompt : buildAssembledPrompt(shot);

        setShots(prev => prev.map((s, i) =>
            i === index ? { ...s, videoStatus: "pending" } : s
        ));

        try {
            if (shot.tabMode === "direct_r2v") {
                // R2V mode: use reference assets. We prefer the user's
                // explicit R2V model choice (videoConfig.r2vModel) over
                // the derived route from the I2V model. The derivation
                // is kept as a fallback when the explicit r2vModel is
                // missing or invalid (which can only happen if the
                // catalog flipped under our feet).
                let referenceUrls = parseAssetTags(taggedPrompt, shot);
                const explicitR2v = videoConfig.r2vModel;
                const explicitOk = !!findR2vModel(explicitR2v) || isExternalVideoModel(explicitR2v);
                const routeModelId = explicitOk
                    ? explicitR2v
                    : getR2vRouteModelId(videoConfig.model);
                const imageBased = isExternalVideoModel(routeModelId) || isR2vImageBased(routeModelId);
                if (referenceUrls.length === 0 && imageBased) {
                    const storyboardImage = getActiveT2IImageUrl(shot) || shot.imageUrl;
                    if (storyboardImage) referenceUrls = [storyboardImage];
                }

                const tasks = await api.createVideoTask(
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
                const task = Array.isArray(tasks) ? tasks[0] : tasks;

                if (task && task.id) {
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoTaskId: task.id, videoStatus: "processing" } : s
                    ));
                }
            } else {
                // I2V mode: use T2I image as first frame.
                // Bug A guard: even if videoConfig.model passed the
                // mount-time check, the catalog can change at runtime
                // (catalog reload, project setting flip). Last sanity
                // check right before submit so we never ship an r2v-
                // only model into the I2V flow.
                const i2vModelOk = VIDEO_I2V_MODELS.some(m => m.id === videoConfig.model);
                if (!i2vModelOk) {
                    debugLog.warn(
                        "Studio",
                        `Refusing to submit I2V task with model "${videoConfig.model}" ` +
                        `which is not in the visible I2V list. Falling back to "${DEFAULT_I2V_MODEL_ID}".`,
                    );
                    setVideoConfig(c => ({ ...c, model: DEFAULT_I2V_MODEL_ID }));
                    if (typeof window !== 'undefined') {
                        localStorage.removeItem('storyboard-r2v-model');
                    }
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoStatus: "failed" as const } : s,
                    ));
                    return;
                }
                // Use the multi-frame-aware accessor so this legacy path
                // stays in sync with the new ParamsSection batch path
                // (Issue 15). `shot.t2iImageUrl` (legacy singular) and
                // `shot.t2iImageUrls[selectedIndex]` should normally agree,
                // but the singular field has occasionally lagged behind the
                // plural one (e.g. async upload state mid-flight), causing
                // HappyHorse to silently submit with no media.
                const imageUrl = getActiveT2IImageUrl(shot) || shot.imageUrl || "";
                if (!imageUrl) {
                    // I2V without a first frame is guaranteed to fail with
                    // "input.media required" on HappyHorse — surface inline
                    // instead of letting it 502 mid-generation.
                    setShotErrors(prev => ({
                        ...prev,
                        [shot.id]: t("i2vNeedsFirstFrame") || "请先上传或生成首帧再生成视频。",
                    }));
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoStatus: undefined } : s,
                    ));
                    return;
                }

                const tasks = await api.createVideoTask(
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
                const task = Array.isArray(tasks) ? tasks[0] : tasks;

                if (task && task.id) {
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoTaskId: task.id, videoStatus: "processing" } : s
                    ));
                }
            }
        } catch (error: any) {
            debugLog.error("Studio", "Failed to generate video for shot:", error);
            const detail = error?.response?.data?.detail || error?.message || "未知错误";
            toast.error(`视频生成失败：${String(detail).slice(0, 150)}`);
            setShots(prev => prev.map((s, i) =>
                i === index ? { ...s, videoStatus: "failed" } : s
            ));
        }
    }, [shots, currentProject, characters, scenes, props, videoConfig, parseAssetTags]);

    // Batch-aware generation. The user's "抽卡" mental model: one
    // click of Generate ×N fires N independent createVideoTask calls
    // in parallel (each becomes its own VideoTask record on the
    // backend). All N task ids get appended to the shot's per-tab
    // bucket so the CandidatesSection can render them as one batch.
    // Refactored from the single-task generateVideo to support both
    // R2V and I2V paths; falls back to N=1 if count is undefined.
    const generateVideoBatch = useCallback(async (
        index: number,
        count: number,
        params?: Partial<ParamsState>,
    ) => {
        const shot = shots[index];
        if (!currentProject || !shot?.prompt.trim()) return;
        const taggedPrompt = buildPromptWithReferenceTags(shot, characters, scenes, props);
        const tabMode = shot.tabMode;
        const promptText = tabMode === "direct_r2v" ? taggedPrompt : buildAssembledPrompt(shot);
        const effectiveCount = Math.max(1, Math.min(6, count || 1));

        // Pre-flight: R2V tab needs reference inputs. Without them
        // the backend rejects with 400 anyway, but historically the
        // task would queue, fail mid-generation, and the user'd see
        // "排队中..." until the failure surfaced. Cheaper to validate
        // here and show inline error in the ParamsSection.
        if (tabMode === "direct_r2v") {
            let refs = parseAssetTags(taggedPrompt, shot);
            const r2vModelId = params?.model ?? videoConfig.r2vModel;
            const r2vModel = findR2vModel(r2vModelId);
            const routeModelId = r2vModel ? r2vModelId : getR2vRouteModelId(videoConfig.model);
            const imageBased = isExternalVideoModel(routeModelId) || isR2vImageBased(routeModelId);
            if (refs.length === 0 && imageBased) {
                const storyboardImage = getActiveT2IImageUrl(shot) || shot.imageUrl;
                if (storyboardImage) refs = [storyboardImage];
            }
            if (refs.length === 0) {
                const hasTags = hasAssetTags(taggedPrompt);
                let errMsg: string;
                if (hasTags) {
                    const unresolved = getUnresolvedAssetNames(taggedPrompt);
                    errMsg = `引用的「${unresolved.join("、")}」尚未生成图片，请先到素材步骤生成。`;
                } else {
                    const modelLabel = r2vModel?.name ?? r2vModelId;
                    errMsg = `当前分镜只有润色后的文字提示词，没有可用图片。请先生成分镜图，或为 ${modelLabel} 添加带参考图的角色/场景/道具。`;
                }
                setShotErrors(prev => ({ ...prev, [shot.id]: errMsg }));
                toast.warning(errMsg);
                return;
            }
        } else {
            const probeImage = getActiveT2IImageUrl(shot) || shot.imageUrl || "";
            if (!probeImage) {
                const errMsg = t("i2vNeedsFirstFrame") || "请先上传或生成首帧再生成视频。";
                setShotErrors(prev => ({ ...prev, [shot.id]: errMsg }));
                toast.warning(errMsg);
                return;
            }
        }

        // Per-shot submission lockout (Issue 17). The earlier in-flight guard
        // (`shot.videoStatus === "pending"|"processing"`) had a false positive
        // problem: when a shot has multiple tasks (batch ×4), one fails + others
        // still processing, retrying the failed one was BLOCKED by the others'
        // status. Replace with a 500ms debounce on the SHOT specifically — that
        // catches double-clicks / strict-mode double-fires without entangling
        // status semantics.
        if (submittingShotsRef.current.has(shot.id)) {
            debugLog.warn("Studio", "generateVideoBatch: refused — same shot submitted < 500ms ago");
            return;
        }
        submittingShotsRef.current.add(shot.id);
        window.setTimeout(() => submittingShotsRef.current.delete(shot.id), 500);
        // Clear any prior error once this attempt is valid; success
        // path or backend-side rejection will overwrite if needed.
        setShotErrors(prev => {
            if (!prev[shot.id]) return prev;
            const next = { ...prev };
            delete next[shot.id];
            return next;
        });

        setShots(prev => prev.map((s, i) =>
            i === index ? { ...s, videoStatus: "pending" } : s
        ));

        try {
            // Build a per-call factory so the batch fires N parallel
            // requests through Promise.all — fail-fast on any one
            // failure leaves the others untouched on the backend (the
            // BG-task wrapper handles their lifecycle independently).
            const createOne = async (): Promise<string | null> => {
                if (tabMode === "direct_r2v") {
                    let referenceUrls = parseAssetTags(taggedPrompt, shot);
                    const explicitR2v = params?.model ?? videoConfig.r2vModel;
                    const explicitOk = !!findR2vModel(explicitR2v) || isExternalVideoModel(explicitR2v);
                    const routeModelId = explicitOk
                        ? explicitR2v
                        : getR2vRouteModelId(videoConfig.model);
                    const imageBased = isExternalVideoModel(routeModelId) || isR2vImageBased(routeModelId);
                    if (referenceUrls.length === 0 && imageBased) {
                        const storyboardImage = getActiveT2IImageUrl(shot) || shot.imageUrl;
                        if (storyboardImage) referenceUrls = [storyboardImage];
                    }
                    const tasks = await api.createVideoTask(
                        currentProject.id,
                        "",
                        promptText,
                        params?.duration ?? videoConfig.duration,
                        params?.seed,
                        params?.resolution ?? videoConfig.resolution,
                        false,
                        "",
                        params?.promptExtend ?? videoConfig.promptExtend,
                        params?.negativePrompt ?? videoConfig.negativePrompt,
                        1,
                        routeModelId,
                        shot.id,
                        params?.shotType ?? "multi",
                        "r2v",
                        !imageBased ? referenceUrls : undefined,
                        undefined, undefined, undefined,
                        undefined, undefined,
                        imageBased ? referenceUrls : undefined,
                        params?.ratio,
                        tabMode,
                        params?.watermark,
                    );
                    const task = Array.isArray(tasks) ? tasks[0] : tasks;
                    return task?.id ?? null;
                }
                // I2V branch — same defensive check on the model.
                const i2vModelId = params?.model ?? videoConfig.model;
                const i2vModelOk = VIDEO_I2V_MODELS.some(m => m.id === i2vModelId);
                if (!i2vModelOk) {
                    debugLog.warn("Studio", `Refusing I2V submission with non-I2V model "${i2vModelId}".`);
                    return null;
                }
                const imageUrl = getActiveT2IImageUrl(shot) || shot.imageUrl || "";
                const tasks = await api.createVideoTask(
                    currentProject.id,
                    imageUrl,
                    promptText,
                    params?.duration ?? videoConfig.duration,
                    params?.seed,
                    params?.resolution ?? videoConfig.resolution,
                    false,
                    "",
                    params?.promptExtend ?? videoConfig.promptExtend,
                    params?.negativePrompt ?? videoConfig.negativePrompt,
                    1,
                    i2vModelId,
                    shot.id,
                    params?.shotType ?? "multi",
                    "i2v",
                    undefined,
                    params?.mode ?? videoConfig.mode,
                    params?.sound ?? videoConfig.sound,
                    params?.cfgScale ?? videoConfig.cfgScale,
                    params?.viduAudio ?? videoConfig.viduAudio,
                    params?.movementAmplitude ?? videoConfig.movementAmplitude,
                    undefined,
                    undefined,
                    tabMode,
                    params?.watermark,
                );
                const task = Array.isArray(tasks) ? tasks[0] : tasks;
                return task?.id ?? null;
            };

            const taskIds = (await Promise.all(
                Array.from({ length: effectiveCount }, createOne),
            )).filter((id): id is string => !!id);

            if (taskIds.length > 0) {
                setShotErrors(prev => {
                    if (!prev[shot.id]) return prev;
                    const next = { ...prev };
                    delete next[shot.id];
                    return next;
                });
                setShots(prev => prev.map((s, i) => {
                    if (i !== index) return s;
                    // Mirror the latest task id on the legacy single
                    // field so the ShotCard preview spinner / cancel
                    // CTA keep working. The candidates panel reads
                    // from project.video_tasks (filtered by
                    // frame_id + workbench_tab), so the per-tab id
                    // bucket on the shot is no longer needed.
                    return {
                        ...s,
                        videoTaskId: taskIds[taskIds.length - 1],
                        videoStatus: "processing" as const,
                    };
                }));
            } else {
                toast.error("视频生成失败：任务提交未成功，请检查参数后重试");
                setShots(prev => prev.map((s, i) =>
                    i === index ? { ...s, videoStatus: "failed" as const } : s
                ));
            }
        } catch (error: any) {
            debugLog.error("Studio", "Batch generate failed for shot:", error);
            const status = error?.response?.status;
            const detail = error?.response?.data?.detail || error?.message || "未知错误";
            if (status === 400 && typeof detail === "string") {
                setShotErrors(prev => ({ ...prev, [shot.id]: detail }));
            }
            toast.error(`视频生成失败：${String(detail).slice(0, 150)}`);
            setShots(prev => prev.map((s, i) =>
                i === index ? { ...s, videoStatus: "failed" as const } : s
            ));
        }
    }, [shots, currentProject, characters, scenes, props, videoConfig, parseAssetTags, findR2vModel, isExternalVideoModel]);

    // Project-level task refresh: when any task on any shot is in
    // flight, refetch the whole project every 5s. The candidates
    // panel + queue read from currentProject.video_tasks for canonical
    // state. Cheap because it's just a GET; cancels when nothing is
    // in flight. This is independent of the per-shot poll above (the
    // per-shot poll updates shot.videoStatus / videoUrl which drives
    // the ShotCard preview; the project refresh fills in candidate
    // metadata like is_starred / label / error / final video_url).
    useEffect(() => {
        if (!currentProject?.id) return;
        const allTasks: any[] = (currentProject as any).video_tasks ?? [];
        const anyInFlight = allTasks.some(
            (t) => t.status === "pending" || t.status === "processing",
        );
        // Also poll if any shot's locally-tracked videoTaskId is not
        // yet reflected in the project record (closes the just-created
        // window). With the Phase-2 derive-from-tasks model, we only
        // care about the legacy single-id mirror on the shot.
        const localInFlight = shots.some((s) => {
            const id = s.videoTaskId;
            if (!id) return false;
            const t = allTasks.find((tt) => tt.id === id);
            return !t || t.status === "pending" || t.status === "processing";
        });
        const localT2IInFlight = shots.some((s) =>
            s.t2iStatus === "pending" || s.t2iStatus === "processing"
        );
        if (!anyInFlight && !localInFlight && !localT2IInFlight && !renderingFrames) return;
        const projectId = currentProject.id;
        const id = window.setInterval(async () => {
            try {
                const fresh = await api.getProject(projectId);
                updateProject(projectId, fresh);
                if (Array.isArray(fresh?.frames)) {
                    setShots(fresh.frames.map((frame: any) => frameToShotNode(frame)));
                }
            } catch {
                /* swallow — network blips are fine, next tick retries */
            }
        }, 5000);
        return () => window.clearInterval(id);
    }, [currentProject?.id, (currentProject as any)?.video_tasks, shots, updateProject, frameToShotNode, renderingFrames]);

    // Poll for task completion (both T2I and video)
    useEffect(() => {
        const processingShots = shots.filter(s =>
            (s.videoTaskId && (s.videoStatus === "processing" || s.videoStatus === "pending")) ||
            (s.t2iTaskId && (s.t2iStatus === "processing" || s.t2iStatus === "pending"))
        );
        if (processingShots.length === 0) return;

        const interval = setInterval(async () => {
            for (const shot of processingShots) {
                // Poll video task
                if (shot.videoTaskId && (shot.videoStatus === "processing" || shot.videoStatus === "pending")) {
                    try {
                        const status = await api.getTaskStatus(shot.videoTaskId);
                        if (status.status === "completed" && status.video_url) {
                            setShots(prev => prev.map(s =>
                                s.id === shot.id ? { ...s, videoStatus: "completed", videoUrl: status.video_url } : s
                            ));
                        } else if (status.status === "failed") {
                            setShots(prev => prev.map(s =>
                                s.id === shot.id ? { ...s, videoStatus: "failed" } : s
                            ));
                        }
                    } catch (error) {
                        debugLog.error("Studio", "Video poll failed for shot:", shot.id, error);
                    }
                }
                // Poll T2I task
                if (shot.t2iTaskId && (shot.t2iStatus === "processing" || shot.t2iStatus === "pending")) {
                    try {
                        const status = await api.getTaskStatus(shot.t2iTaskId);
                        if (status.status === "completed") {
                            const imageUrl = status.image_url || status.video_url || status.result_url;
                            if (imageUrl) {
                                setShots(prev => prev.map(s => {
                                    if (s.id !== shot.id) return s;
                                    const updated = appendT2IImage({ ...s, t2iStatus: "completed" }, imageUrl);
                                    persistWorkbench(s.id, {
                                        t2i_image_urls: updated.t2iImageUrls ?? [],
                                        t2i_selected_index: updated.t2iSelectedIndex ?? 0,
                                    });
                                    return updated;
                                }));
                            }
                        } else if (status.status === "failed") {
                            setShots(prev => prev.map(s =>
                                s.id === shot.id ? { ...s, t2iStatus: "failed" } : s
                            ));
                        }
                    } catch (error) {
                        debugLog.error("Studio", "T2I poll failed for shot:", shot.id, error);
                    }
                }
            }
        }, 5000);

        return () => clearInterval(interval);
    }, [shots, persistWorkbench]);

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

    // Toolbar model display: surface the model the project's workflow
    // mode actually uses, not the I2V parent. R2V projects were
    // showing "wan2.7-i2v" while their generation actually went
    // through wan2.6-r2v / wan2.7-r2v — confusing and the source of
    // the "but I selected R2V" support thread.
    const isR2VWorkflow = (currentProject?.workflow_mode ?? "r2v") === "r2v";
    const currentModelName = envModelName
        ? envModelName
        : isR2VWorkflow
        ? (findR2vModel(videoConfig.r2vModel)?.name ?? videoConfig.r2vModel)
        : (VIDEO_I2V_MODELS.find(m => m.id === videoConfig.model)?.name ?? videoConfig.model);

    // ---- Project-level task derivations (drive Queue + Candidates) ----
    // We derive these via useMemo so per-render allocation is cheap and
    // children can rely on referentially-stable arrays (set-membership
    // tests in CompareModal etc. are correctness-sensitive).
    const allVideoTasks: VideoTask[] = useMemo(
        () => ((currentProject as any)?.video_tasks ?? []) as VideoTask[],
        [currentProject],
    );

    const tasksById = useMemo(() => {
        const map = new Map<string, VideoTask>();
        for (const t of allVideoTasks) map.set(t.id, t);
        return map;
    }, [allVideoTasks]);

    // Map shot.id → human label for the queue panel's frame column.
    const shotLabelByFrameId = useMemo(() => {
        const out: Record<string, string> = {};
        shots.forEach((s, i) => { out[s.id] = `Shot ${i + 1}`; });
        return out;
    }, [shots]);

    // In-flight aggregate count drives the TaskQueueButton badge.
    const inFlightTaskCount = useMemo(
        () => allVideoTasks.filter(t => t.status === "pending" || t.status === "processing").length,
        [allVideoTasks],
    );

    // Sync shot.videoStatus from project.video_tasks when the
    // project-level poll refreshes. Video task status is only visible
    // via project refresh (GET /tasks/ only covers asset tasks).
    useEffect(() => {
        if (!allVideoTasks.length) return;
        setShots(prev => {
            let changed = false;
            const next = prev.map(s => {
                if (!s.videoTaskId) return s;
                const task = allVideoTasks.find(t => t.id === s.videoTaskId);
                if (!task) return s;
                if (task.status === "completed" && s.videoStatus !== "completed") {
                    changed = true;
                    return { ...s, videoStatus: "completed" as const, videoUrl: (task as any).video_url };
                }
                if (task.status === "failed" && s.videoStatus !== "failed") {
                    changed = true;
                    return { ...s, videoStatus: "failed" as const };
                }
                return s;
            });
            return changed ? next : prev;
        });
    }, [allVideoTasks]);

    // Compare modal needs the actual VideoTask objects for the
    // currently-selected ids (in whatever order they were selected).
    const compareTasks = useMemo(() => {
        const out: VideoTask[] = [];
        Array.from(compareSelectedIds).forEach((id) => {
            const t = tasksById.get(id);
            if (t) out.push(t);
        });
        return out;
    }, [compareSelectedIds, tasksById]);

    // Per-shot candidate tasks — derived directly from the project-
    // level video_tasks. After Phase 2 persistence, each VideoTask
    // carries `frame_id` + `workbench_tab` so we can bucket without a
    // shot-side index. Pre-Phase-2 tasks lack `workbench_tab`; they
    // fall back to `generation_mode` so legacy records still group
    // correctly into the right tab.
    const tasksForShot = useCallback((shot: ShotNode): VideoTask[] => {
        return allVideoTasks.filter((t) => {
            if (t.frame_id !== shot.id) return false;
            if (t.workbench_tab != null) {
                return t.workbench_tab === shot.tabMode;
            }
            // Legacy fallback: i2v tasks belong in t2i_i2v, r2v in direct_r2v.
            if (shot.tabMode === "direct_r2v") return t.generation_mode === "r2v";
            return t.generation_mode !== "r2v"; // i2v + undefined → i2v tab
        });
    }, [allVideoTasks]);

    // Build a ParamsState from videoConfig + per-shot overrides.
    // Single source of truth strategy:
    //  - Per-shot overrides (shotCounts, shotSeeds) for params whose
    //    "right value" naturally differs by shot.
    //  - videoConfig for shared knobs the user typically picks once
    //    and uses across all shots in a project.
    const paramsStateForShot = useCallback((shot: ShotNode): ParamsState => {
        const isR2v = shot.tabMode === "direct_r2v";
        const modelId = isR2v ? videoConfig.r2vModel : videoConfig.model;
        return {
            model: modelId,
            duration: shot.duration ?? videoConfig.duration,
            count: shotCounts[shot.id] ?? 1,
            // Per-shot seed override (Sweep G fix); undefined means
            // "random per generation".
            seed: shotSeeds[shot.id],
            resolution: videoConfig.resolution,
            ratio: undefined,
            negativePrompt: videoConfig.negativePrompt,
            promptExtend: videoConfig.promptExtend,
            cfgScale: videoConfig.cfgScale,
            mode: videoConfig.mode,
            movementAmplitude: videoConfig.movementAmplitude,
            sound: videoConfig.sound,
            viduAudio: videoConfig.viduAudio,
            watermark: videoConfig.watermark,
        };
    }, [videoConfig, shotCounts, shotSeeds]);

    // ParamsSection.onChange handler: per-shot overrides (count, seed)
    // go into their dedicated maps; everything else writes back to
    // the shared videoConfig (so the user's most-recent picks become
    // the new default for siblings). videoConfig is mirrored to
    // localStorage as a recovery cache only — the authoritative model
    // selection lives in project.model_settings, written via the
    // 生成设置 modal.
    const handleShotParamsChange = useCallback((shot: ShotNode, next: ParamsState) => {
        if ((shotCounts[shot.id] ?? 1) !== next.count) {
            persistWorkbench(shot.id, { workbench_generate_count: next.count });
        }
        setShotCounts(prev => ({ ...prev, [shot.id]: next.count }));
        // Sync duration back to structured field (single source of truth)
        if (next.duration !== (shot.duration ?? videoConfig.duration)) {
            const idx = shots.findIndex(s => s.id === shot.id);
            if (idx >= 0) handleUpdateField(idx, "duration", next.duration);
        }
        // Seed: track per-shot. Undefined ↔ "random" — stored as
        // delete-from-map so the entry doesn't accrete forever.
        setShotSeeds(prev => {
            const wasSet = prev[shot.id] !== undefined;
            const isSet = next.seed !== undefined && !Number.isNaN(next.seed);
            if (!wasSet && !isSet) return prev;
            if (wasSet && !isSet) {
                const out = { ...prev };
                delete out[shot.id];
                return out;
            }
            if (prev[shot.id] === next.seed) return prev;
            return { ...prev, [shot.id]: next.seed };
        });
        const isR2v = shot.tabMode === "direct_r2v";
        const ls = typeof window !== "undefined" ? window.localStorage : null;
        setVideoConfig(prev => {
            const updated: VideoConfig = {
                ...prev,
                duration: next.duration,
                resolution: next.resolution ?? prev.resolution,
                negativePrompt: next.negativePrompt ?? prev.negativePrompt,
                promptExtend: next.promptExtend ?? prev.promptExtend,
                cfgScale: next.cfgScale ?? prev.cfgScale,
                mode: next.mode ?? prev.mode,
                movementAmplitude: next.movementAmplitude ?? prev.movementAmplitude,
                sound: next.sound ?? prev.sound,
                viduAudio: next.viduAudio ?? prev.viduAudio,
                // Watermark — preserve undefined (means "model doesn't expose
                // it") so swapping to a non-watermark-supporting model clears it.
                watermark: next.watermark,
            };
            if (isR2v) {
                updated.r2vModel = next.model;
                ls?.setItem("storyboard-r2v-r2v-model", next.model);
            } else {
                updated.model = next.model;
                ls?.setItem("storyboard-r2v-model", next.model);
            }
            return updated;
        });
    }, [persistWorkbench, shotCounts]);

    // Annotate handlers wire CandidateThumb's star/label CTAs to the
    // backend PATCH endpoint. We refresh the project after each call
    // so the candidate cell re-renders with the new flag without
    // waiting for the 5s polling tick.
    const refreshProject = useCallback(async () => {
        if (!currentProject?.id) return;
        try {
            const fresh = await api.getProject(currentProject.id);
            updateProject(currentProject.id, fresh);
        } catch { /* swallow */ }
    }, [currentProject?.id, updateProject]);

    const handleToggleStar = useCallback(async (task: VideoTask, next: boolean) => {
        if (!currentProject?.id) return;
        try {
            await api.annotateVideoTask(currentProject.id, task.id, { is_starred: next });
            await refreshProject();
        } catch (err) {
            debugLog.error("Studio", "Failed to toggle star:", err);
        }
    }, [currentProject?.id, refreshProject]);

    const handleSetLabel = useCallback(async (task: VideoTask, next: string | null) => {
        if (!currentProject?.id) return;
        try {
            if (next === null || next === "") {
                await api.annotateVideoTask(currentProject.id, task.id, { clear_label: true });
            } else {
                await api.annotateVideoTask(currentProject.id, task.id, { label: next });
            }
            await refreshProject();
        } catch (err) {
            debugLog.error("Studio", "Failed to set label:", err);
        }
    }, [currentProject?.id, refreshProject]);

    const handleCancelTask = useCallback(async (task: VideoTask) => {
        if (!currentProject?.id) return;
        try {
            await api.cancelVideoTask(currentProject.id, task.id);
            await refreshProject();
        } catch (err) {
            debugLog.error("Studio", "Failed to cancel task:", err);
        }
    }, [currentProject?.id, refreshProject]);

    // Retry = fire a fresh batch of 1 for the shot owning this task,
    // reusing the task's params as best-effort. After Phase 2 the
    // task→shot mapping is direct via task.frame_id; falls back to
    // current ParamsSection state if we can't find the owner.
    const handleRetryTask = useCallback(async (task: VideoTask) => {
        const ownerIdx = task.frame_id
            ? shots.findIndex((s) => s.id === task.frame_id)
            : -1;
        if (ownerIdx < 0) return;
        await generateVideoBatch(ownerIdx, 1);
    }, [shots, generateVideoBatch]);

    // Click on a candidate thumb: plain click = preview (open new
    // window for v1), shift-click = toggle compare-selection.
    const handleCandidateClick = useCallback((task: VideoTask, mods: { shift: boolean; meta: boolean }) => {
        if (mods.shift) {
            setCompareSelectedIds(prev => {
                const next = new Set(prev);
                if (next.has(task.id)) next.delete(task.id);
                else next.add(task.id);
                return next;
            });
            return;
        }
        const frame = currentProject?.frames?.find((f: any) => f.dubbed_video_task_id === task.id);
        const url = frame?.dubbed_video_url || task.video_url;
        if (url) {
            window.open(getAssetUrl(url), "_blank", "noopener");
        }
    }, [currentProject]);

    // 复用此批参数: copy a batch's model + neg_prompt into videoConfig,
    // so the next Generate uses the same recipe. We don't change count
    // here — count remains the per-shot knob the user chose.
    const handleReuseBatchParams = useCallback((batch: BatchSummary) => {
        const first = batch.tasks[0];
        if (!first) return;
        setVideoConfig(prev => {
            const updated = { ...prev };
            // Decide which slot the batch's model lives in (I2V or R2V).
            if (findR2vModel(first.model) || isExternalVideoModel(first.model)) {
                updated.r2vModel = first.model!;
            } else if (VIDEO_I2V_MODELS.some(m => m.id === first.model)) {
                updated.model = first.model!;
            }
            if (first.duration) updated.duration = first.duration;
            if (first.resolution) updated.resolution = first.resolution;
            if (first.negative_prompt !== undefined) updated.negativePrompt = first.negative_prompt;
            return updated;
        });
    }, [findR2vModel, isExternalVideoModel]);

    // Queue's jump-to-shot: scroll the shot's wrapper into view AND
    // expand the shot panel + its sections (otherwise jumping to a
    // collapsed shot lands the user on a 1-line strip and they have
    // to expand manually).
    const handleJumpToShot = useCallback((frameId: string) => {
        setExpandedShots(prev => {
            if (prev.has(frameId)) return prev;
            const next = new Set(prev);
            next.add(frameId);
            return next;
        });
        // Force inner sections open too — feels right when arriving from
        // a queue task: you want to see Params + Candidates for that shot.
        overridePanelSectionState([frameId], ["params", "candidates"], true);
        // Scroll after the next paint so the newly-expanded body is
        // measured correctly. RAF is sufficient — we don't need the
        // full layout effect cycle.
        requestAnimationFrame(() => {
            const el = shotWrapperRefs.current.get(frameId);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    }, []);

    // Active candidate URL resolver — many backend video URLs are
    // relative paths needing the asset prefix to render in <video>.
    const resolveAssetUrl = useCallback((u: string) => getAssetUrl(u), []);

    // In-flight shot count for trailing slot stat
    const totalInFlight = useMemo(
        () => Object.values(shotCounts).reduce((acc: number, c: any) => acc + (c?.processing ?? 0) + (c?.pending ?? 0), 0),
        [shotCounts],
    );

    return (
        // Layout v4: outer horizontal split. StepHeader belongs to main
        // column (not page-wide), so the right TaskQueuePanel can be a
        // true floor-to-ceiling sidebar with its own SidePanelHeader.
        <div className="h-full flex overflow-hidden relative">
        {/* Main column — pushed (compressed) when the queue panel opens
            so the queue doesn't overlay content. */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <StepHeader
                stepNumber={3}
                icon={<Film />}
                englishName="Storyboard"
                title={tStep("storyboardTitle")}
                subtitle={tStep("storyboardSubtitle")}
                trailing={(
                    <>
                        {/* 画风 (Art Direction) pill — 上移到顶菜单 */}
                        {currentProject?.art_direction?.style_config?.name ? (
                            <button
                                type="button"
                                onClick={() => {
                                    document.dispatchEvent(
                                        new CustomEvent("lumenx:navigateStep", { detail: "art_direction" }),
                                    );
                                }}
                                title={t("artStyleHint")}
                                className="btn-tip hidden md:inline-flex items-center gap-1.5 rounded-md border border-glass-border bg-black/20 px-2.5 py-1.5 font-mono text-[10.5px] font-medium text-text-secondary transition-colors duration-fast ease-out-quart hover:border-accent/50 hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
                            >
                                <Palette size={11} aria-hidden="true" />
                                <span className="text-foreground/95">{currentProject.art_direction.style_config.name}</span>
                            </button>
                        ) : null}
                        {/* Current model name —— 简化的 mono chrome label */}
                        <span className="hidden lg:inline font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
                            <span>{t("currentModel")}:</span>
                            <span className="ml-1 text-foreground/95">{currentModelName}</span>
                        </span>
                        {/* Open task queue */}
                        <TaskQueueButton
                            inFlightCount={inFlightTaskCount}
                            open={queueOpen}
                            onToggle={() => setQueueOpen(v => !v)}
                        />
                    </>
                )}
            />
            {/* Top Toolbar — 简化版：只保留 shot 计数 / + shot / 全展开-全折叠
                model name + queue button + 画风 已上移到 StepHeader trailing. */}
            <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.015] shrink-0 sm:px-6">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-text-muted">
                    <span className="text-foreground font-medium">{shots.length}</span>
                    <span className="ml-1.5">{shots.length === 1 ? "shot" : "shots"}</span>
                    {totalInFlight > 0 ? <span className="ml-2 text-primary">· {totalInFlight} in flight</span> : null}
                </span>
                <motion.button
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => addShot(shots.length - 1)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                >
                    <Plus size={13} strokeWidth={2} />
                    {t("addShot")}
                </motion.button>
                <button
                    type="button"
                    onClick={() => setGenDialogOpen(true)}
                    disabled={generating || refining || renderingFrames}
                    className="inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors disabled:opacity-40"
                >
                    {generating
                        ? <Loader2 size={11} className="animate-spin" />
                        : shots.length > 0
                            ? <RefreshCw size={11} />
                            : <Sparkles size={11} />
                    }
                    {generating ? t("genInFlight") : shots.length > 0 ? "重新生成" : "✨ 智能分镜"}
                </button>
                {shots.length > 0 ? (
                    <button
                        type="button"
                        onClick={handleBatchAutoLink}
                        disabled={generating || isLinking}
                        className="inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] font-medium text-emerald-200 border border-emerald-300/30 bg-emerald-300/5 hover:bg-emerald-300/10 transition-colors disabled:opacity-40"
                    >
                        {isLinking ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                        自动引用资源
                    </button>
                ) : null}
                {shots.length > 0 ? (
                    <button
                        type="button"
                        onClick={handleBatchRenderFrames}
                        disabled={generating || refining || renderingFrames || renderStats.remaining === 0}
                        className="inline-flex h-7 items-center gap-1.5 rounded px-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] font-medium text-emerald-200 border border-emerald-300/30 bg-emerald-300/5 hover:bg-emerald-300/10 transition-colors disabled:opacity-40"
                    >
                        {renderingFrames ? <Loader2 size={11} className="animate-spin" /> : <Film size={11} />}
                        {renderingFrames
                            ? `分镜图生成中${renderProgress ? ` · ${renderProgress.current}/${renderProgress.total}` : ""}`
                            : renderStats.remaining === 0
                                ? "分镜图已生成"
                                : renderStats.rendered > 0
                                    ? `继续生成分镜图 · ${renderStats.remaining}`
                                    : "批量生成分镜图"
                        }
                    </button>
                ) : null}
                {shots.length > 1 ? (
                    <div className="ml-auto flex items-center gap-1">
                        <button
                            type="button"
                            onClick={expandAllShots}
                            title={t("expandAll")}
                            className="-m-1 inline-flex h-7 items-center gap-1 rounded px-1.5 font-mono text-chrome-sm font-medium text-text-muted transition-colors duration-fast ease-out-quart hover:bg-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
                        >
                            ▾▾ {t("expandAll")}
                        </button>
                        <button
                            type="button"
                            onClick={collapseAllShots}
                            title={t("collapseAll")}
                            className="-m-1 inline-flex h-7 items-center gap-1 rounded px-1.5 font-mono text-chrome-sm font-medium text-text-muted transition-colors duration-fast ease-out-quart hover:bg-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
                        >
                            ▴▴ {t("collapseAll")}
                        </button>
                    </div>
                ) : null}
            </div>

            <GenerationBanner
                state={bannerState}
                phase1Captions={PHASE1_CAPTIONS}
                refineProgress={refineProgress}
                dialogueProgress={dialogueProgress}
                summary={bannerSummary}
                onGenerateDialogue={handleBatchDialogue}
            />

            <PreviousEpisodeFramesRail
                scriptId={currentProject?.id ?? null}
                seriesId={currentProject?.series_id ?? null}
            />
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 sm:px-6">
                {shots.length === 0 && (
                    <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center px-6">
                        <div className="rounded-2xl border border-glass-border bg-glass p-8 max-w-lg">
                            <div className="mx-auto w-12 h-12 grid place-items-center rounded-full bg-primary/10 border border-primary/30 mb-4">
                                <Wand2 size={20} className="text-primary" />
                            </div>
                            <h3 className="text-display font-medium text-foreground">{t("emptyTitle")}</h3>
                            <p className="text-body-sm text-text-secondary mt-1.5 max-w-md mx-auto leading-relaxed">
                                {t("emptyBody")}
                            </p>
                            <div className="mt-5 flex items-center justify-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setGenDialogOpen(true)}
                                    disabled={generating || refining}
                                    className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-md bg-primary text-white border border-[rgba(100,108,255,0.65)] shadow-[inset_0_1.5px_0_rgba(255,255,255,0.14)] hover:bg-[#7a82ff] disabled:opacity-40 transition-colors text-[13px] font-semibold"
                                >
                                    {generating ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                                    {generating ? t("genInFlight") : t("emptyCTA")}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => addShot(-1)}
                                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md bg-glass border border-glass-border text-text-secondary hover:text-foreground hover:bg-hover-bg transition-colors text-[12px]"
                                >
                                    <Plus size={12} />
                                    {t("emptyManualAdd")}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {shots.map((shot, index) => {
                    const shotTasks = tasksForShot(shot);
                    const shotInFlight = shotTasks.filter(
                        (t) => t.status === "pending" || t.status === "processing",
                    ).length;
                    const paramsState = paramsStateForShot(shot);
                    const isI2vTab = shot.tabMode === "t2i_i2v";
                    const modelList = shot.tabMode === "direct_r2v" ? r2vModelList : i2vModelList;
                    return (
                    /* Plain div (was motion.div) — staggered enter
                       animation re-fired every time the user switched
                       step tabs and came back, causing a noticeable
                       全 list opacity flicker. ShotCard hover micro-
                       motion is kept inside the card itself. */
                    <div
                        key={shot.id}
                        ref={(el) => { shotWrapperRefs.current.set(shot.id, el); }}
                    >
                        <ShotCard
                            shot={shot}
                            index={index}
                            totalShots={shots.length}
                            characters={characters}
                            scenes={scenes}
                            props={props}
                            onUpdatePrompt={(prompt) => updatePrompt(index, prompt)}
                            onUpdateField={(field, value) => handleUpdateField(index, field, value)}
                            durationEditorConfig={durationEditorCfg}
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
                            onCancelVideo={
                                shot.videoTaskId && currentProject
                                    ? async () => {
                                        const projectId = currentProject.id;
                                        const taskId = shot.videoTaskId!;
                                        try {
                                            await api.cancelVideoTask(projectId, taskId);
                                        } finally {
                                            // Optimistic local flip — backend has
                                            // already marked failed, but the next
                                            // refetch may take a beat. Failed state
                                            // surfaces the existing Retry button.
                                            setShots(prev => prev.map((s, i) =>
                                                i === index ? { ...s, videoStatus: "failed" as const } : s,
                                            ));
                                        }
                                    }
                                    : undefined
                            }
                            onAutoLink={async () => {
                                await refreshProjectFrames();
                            }}
                            expanded={expandedShots.has(shot.id)}
                            onToggleExpanded={() => toggleShotExpanded(shot.id)}
                            /* PR-3c · 闭环生成: ShotCard 内全宽生成行 + count selector.
                               canGenerate: direct_r2v 需 prompt; t2i_i2v 还需 first frame. */
                            generateCount={paramsState.count}
                            canGenerate={
                                shot.prompt.trim().length > 0
                                && (
                                    shot.tabMode === "direct_r2v"
                                    || !!shot.t2iImageUrl
                                    || (shot.t2iImageUrls?.length ?? 0) > 0
                                )
                            }
                            onSetGenerateCount={(n) => handleShotParamsChange(shot, { ...paramsState, count: n })}
                            onGenerateBatch={(n) => generateVideoBatch(index, n, paramsState)}
                            inFlightCount={shotInFlight}
                            onRefineFrame={() => handleRefineFrame(shot.id)}
                            onUpdateDialogue={async (text: string) => {
                                if (!currentProject) return;
                                try {
                                    await api.updateFrame(currentProject.id, shot.id, { dialogue: text });
                                    const updated = await api.getProject(currentProject.id);
                                    if (updated?.frames) updateProject(currentProject.id, { frames: updated.frames });
                                } catch (e) {
                                    debugLog.error("Studio", "update dialogue failed", e);
                                }
                            }}
                        />
                        {/* PR-3j · Frame-level dialogue audio row. Only renders
                            when the frame has dialogue text; resolves the
                            bound character's voice_id and tracks stale state. */}
                        {(() => {
                            const frame = currentProject?.frames?.find((f: any) => f.id === shot.id);
                            if (!frame) return null;
                            const dialogueText = frame?.dialogue_structured?.line || frame?.dialogue;
                            const hasVideoTask = !!(frame.selected_video_id || (currentProject as any)?.video_tasks?.find((t: any) => t.frame_id === frame.id && t.status === "completed"));
                            // Show row when dialogue exists, or when video exists (dub available)
                            if (!dialogueText?.trim() && !hasVideoTask) return null;
                            const charId = Array.isArray(frame.character_ids) ? frame.character_ids[0] : null;
                            const speaker = charId ? characters.find((c: any) => c.id === charId) : null;
                            return (
                                <div className="ml-2 mr-1 mt-1.5 md:ml-5">
                                    <DialogueAudioRow
                                        scriptId={currentProject!.id}
                                        frameId={frame.id}
                                        dialogue={dialogueText}
                                        voiceId={speaker?.voice_id}
                                        audioUrl={frame.audio_url}
                                        audioError={frame.audio_error}
                                        snapshotDialogue={dialogueText}
                                        snapshotVoiceId={frame.dialogue_voice_id}
                                        snapshotInstructions={frame.dialogue_instructions}
                                        onUpdateDialogue={async (text: string) => {
                                            if (!currentProject) return;
                                            try {
                                                await api.updateFrame(currentProject.id, frame.id, { dialogue: text });
                                                const updated = await api.getProject(currentProject.id);
                                                if (updated?.frames) updateProject(currentProject.id, { frames: updated.frames });
                                            } catch (e) {
                                                debugLog.error("Studio", "update dialogue from audio row failed", e);
                                            }
                                        }}
                                        onAudioUpdated={async () => {
                                            if (!currentProject) return;
                                            try {
                                                const updated = await api.getProject(currentProject.id);
                                                if (updated?.frames) {
                                                    updateProject(currentProject.id, { frames: updated.frames });
                                                }
                                            } catch (e) {
                                                debugLog.warn("Studio", "refresh after audio gen failed", e);
                                            }
                                        }}
                                        videoUrl={(() => {
                                            const selectedId = frame.selected_video_id;
                                            const task = (currentProject as any)?.video_tasks?.find(
                                                (t: any) => selectedId ? t.id === selectedId : (t.frame_id === frame.id && t.status === "completed")
                                            );
                                            return task?.video_url;
                                        })()}
                                        videoTaskId={frame.selected_video_id ||
                                            (currentProject as any)?.video_tasks?.find(
                                                (t: any) => t.frame_id === frame.id && t.status === "completed"
                                            )?.id}
                                        previewVideoUrl={frame.preview_video_url}
                                        dubbedVideoUrl={frame.dubbed_video_url}
                                        dubOffsetMs={frame.dub_offset_ms ?? 0}
                                        onPreviewDub={async (videoTaskId: string, offsetMs: number) => {
                                            if (!currentProject) return;
                                            await api.previewDub(currentProject.id, frame.id, videoTaskId, offsetMs);
                                            const updated = await api.getProject(currentProject.id);
                                            if (updated?.frames) {
                                                updateProject(currentProject.id, { frames: updated.frames });
                                            }
                                        }}
                                        onApplyDub={async () => {
                                            if (!currentProject) return;
                                            await api.applyDub(currentProject.id, frame.id);
                                            const updated = await api.getProject(currentProject.id);
                                            if (updated?.frames) {
                                                updateProject(currentProject.id, { frames: updated.frames });
                                            }
                                        }}
                                        onRevertDub={async () => {
                                            if (!currentProject) return;
                                            await api.revertDub(currentProject.id, frame.id);
                                            const updated = await api.getProject(currentProject.id);
                                            if (updated?.frames) {
                                                updateProject(currentProject.id, { frames: updated.frames });
                                            }
                                        }}
                                    />
                                </div>
                            );
                        })()}
                        {/* Attached workbench: t2i_i2v 模式下渲染顺序为
                            Step 1 (T2ISubsection) → Step 2 (ParamsSection)
                            → CandidatesSection；direct_r2v 模式无 T2I 区，
                            ParamsSection → CandidatesSection。
                            Spec: docs/design/r2v-workflow-v3-unified.md §4.3.2
                            (PR-3a · Option A 最小修复)
                            v1 不加 explicit section header / first-frame
                            thumbnail in Step 2 — 看用户反馈再升级 v2. */}
                        {expandedShots.has(shot.id) ? (
                        <div className="ml-2 mr-1 mt-1.5 rounded-lg border border-glass-border bg-black/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_12px_-6px_rgba(0,0,0,0.5)] backdrop-blur-[2px] motion-safe:animate-[shotPanelIn_220ms_cubic-bezier(0.22,1,0.36,1)_both] md:ml-5">
                            {isI2vTab ? (
                                <div>
                                    <T2ISubsection
                                        imageUrls={shot.t2iImageUrls ?? []}
                                        selectedIndex={shot.t2iSelectedIndex ?? 0}
                                        storyboardFrameUrl={shot.imageUrl || undefined}
                                        promptIsEmpty={!shot.prompt.trim()}
                                        generating={shot.t2iStatus === "pending" || shot.t2iStatus === "processing"}
                                        inFlightTaskId={shot.t2iTaskId}
                                        inFlightStatus={shot.t2iStatus}
                                        onSelect={(i) => setShots(prev => prev.map((s, j) => {
                                            if (j !== index) return s;
                                            const next = setActiveT2IIndex(s, i);
                                            persistWorkbench(s.id, {
                                                t2i_selected_index: next.t2iSelectedIndex ?? 0,
                                            });
                                            return next;
                                        }))}
                                        onRemove={(i) => setShots(prev => prev.map((s, j) => {
                                            if (j !== index) return s;
                                            const next = removeT2IImage(s, i);
                                            persistWorkbench(s.id, {
                                                t2i_image_urls: next.t2iImageUrls ?? [],
                                                t2i_selected_index: next.t2iSelectedIndex ?? 0,
                                            });
                                            return next;
                                        }))}
                                        onGenerate={() => generateT2I(index)}
                                        onUpload={async (file) => {
                                            // Issue 10: upload an external image as a T2I首帧 candidate.
                                            // Backend appends + auto-selects; we mirror state from the
                                            // returned frame (single source of truth for the URL the
                                            // server actually persisted).
                                            //
                                            // Frontend may hold a synthetic shot id (`shot_<ts>_<rand>`)
                                            // for shots created via the + button that haven't been
                                            // persisted yet. The backend has no such frame_id → 404.
                                            // Lazy-create the frame on backend first, then upload.
                                            if (!currentProject) return { code: "network", detail: "no current project" };
                                            try {
                                                let effectiveFrameId = shot.id;
                                                const isSynthetic = effectiveFrameId.startsWith("shot_");
                                                if (isSynthetic) {
                                                    // Materialize the shot on backend before any
                                                    // frame-scoped op. Send minimum viable payload —
                                                    // the prompt + tab mode survives via separate
                                                    // workbench PATCH calls already triggered elsewhere.
                                                    try {
                                                        const created = await crudApi.createFrame(currentProject.id, {
                                                            scene_id: "",
                                                            action_description: shot.prompt || "",
                                                            insert_at: index,
                                                        } as any);
                                                        // Find the newly inserted frame by index in the response
                                                        const newFrame = Array.isArray(created?.frames)
                                                            ? created.frames[Math.min(index, created.frames.length - 1)]
                                                            : null;
                                                        if (newFrame?.id) {
                                                            effectiveFrameId = newFrame.id;
                                                            // Swap synthetic id → backend id locally so
                                                            // subsequent ops (workbench persist, generate, etc.)
                                                            // hit the real frame.
                                                            setShots(prev => prev.map((s, j) =>
                                                                j === index ? { ...s, id: newFrame.id } : s,
                                                            ));
                                                        }
                                                    } catch (createErr: any) {
                                                        debugLog.error("Studio", "Lazy createFrame failed", createErr);
                                                        const cdetail = createErr?.response?.data?.detail || createErr?.message || "create frame failed";
                                                        return { code: "server", detail: `先创建镜头失败：${cdetail}` };
                                                    }
                                                }

                                                const updatedFrame = await api.uploadT2IFrame(
                                                    currentProject.id,
                                                    effectiveFrameId,
                                                    file,
                                                );
                                                if (!updatedFrame) return { code: "network", detail: "empty response" };
                                                const nextUrls: string[] = updatedFrame.t2i_image_urls ?? [];
                                                const nextIdx: number = typeof updatedFrame.t2i_selected_index === "number"
                                                    ? updatedFrame.t2i_selected_index
                                                    : Math.max(0, nextUrls.length - 1);
                                                setShots(prev => prev.map((s, j) => {
                                                    if (j !== index) return s;
                                                    return {
                                                        ...s,
                                                        t2iImageUrls: nextUrls,
                                                        t2iSelectedIndex: nextIdx,
                                                        t2iImageUrl: nextUrls[nextIdx],
                                                        t2iStatus: "completed",
                                                    };
                                                }));
                                                return undefined;
                                            } catch (err: any) {
                                                debugLog.error("Studio", "T2I upload failed", err);
                                                const status = err?.response?.status;
                                                // Always surface the backend detail string so the
                                                // user can self-diagnose ("frame not found", "OSS
                                                // write denied", etc.) instead of "请重试".
                                                const detail = err?.response?.data?.detail
                                                    || err?.message
                                                    || `HTTP ${status ?? "?"}`;
                                                if (status === 413) return { code: "size", detail: String(detail) };
                                                if (status === 415) return { code: "type", detail: String(detail) };
                                                if (status === 404) return { code: "not_found", detail: String(detail) };
                                                if (status && status >= 500) return { code: "server", detail: String(detail) };
                                                return { code: "network", detail: String(detail) };
                                            }
                                        }}
                                        resolveUrl={resolveAssetUrl}
                                    />
                                </div>
                            ) : null}
                            {/* Step 2 · 生成视频 (ParamsSection) — always shown
                                when shot expanded; renders below Step 1 in
                                t2i_i2v mode, and is the only section above
                                candidates in direct_r2v mode. */}
                            <div className={isI2vTab ? "border-t border-glass-border" : ""}>
                                <ParamsSection
                                    shotId={shot.id}
                                    modelList={modelList}
                                    title={isI2vTab ? "I2V Params" : "R2V Params"}
                                    params={paramsState}
                                    onChange={(next) => handleShotParamsChange(shot, next)}
                                    inFlightCount={shotInFlight}
                                    errorMessage={shotErrors[shot.id] ?? null}
                                />
                            </div>
                            <div className="border-t border-glass-border">
                                <CandidatesSection
                                    shotId={shot.id}
                                    tasks={shotTasks}
                                    activeModel={paramsState.model}
                                    compareSelectedIds={compareSelectedIds}
                                    dubbedVideoUrl={currentProject?.frames?.find((f: any) => f.id === shot.id)?.dubbed_video_url}
                                    dubbedVideoTaskId={currentProject?.frames?.find((f: any) => f.id === shot.id)?.dubbed_video_task_id}
                                    onClickThumb={handleCandidateClick}
                                    onToggleStar={handleToggleStar}
                                    onSetLabel={handleSetLabel}
                                    onCancel={handleCancelTask}
                                    onRetry={handleRetryTask}
                                    onReuseBatchParams={handleReuseBatchParams}
                                    onOpenCompare={() => setCompareModalOpen(true)}
                                    resolveUrl={resolveAssetUrl}
                                />
                            </div>
                        </div>
                        ) : null}
                    </div>
                    );
                })}

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
        </div>
        {/* Right-side Task Queue — pushes (does not overlay) the main
            column. Mounted in the layout flex, not as a fixed overlay,
            so width compression is automatic when it opens. */}
        <TaskQueuePanel
            open={queueOpen}
            onClose={() => setQueueOpen(false)}
            tasks={allVideoTasks}
            shotLabelByFrameId={shotLabelByFrameId}
            onJumpToShot={handleJumpToShot}
            onCancel={handleCancelTask}
            onRetry={handleRetryTask}
        />
        {/* Compare modal — portaled to body to escape clipped/transformed
            ancestors. Shows once user has shift-selected ≥2 and clicked
            the floating Compare button in any CandidatesSection. */}
        {compareModalOpen && compareTasks.length >= 2 ? (
            <CompareModal
                tasks={compareTasks}
                onClose={() => setCompareModalOpen(false)}
                resolveUrl={resolveAssetUrl}
            />
        ) : null}
        {/* LLM-generate frames dialog */}
        <StoryboardGenerateDialog
            isOpen={genDialogOpen}
            onClose={() => setGenDialogOpen(false)}
            project={currentProject as any}
            existingShotCount={shots.length}
            onConfirm={handleSmartGenerate}
            onJumpToScript={() => {
                setGenDialogOpen(false);
                window.dispatchEvent(new CustomEvent("navigateStep", { detail: "script" }));
            }}
        />
        </div>
    );
}
