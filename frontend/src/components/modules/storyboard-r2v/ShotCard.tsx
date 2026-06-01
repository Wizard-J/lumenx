"use client";

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
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
    Code2,
    ChevronRight,
} from "lucide-react";
import { useTranslations } from "next-intl";
import AssetChipBar from "./AssetChipBar";
import PromptExpandModal from "./PromptExpandModal";
import PolishPanel from "./PolishPanel";
import FieldTagChip, { AddFieldButton, type FieldType } from "./FieldTagChip";
import { buildAssembledPrompt } from "./buildAssembledPrompt";
import { PendingTaskAffordance } from "@/components/shared/PendingTaskAffordance";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import PreviewVideo from "@/components/shared/preview/PreviewVideo";
import { useProjectStore } from "@/store/projectStore";

export interface ShotNode {
    id: string;
    prompt: string;
    tabMode: "t2i_i2v" | "direct_r2v";

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
    /** Every video task this shot has spawned, oldest first. Each tab
     *  (t2i_i2v / direct_r2v) gets its own list — see videoTaskIdsByTab.
     *  Empty / missing → no history (e.g. legacy shots). */
    videoTaskIdsByTab?: {
        t2i_i2v?: string[];
        direct_r2v?: string[];
    };
    imageUrl?: string;

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
}

