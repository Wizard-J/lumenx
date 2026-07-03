"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { Plus, Palette, Film, Loader2, Link2, Sparkles, RefreshCw, ImageIcon, Upload } from "lucide-react";
import StepHeader from "@/components/shared/StepHeader";
import PreviousEpisodeFramesRail from "./storyboard-r2v/PreviousEpisodeFramesRail";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api, crudApi, type VideoTask, type RefineSSEEvent, type RenderSSEEvent } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { debugLog } from "@/lib/debugLog";
import type { BatchSummary } from "./storyboard-r2v/shot-panel/CandidatesSection";
import { getR2vRouteModelId, isR2vImageBased, VIDEO_I2V_MODELS, VIDEO_R2V_MODELS, DEFAULT_I2V_MODEL_ID, DEFAULT_R2V_MODEL_ID, DEFAULT_MODEL_SETTINGS, type I2VModelConfig } from "@/lib/modelCatalog";
import ShotCard, { type ShotNode, type WorkbenchTabMode } from "./storyboard-r2v/ShotCard";
import { buildAssembledPrompt, buildPromptWithReferenceTags } from "./storyboard-r2v/buildAssembledPrompt";
import {
    hasAssetReferenceTags,
    mergeAssetPools,
    parseAssetReferenceTags,
    referenceUrlsForVideoModel,
    stripAssetReferenceTags,
} from "./storyboard-r2v/assetReferences";
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
    normalizeWorkbenchTabMode,
} from "./storyboard-r2v/shotNodeHelpers";
import { overridePanelSectionState } from "./storyboard-r2v/shot-panel/usePanelSectionState";
import ParamsSection, { type ParamsState } from "./storyboard-r2v/shot-panel/ParamsSection";
import T2ISubsection, { type T2IUploadError } from "./storyboard-r2v/shot-panel/T2ISubsection";
import CandidatesSection from "./storyboard-r2v/shot-panel/CandidatesSection";
import CompareModal from "./storyboard-r2v/shot-panel/CompareModal";
import { GenerationBanner, type BannerState } from "./storyboard-r2v/GenerationBanner";

type StoredModelSettings = Partial<typeof DEFAULT_MODEL_SETTINGS>;
type KeyframeRole = "start" | "end";
type KeyframeBusyMap = Record<string, Partial<Record<KeyframeRole, boolean>>>;

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

function getVisibleI2vModelId(candidate?: string | null, externalModelId?: string | null): string {
    if (candidate && candidate === externalModelId) return candidate;
    return VIDEO_I2V_MODELS.some((model) => model.id === candidate)
        ? candidate as string
        : DEFAULT_I2V_MODEL_ID;
}

function getVisibleR2vModelId(candidate?: string | null): string {
    return VIDEO_R2V_MODELS.some((model) => model.id === candidate)
        ? candidate as string
        : (VIDEO_R2V_MODELS[0]?.id ?? DEFAULT_R2V_MODEL_ID);
}

function isVisibleR2vModelId(candidate?: string | null, externalModelId?: string | null): boolean {
    return !!candidate && (
        candidate === externalModelId ||
        VIDEO_R2V_MODELS.some((model) => model.id === candidate)
    );
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

function defaultKeyframePrompt(
    prompt: string,
    shot: Partial<ShotNode>,
    role: "start" | "end" | "neutral",
): string {
    const base = stripAssetReferenceTags(prompt).trim();
    if (role === "start") {
        return [
            base,
            "这是视频首帧关键帧：表现动作刚开始的瞬间，主体处于起始位置，镜头运动尚未展开，画面稳定、完整、可作为视频第一帧。",
        ].join(" ").trim();
    }
    if (role === "end") {
        const movement = shot.cameraMovementStructured?.description || "";
        const transition = shot.transitionHint || "";
        return [
            base,
            "这是视频尾帧关键帧：表现本镜头动作完成后的终点状态，主体位置、姿态、环境细节要相对首帧产生清晰变化，镜头到达运动终点，适合作为视频最后一帧。",
            movement ? `运镜终点参考：${movement}` : "",
            transition ? `衔接下一镜头：${transition}` : "",
        ].filter(Boolean).join(" ").trim();
    }
    return [
        base,
        "生成一张完整分镜关键帧：角色、场景、道具都应组合进同一镜头画面，不要生成资产设定图、三视图或拼贴版式。",
    ].join(" ").trim();
}

function isPovShotPrompt(prompt: string, shot?: Partial<ShotNode>): boolean {
    const text = [
        prompt,
        shot?.prompt,
        shot?.visualDescription,
        shot?.assembledPrompt,
        shot?.cameraAngle,
    ].filter(Boolean).join("\n");
    return /(主观视角|第一人称|\bPOV\b|first[-\s]?person|point[-\s]?of[-\s]?view)/i.test(text);
}

function buildPovPerspectiveConstraint(subjectNames: string[]): string {
    const subject = subjectNames.length ? subjectNames.join("、") : "视角所属角色";
    return [
        "主观视角硬约束：",
        `本镜头是${subject}的第一人称 POV，镜头就是${subject}的眼睛/视线。`,
        `不要显示${subject}的正脸、半身、全身、背影或任何第三人称肖像构图。`,
        `如需体现${subject}，只能显示手部、衣袖、膝盖、持物、手表等第一人称局部身体线索。`,
        "画面重点应是视角主体正在看到的场景和事件，而不是拍摄视角主体本人。",
    ].join("\n");
}

const KEYFRAME_HISTORY_LIMIT = 10;
const KEYFRAME_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const KEYFRAME_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_UPLOAD_MAX_BYTES = 300 * 1024 * 1024;
const VIDEO_UPLOAD_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"];

function appendKeyframeCandidate(urls: string[] | undefined, imageUrl: string): string[] {
    if (!imageUrl) return urls ?? [];
    const existing = urls ?? [];
    if (existing.includes(imageUrl)) return existing;
    const appended = [...existing, imageUrl];
    return appended.length > KEYFRAME_HISTORY_LIMIT
        ? appended.slice(appended.length - KEYFRAME_HISTORY_LIMIT)
        : appended;
}

function mergeUrlHistory(primary: string[] | undefined, fallback: string[] | undefined): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const url of [...(primary ?? []), ...(fallback ?? [])]) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        merged.push(url);
    }
    return merged.length > KEYFRAME_HISTORY_LIMIT
        ? merged.slice(merged.length - KEYFRAME_HISTORY_LIMIT)
        : merged;
}

function preserveLocalWorkbenchState(hydrated: ShotNode, local?: ShotNode): ShotNode {
    if (!local) return hydrated;
    const t2iImageUrls = mergeUrlHistory(hydrated.t2iImageUrls, local.t2iImageUrls);
    const keyframeStartImageUrls = mergeUrlHistory(hydrated.keyframeStartImageUrls, local.keyframeStartImageUrls);
    const keyframeEndImageUrls = mergeUrlHistory(hydrated.keyframeEndImageUrls, local.keyframeEndImageUrls);
    const t2iSelectedIndex = t2iImageUrls.length
        ? Math.max(0, Math.min(hydrated.t2iSelectedIndex ?? local.t2iSelectedIndex ?? 0, t2iImageUrls.length - 1))
        : 0;
    return migrateShotNode({
        ...hydrated,
        t2iImageUrls,
        t2iSelectedIndex,
        t2iImageUrl: t2iImageUrls[t2iSelectedIndex] ?? hydrated.t2iImageUrl ?? local.t2iImageUrl,
        storyboardImagePrompt: hydrated.storyboardImagePrompt ?? local.storyboardImagePrompt,
        keyframeStartImageUrl: hydrated.keyframeStartImageUrl ?? local.keyframeStartImageUrl,
        keyframeEndImageUrl: hydrated.keyframeEndImageUrl ?? local.keyframeEndImageUrl,
        keyframeStartImageUrls,
        keyframeEndImageUrls,
    });
}

