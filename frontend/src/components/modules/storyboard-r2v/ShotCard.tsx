"use client";

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Link2,
    Trash2,
    ChevronUp,
    ChevronDown,
    Copy,
    Video,
    ImageIcon,
    AtSign,
    Maximize2,
    PanelBottomOpen,
    PanelBottomClose,
    Sparkles,
    Loader2,
    ChevronRight,
} from "lucide-react";
import { useTranslations } from "next-intl";
import AssetChipBar from "./AssetChipBar";
import PromptExpandModal from "./PromptExpandModal";

import FieldTagChip, { AddFieldButton, type FieldType } from "./FieldTagChip";
import { buildPromptWithReferenceTags, normalizeReferenceTokensForEditor } from "./buildAssembledPrompt";
import { PendingTaskAffordance } from "@/components/shared/PendingTaskAffordance";
import { api } from "@/lib/api";
import { toast } from "@/store/toastStore";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import PreviewVideo from "@/components/shared/preview/PreviewVideo";
import { useProjectStore } from "@/store/projectStore";
import {
    parseAssetReferenceTags,
    resolveAssetReferenceImage,
    type AssetKind,
} from "./assetReferences";

export type WorkbenchTabMode = "t2i_i2v" | "keyframe_r2v" | "asset_compose";

export interface ShotNode {
    id: string;
    prompt: string;
    tabMode: WorkbenchTabMode;

    // T2I stage (only for t2i_i2v mode). Single-task fields stay here
    // for backward compat with existing shot drafts and the legacy
    // single-image preview. New: a history of generated T2I images per
    // shot + an index for the currently-active one (the one used as
    // first-frame for I2V). Persisted in localStorage with the rest of
    // the shot state. See Storyboard R2V redesign discussion.
    t2iImageUrl?: string;
    t2iTaskId?: string;
    t2iStatus?: "pending" | "processing" | "completed" | "failed";
    /** Ordered list of every T2I image URL this shot has produced.
     *  Newest at the end. Active one is at t2iSelectedIndex (defaults
     *  to last). Bounded to T2I_HISTORY_LIMIT FIFO to keep
     *  localStorage from growing without bound. */
    t2iImageUrls?: string[];
    t2iSelectedIndex?: number;

    // Video stage (shared). The single-task fields stay for "the most
    // recent attempt" but the candidates panel reads from the shot's
    // full videoTaskIds history (cross-referenced against the script's
    // video_tasks list which is persisted server-side).
    videoUrl?: string;
    videoTaskId?: string;
    videoStatus?: "pending" | "processing" | "completed" | "failed";
    /** Issue 16 — final take selection (Z plan). Set in Assembly stage; read
     *  by Storyboard's ShotCard top preview as the canonical "this is the
     *  shipped output". Falls back to latest starred / latest completed /
     *  first frame when null. */
    finalTakeId?: string | null;
    /** Every video task this shot has spawned, oldest first. Each workbench tab
     *  gets its own list — `direct_r2v` is kept only for legacy records.
     *  Empty / missing → no history (e.g. legacy shots). */
    videoTaskIdsByTab?: {
        t2i_i2v?: string[];
        keyframe_r2v?: string[];
        asset_compose?: string[];
        direct_r2v?: string[];
    };
    imageUrl?: string;

    // Structured references mirrored from backend StoryboardFrame.
    // These drive hidden R2V reference tags even when the editable prompt is
    // clean natural language after AI polish.
    sceneId?: string | null;
    characterIds?: string[];
    propIds?: string[];
    characterStageRefs?: Record<string, string>;
    sceneStageRef?: string | null;

    // ─── Storyboard Schema v2 fields ────────────────────────────────
    duration?: number | null;
    visualDescription?: string | null;
    assembledPrompt?: string | null;
    dialogueStructured?: {
        speaker: string;
        line: string;
        emotion?: string | null;
        delivery?: string | null;
    } | null;
    cameraMovementStructured?: {
        primary: string;
        secondary?: string | null;
        speed: string;
        description?: string | null;
    } | null;
    shotSize?: string | null;
    cameraAngle?: string | null;
    transitionHint?: string | null;
    storyboardImagePrompt?: string | null;
    keyframeStartPrompt?: string | null;
    keyframeEndPrompt?: string | null;
    keyframeStartImageUrl?: string | null;
    keyframeEndImageUrl?: string | null;
    keyframeStartImageUrls?: string[];
    keyframeEndImageUrls?: string[];
}

/** Cap on T2I image history per shot. Older drops off FIFO when adding. */
export const T2I_HISTORY_LIMIT = 10;

function promptDeclaresNoCharacters(prompt: string): boolean {
    const match = prompt.match(/角色\s*[：:]\s*([^】\]\n。；;]+)/);
    if (!match) return false;
    const firstValue = match[1].split(/[·,，、]/)[0]?.trim().toLowerCase() ?? "";
    return /^(无|なし|none|no|n\/a|空|没有|无人)$/.test(firstValue);
}