/** Cap on T2I image history per shot. Older drops off FIFO when adding. */
export const T2I_HISTORY_LIMIT = 10;

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
    onGenerateVideo: () => void;
    onDelete: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onDuplicate: () => void;
    onSetTabMode: (mode: "t2i_i2v" | "direct_r2v") => void;
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
}: ShotCardProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const t = useTranslations("storyboardR2V");
    // Expand modal state (B5). Cmd/Ctrl+E in the small textarea
    // opens it; saving syncs back via onUpdatePrompt; cancel
    // discards the modal's draft without touching parent state.
    const [expandOpen, setExpandOpen] = useState(false);
    const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
    // currentProjectId — needed by PolishPanel to look up the
    // project's PromptConfig override server-side.
    const currentProjectId = useProjectStore((state) => state.currentProject?.id);
    // r2vSlots — when R2V tab is active, derive slot context from
    // @character references in the prompt so the polish system
    // prompt knows what character1/character2 ID maps to.
    const r2vSlots = useCallback((): { description: string }[] => {
        if (shot.tabMode !== "direct_r2v") return [];
        const out: { description: string }[] = [];
        const tagPattern = /\[character\d+:([^\]]+)\]/g;
        let match;
        while ((match = tagPattern.exec(shot.prompt)) !== null) {
            const [, name] = match;
            const char = characters.find((c: any) => c.name === name);
            out.push({ description: char?.description ? `${name}: ${char.description}` : name });
        }
        return out;
    }, [shot.tabMode, shot.prompt, characters])();

    // polishImageUrls — feed vision-capable polish (Issue 13) with the
    // images the polish actually needs to "see":
    //   • i2v: the active first frame (T2I selection if any, else the
    //     Storyboard render). No frame yet → empty → text-only polish.
    //   • r2v: each referenced character's avatar/headshot/full body
    //     image, dedup'd by id. No references → empty → text-only.
    const polishImageUrls = useCallback((): string[] => {
        if (shot.tabMode === "direct_r2v") {
            const out: string[] = [];
            const seen = new Set<string>();
            const tagPattern = /\[character\d*:([^\]]+)\]/g;
            let m;
            while ((m = tagPattern.exec(shot.prompt)) !== null) {
                const [, name] = m;
                const char = characters.find((c: any) => c.name === name);
                if (!char || seen.has(char.id)) continue;
                seen.add(char.id);
                const url = char.headshot_image_url || char.image_url || char.full_body_image_url
                    || (char.full_body_asset?.variants?.[0]?.url);
                if (url) out.push(url);
            }
            return out.slice(0, 4); // cap at 4 to keep payload reasonable
        }
        // i2v: prefer active T2I image; fall back to storyboard frame.
        const active = (shot.t2iImageUrls && shot.t2iImageUrls.length > 0)
            ? shot.t2iImageUrls[Math.max(0, Math.min(shot.t2iSelectedIndex ?? 0, shot.t2iImageUrls.length - 1))]
            : (shot.t2iImageUrl || shot.imageUrl);
        return active ? [active] : [];
    }, [shot.tabMode, shot.prompt, shot.t2iImageUrls, shot.t2iSelectedIndex, shot.t2iImageUrl, shot.imageUrl, characters])();

    // castAvatars — character avatar group for the "Cast:" row above
    // the prompt textarea (L5 borrow from 火山剧创's 出镜角色). De-
    // duped by id. We accept either [character:name] or [characterN:
    // name] patterns since the asset chip bar emits both formats.
    const castAvatars = useCallback((): Array<{ id: string; name: string; avatarUrl?: string }> => {
        const out: Array<{ id: string; name: string; avatarUrl?: string }> = [];
        const seen = new Set<string>();
        const tagPattern = /\[character\d*:([^\]]+)\]/g;
        let match;
        while ((match = tagPattern.exec(shot.prompt)) !== null) {
            const [, name] = match;
            const char = characters.find((c: any) => c.name === name);
            if (!char || seen.has(char.id)) continue;
            seen.add(char.id);
            const avatarUrl =
                char.avatar_url ||
                char.headshot_image_url ||
                char.image_url ||
                char.full_body_image_url ||
                (char.full_body_asset?.variants?.[0]?.url);
            out.push({ id: char.id, name: char.name, avatarUrl });
        }
        return out;
    }, [shot.prompt, characters])();

    const assembledPromptPreview = useMemo(() => buildAssembledPrompt(shot), [
        shot.prompt, shot.shotSize, shot.cameraAngle, shot.cameraMovementStructured, shot.transitionHint,
    ]);

    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        // Reset before measuring so shrinking also works (delete text).
        ta.style.height = "auto";
        const next = Math.min(ta.scrollHeight, 260);
        ta.style.height = `${next}px`;
    }, [shot.prompt]);

    const statusColor: Record<string, string> = {
        pending: "text-amber-400",
        processing: "text-sky-400",
        completed: "text-emerald-400",
        failed: "text-rose-400",
    };

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const el = cardRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        el.style.setProperty("--spotlight-x", `${e.clientX - rect.left}px`);
        el.style.setProperty("--spotlight-y", `${e.clientY - rect.top}px`);
    }, []);

    const renderPreview = () => {
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
            if (shot.t2iImageUrl) {
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
                            src={shot.t2iImageUrl}
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
                                left: isActiveT2I ? 3 : "calc(50% + 1.5px)",
                                width: "calc(50% - 3px)",
                            }}
                            transition={{ type: "spring", stiffness: 350, damping: 32 }}
                        />
                        <button
                            onClick={() => onSetTabMode("t2i_i2v")}
                            className={`relative z-10 flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-md transition-colors duration-200 ${
                                isActiveT2I ? "text-foreground" : "text-text-secondary hover:text-text-secondary/80"
                            }`}
                        >
                            <ImageIcon size={12} strokeWidth={1.5} />
                            {t("tabT2iI2v")}
                        </button>
                        <button
                            onClick={() => onSetTabMode("direct_r2v")}
                            className={`relative z-10 flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-md transition-colors duration-200 ${
                                !isActiveT2I ? "text-foreground" : "text-text-secondary hover:text-text-secondary/80"
                            }`}
                        >
                            <Video size={12} strokeWidth={1.5} />
                            {t("tabDirectR2v")}
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
                        {/* Cast avatar group — at-a-glance view of
                            which characters are referenced in this
                            shot's prompt. Derived from [character:X]
                            tags. Click an avatar to jump to the
                            Assets step for editing. Borrowed from
                            火山剧创's "出镜角色" but as a compact
                            avatar group instead of a verbose list. */}
                        {castAvatars.length > 0 ? (
                            <div className="flex items-center gap-1.5">
                                <span className="font-mono text-chrome-sm tracking-tight text-text-muted">
                                    {t("shotCast")}
                                </span>
                                <div className="flex items-center -space-x-1.5">
                                    {castAvatars.slice(0, 3).map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => {
                                                // R2V v2: "assets" step id renamed to "cast" for R2V workflow.
                                                // ShotCard only appears inside StoryboardR2V (R2V-only),
                                                // so always navigate to the new cast step.
                                                document.dispatchEvent(
                                                    new CustomEvent("lumenx:navigateStep", { detail: "cast" }),
                                                );
                                            }}
                                            title={c.name}
                                            className="grid h-6 w-6 place-items-center overflow-hidden rounded-full border-2 border-surface bg-elevated transition-all duration-fast ease-out-quart hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
                                        >
                                            {c.avatarUrl ? (
                                                <PreviewImage
                                                    src={c.avatarUrl}
                                                    alt={c.name}
                                                    className="h-full w-full"
                                                    noLightbox
                                                />
                                            ) : (
                                                <span className="font-mono text-[9px] font-medium text-text-secondary">
                                                    {c.name.slice(0, 1)}
                                                </span>
                                            )}
                                        </button>
                                    ))}
                                    {castAvatars.length > 3 ? (
                                        <span className="grid h-6 w-6 place-items-center rounded-full border-2 border-surface bg-elevated font-mono text-[9px] font-medium text-text-secondary">
                                            +{castAvatars.length - 3}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}

                        {/* Prompt Editor wrapper — relative so the
                            expand icon can sit absolute top-right
                            without taking layout space. */}
                        <div className="relative">
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
                                // pr-8 reserves space for the expand
                                // icon so it never overlays text.
                                className="w-full text-sm resize-none leading-relaxed bg-transparent border border-white/[0.06] rounded-lg pl-3 pr-8 py-2.5 text-foreground placeholder:text-text-muted focus:outline-none focus:border-primary/30 focus:bg-white/[0.02] transition-all duration-200 min-h-[110px] max-h-[260px] overflow-y-auto"
                                rows={5}
                            />
                            {/* Expand-to-modal icon — top-right,
                                always visible. 24×24 hit area on
                                a 14×14 visual via padding. */}
                            <button
                                type="button"
                                onClick={() => setExpandOpen(true)}
                                aria-label={t("promptExpand")}
                                title={`${t("promptExpand")} (⌘/Ctrl + E)`}
                                className="btn-tip absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded text-text-muted/70 transition-colors duration-fast ease-out-quart hover:bg-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55"
                            >
                                <Maximize2 size={12} aria-hidden="true" />
                            </button>
                        </div>

                        {/* AI Polish — bilingual prompt rewrite using
                            the project's polish system prompt
                            (storyboard_polish / video_polish /
                            r2v_polish from PromptConfig). Routes to
                            the right API by tabMode. */}
                        <PolishPanel
                            prompt={shot.prompt}
                            tabMode={shot.tabMode}
                            scriptId={currentProjectId ?? ""}
                            slots={r2vSlots}
                            imageUrls={polishImageUrls}
                            onApply={onUpdatePrompt}
                        />

                        {/* Structured field tags — interactive Popover editors */}
                        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
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

                        {/* Assembled prompt preview (read-only, collapsible) — uses buildAssembledPrompt for real-time computation */}
                        {(shot.prompt || shot.shotSize || shot.cameraMovementStructured) && (
                            <div className="mt-1">
                                <button
                                    type="button"
                                    onClick={() => setPromptPreviewOpen(v => !v)}
                                    className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                                >
                                    <Code2 size={12} strokeWidth={1.5} />
                                    <span>查看最终提示词</span>
                                    <ChevronRight
                                        size={11}
                                        className={`transition-transform duration-200 ${promptPreviewOpen ? "rotate-90" : ""}`}
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
                                whileHover={canGenerate && inFlightCount === 0 ? { scale: 1.005 } : undefined}
                                whileTap={canGenerate && inFlightCount === 0 ? { scale: 0.995 } : undefined}
                                type="button"
                                onClick={() => onGenerateBatch?.(generateCount)}
                                disabled={!canGenerate || inFlightCount > 0}
                                title={!canGenerate
                                    ? (shot.tabMode === "t2i_i2v"
                                        ? "请先在上方生成或上传首帧"
                                        : "请先输入提示词")
                                    : `生成 ${generateCount} 条视频候选`}
                                className="inline-flex items-center justify-center gap-1.5 rounded-md px-5 py-2 min-w-[140px] font-sans text-[13px] font-semibold tracking-tight transition-colors duration-fast ease-out-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 disabled:cursor-not-allowed disabled:opacity-40 bg-primary text-white border border-[rgba(100,108,255,0.65)] shadow-[inset_0_1.5px_0_rgba(255,255,255,0.14),inset_0_-1px_0_rgba(60,68,200,0.45),0_4px_14px_-2px_rgba(100,108,255,0.45)] hover:bg-[#7a82ff] hover:border-[rgba(100,108,255,0.85)] disabled:hover:bg-primary disabled:hover:border-[rgba(100,108,255,0.65)]"
                            >
                                {inFlightCount > 0 ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" strokeWidth={2} />
                                        <span>{`生成中 · ${inFlightCount}`}</span>
                                    </>
                                ) : (
                                    <>
                                        <Sparkles size={14} strokeWidth={2} />
                                        <span>{`生成 ×${generateCount}`}</span>
                                    </>
                                )}
                            </motion.button>
                            </div>
                        </div>

                        {/* PR-3b · 参数 / Takes disclosure bar — 控制 attached
                            panel 显隐. Right-aligned 适宜宽度 (跟生成行对齐,
                            不全宽，避免视觉过重). */}
                        <div className="mt-2 flex justify-end">
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