function collectKeyframeSourceOptions(shot: ShotNode): Array<{ url: string; label: string }> {
    const seen = new Set<string>();
    const options: Array<{ url: string; label: string }> = [];
    const add = (url: string | null | undefined, label: string) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        options.push({ url, label });
    };
    add(shot.imageUrl, "分镜图");
    (shot.t2iImageUrls ?? []).forEach((url, index) => add(url, `首帧池 ${index + 1}`));
    (shot.keyframeStartImageUrls ?? []).forEach((url, index) => add(url, `首帧候选 ${index + 1}`));
    (shot.keyframeEndImageUrls ?? []).forEach((url, index) => add(url, `尾帧候选 ${index + 1}`));
    return options;
}

function setKeyframeBusy(
    prev: KeyframeBusyMap,
    shotId: string,
    role: KeyframeRole,
    busy: boolean,
): KeyframeBusyMap {
    const next = { ...prev };
    const current = { ...(next[shotId] ?? {}) };
    if (busy) {
        current[role] = true;
        next[shotId] = current;
    } else {
        delete current[role];
        if (current.start || current.end) next[shotId] = current;
        else delete next[shotId];
    }
    return next;
}

function buildImageReferenceInstruction(
    items: Array<{ name: string; resolvedKind: string }>,
    options: { povSubjectNames?: string[] } = {},
): string {
    if (!items.length) return "";
    const povSubjectNames = new Set((options.povSubjectNames ?? []).map((name) => name.trim()).filter(Boolean));
    const kindLabel: Record<string, string> = {
        character: "角色",
        scene: "场景",
        prop: "道具",
    };
    const lines = items.map((item, index) => {
        const label = kindLabel[item.resolvedKind] ?? "资产";
        if (item.resolvedKind === "character") {
            if (povSubjectNames.has(item.name)) {
                return `参考图${index + 1}是${label}「${item.name}」，仅用于保持视角主体的身份、年龄感、服装、手部/衣袖等局部线索；不要把「${item.name}」以正脸、半身、全身或第三人称方式放入画面。`;
            }
            return `参考图${index + 1}是${label}「${item.name}」，请保持人物身份、脸型、发型、年龄感、服装和主要特征一致，并把他自然放入当前镜头。`;
        }
        if (item.resolvedKind === "scene") {
            return `参考图${index + 1}是${label}「${item.name}」，请保持空间结构、环境材质、色调和关键陈设一致，并按当前镜头重新构图。`;
        }
        return `参考图${index + 1}是${label}「${item.name}」，请保持外形、材质、颜色和用途一致，并自然出现在当前镜头中。`;
    });
    return [
        "参考图使用规则：",
        ...lines,
        "请生成一张完整、连续、单画面的分镜图，不要生成参考图拼贴、对比图、设定图、三视图、缩略图网格或分栏画面。",
    ].join("\n");
}

function summarizeVideoTaskResponse(value: unknown): string {
    try {
        const text = JSON.stringify(value);
        return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    } catch {
        return String(value);
    }
}

function firstCreatedVideoTask(value: unknown): VideoTask {
    const task = Array.isArray(value) ? value[0] : value;
    if (task && typeof task === "object" && "id" in task && (task as VideoTask).id) {
        return task as VideoTask;
    }
    throw new Error(`后端没有返回有效的视频任务：${summarizeVideoTaskResponse(value)}`);
}

function frameToBaseShotNode(frame: any, defaultMode: WorkbenchTabMode): ShotNode {
    const partial: ShotNode = {
        id: frame.id,
        prompt: frame.visual_description || frame.action_description || "",
        tabMode: normalizeWorkbenchTabMode(frame.workbench_tab_mode ?? defaultMode),
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
        storyboardImagePrompt: frame.storyboard_image_prompt ?? null,
        keyframeStartPrompt: null,
        keyframeEndPrompt: null,
        keyframeStartImageUrl: frame.keyframe_start_image_url ?? null,
        keyframeEndImageUrl: frame.keyframe_end_image_url ?? null,
        keyframeStartImageUrls: Array.isArray(frame.keyframe_start_image_urls) ? frame.keyframe_start_image_urls : [],
        keyframeEndImageUrls: Array.isArray(frame.keyframe_end_image_urls) ? frame.keyframe_end_image_urls : [],
    };
    return migrateShotNode({
        ...partial,
        keyframeStartPrompt: frame.keyframe_start_prompt || defaultKeyframePrompt(partial.prompt, partial, "start"),
        keyframeEndPrompt: frame.keyframe_end_prompt || defaultKeyframePrompt(partial.prompt, partial, "end"),
    });
}