interface ShotCardProps {
    shot: ShotNode;
    index: number;
    totalShots: number;
    characters: any[];
    scenes: any[];
    props: any[];
    onUpdatePrompt: (prompt: string) => void;
    onUpdateField: (field: string, value: string | number | null) => void;
    onGenerateT2I: () => void;
    onAutoLink?: () => void;
    onGenerateVideo: () => void;
    onDelete: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onDuplicate: () => void;
    onSetTabMode: (mode: WorkbenchTabMode) => void;
    onOpenDrawer: () => void;
    onInsertAsset: (type: string, name: string) => void;
    /** Duration editor config derived from model catalog */
    durationEditorConfig?: { min: number; max: number; step: number };
    /** Optional: Cancel CTA shown inside the pending-state affordance
     *  after the soft-stuck threshold (60 s by default). Caller should
     *  hit the backend cancel endpoint and refresh local state. */
    onCancelVideo?: () => Promise<void> | void;
    /** Issue 16 — per-shot expand state (P plan). When false, the
     *  Setup/Takes chips below the card are hidden entirely (zero chrome
     *  residue). When true, chips render. The chevron in the card's
     *  top-right corner toggles this. */
    expanded: boolean;
    onToggleExpanded: () => void;
    /** PR-3c · 闭环生成. Generation 移到 ShotCard 内的全宽行 (Action
     *  Bar 之后, disclosure bar 之前), 含 count selector 同行. Host
     *  传入 current count + handlers + canGenerate gate.
     *  Spec: r2v-workflow-v3-unified.md §4.3.1 / Q12. */
    generateCount?: number;
    canGenerate?: boolean;
    onSetGenerateCount?: (count: number) => void;
    onGenerateBatch?: (count: number) => void;
    /** Active in-flight count for label flip (生成 ×N → 生成中 · N). */
    inFlightCount?: number;
    onRefineFrame?: () => void;
    onUpdateDialogue?: (text: string) => void;
}

export default function ShotCard({
    shot,
    index,
    totalShots,
    characters,
    scenes,
    props,
    onUpdatePrompt,
    onUpdateField,
    onGenerateT2I,
    onGenerateVideo,
    onDelete,
    onMoveUp,
    onMoveDown,
    onDuplicate,
    onSetTabMode,
    onOpenDrawer,
    onInsertAsset: _onInsertAsset,
    durationEditorConfig,
    onCancelVideo,
    expanded,
    onToggleExpanded,
    generateCount = 1,
    canGenerate = true,
    onSetGenerateCount,
    onGenerateBatch,
    inFlightCount = 0,
    onRefineFrame,
    onAutoLink,
}: ShotCardProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const t = useTranslations("storyboardR2V");
    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const rect = cardRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        cardRef.current?.style.setProperty("--spotlight-x", `${x}%`);
        cardRef.current?.style.setProperty("--spotlight-y", `${y}%`);
    }, []);

    // Expand modal state (B5). Cmd/Ctrl+E in the small textarea
    // discards the modal's draft without touching parent state.
    const [expandOpen, setExpandOpen] = useState(false);
    const [isLinking, setIsLinking] = useState(false);
    const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
    // project's PromptConfig override server-side.
    const currentProjectId = useProjectStore((state) => state.currentProject?.id);
    const promptWithReferenceTags = useMemo(() => buildPromptWithReferenceTags(shot, characters, scenes, props), [
        shot,
        characters,
        scenes,
        props,
    ]);

    const appearingAssets = useMemo(() => {
        const refs: Array<{ id: string; name: string; kind: AssetKind; imageUrl?: string }> = [];
        const seen = new Set<string>();
        const add = (asset: any, kind: AssetKind, imageUrl?: string) => {
            if (!asset) return;
            const key = `${kind}:${asset.id || asset.name}`;
            if (seen.has(key)) return;
            seen.add(key);
            refs.push({
                id: String(asset.id || asset.name || key),
                name: String(asset.name || "未命名资产"),
                kind,
                imageUrl,
            });
        };

        if (!promptDeclaresNoCharacters(shot.prompt)) {
            (shot.characterIds ?? []).forEach((id) => {
                const asset = characters.find((item: any) => item.id === id);
                add(
                    asset,
                    "character",
                    resolveAssetReferenceImage(asset, "character", asset ? shot.characterStageRefs?.[asset.id] : undefined),
                );
            });
        }

        if (shot.sceneId) {
            const asset = scenes.find((item: any) => item.id === shot.sceneId);
            add(asset, "scene", resolveAssetReferenceImage(asset, "scene", shot.sceneStageRef));
        }

        (shot.propIds ?? []).forEach((id) => {
            const asset = props.find((item: any) => item.id === id);
            add(asset, "prop", resolveAssetReferenceImage(asset, "prop"));
        });

        // This strip is a visible editing aid, so it should reflect explicit
        // shot references instead of hidden tags injected for model submission.
        const parsedTags = parseAssetReferenceTags(shot.prompt, { characters, scenes, props }, shot);
        parsedTags.items.forEach((item) => {
            const pool = item.resolvedKind === "character"
                ? characters
                : item.resolvedKind === "scene"
                    ? scenes
                    : props;
            const asset = pool.find((candidate: any) => candidate.name === item.name);
            add(
                asset || { id: item.name, name: item.name },
                item.resolvedKind,
                item.url,
            );
        });

        return refs;
    }, [
        shot,
        characters,
        scenes,
        props,
    ]);

    const assembledPromptPreview = promptWithReferenceTags || shot.assembledPrompt || shot.prompt || "";

    const handleSingleAutoLink = useCallback(async () => {
        if (!currentProjectId) return;
        setIsLinking(true);
        try {
            // Regex name matching: match character/scene names in frame text
            await api.autoLinkSingleFrame(currentProjectId, shot.id);
            toast.success("已引用资源");
            // Notify parent to refresh this frame's data
            onAutoLink?.();
        } catch (err) {
            console.error("Auto-link failed", err);
            toast.error("引用资源失败");
        } finally {
            setIsLinking(false);
        }
    }, [currentProjectId, shot.id, onAutoLink]);


    const renderPreview = () => {
        const fallbackImageUrl = shot.t2iImageUrl || shot.imageUrl;
        const renderImageFallback = (showVideoRetry = false) => (
            <div className="w-full aspect-video relative">
                <PreviewImage
                    src={fallbackImageUrl || ""}
                    alt={t("t2iCompleted") || "Storyboard frame"}
                    className="w-full h-full"
                />
                {showVideoRetry ? (
                    <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2 rounded-md border border-status-failed-border bg-status-failed-bg/85 px-2 py-1 backdrop-blur-sm">
                        <span className="text-[10px] font-medium text-status-failed-fg">{t("generationFailed")}</span>
                        <button
                            type="button"
                            onClick={onGenerateVideo}
                            className="text-[10px] font-medium text-primary hover:text-primary/80"
                        >
                            {t("retry")}
                        </button>
                    </div>
                ) : (
                    <div className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded-full bg-black/65 text-white/90 font-medium backdrop-blur-sm pointer-events-none">
                        分镜图
                    </div>
                )}
            </div>
        );

        if (shot.tabMode === "t2i_i2v") {
            if (shot.videoUrl) {
                return (
                    <PreviewVideo
                        src={shot.videoUrl}
                        alt={t("generatedVideo") || "Generated video"}
                        className="w-full aspect-video"
                    />
                );
            }
            if (shot.videoStatus === "processing" || shot.videoStatus === "pending") {
                return (
                    <div className="w-full aspect-video flex items-center justify-center">
                        <PendingTaskAffordance
                            statusLabel={shot.videoStatus === "pending" ? t("queued") : t("generatingVideo")}
                            taskId={shot.videoTaskId}
                            onCancel={onCancelVideo}
                        />
                    </div>
                );
            }
            if (shot.videoStatus === "failed" && fallbackImageUrl) {
                return renderImageFallback(true);
            }
            if (shot.videoStatus === "failed") {
                return (
                    <div className="w-full aspect-video flex flex-col items-center justify-center gap-2">
                        <span className="text-[11px] text-rose-400 font-medium">{t("generationFailed")}</span>
                        <button
                            onClick={onGenerateVideo}
                            className="text-[11px] text-primary hover:text-primary/80 transition-colors font-medium"
                        >
                            {t("retry")}
                        </button>
                    </div>
                );
            }
            if (fallbackImageUrl) {
                // Fixed: was rendering raw `<img src={shot.t2iImageUrl}>` —
                // shot.t2iImageUrl is a relative path (e.g. "uploads/t2i_xxx.jpg")
                // which the browser resolved against the current origin → 404 →
                // broken icon + "Generated frame" alt fallback. PreviewImage
                // routes through getAssetUrl() (Issue 14).
                //
                // Issue 15: bottom badge label changed to "next: generate
                // video →" so the user knows the first frame is in place and
                // the next step is downstream, not another image gen.
                return (
                    <div className="w-full aspect-video relative">
                        <PreviewImage
                            src={fallbackImageUrl}
                            alt={t("t2iCompleted") || "First frame"}
                            className="w-full h-full"
                        />
                        <div className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/90 text-white font-medium backdrop-blur-sm pointer-events-none">
                            {t("generateVideoNext")}
                        </div>
                    </div>
                );
            }
            if (shot.t2iStatus === "processing" || shot.t2iStatus === "pending") {
                return (
                    <div className="w-full aspect-video flex items-center justify-center">
                        <PendingTaskAffordance
                            statusLabel={shot.t2iStatus === "pending" ? t("queued") : t("t2iGenerating")}
                            taskId={shot.t2iTaskId}
                        />
                    </div>
                );
            }
            if (shot.t2iStatus === "failed") {
                return (
                    <div className="w-full aspect-video flex flex-col items-center justify-center gap-2">
                        <span className="text-[11px] text-rose-400 font-medium">{t("generationFailed")}</span>
                        <button
                            onClick={onGenerateT2I}
                            className="text-[11px] text-primary hover:text-primary/80 transition-colors font-medium"
                        >
                            {t("retry")}
                        </button>
                    </div>
                );
            }
            // I2V tab, no first frame yet — the active CTA is in the
            // Step 1 panel below (Hero state), not here. Just signal
            // "waiting for a first frame" so the user knows where to
            // act (Issue 15).
            return (
                <div className="w-full aspect-video flex flex-col items-center justify-center gap-2 text-text-secondary/60">
                    <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                        <ImageIcon size={18} strokeWidth={1.5} />
                    </div>
                    <span className="text-[11px] font-medium">{t("generateImageOrUpload")}</span>
                    <span className="text-[10px] text-text-muted">↓ Step 1</span>
                </div>
            );
        }

        // Direct R2V mode
        if (shot.videoUrl) {
            return (
                <PreviewVideo
                    src={shot.videoUrl}
                    alt={t("generatedVideo") || "Generated video"}
                    className="w-full aspect-video"
                />
            );
        }
        if (shot.videoStatus === "processing" || shot.videoStatus === "pending") {
            return (
                <div className="w-full aspect-video flex items-center justify-center">
                    <PendingTaskAffordance
                        statusLabel={shot.videoStatus === "pending" ? t("queued") : t("generatingVideo")}
                        taskId={shot.videoTaskId}
                        onCancel={onCancelVideo}
                    />
                </div>
            );
        }
        if (shot.videoStatus === "failed" && fallbackImageUrl) {
            return renderImageFallback(true);
        }
        if (fallbackImageUrl) {
            return renderImageFallback(false);
        }
        if (shot.videoStatus === "failed") {
            return (
                <div className="w-full aspect-video flex flex-col items-center justify-center gap-2">
                    <span className="text-[11px] text-rose-400 font-medium">{t("generationFailed")}</span>
                    <button
                        onClick={onGenerateVideo}
                        className="text-[11px] text-primary hover:text-primary/80 transition-colors font-medium"
                    >
                        {t("retry")}
                    </button>
                </div>
            );
        }
        return (
            <div className="w-full aspect-video flex flex-col items-center justify-center gap-2 text-text-secondary/60">
                <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                    <Video size={18} strokeWidth={1.5} />
                </div>
                <span className="text-[11px] font-medium">{t("noVideoYet")}</span>
            </div>
        );
    };

    // Legacy renderGenerateButton was removed in the workbench
    // redesign (Sweep G, 2026-05-21): generation moved to the
    // ParamsSection's "Generate ×N" CTA inside the attached
    // ShotPanel, and T2I首帧 generation lives in T2ISubsection's
    // "+gen" tile. Keeping it on the ShotCard duplicated the action
    // with a different label (i18n vs English) and a different
    // batch-size semantics (×1 vs ×N) — confusing and the source of
    // the "two Generate buttons" bug report.
    // onGenerateVideo / onGenerateT2I are still wired for the inline
    // retry buttons inside renderPreview when a take fails.

    const handleInsertAssetFromChip = (_type: string, name: string) => {
        const currentPrompt = shot.prompt;
        // Check if this asset is already referenced in the prompt
        const existingTag = new RegExp(`\\[character\\d+:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
        if (existingTag.test(currentPrompt)) return;

        // Find the next available characterN slot
        const usedNums: number[] = [];
        const slotRe = /\[character(\d+):/g;
        let m;
        while ((m = slotRe.exec(currentPrompt)) !== null) {
            usedNums.push(parseInt(m[1], 10));
        }
        const nextSlot = usedNums.length > 0 ? Math.max(...usedNums) + 1 : 1;
        const tag = `[character${nextSlot}:${name}]`;

        const textarea = textareaRef.current;
        if (textarea) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const newPrompt = currentPrompt.slice(0, start) + tag + currentPrompt.slice(end);
            onUpdatePrompt(newPrompt);
            setTimeout(() => {
                textarea.selectionStart = textarea.selectionEnd = start + tag.length;
                textarea.focus();
            }, 0);
        } else {
            onUpdatePrompt(currentPrompt + " " + tag);
        }
    };

    const isActiveT2I = shot.tabMode === "t2i_i2v";
    const isActiveKeyframe = shot.tabMode === "keyframe_r2v";
    const isActiveAssetCompose = shot.tabMode === "asset_compose";
    const hasStoryboardImage = !!(shot.t2iImageUrl || shot.imageUrl);
    const imageInFlight = shot.t2iStatus === "pending" || shot.t2iStatus === "processing";
    const imageButtonLabel = imageInFlight
        ? "分镜图生成中"
        : shot.t2iStatus === "failed"
            ? "重试分镜图"
            : hasStoryboardImage
                ? "重生成分镜图"
                : "生成分镜图";
    const videoInFlight = inFlightCount > 0 || shot.videoStatus === "pending" || shot.videoStatus === "processing";
    const videoButtonLabel = videoInFlight
        ? `视频生成中 · ${inFlightCount || 1}`
        : shot.videoStatus === "failed"
            ? `重试视频 ×${generateCount}`
            : shot.videoUrl
                ? `再生成视频 ×${generateCount}`
                : `生成视频 ×${generateCount}`;

    return (
        <div
            ref={cardRef}
            onMouseMove={handleMouseMove}
            className="relative group"
        >
            {/* Spotlight border glow */}
            <div
                className="absolute -inset-[1px] rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none z-0"
                style={{
                    background:
                        "radial-gradient(600px circle at var(--spotlight-x, 50%) var(--spotlight-y, 50%), rgba(255,255,255,0.07), transparent 40%)",
                }}
            />

            {/* Liquid Glass card body */}
            <div className="relative backdrop-blur-xl bg-white/[0.02] border border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] rounded-xl overflow-hidden z-10">
                {/* Header row: Tab switcher + Shot number */}
                <div className="flex items-center justify-between px-3 pt-3 pb-2">
                    {/* Pill Tab Switcher */}
                    <div className="relative inline-flex items-center p-[3px] bg-black/40 rounded-lg backdrop-blur-sm">
                        <motion.div
                            className="absolute top-[3px] bottom-[3px] rounded-md bg-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"
                            initial={false}
                            animate={{
                                left: isActiveT2I
                                    ? 3
                                    : isActiveKeyframe
                                        ? "calc(33.333% + 1px)"
                                        : "calc(66.666% - 1px)",
                                width: "calc(33.333% - 2px)",
                            }}
                            transition={{ type: "spring", stiffness: 350, damping: 32 }}
                        />
                        <button
                            onClick={() => onSetTabMode("t2i_i2v")}
                            className={`relative z-10 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors duration-200 ${
                                isActiveT2I ? "text-foreground" : "text-text-secondary hover:text-text-secondary/80"
                            }`}
                        >
                            <ImageIcon size={12} strokeWidth={1.5} />
                            {t("tabT2iI2v")}
                        </button>
                        <button
                            onClick={() => onSetTabMode("keyframe_r2v")}
                            className={`relative z-10 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors duration-200 ${
                                isActiveKeyframe ? "text-foreground" : "text-text-secondary hover:text-text-secondary/80"
                            }`}
                        >
                            <Video size={12} strokeWidth={1.5} />
                            {t("tabDirectR2v")}
                        </button>
                        <button
                            onClick={() => onSetTabMode("asset_compose")}
                            className={`relative z-10 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors duration-200 ${
                                isActiveAssetCompose ? "text-foreground" : "text-text-secondary hover:text-text-secondary/80"
                            }`}
                        >
                            <Sparkles size={12} strokeWidth={1.5} />
                            {t("tabAssetCompose")}
                        </button>
                    </div>

                    {/* Shot number badge — expand toggle moved to Action Bar
                        (bottom-left cluster) for closer reach. */}
                    <div className="flex items-center gap-2">
                        <div className="text-[10px] font-mono text-text-muted tabular-nums">
                            #{String(index + 1).padStart(2, "0")}
                        </div>
                        <div className="w-5 h-5 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center">
                            <span className="text-[9px] font-bold text-foreground">{index + 1}</span>
                        </div>
                    </div>
                </div>

                {/* Main content: Preview + Editor */}
                <div className="flex">
                    {/* Left: Preview */}
                    <div className="w-44 shrink-0 bg-black/20 flex flex-col items-center justify-center relative border-r border-white/[0.04]">
                        {renderPreview()}
                    </div>

                    {/* Right: Prompt + Controls */}
                    <div className="flex-1 p-3 flex flex-col gap-2">
                        {/* Compact shot reference strip. It mirrors explicit
                            shot assets, not hidden model-submission tags. */}
                        {appearingAssets.length > 0 ? (
                            <div className="flex max-w-full items-center gap-2 overflow-hidden rounded-md border border-white/[0.06] bg-white/[0.025] px-2 py-1">
                                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                                    {t("shotCast")}
                                </span>
                                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                    {appearingAssets.slice(0, 5).map((asset) => {
                                        const kindLabel = asset.kind === "character"
                                            ? "角色"
                                            : asset.kind === "scene"
                                                ? "场景"
                                                : "道具";
                                        const kindClass = asset.kind === "character"
                                            ? "border-blue-400/25 bg-blue-400/10 text-blue-200"
                                            : asset.kind === "scene"
                                                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                                                : "border-orange-400/25 bg-orange-400/10 text-orange-200";
                                        return (
                                        <button
                                            key={`${asset.kind}-${asset.id}`}
                                            type="button"
                                            onClick={() => {
                                                // R2V v2: "assets" step id renamed to "cast" for R2V workflow.
                                                // ShotCard only appears inside StoryboardR2V (R2V-only),
                                                // so always navigate to the new cast step.
                                                document.dispatchEvent(
                                                    new CustomEvent("lumenx:navigateStep", { detail: "cast" }),
                                                );
                                            }}
                                            title={`${asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具"} · ${asset.name}`}
                                            className="group inline-flex max-w-[150px] items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/25 px-1.5 py-1 text-left transition-colors duration-fast ease-out-quart hover:border-primary/35 hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
                                        >
                                            <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold leading-none ${kindClass}`}>
                                                {kindLabel}
                                            </span>
                                            {asset.imageUrl ? (
                                                <span className="h-5 w-7 shrink-0 overflow-hidden rounded border border-white/[0.08] bg-black/30">
                                                    <PreviewImage
                                                        src={asset.imageUrl}
                                                        alt={asset.name}
                                                        className="h-full w-full"
                                                        noLightbox
                                                    />
                                                </span>
                                            ) : null}
                                            <span className="min-w-0 truncate text-[11px] font-medium text-text-secondary group-hover:text-foreground">
                                                {asset.name}
                                            </span>
                                        </button>
                                        );
                                    })}
                                    {appearingAssets.length > 5 ? (
                                        <span className="inline-flex h-7 items-center rounded-md border border-white/[0.08] bg-black/25 px-2 font-mono text-[10px] font-medium text-text-muted">
                                            +{appearingAssets.length - 5}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}

                        {/* Prompt Editor */}
                        <div>
                            <textarea
                                ref={textareaRef}
                                value={shot.prompt}
                                onChange={(e) => onUpdatePrompt(e.target.value)}
                                onKeyDown={(e) => {
                                    // Cmd/Ctrl + E from inside the
                                    // textarea opens the focus editor
                                    // (B5). Cmd is mac, Ctrl is
                                    // win/linux — handle both.
                                    if (e.key.toLowerCase() === "e" && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        setExpandOpen(true);
                                    }
                                }}
                                placeholder={t("promptPlaceholder")}
                                // rows=5 baseline (B3); auto-grow up
                                // to max-h-[260px] (≈10 lines, B2).
                                className="w-full text-sm resize-none leading-relaxed bg-transparent border border-white/[0.06] rounded-lg px-3 py-2.5 text-foreground placeholder:text-text-muted focus:outline-none focus:border-primary/30 focus:bg-white/[0.02] transition-all duration-200 min-h-[110px] max-h-[260px] overflow-y-auto"
                                rows={5}
                            />
                        </div>

                        {/* Row: prompt-expand icon + field tags (same line) */}
                        <div className="mt-1 flex flex-wrap items-start gap-2">
                            <div className="flex items-center flex-wrap gap-1.5 min-w-0">
                                {/* Expand-to-modal icon — moved inline (user requested it to be on this row) */}
                                <button
                                    type="button"
                                    onClick={() => setExpandOpen(true)}
                                    aria-label={t("promptExpand")}
                                    title={`${t("promptExpand")} (⌘/Ctrl + E)`}
                                    className="btn-tip grid h-7 w-7 place-items-center rounded-md border border-white/[0.08] bg-black/25 text-text-muted transition-colors hover:bg-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
                                >
                                    <Maximize2 size={13} aria-hidden="true" />
                                </button>

                                {/* Structured field tags — interactive Popover editors */}
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {/* Duration: always visible */}
                                    <FieldTagChip
                                        field="duration"
                                        value={shot.duration}
                                        editorConfig={durationEditorConfig
                                            ? { type: "duration", ...durationEditorConfig }
                                            : { type: "duration", min: 3, max: 15, step: 1 }
                                        }
                                        onChange={(v) => onUpdateField("duration", v)}
                                    />
                                    {/* Shot size: visible when has value */}
                                    {shot.shotSize !== undefined && shot.shotSize !== null && (
                                        <FieldTagChip
                                            field="shotSize"
                                            value={shot.shotSize}
                                            editorConfig={{ type: "preset", presets: ["特写", "近景", "中景", "全景", "远景", "大特写"] }}
                                            onChange={(v) => onUpdateField("shotSize", v)}
                                        />
                                    )}
                                    {/* Camera angle: visible when has value */}
                                    {shot.cameraAngle !== undefined && shot.cameraAngle !== null && (
                                        <FieldTagChip
                                            field="cameraAngle"
                                            value={shot.cameraAngle}
                                            editorConfig={{ type: "preset", presets: ["平视", "俯视", "仰视", "鸟瞰", "低角度"] }}
                                            onChange={(v) => onUpdateField("cameraAngle", v)}
                                        />
                                    )}
                                    {/* Camera movement: visible when has value */}
                                    {shot.cameraMovementStructured && (
                                        <FieldTagChip
                                            field="cameraMovement"
                                            value={shot.cameraMovementStructured.description || shot.cameraMovementStructured.primary}
                                            editorConfig={{ type: "preset", presets: ["固定镜头", "缓慢推进", "跟随平移", "环绕旋转", "快速拉远", "缓慢上升"] }}
                                            onChange={(v) => onUpdateField("cameraMovement", v)}
                                        />
                                    )}
                                    {/* Transition hint: visible when has value */}
                                    {shot.transitionHint !== undefined && shot.transitionHint !== null && (
                                        <FieldTagChip
                                            field="transitionHint"
                                            value={shot.transitionHint}
                                            editorConfig={{ type: "preset", presets: ["硬切", "淡入淡出", "溶解", "闪白", "划像"], allowCustom: true }}
                                            onChange={(v) => onUpdateField("transitionHint", v)}
                                        />
                                    )}
                                    {/* "+" button to add optional fields */}
                                    <AddFieldButton
                                        onAdd={(field: FieldType) => {
                                            if (field === "cameraMovement") {
                                                onUpdateField("cameraMovement", "固定镜头");
                                            } else {
                                                onUpdateField(field, "");
                                            }
                                        }}
                                    />
                                </div>
                            <button
                                type="button"
                                onClick={handleSingleAutoLink}
                                disabled={isLinking}
                                className="btn-tip grid h-7 w-7 place-items-center rounded-md border border-white/[0.08] bg-black/25 text-emerald-400 transition-colors hover:bg-emerald-900/30 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/55 shrink-0" data-tip="自动引用资源"
                                title="自动引用资源（匹配此分镜中的人物/场景名称到已有资产）"
                            >
                                {isLinking ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                            </button>

                            </div>


                        </div>

                        {/* Dialogue text display (read-only — editing via 配音工作台 modal) */}
                        {shot.dialogueStructured?.line && (
                            <div className="mt-1.5 flex items-start gap-1.5 px-1.5 py-1 -mx-1.5">
                                <span className="text-[10px] text-text-muted font-medium shrink-0 mt-px">
                                    {shot.dialogueStructured.speaker}:
                                </span>
                                <span className="text-[11px] text-text-secondary italic leading-relaxed">
                                    「{shot.dialogueStructured.line}」
                                </span>
                            </div>
                        )}

                        {/* Assembled prompt preview (read-only, collapsible) */}
                        {(shot.prompt || shot.shotSize || shot.cameraMovementStructured) && (
                            <div className="mt-1">
                                <button
                                    type="button"
                                    onClick={() => setPromptPreviewOpen(v => !v)}
                                    className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                                >
                                    <span>查看最终提示词</span>
                                    <ChevronRight
                                        size={11}
                                        className={`transition-transform duration-200 ${promptPreviewOpen ? "rotate-90" : ""}`}
                                        aria-hidden="true"
                                    />
                                </button>
                                <AnimatePresence>
                                    {promptPreviewOpen && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: "auto", opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.2 }}
                                            className="overflow-hidden"
                                        >
                                            <div className="mt-1.5 rounded-md border border-white/[0.06] bg-black/20 px-3 py-2 text-[11.5px] leading-relaxed font-mono space-y-2">
                                                {/* Final prompt as model receives it (computed real-time) */}
                                                <p className="text-text-secondary whitespace-pre-wrap">
                                                    {assembledPromptPreview}
                                                </p>
                                                {/* Duration is the only field NOT in prompt — show as API param note */}
                                                {shot.duration && (
                                                    <p className="text-text-muted border-t border-white/[0.04] pt-1.5">
                                                        <span className="text-emerald-300/70">时长:</span> {shot.duration}s (API参数，不入提示词)
                                                    </p>
                                                )}
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        )}

                        {/* Asset Chip Bar */}
                        <AssetChipBar
                            characters={characters}
                            scenes={scenes}
                            props={props}
                            onInsertAsset={handleInsertAssetFromChip}
                            characterStageRefs={shot.characterStageRefs}
                            sceneStageRef={shot.sceneStageRef}
                        />

                        {/* PR-3c+ · 底部一体化 action 行:
                            左 = shot actions (@ ↑ ↓ ⊙ ×) -- 之前悬空在 chip
                                  bar 下方，现移到底部跟生成行同一区域.
                            右 = generation cluster (count selector + 生成 ×N).
                            一行解决"所有 shot operations + generate"，
                            不再两段隔离视觉. */}
                        <div className="mt-2 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-0.5 shrink-0">
                                <motion.button
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={onOpenDrawer}
                                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-secondary hover:text-foreground transition-colors"
                                    title={t("browseAssets")}
                                >
                                    <AtSign size={14} strokeWidth={2} />
                                </motion.button>
                                <div className="w-px h-3.5 bg-white/[0.06] mx-0.5" />
                                <motion.button
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={onMoveUp}
                                    disabled={index === 0}
                                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-secondary hover:text-foreground transition-colors disabled:opacity-20 disabled:hover:bg-transparent"
                                    title="上移"
                                >
                                    <ChevronUp size={14} strokeWidth={1.5} />
                                </motion.button>
                                <motion.button
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={onMoveDown}
                                    disabled={index === totalShots - 1}
                                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-secondary hover:text-foreground transition-colors disabled:opacity-20 disabled:hover:bg-transparent"
                                    title="下移"
                                >
                                    <ChevronDown size={14} strokeWidth={1.5} />
                                </motion.button>
                                <motion.button
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={onDuplicate}
                                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-secondary hover:text-foreground transition-colors"
                                    title={t("duplicateShot")}
                                >
                                    <Copy size={13} strokeWidth={1.5} />
                                </motion.button>
                                <motion.button
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={onDelete}
                                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-secondary hover:text-rose-400 transition-colors"
                                    title={t("deleteShot")}
                                >
                                    <Trash2 size={13} strokeWidth={1.5} />
                                </motion.button>
                                {onRefineFrame && (
                                    <>
                                        <div className="w-px h-3.5 bg-white/[0.06] mx-0.5" />
                                        <motion.button
                                            whileHover={{ scale: 1.08 }}
                                            whileTap={{ scale: 0.92 }}
                                            onClick={onRefineFrame}
                                            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-secondary hover:text-amber-400 transition-colors"
                                            title="精修此帧"
                                        >
                                            <Sparkles size={13} strokeWidth={1.5} />
                                        </motion.button>
                                    </>
                                )}
                            </div>

                            <div className="flex items-center gap-2">
                                {/* 参数 / TAKES disclosure — moved into the same row with tools + generate */}
                                <motion.button
                                    whileHover={{ scale: 1.005 }}
                                    whileTap={{ scale: 0.995 }}
                                    type="button"
                                    onClick={onToggleExpanded}
                                    aria-expanded={expanded}
                                    aria-label={expanded ? t("collapseShot") : t("expandShot")}
                                    className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-colors duration-fast ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 ${
                                        expanded
                                            ? "border-primary/40 bg-primary/12 text-primary hover:bg-primary/20"
                                            : "border-glass-border bg-black/30 text-text-secondary hover:border-white/20 hover:bg-white/[0.06] hover:text-foreground"
                                    }`}
                                >
                                    {expanded ? (
                                        <PanelBottomClose size={13} strokeWidth={1.6} aria-hidden="true" />
                                    ) : (
                                        <PanelBottomOpen size={13} strokeWidth={1.6} aria-hidden="true" />
                                    )}
                                    <span>{expanded ? t("collapseShotShort") : t("expandShotShort")}</span>
                                    {expanded ? (
                                        <ChevronUp size={12} strokeWidth={2} className="opacity-60" aria-hidden="true" />
                                    ) : (
                                        <ChevronDown size={12} strokeWidth={2} className="opacity-60" aria-hidden="true" />
                                    )}
                                </motion.button>

                                <motion.button
                                    whileHover={!imageInFlight && shot.prompt.trim() ? { scale: 1.01 } : undefined}
                                    whileTap={!imageInFlight && shot.prompt.trim() ? { scale: 0.99 } : undefined}
                                    type="button"
                                    onClick={onGenerateT2I}
                                    disabled={!shot.prompt.trim() || imageInFlight}
                                    title={!shot.prompt.trim() ? "请先输入提示词" : "生成分镜图，用于预览和后续视频生成参考"}
                                    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 min-w-[128px] font-sans text-[12px] font-semibold tracking-tight transition-colors duration-fast ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/55 disabled:cursor-not-allowed disabled:opacity-50 ${
                                        imageInFlight
                                            ? "border border-amber-400/35 bg-amber-400/12 text-amber-200"
                                            : shot.t2iStatus === "failed"
                                                ? "border border-status-failed-border bg-status-failed-bg text-status-failed-fg hover:brightness-110"
                                                : hasStoryboardImage
                                                    ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/16"
                                                    : "border border-amber-400/35 bg-amber-400/12 text-amber-200 hover:bg-amber-400/18"
                                    }`}
                                >
                                    {imageInFlight ? (
                                        <Loader2 size={14} className="animate-spin" strokeWidth={2} />
                                    ) : (
                                        <ImageIcon size={14} strokeWidth={2} />
                                    )}
                                    <span>{imageButtonLabel}</span>
                                </motion.button>
                                <div className="flex items-center gap-1 shrink-0">
                                    {[1, 2, 4, 6].map((n) => {
                                        const active = generateCount === n;
                                        return (
                                            <button
                                                key={n}
                                                type="button"
                                                onClick={() => onSetGenerateCount?.(n)}
                                                aria-pressed={active}
                                                aria-label={`Generate ${n} at a time`}
                                                title={`每次生成 ${n} 条候选`}
                                                className={`grid h-9 w-9 place-items-center rounded-md border font-mono text-[11px] font-medium transition-colors duration-fast ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 ${
                                                    active
                                                        ? "border-primary/55 bg-primary/15 text-primary"
                                                        : "border-glass-border bg-black/20 text-text-secondary hover:border-white/20 hover:text-foreground"
                                                }`}
                                            >
                                                ×{n}
                                            </button>
                                        );
                                    })}
                                </div>
                                <motion.button
                                    whileHover={canGenerate && !videoInFlight ? { scale: 1.005 } : undefined}
                                    whileTap={canGenerate && !videoInFlight ? { scale: 0.995 } : undefined}
                                    type="button"
                                    onClick={() => onGenerateBatch?.(generateCount)}
                                    disabled={!canGenerate || videoInFlight}
                                    title={!canGenerate
                                        ? (shot.tabMode === "t2i_i2v"
                                            ? "请先在上方生成或上传首帧"
                                            : "请先生成首帧关键帧")
                                        : `生成 ${generateCount} 条视频候选`}
                                    className="inline-flex items-center justify-center gap-1.5 rounded-md px-5 py-2 min-w-[140px] font-sans text-[13px] font-semibold tracking-tight transition-colors duration-fast ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 disabled:cursor-not-allowed disabled:opacity-40 bg-primary text-white border border-[rgba(100,108,255,0.65)] shadow-[inset_0_1.5px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(60,68,200,0.45),0_4px_14px_-2px_rgba(100,108,255,0.45)] hover:bg-[#7a82ff] hover:border-[rgba(100,108,255,0.85)] disabled:hover:bg-primary disabled:hover:border-[rgba(100,108,255,0.65)]"
                                >
                                    {videoInFlight ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" strokeWidth={2} />
                                            <span>{videoButtonLabel}</span>
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles size={14} strokeWidth={2} />
                                            <span>{videoButtonLabel}</span>
                                        </>
                                    )}
                                </motion.button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {/* Focus-editor modal (B5 escape hatch) — opens via the
                expand icon or Cmd/Ctrl+E. Cancel discards; Save
                propagates back through the same onUpdatePrompt
                path the inline textarea uses. */}
            {expandOpen ? (
                <PromptExpandModal
                    initialValue={shot.prompt}
                    shotLabel={`Shot ${index + 1}`}
                    placeholder={t("promptPlaceholder")}
                    onSave={(next) => {
                        onUpdatePrompt(next);
                        setExpandOpen(false);
                    }}
                    onClose={() => setExpandOpen(false)}
                />
            ) : null}
        </div>
    );
}