function hydrateShotNodeFromVideoTasks(
    frame: any,
    videoTasks: any[],
    defaultMode: WorkbenchTabMode,
): ShotNode {
    const base = frameToBaseShotNode(frame, defaultMode);
    const frameTasks = videoTasks.filter((t: any) => t.frame_id === frame.id);
    const tabTasks = frameTasks.filter((t: any) => {
        if (t.workbench_tab != null) return normalizeWorkbenchTabMode(t.workbench_tab) === base.tabMode;
        if (base.tabMode === "keyframe_r2v") return t.generation_mode === "r2v";
        if (base.tabMode === "asset_compose") return false;
        return t.generation_mode !== "r2v";
    });
    const scopedTasks = tabTasks.length ? tabTasks : frameTasks;
    const inFlightTask = scopedTasks.find((t: any) =>
        t.status === "pending" || t.status === "processing"
    );
    const completedTasks = scopedTasks.filter((t: any) =>
        t.status === "completed" && t.video_url
    );
    const latestCompleted = completedTasks[completedTasks.length - 1];
    let videoStatus: "pending" | "processing" | "completed" | "failed" | undefined;
    let videoUrl: string | undefined = frame.dubbed_video_url || frame.video_url || undefined;
    let videoTaskId: string | undefined;
    if (inFlightTask) {
        videoStatus = inFlightTask.status;
        videoTaskId = inFlightTask.id;
    } else if (videoUrl || latestCompleted) {
        videoStatus = "completed";
        videoUrl = videoUrl || latestCompleted?.video_url;
        videoTaskId = latestCompleted?.id;
    } else if (scopedTasks.some((t: any) => t.status === "failed")) {
        videoStatus = "failed";
    }
    return {
        ...base,
        videoUrl,
        videoStatus,
        videoTaskId,
    };
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
            : savedI2v || globalSettings.i2v_model || DEFAULT_I2V_MODEL_ID,
        externalVideoModelId,
    );

    if (savedI2v && savedI2v !== i2vModelId && savedI2v !== externalVideoModelId && !VIDEO_I2V_MODELS.some((model) => model.id === savedI2v)) {
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
        : savedR2vCandidate || globalR2v || externalVideoModelId || derivedR2v || DEFAULT_R2V_MODEL_ID;
    const r2vModelId = r2vCandidate === externalVideoModelId
        ? r2vCandidate
        : getVisibleR2vModelId(r2vCandidate);

    if (savedR2v && (staleDefaultR2v || !isVisibleR2vModelId(savedR2v, externalVideoModelId))) {
        ls?.removeItem("storyboard-r2v-r2v-model");
        debugLog.warn("Studio", `Removed stale cached R2V model "${savedR2v}".`);
    }

    const finalConfig = i2vModelId === externalVideoModelId
        ? buildExternalVideoModelOption(i2vModelId)
        : VIDEO_I2V_MODELS.find((model) => model.id === i2vModelId);
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
            const defaultMode: WorkbenchTabMode = currentProject.default_generation_mode === "i2v" ? "t2i_i2v" : "asset_compose";
            return currentProject.frames.map((frame: any) =>
                hydrateShotNodeFromVideoTasks(frame, videoTasks, defaultMode)
            );
        }
        return [migrateShotNode({ id: `shot_${Date.now()}`, prompt: "", tabMode: "asset_compose", sceneId: null, characterIds: [], propIds: [] })];
    });
    const [keyframeGenerating, setKeyframeGenerating] = useState<KeyframeBusyMap>({});
    const [keyframeUploading, setKeyframeUploading] = useState<KeyframeBusyMap>({});

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

    // Compare-mode selection: a Set of task ids the user shift-clicked
    // in any shot's candidate panel. Multi-shot compare is a future
    // feature; for now the same Set is shared across shots so user
    // can only effectively compare within one shot at a time. Cleared
    // on Compare modal close.
    const [compareSelectedIds, setCompareSelectedIds] = useState<Set<string>>(() => new Set());
    const [compareModalOpen, setCompareModalOpen] = useState(false);

    // Refs map for textareas (for asset insertion from drawer)
    const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());
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
        () => mergeExternalModel(VIDEO_I2V_MODELS, externalVideoModelId),
        [externalVideoModelId],
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
        // "i2v" starts on first-frame video; R2V starts at asset composition
        // so users create a complete keyframe before sending anything to video.
        const defaultMode: WorkbenchTabMode = currentProject?.default_generation_mode === "i2v" ? "t2i_i2v" : "asset_compose";
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

    const frameToShotNode = useCallback((frame: any, project: any = currentProject): ShotNode => {
        const defaultMode: WorkbenchTabMode = project?.default_generation_mode === "i2v" ? "t2i_i2v" : "asset_compose";
        return hydrateShotNodeFromVideoTasks(frame, project?.video_tasks ?? [], defaultMode);
    }, [currentProject]);

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
            updateProject(currentProject.id, refreshed);
            setShots(prev => refreshed.frames.map((frame: any) =>
                preserveLocalWorkbenchState(
                    frameToShotNode(frame, refreshed),
                    prev.find((shot) => shot.id === frame.id),
                )
            ));
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
                setShots(prev => updated.frames.map((frame: any) =>
                    preserveLocalWorkbenchState(
                        frameToShotNode(frame, updated),
                        prev.find((shot) => shot.id === frame.id),
                    )
                ));
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
                setShots(prev => updated.frames.map((frame: any) =>
                    preserveLocalWorkbenchState(
                        frameToShotNode(frame, updated),
                        prev.find((shot) => shot.id === frame.id),
                    )
                ));
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
                            tabMode: normalizeWorkbenchTabMode(
                                frame.workbench_tab_mode
                                ?? (currentProject.default_generation_mode === "i2v" ? "t2i_i2v" : "asset_compose"),
                            ),
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
    const setTabMode = useCallback((index: number, mode: WorkbenchTabMode) => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            persistWorkbench(s.id, { workbench_tab_mode: mode });
            return { ...s, tabMode: mode };
        }));
    }, [persistWorkbench]);

    const updateKeyframePrompt = useCallback((
        index: number,
        role: "start" | "end",
        prompt: string,
    ) => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            const patch = role === "start"
                ? { keyframe_start_prompt: prompt }
                : { keyframe_end_prompt: prompt };
            persistWorkbench(s.id, patch);
            return role === "start"
                ? { ...s, keyframeStartPrompt: prompt }
                : { ...s, keyframeEndPrompt: prompt };
        }));
    }, [persistWorkbench]);

    const updateStoryboardImagePrompt = useCallback((index: number, prompt: string) => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            persistWorkbench(s.id, { storyboard_image_prompt: prompt });
            return { ...s, storyboardImagePrompt: prompt };
        }));
    }, [persistWorkbench]);

    const selectKeyframeImage = useCallback((
        index: number,
        role: "start" | "end",
        imageUrl: string,
    ) => {
        setShots(prev => prev.map((s, i) => {
            if (i !== index) return s;
            const nextStartUrls = role === "start"
                ? appendKeyframeCandidate(s.keyframeStartImageUrls, imageUrl)
                : s.keyframeStartImageUrls ?? [];
            const nextEndUrls = role === "end"
                ? appendKeyframeCandidate(s.keyframeEndImageUrls, imageUrl)
                : s.keyframeEndImageUrls ?? [];
            const patch = role === "start"
                ? { keyframe_start_image_url: imageUrl, keyframe_start_image_urls: nextStartUrls }
                : { keyframe_end_image_url: imageUrl, keyframe_end_image_urls: nextEndUrls };
            persistWorkbench(s.id, patch);
            return role === "start"
                ? { ...s, keyframeStartImageUrl: imageUrl, keyframeStartImageUrls: nextStartUrls }
                : { ...s, keyframeEndImageUrl: imageUrl, keyframeEndImageUrls: nextEndUrls };
        }));
    }, [persistWorkbench]);

    const uploadT2IForShot = useCallback(async (
        index: number,
        shot: ShotNode,
        file: File,
        keyframeRole?: "start" | "end",
    ): Promise<T2IUploadError | void> => {
        if (!currentProject) return { code: "network", detail: "no current project" };
        if (!KEYFRAME_UPLOAD_TYPES.includes(file.type)) return "type";
        if (file.size > KEYFRAME_UPLOAD_MAX_BYTES) return "size";

        try {
            let effectiveFrameId = shot.id;
            const isSynthetic = effectiveFrameId.startsWith("shot_");
            if (isSynthetic) {
                try {
                    const created = await crudApi.createFrame(currentProject.id, {
                        scene_id: "",
                        action_description: shot.prompt || "",
                        insert_at: index,
                    } as any);
                    const newFrame = Array.isArray(created?.frames)
                        ? created.frames[Math.min(index, created.frames.length - 1)]
                        : null;
                    if (newFrame?.id) {
                        effectiveFrameId = newFrame.id;
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

            const updatedFrame = await api.uploadT2IFrame(currentProject.id, effectiveFrameId, file);
            if (!updatedFrame) return { code: "network", detail: "empty response" };

            const nextUrls: string[] = updatedFrame.t2i_image_urls ?? [];
            const nextIdx: number = typeof updatedFrame.t2i_selected_index === "number"
                ? updatedFrame.t2i_selected_index
                : Math.max(0, nextUrls.length - 1);
            const uploadedUrl = nextUrls[nextIdx];
            const currentShot = shots[index];
            const startUrls = keyframeRole === "start" && uploadedUrl
                ? appendKeyframeCandidate(currentShot?.keyframeStartImageUrls, uploadedUrl)
                : currentShot?.keyframeStartImageUrls ?? [];
            const endUrls = keyframeRole === "end" && uploadedUrl
                ? appendKeyframeCandidate(currentShot?.keyframeEndImageUrls, uploadedUrl)
                : currentShot?.keyframeEndImageUrls ?? [];
            const keyframeFramePatch = keyframeRole === "start" && uploadedUrl
                ? { keyframe_start_image_url: uploadedUrl, keyframe_start_image_urls: startUrls }
                : keyframeRole === "end" && uploadedUrl
                    ? { keyframe_end_image_url: uploadedUrl, keyframe_end_image_urls: endUrls }
                    : {};

            updateProject(currentProject.id, {
                frames: (currentProject.frames ?? []).map((frame: any) =>
                    frame.id === effectiveFrameId
                        ? { ...frame, ...updatedFrame, ...keyframeFramePatch }
                        : frame,
                ),
            } as any);

            setShots(prev => prev.map((s, j) => {
                if (j !== index) return s;
                const base = {
                    ...s,
                    id: effectiveFrameId,
                    t2iImageUrls: nextUrls,
                    t2iSelectedIndex: nextIdx,
                    t2iImageUrl: uploadedUrl,
                    t2iStatus: "completed" as const,
                };
                if (!keyframeRole || !uploadedUrl) return base;
                if (keyframeRole === "start") {
                    return {
                        ...base,
                        keyframeStartImageUrl: uploadedUrl,
                        keyframeStartImageUrls: startUrls,
                    };
                }
                return {
                    ...base,
                    keyframeEndImageUrl: uploadedUrl,
                    keyframeEndImageUrls: endUrls,
                };
            }));

            if (keyframeRole && uploadedUrl) {
                const patch = keyframeRole === "start"
                    ? { keyframe_start_image_url: uploadedUrl, keyframe_start_image_urls: startUrls }
                    : { keyframe_end_image_url: uploadedUrl, keyframe_end_image_urls: endUrls };
                persistWorkbench(effectiveFrameId, patch);
            }

            return undefined;
        } catch (err: any) {
            debugLog.error("Studio", "T2I upload failed", err);
            const status = err?.response?.status;
            const detail = err?.response?.data?.detail
                || err?.message
                || `HTTP ${status ?? "?"}`;
            if (status === 413) return { code: "size", detail: String(detail) };
            if (status === 415) return { code: "type", detail: String(detail) };
            if (status === 404) return { code: "not_found", detail: String(detail) };
            if (status && status >= 500) return { code: "server", detail: String(detail) };
            return { code: "network", detail: String(detail) };
        }
    }, [currentProject, persistWorkbench, shots]);

    const uploadKeyframeImage = useCallback(async (
        index: number,
        shot: ShotNode,
        role: "start" | "end",
        file: File,
    ) => {
        setKeyframeUploading(prev => setKeyframeBusy(prev, shot.id, role, true));
        try {
            const result = await uploadT2IForShot(index, shot, file, role);
            if (result) {
                const detail = typeof result === "string" ? "" : result.detail;
                const code = typeof result === "string" ? result : result.code;
                const label = code === "type"
                    ? "图片格式仅支持 JPG / PNG / WebP"
                    : code === "size"
                        ? "图片不能超过 8MB"
                        : "上传关键帧失败";
                toast.error(detail ? `${label}：${detail}` : label);
            }
        } finally {
            setKeyframeUploading(prev => setKeyframeBusy(prev, shot.id, role, false));
        }
    }, [uploadT2IForShot]);

    const uploadVideoCandidate = useCallback(async (
        index: number,
        shot: ShotNode,
        file: File,
        modelId: string,
    ) => {
        if (!currentProject) return;
        const fileName = file.name.toLowerCase();
        const extOk = /\.(mp4|mov|webm|m4v)$/.test(fileName);
        const typeOk = !file.type || VIDEO_UPLOAD_TYPES.includes(file.type);
        if (!extOk || !typeOk) {
            toast.error("视频格式仅支持 MP4 / MOV / WebM / M4V");
            return;
        }
        if (file.size > VIDEO_UPLOAD_MAX_BYTES) {
            toast.error("视频不能超过 300MB");
            return;
        }

        try {
            let effectiveFrameId = shot.id;
            if (effectiveFrameId.startsWith("shot_")) {
                const created = await crudApi.createFrame(currentProject.id, {
                    scene_id: "",
                    action_description: shot.prompt || "",
                    insert_at: index,
                } as any);
                const newFrame = Array.isArray(created?.frames)
                    ? created.frames[Math.min(index, created.frames.length - 1)]
                    : null;
                if (!newFrame?.id) {
                    toast.error("上传视频失败：无法创建镜头");
                    return;
                }
                effectiveFrameId = newFrame.id;
                updateProject(currentProject.id, created);
                setShots(prev => prev.map((s, j) =>
                    j === index ? { ...s, id: newFrame.id } : s,
                ));
            }

            const task = await api.uploadVideoCandidate(
                currentProject.id,
                effectiveFrameId,
                file,
                shot.tabMode,
                modelId || "uploaded-video",
            );
            const existingTasks = (((currentProject as any).video_tasks ?? []) as VideoTask[]);
            updateProject(currentProject.id, {
                video_tasks: [
                    ...existingTasks.filter((existing) => existing.id !== task.id),
                    task,
                ],
            } as any);
            setShots(prev => prev.map((s, j) =>
                j === index
                    ? {
                        ...s,
                        id: effectiveFrameId,
                        videoStatus: "completed" as const,
                        videoUrl: task.video_url,
                        videoTaskId: task.id,
                    }
                    : s,
            ));
            toast.success("视频已加入候选");
        } catch (err: any) {
            const detail = err?.response?.data?.detail || err?.message || "未知错误";
            toast.error(`上传视频失败：${String(detail).slice(0, 140)}`);
        }
    }, [currentProject, updateProject]);

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
    const [seriesAssetsLoaded, setSeriesAssetsLoaded] = useState(false);
    useEffect(() => {
        const sid = currentProject?.series_id;
        if (sid) {
            setSeriesAssetsLoaded(false);
            import("@/lib/api").then(({ api }) => {
                api.getSeriesAssets(sid).then((assets: any) => {
                    setSeriesAssets({
                        characters: assets.characters || [],
                        scenes: assets.scenes || [],
                        props: assets.props || [],
                    });
                    setSeriesAssetsLoaded(true);
                }).catch(() => {
                    setSeriesAssetsLoaded(true);
                });
            });
        } else {
            setSeriesAssets(null);
            setSeriesAssetsLoaded(true);
        }
    }, [currentProject?.series_id]);

    const drawerAssetPools = useMemo(() => ({
        characters: mergeAssetPools(characters, seriesAssets?.characters ?? [], "character"),
        scenes: mergeAssetPools(scenes, seriesAssets?.scenes ?? [], "scene"),
        props: mergeAssetPools(props, seriesAssets?.props ?? [], "prop"),
    }), [characters, scenes, props, seriesAssets]);
    const seriesAssetsLoading = !!currentProject?.series_id && !seriesAssetsLoaded;

    const parseAssetTagsForVideoModel = useCallback((
        prompt: string,
        shot: ShotNode | undefined,
        modelId?: string | null,
    ) => {
        const parsed = parseAssetReferenceTags(prompt, drawerAssetPools, shot);
        return {
            urls: referenceUrlsForVideoModel(parsed, modelId),
            unresolved: parsed.unresolved,
        };
    }, [drawerAssetPools]);

    const getUnresolvedAssetNames = useCallback((prompt: string, shot?: ShotNode): string[] => (
        parseAssetReferenceTags(prompt, drawerAssetPools, shot).unresolved
    ), [drawerAssetPools]);

    // Strip tags from prompt for clean text
    const cleanPrompt = (prompt: string): string => {
        return stripAssetReferenceTags(prompt);
    };

    const getShotKeyframeUrls = (shot: ShotNode): string[] => {
        const startUrl = shot.keyframeStartImageUrl || shot.keyframeStartImageUrls?.[0];
        const endUrl = shot.keyframeEndImageUrl || shot.keyframeEndImageUrls?.[0];
        if (startUrl || endUrl) return [startUrl, endUrl].filter((url): url is string => !!url);

        const urls = (shot.t2iImageUrls ?? []).filter(Boolean);
        if (urls.length > 1) return [urls[0], urls[urls.length - 1]];
        if (urls.length === 1) return [urls[0]];
        const fallback = getActiveT2IImageUrl(shot) || shot.imageUrl;
        return fallback ? [fallback] : [];
    };

    const getSeedanceReferenceUrls = (shot: ShotNode, keyframes: string[], parsedAssetRefs: string[]): string[] => {
        const seen = new Set<string>();
        const refs: string[] = [];
        for (const url of [...keyframes, ...parsedAssetRefs]) {
            if (!url || seen.has(url)) continue;
            seen.add(url);
            refs.push(url);
        }
        return refs;
    };

    const agnesKeyframeError = "Agnes 的关键帧 R2V 需要完整分镜图。请先在「首帧 I2V」生成/上传首帧，或先生成本镜分镜图。";

    const resolveKeyframePrompt = (prompt: string, shot: ShotNode, role: "start" | "end" | "neutral"): string => {
        if (role === "start" && shot.keyframeStartPrompt?.trim()) return shot.keyframeStartPrompt.trim();
        if (role === "end" && shot.keyframeEndPrompt?.trim()) return shot.keyframeEndPrompt.trim();
        return defaultKeyframePrompt(prompt, shot, role);
    };

    // Generate T2I image for a shot (t2i_i2v mode stage 1)
    const generateT2I = useCallback(async (index: number, role: "start" | "end" | "neutral" = "neutral") => {
        const shot = shots[index];
        if (!currentProject) return;
        const isKeyframeRole = role === "start" || role === "end";
        const imagePromptOverride = !isKeyframeRole ? shot.storyboardImagePrompt?.trim() : "";
        if (!(imagePromptOverride || shot.prompt.trim())) return;
        if (seriesAssetsLoading) {
            toast.warning("资产库还在加载，请稍后再生成当前帧。");
            return;
        }
        const promptShot = imagePromptOverride
            ? { ...shot, prompt: imagePromptOverride }
            : shot;
        const taggedPrompt = buildPromptWithReferenceTags(
            promptShot,
            drawerAssetPools.characters,
            drawerAssetPools.scenes,
            drawerAssetPools.props,
        );

        if (isKeyframeRole) {
            setKeyframeGenerating(prev => setKeyframeBusy(prev, shot.id, role, true));
        } else {
            setShots(prev => prev.map((s, i) =>
                i === index ? { ...s, t2iStatus: "pending" } : s
            ));
        }

        // Build reference_image_urls from asset tags so generated first/end
        // keyframes are composed from the existing asset library instead of
        // drifting into text-only imagery.
        const parsedRefs = parseAssetReferenceTags(taggedPrompt, drawerAssetPools, promptShot);
        const refUrls = parsedRefs.urls;
        if (hasAssetReferenceTags(taggedPrompt) && refUrls.length === 0) {
            toast.warning("没有解析到可用资产参考图，请先自动引用资源并生成对应资产图。");
            if (isKeyframeRole) {
                setKeyframeGenerating(prev => setKeyframeBusy(prev, shot.id, role, false));
            } else {
                setShots(prev => prev.map((s, i) =>
                    i === index ? { ...s, t2iStatus: undefined } : s
                ));
            }
            return;
        }
        if (parsedRefs.unresolved.length > 0) {
            toast.warning(`部分资产没有可用参考图：${parsedRefs.unresolved.slice(0, 3).join("、")}`);
        }
        const compositionData: any = {};
        if (refUrls.length > 0) {
            compositionData.reference_image_urls = refUrls;
        }
        const baseFramePrompt = resolveKeyframePrompt(taggedPrompt, shot, role);
        const povSubjectNames = isPovShotPrompt(baseFramePrompt, shot)
            ? parsedRefs.items
                .filter((item) => item.resolvedKind === "character")
                .map((item) => item.name)
            : [];
        const povPerspectiveConstraint = povSubjectNames.length || isPovShotPrompt(baseFramePrompt, shot)
            ? buildPovPerspectiveConstraint(povSubjectNames)
            : "";
        const imageReferenceInstruction = buildImageReferenceInstruction(parsedRefs.items, {
            povSubjectNames,
        });
        const framePrompt = [
            baseFramePrompt,
            povPerspectiveConstraint,
            imageReferenceInstruction,
        ].filter(Boolean).join("\n\n");

        try {
            const result = await api.renderFrame(
                currentProject.id,
                shot.id,
                compositionData,
                framePrompt,
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
                if (!isKeyframeRole) {
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, t2iTaskId: result.task_id, t2iStatus: "processing" } : s
                    ));
                }
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
                        t2iStatus: isKeyframeRole ? s.t2iStatus : "completed",
                    }, imageUrl);
                    const nextStartUrls = role === "start"
                        ? appendKeyframeCandidate(s.keyframeStartImageUrls, imageUrl)
                        : s.keyframeStartImageUrls ?? [];
                    const nextEndUrls = role === "end"
                        ? appendKeyframeCandidate(s.keyframeEndImageUrls, imageUrl)
                        : s.keyframeEndImageUrls ?? [];
                    const keyframePatch = role === "start"
                        ? { keyframe_start_image_url: imageUrl, keyframe_start_image_urls: nextStartUrls }
                        : role === "end"
                            ? { keyframe_end_image_url: imageUrl, keyframe_end_image_urls: nextEndUrls }
                            : {};
                    persistWorkbench(s.id, {
                        t2i_image_urls: updated.t2iImageUrls ?? [],
                        t2i_selected_index: updated.t2iSelectedIndex ?? 0,
                        ...keyframePatch,
                    });
                    return {
                        ...updated,
                        ...(role === "start" ? { keyframeStartImageUrl: imageUrl, keyframeStartImageUrls: nextStartUrls } : {}),
                        ...(role === "end" ? { keyframeEndImageUrl: imageUrl, keyframeEndImageUrls: nextEndUrls } : {}),
                    };
                }));
            } else {
                throw new Error("Render returned an empty response");
            }
        } catch (error) {
            debugLog.error("Studio", "Failed to generate T2I for shot:", error);
            if (isKeyframeRole) {
                toast.error(`${role === "start" ? "首帧" : "尾帧"}生成失败`);
            } else {
                setShots(prev => prev.map((s, i) =>
                    i === index ? { ...s, t2iStatus: "failed" } : s
                ));
            }
        } finally {
            if (isKeyframeRole) {
                setKeyframeGenerating(prev => setKeyframeBusy(prev, shot.id, role, false));
            }
        }
    }, [shots, currentProject, drawerAssetPools, updateProject, persistWorkbench, seriesAssetsLoading]);

    // Generate video for a shot
    const generateVideo = useCallback(async (index: number) => {
        const shot = shots[index];
        if (!currentProject || !shot.prompt.trim()) return;
        const isR2vTab = shot.tabMode === "keyframe_r2v" || shot.tabMode === "asset_compose";
        if (isR2vTab && seriesAssetsLoading) {
            toast.warning("资产库还在加载，请稍后再生成视频。");
            return;
        }

        const taggedPrompt = buildPromptWithReferenceTags(
            shot,
            drawerAssetPools.characters,
            drawerAssetPools.scenes,
            drawerAssetPools.props,
        );
        const promptText = isR2vTab ? taggedPrompt : buildAssembledPrompt(shot);

        setShots(prev => prev.map((s, i) =>
            i === index ? { ...s, videoStatus: "pending" } : s
        ));

        try {
            if (isR2vTab) {
                // R2V mode: use reference assets. We prefer the user's
                // explicit R2V model choice (videoConfig.r2vModel) over
                // the derived route from the I2V model. The derivation
                // is kept as a fallback when the explicit r2vModel is
                // missing or invalid (which can only happen if the
                // catalog flipped under our feet).
                const explicitR2v = videoConfig.r2vModel;
                const explicitOk = !!findR2vModel(explicitR2v) || isExternalVideoModel(explicitR2v);
                const routeModelId = explicitOk
                    ? explicitR2v
                    : getR2vRouteModelId(videoConfig.model);
                const isExternal = isExternalVideoModel(routeModelId);
                const isAgnes = routeModelId?.startsWith("agnes-");
                const isSeedance = routeModelId?.startsWith("seedance-");
                const imageBased = isExternal || isR2vImageBased(routeModelId);
                const parsedRefs = parseAssetTagsForVideoModel(taggedPrompt, shot, routeModelId);
                const keyframeRefs = getShotKeyframeUrls(shot);
                const referenceUrls = isSeedance
                    ? getSeedanceReferenceUrls(shot, keyframeRefs, parsedRefs.urls)
                    : imageBased ? keyframeRefs : parsedRefs.urls;
                if (imageBased && referenceUrls.length === 0) {
                    setShotErrors(prev => ({ ...prev, [shot.id]: agnesKeyframeError }));
                    toast.warning(agnesKeyframeError);
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoStatus: undefined } : s
                    ));
                    return;
                }
                if ((!imageBased && parsedRefs.unresolved.length > 0) || (referenceUrls.length === 0 && hasAssetReferenceTags(taggedPrompt) && !imageBased)) {
                    const unresolved = parsedRefs.unresolved.length > 0
                        ? parsedRefs.unresolved
                        : getUnresolvedAssetNames(taggedPrompt, shot);
                    const errMsg = `引用的「${unresolved.join("、")}」尚未生成图片，请先到素材步骤生成。`;
                    setShotErrors(prev => ({ ...prev, [shot.id]: errMsg }));
                    toast.warning(errMsg);
                    setShots(prev => prev.map((s, i) =>
                        i === index ? { ...s, videoStatus: undefined } : s
                    ));
                    return;
                }

                const tasks = await api.createVideoTask(
                    currentProject.id,
                    "",  // no image_url for R2V
                    isAgnes ? cleanPrompt(promptText) : promptText,
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
                    (isAgnes || isSeedance) && keyframeRefs.length > 1 ? "keyframes" : undefined,
                    undefined,
                    undefined, // kling params
                    undefined, undefined, // vidu params
                    imageBased ? referenceUrls : undefined, // referenceImageUrls
                );
                const task = firstCreatedVideoTask(tasks);

                if (task && task.id) {
                    updateProject(currentProject.id, {
                        video_tasks: [...(((currentProject as any).video_tasks ?? []) as any[]), task],
                    } as any);
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
                const i2vModelOk = i2vModelList.some(m => m.id === videoConfig.model);
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
                const task = firstCreatedVideoTask(tasks);

                if (task && task.id) {
                    updateProject(currentProject.id, {
                        video_tasks: [...(((currentProject as any).video_tasks ?? []) as any[]), task],
                    } as any);
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
    }, [shots, currentProject, drawerAssetPools, videoConfig, parseAssetTagsForVideoModel, seriesAssetsLoading, getUnresolvedAssetNames, findR2vModel, isExternalVideoModel, i2vModelList]);

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
        const tabMode = shot.tabMode;
        const isR2vTab = tabMode === "keyframe_r2v" || tabMode === "asset_compose";
        if (isR2vTab && seriesAssetsLoading) {
            toast.warning("资产库还在加载，请稍后再生成视频。");
            return;
        }
        const taggedPrompt = buildPromptWithReferenceTags(
            shot,
            drawerAssetPools.characters,
            drawerAssetPools.scenes,
            drawerAssetPools.props,
        );
        const promptText = isR2vTab ? taggedPrompt : buildAssembledPrompt(shot);
        const requestedCount = Math.max(1, Math.min(6, count || 1));
        let effectiveCount = requestedCount;
        const requestedR2vModelId = params?.model ?? videoConfig.r2vModel;
        const requestedRouteModelId = findR2vModel(requestedR2vModelId) || isExternalVideoModel(requestedR2vModelId)
            ? requestedR2vModelId
            : getR2vRouteModelId(videoConfig.model);
        if (isR2vTab && isExternalVideoModel(requestedRouteModelId) && requestedCount > 1) {
            effectiveCount = 1;
            toast.warning("Agnes 当前只支持单任务提交，已自动改为生成 1 个。");
        }

        // Pre-flight: R2V tab needs reference inputs. Without them
        // the backend rejects with 400 anyway, but historically the
        // task would queue, fail mid-generation, and the user'd see
        // "排队中..." until the failure surfaced. Cheaper to validate
        // here and show inline error in the ParamsSection.
        if (isR2vTab) {
            const r2vModelId = requestedR2vModelId;
            const r2vModel = findR2vModel(r2vModelId);
            const routeModelId = r2vModel ? r2vModelId : requestedRouteModelId;
            const isExternal = isExternalVideoModel(routeModelId);
            const imageBased = !isExternal && isR2vImageBased(routeModelId);
            const parsedRefs = parseAssetTagsForVideoModel(taggedPrompt, shot, routeModelId);
            const keyframeRefs = getShotKeyframeUrls(shot);
            const refs = (isExternal || imageBased) ? keyframeRefs : parsedRefs.urls;
            if ((isExternal || imageBased) && refs.length === 0) {
                setShotErrors(prev => ({ ...prev, [shot.id]: agnesKeyframeError }));
                toast.warning(agnesKeyframeError);
                return;
            }
            // External video models (e.g. agnes-video-v2.0) can do
            // pure T2V without reference images, but the keyframe workflow
            // deliberately requires a complete shot image so asset sheets are
            // never sent as provider refs.
            const hasTags = hasAssetReferenceTags(taggedPrompt);
            if ((!isExternal && !imageBased && parsedRefs.unresolved.length > 0) || (refs.length === 0 && (hasTags || !isExternal) && !isExternal && !imageBased)) {
                let errMsg: string;
                if (hasTags) {
                    const unresolved = parsedRefs.unresolved.length > 0
                        ? parsedRefs.unresolved
                        : getUnresolvedAssetNames(taggedPrompt, shot);
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
            const createOne = async (): Promise<VideoTask | null> => {
                if (isR2vTab) {
                    const explicitR2v = params?.model ?? videoConfig.r2vModel;
                    const explicitOk = !!findR2vModel(explicitR2v) || isExternalVideoModel(explicitR2v);
                    const routeModelId = explicitOk
                        ? explicitR2v
                        : getR2vRouteModelId(videoConfig.model);
                    const isExternal = isExternalVideoModel(routeModelId);
                    const isAgnes = routeModelId?.startsWith("agnes-");
                    const isSeedance = routeModelId?.startsWith("seedance-");
                    const imageBased = isExternal || isR2vImageBased(routeModelId);
                    const parsedRefs = parseAssetTagsForVideoModel(taggedPrompt, shot, routeModelId);
                    const keyframeRefs = getShotKeyframeUrls(shot);
                    const referenceUrls = isSeedance
                        ? getSeedanceReferenceUrls(shot, keyframeRefs, parsedRefs.urls)
                        : imageBased ? keyframeRefs : parsedRefs.urls;
                    const tasks = await api.createVideoTask(
                        currentProject.id,
                        "",
                        isAgnes ? cleanPrompt(promptText) : promptText,
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
                        (isAgnes || isSeedance) && keyframeRefs.length > 1 ? "keyframes" : undefined,
                        undefined,
                        undefined,
                        undefined, undefined,
                        imageBased ? referenceUrls : undefined,
                        params?.ratio,
                        tabMode,
                        params?.watermark,
                    );
                    return firstCreatedVideoTask(tasks);
                }
                // I2V branch — same defensive check on the model.
                const i2vModelId = params?.model ?? videoConfig.model;
                const i2vModelOk = i2vModelList.some(m => m.id === i2vModelId);
                if (!i2vModelOk) {
                    debugLog.warn("Studio", `Refusing I2V submission with non-I2V model "${i2vModelId}".`);
                    throw new Error(`当前分镜被当作 I2V 提交，但模型「${i2vModelId}」不是 I2V 模型。请切到首帧 I2V，或在资产合成/关键帧 R2V 中使用 R2V 模型。`);
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
                return firstCreatedVideoTask(tasks);
            };

            const createdTasks = (await Promise.all(
                Array.from({ length: effectiveCount }, createOne),
            )).filter((task): task is VideoTask => !!task?.id);
            const taskIds = createdTasks.map((task) => task.id);

            if (taskIds.length > 0) {
                const existingTasks = (((currentProject as any).video_tasks ?? []) as VideoTask[]);
                const existingIds = new Set(existingTasks.map((task) => task.id));
                updateProject(currentProject.id, {
                    video_tasks: [
                        ...existingTasks,
                        ...createdTasks.filter((task) => !existingIds.has(task.id)),
                    ],
                } as any);
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
    }, [shots, currentProject, drawerAssetPools, videoConfig, parseAssetTagsForVideoModel, findR2vModel, isExternalVideoModel, seriesAssetsLoading, getUnresolvedAssetNames, i2vModelList]);

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
                    setShots(prev => fresh.frames.map((frame: any) =>
                        preserveLocalWorkbenchState(
                            frameToShotNode(frame, fresh),
                            prev.find((shot) => shot.id === frame.id),
                        )
                    ));
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
        : (i2vModelList.find(m => m.id === videoConfig.model)?.name ?? videoConfig.model);

    // ---- Project-level task derivations (drive Candidates + status sync) ----
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

    // Sync shot.videoStatus from project.video_tasks when the
    // project-level poll refreshes. Video task status is only visible
    // via project refresh (GET /tasks/ only covers asset tasks).
    useEffect(() => {
        if (!allVideoTasks.length) return;
        setShots(prev => {
            let changed = false;
            const next = prev.map(s => {
                const shotTasks = allVideoTasks.filter((t: any) => {
                    if (t.frame_id !== s.id) return false;
                    if (t.workbench_tab != null) return normalizeWorkbenchTabMode(t.workbench_tab) === s.tabMode;
                    if (s.tabMode === "keyframe_r2v") return t.generation_mode === "r2v";
                    if (s.tabMode === "asset_compose") return false;
                    return t.generation_mode !== "r2v";
                });
                const task = shotTasks.find(t => t.status === "pending" || t.status === "processing")
                    || (s.videoTaskId ? allVideoTasks.find(t => t.id === s.videoTaskId) : undefined)
                    || [...shotTasks].reverse().find(t => t.status === "completed" && t.video_url)
                    || [...shotTasks].reverse().find(t => t.status === "failed");
                if (!task) return s;
                if ((task.status === "pending" || task.status === "processing") && (s.videoStatus !== task.status || s.videoTaskId !== task.id)) {
                    changed = true;
                    return { ...s, videoStatus: task.status as "pending" | "processing", videoTaskId: task.id };
                }
                if (task.status === "completed" && (s.videoStatus !== "completed" || s.videoTaskId !== task.id)) {
                    changed = true;
                    return { ...s, videoStatus: "completed" as const, videoUrl: (task as any).video_url, videoTaskId: task.id };
                }
                if (task.status === "failed" && (s.videoStatus !== "failed" || s.videoTaskId !== task.id)) {
                    changed = true;
                    return { ...s, videoStatus: "failed" as const, videoTaskId: task.id };
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
                return normalizeWorkbenchTabMode(t.workbench_tab) === shot.tabMode;
            }
            // Legacy fallback: i2v tasks belong in t2i_i2v, r2v in keyframe_r2v.
            if (shot.tabMode === "keyframe_r2v") return t.generation_mode === "r2v";
            if (shot.tabMode === "asset_compose") return false;
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
        const isR2v = shot.tabMode === "keyframe_r2v" || shot.tabMode === "asset_compose";
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
        const isR2v = shot.tabMode === "keyframe_r2v" || shot.tabMode === "asset_compose";
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
            } else if (i2vModelList.some(m => m.id === first.model)) {
                updated.model = first.model!;
            }
            if (first.duration) updated.duration = first.duration;
            if (first.resolution) updated.resolution = first.resolution;
            if (first.negative_prompt !== undefined) updated.negativePrompt = first.negative_prompt;
            return updated;
        });
    }, [findR2vModel, isExternalVideoModel, i2vModelList]);

    // Active candidate URL resolver — many backend video URLs are
    // relative paths needing the asset prefix to render in <video>.
    const resolveAssetUrl = useCallback((u: string) => getAssetUrl(u), []);

    // In-flight shot count for trailing slot stat
    const totalInFlight = useMemo(
        () => Object.values(shotCounts).reduce((acc: number, c: any) => acc + (c?.processing ?? 0) + (c?.pending ?? 0), 0),
        [shotCounts],
    );

    return (
        // Layout v4: outer shell keeps the storyboard column full-height.
        <div className="h-full flex overflow-hidden relative">
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
                    </>
                )}
            />
            {/* Top Toolbar — 简化版：只保留 shot 计数 / + shot / 全展开-全折叠
                model name + 画风 已上移到 StepHeader trailing. */}
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
                    const isKeyframeTab = shot.tabMode === "keyframe_r2v";
                    const isAssetComposeTab = shot.tabMode === "asset_compose";
                    const keyframeUrls = getShotKeyframeUrls(shot);
                    const keyframeSourceOptions = collectKeyframeSourceOptions(shot);
                    const taggedPromptForShot = buildPromptWithReferenceTags(
                        shot,
                        drawerAssetPools.characters,
                        drawerAssetPools.scenes,
                        drawerAssetPools.props,
                    );
                    const imageReferenceSummary = parseAssetReferenceTags(taggedPromptForShot, drawerAssetPools, shot);
                    const imageReferenceCount = imageReferenceSummary.urls.length;
                    const imageReferenceUnresolvedCount = imageReferenceSummary.unresolved.length;
                    const keyframeStartPrompt = shot.keyframeStartPrompt
                        || defaultKeyframePrompt(taggedPromptForShot, shot, "start");
                    const keyframeEndPrompt = shot.keyframeEndPrompt
                        || defaultKeyframePrompt(taggedPromptForShot, shot, "end");
                    const storyboardImagePrompt = shot.storyboardImagePrompt
                        ?? defaultKeyframePrompt(taggedPromptForShot, shot, "neutral");
                    const modelList = (isKeyframeTab || isAssetComposeTab) ? r2vModelList : i2vModelList;
                    return (
                    /* Plain div (was motion.div) — staggered enter
                       animation re-fired every time the user switched
                       step tabs and came back, causing a noticeable
                       全 list opacity flicker. ShotCard hover micro-
                       motion is kept inside the card itself. */
                    <div
                        key={shot.id}
                    >
                        <ShotCard
                            shot={shot}
                            index={index}
                            totalShots={shots.length}
                            characters={drawerAssetPools.characters}
                            scenes={drawerAssetPools.scenes}
                            props={drawerAssetPools.props}
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
                            /* PR-3c · 闭环生成: ShotCard 内全宽生成行 + count selector. */
                            generateCount={paramsState.count}
                            canGenerate={
                                shot.prompt.trim().length > 0
                                && (
                                    (isKeyframeTab && keyframeUrls.length > 0)
                                    || isAssetComposeTab
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
                        {/* Attached workbench:
                            首帧 I2V / 资产合成: generate or upload complete keyframes.
                            关键帧 R2V: choose complete keyframes, then generate takes. */}
                        {expandedShots.has(shot.id) ? (
                        <div className="relative ml-7 mr-2 mt-1.5 border-l border-primary/20 pl-4 pb-2 motion-safe:animate-[shotPanelIn_220ms_cubic-bezier(0.22,1,0.36,1)_both] md:ml-12 md:pl-5">
                            <span className="absolute -left-[5px] top-3 h-2.5 w-2.5 rounded-full border border-primary/45 bg-[#050508] shadow-[0_0_10px_rgba(100,108,255,0.28)]" aria-hidden="true" />
                            <div className="mb-2 flex items-center gap-2">
                                <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.2em] text-primary/70">
                                    Workbench
                                </span>
                                <span className="h-px flex-1 bg-gradient-to-r from-primary/20 via-white/[0.05] to-transparent" aria-hidden="true" />
                                <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-text-muted">
                                    #{String(index + 1).padStart(2, "0")}
                                </span>
                            </div>
                            {(isI2vTab || isAssetComposeTab) ? (
                                <div className="overflow-hidden rounded-md border border-white/[0.07] bg-black/18 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
                                    <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-1.5">
                                        <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.18em] text-text-muted">
                                            Asset refs
                                        </span>
                                        <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
                                            imageReferenceCount > 0
                                                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                                                : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                                        }`}>
                                            {imageReferenceCount > 0
                                                ? `生成当前帧会引用 ${imageReferenceCount} 张资产图`
                                                : "未解析到资产参考图"}
                                            {imageReferenceUnresolvedCount > 0 ? ` · ${imageReferenceUnresolvedCount} 个未就绪` : ""}
                                        </span>
                                    </div>
                                    <label className="block border-b border-white/[0.06] px-3 py-2.5">
                                        <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">
                                            分镜图提示词
                                        </span>
                                        <textarea
                                            value={storyboardImagePrompt}
                                            onChange={(e) => updateStoryboardImagePrompt(index, e.target.value)}
                                            rows={3}
                                            className="w-full resize-y rounded-md border border-glass-border bg-black/30 px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-text-muted focus:border-primary/45 focus:bg-black/40"
                                        />
                                    </label>
                                    <T2ISubsection
                                        imageUrls={shot.t2iImageUrls ?? []}
                                        selectedIndex={shot.t2iSelectedIndex ?? 0}
                                        storyboardFrameUrl={shot.imageUrl || undefined}
                                        promptIsEmpty={!storyboardImagePrompt.trim()}
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
                                        onUpload={(file) => uploadT2IForShot(index, shot, file)}
                                        resolveUrl={resolveAssetUrl}
                                    />
                                </div>
                            ) : null}
                            {isKeyframeTab ? (
                                <div className="border-b border-glass-border px-4 py-3">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div>
                                            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">
                                                Keyframes
                                            </div>
                                            <div className="text-[13px] font-semibold text-foreground">
                                                首尾帧设定
                                            </div>
                                        </div>
                                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                                            imageReferenceCount > 0
                                                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                                                : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                                        }`}>
                                            {imageReferenceCount > 0
                                                ? `生成首尾帧会引用 ${imageReferenceCount} 张资产图`
                                                : "未解析到资产参考图"}
                                            {imageReferenceUnresolvedCount > 0 ? ` · ${imageReferenceUnresolvedCount} 个未就绪` : ""}
                                        </span>
                                    </div>
                                    <div className="mb-3 grid gap-3 lg:grid-cols-2">
                                        {([
                                            { role: "start" as const, label: "首帧提示词", value: keyframeStartPrompt },
                                            { role: "end" as const, label: "尾帧提示词", value: keyframeEndPrompt },
                                        ]).map((item) => (
                                            <label key={item.role} className="block">
                                                <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">
                                                    {item.label}
                                                </span>
                                                <textarea
                                                    value={item.value}
                                                    onChange={(e) => updateKeyframePrompt(index, item.role, e.target.value)}
                                                    rows={3}
                                                    className="w-full resize-y rounded-md border border-glass-border bg-black/30 px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-text-muted focus:border-primary/45 focus:bg-black/40"
                                                />
                                            </label>
                                        ))}
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        {([
                                            {
                                                role: "start" as const,
                                                label: "首帧",
                                                url: shot.keyframeStartImageUrl || keyframeUrls[0],
                                                required: true,
                                            },
                                            {
                                                role: "end" as const,
                                                label: "尾帧",
                                                url: shot.keyframeEndImageUrl || keyframeUrls[1],
                                                required: false,
                                            },
                                        ]).map((slot) => {
                                            const url = slot.url;
                                            const slotCandidates = slot.role === "start"
                                                ? shot.keyframeStartImageUrls ?? []
                                                : shot.keyframeEndImageUrls ?? [];
                                            const isBusy = !!keyframeGenerating[shot.id]?.[slot.role];
                                            const isUploading = !!keyframeUploading[shot.id]?.[slot.role];
                                            const slotBusy = isBusy || isUploading;
                                            const slotPrompt = slot.role === "start" ? keyframeStartPrompt : keyframeEndPrompt;
                                            const canGenerateSlot = !!slotPrompt.trim() && !slotBusy;
                                            const uploadInputId = `keyframe-upload-${shot.id}-${slot.role}`;
                                            return (
                                                <div
                                                    key={slot.role}
                                                    className="overflow-hidden rounded-lg border border-glass-border bg-black/30"
                                                >
                                                    <div className="flex items-center justify-between border-b border-glass-border px-3 py-2">
                                                        <span className="text-[12px] font-semibold text-foreground">{slot.label}</span>
                                                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                                                            {url ? "Ready" : slot.required ? "Required" : "Optional"}
                                                        </span>
                                                    </div>
                                                    <div
                                                        className="relative grid place-items-center overflow-hidden bg-black/45"
                                                        style={{ height: 132 }}
                                                    >
                                                        {url ? (
                                                            <img
                                                                src={resolveAssetUrl(url)}
                                                                alt={slot.label}
                                                                className="absolute inset-0 h-full w-full object-contain"
                                                            />
                                                        ) : (
                                                            <div className="flex flex-col items-center gap-2 text-text-muted">
                                                                <ImageIcon size={22} />
                                                                <span className="text-[12px]">
                                                                    {slot.required ? "请先生成首帧" : "可继续生成尾帧"}
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="relative z-10 space-y-2 border-t border-glass-border bg-[#050508]/95 p-3">
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => generateT2I(index, slot.role)}
                                                                disabled={!canGenerateSlot}
                                                                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[12px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/16 disabled:cursor-not-allowed disabled:opacity-45"
                                                            >
                                                                {isBusy ? (
                                                                    <Loader2 size={13} className="animate-spin" />
                                                                ) : (
                                                                    <Sparkles size={13} />
                                                                )}
                                                                {url ? "重新生成" : "生成"}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => document.getElementById(uploadInputId)?.click()}
                                                                disabled={slotBusy}
                                                                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-glass-border bg-black/25 px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
                                                            >
                                                                {isUploading ? (
                                                                    <Loader2 size={13} className="animate-spin" />
                                                                ) : (
                                                                    <Upload size={13} />
                                                                )}
                                                                上传
                                                            </button>
                                                            <input
                                                                id={uploadInputId}
                                                                type="file"
                                                                accept={KEYFRAME_UPLOAD_TYPES.join(",")}
                                                                className="sr-only"
                                                                onChange={(e) => {
                                                                    const file = e.target.files?.[0];
                                                                    if (file) void uploadKeyframeImage(index, shot, slot.role, file);
                                                                    e.target.value = "";
                                                                }}
                                                            />
                                                        </div>
                                                        {keyframeSourceOptions.length > 0 ? (
                                                            <div>
                                                                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                                                                    可选分镜图
                                                                </div>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    {keyframeSourceOptions.map((source, sourceIndex) => {
                                                                        const active = source.url === url;
                                                                        return (
                                                                            <button
                                                                                key={`${slot.role}-source-${source.url}-${sourceIndex}`}
                                                                                type="button"
                                                                                onClick={() => selectKeyframeImage(index, slot.role, source.url)}
                                                                                title={`选择 ${source.label} 为${slot.label}`}
                                                                                aria-label={`选择 ${source.label} 为${slot.label}`}
                                                                                className={`group relative h-12 w-16 overflow-hidden rounded border transition-colors ${
                                                                                    active
                                                                                        ? "border-primary bg-primary/10"
                                                                                        : "border-glass-border bg-black/30 hover:border-white/25"
                                                                                }`}
                                                                            >
                                                                                <img
                                                                                    src={resolveAssetUrl(source.url)}
                                                                                    alt={source.label}
                                                                                    className="h-full w-full object-contain"
                                                                                />
                                                                                <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-1 py-0.5 text-[9px] text-white/85 opacity-0 transition-opacity group-hover:opacity-100">
                                                                                    {source.label}
                                                                                </span>
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        ) : null}
                                                        {slotCandidates.length > 0 ? (
                                                            <div>
                                                                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                                                                    当前槽位候选
                                                                </div>
                                                            <div className="flex flex-wrap gap-1.5">
                                                                {slotCandidates.map((candidateUrl, candidateIndex) => {
                                                                    const active = candidateUrl === url;
                                                                    return (
                                                                        <button
                                                                            key={`${slot.role}-${candidateUrl}-${candidateIndex}`}
                                                                            type="button"
                                                                            onClick={() => selectKeyframeImage(index, slot.role, candidateUrl)}
                                                                            aria-label={`选择为${slot.label} ${candidateIndex + 1}`}
                                                                            className={`h-12 w-16 overflow-hidden rounded border transition-colors ${
                                                                                active
                                                                                    ? "border-primary bg-primary/10"
                                                                                    : "border-glass-border bg-black/30 hover:border-white/25"
                                                                            }`}
                                                                        >
                                                                            <img
                                                                                src={resolveAssetUrl(candidateUrl)}
                                                                                alt={`候选 ${candidateIndex + 1}`}
                                                                                className="h-full w-full object-contain"
                                                                            />
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : null}
                            <div className={(isI2vTab || isKeyframeTab || isAssetComposeTab) ? "mt-2 overflow-hidden rounded-md border border-white/[0.07] bg-black/[0.18]" : ""}>
                                <ParamsSection
                                    shotId={shot.id}
                                    modelList={modelList}
                                    title={isI2vTab ? "I2V Params" : isAssetComposeTab ? "Video Output Model" : "Keyframe R2V Params"}
                                    params={paramsState}
                                    onChange={(next) => handleShotParamsChange(shot, next)}
                                    inFlightCount={shotInFlight}
                                    errorMessage={shotErrors[shot.id] ?? null}
                                />
                            </div>
                            <div className="mt-2 overflow-hidden rounded-md border border-white/[0.07] bg-black/[0.18]">
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
                                    onUploadVideo={(file) => uploadVideoCandidate(index, shot, file, paramsState.model)}
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
                characters={drawerAssetPools.characters}
                scenes={drawerAssetPools.scenes}
                props={drawerAssetPools.props}
                onSelectAsset={insertAssetFromDrawer}
            />
        </div>
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
