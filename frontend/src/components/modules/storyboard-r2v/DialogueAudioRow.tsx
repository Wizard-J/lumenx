"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Loader2, AlertCircle, Mic, Film, Undo2, Crosshair, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";

interface DialogueAudioRowProps {
    scriptId: string;
    frameId: string;
    dialogue: string | undefined;
    voiceId: string | undefined;
    audioUrl: string | undefined;
    audioError: string | null | undefined;
    snapshotDialogue?: string;
    snapshotVoiceId?: string;
    snapshotInstructions?: string;
    onAudioUpdated?: () => void | Promise<void>;
    onUpdateDialogue?: (text: string) => void;
    videoUrl?: string;
    videoTaskId?: string;
    previewVideoUrl?: string;
    dubbedVideoUrl?: string;
    dubOffsetMs?: number;
    onPreviewDub?: (videoTaskId: string, offsetMs: number) => Promise<void>;
    onApplyDub?: () => Promise<void>;
    onRevertDub?: () => Promise<void>;
}

const EMOTION_CHIPS = [
    "neutral",
    "happy",
    "sad",
    "angry",
    "surprised",
    "calm",
    "gentle",
    "serious",
] as const;

export default function DialogueAudioRow({
    scriptId,
    frameId,
    dialogue,
    voiceId,
    audioUrl,
    audioError,
    snapshotInstructions,
    onAudioUpdated,
    onUpdateDialogue,
    videoUrl,
    videoTaskId,
    previewVideoUrl,
    dubbedVideoUrl,
    dubOffsetMs = 0,
    onPreviewDub,
    onApplyDub,
    onRevertDub,
}: DialogueAudioRowProps) {
    const t = useTranslations("dialogueAudio");
    const [modalOpen, setModalOpen] = useState(false);

    const hasAudio = !!audioUrl;
    const hasVideo = !!(videoUrl && videoTaskId);
    const hasDub = !!dubbedVideoUrl;
    const hasPreview = !!previewVideoUrl;

    return (
        <>
            <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="w-full rounded-lg border border-glass-border bg-glass/50 px-3 py-2 text-left hover:border-white/15 hover:bg-glass/70 transition-colors group"
            >
                <div className="flex items-center gap-2">
                    <Mic size={12} className="text-text-muted shrink-0" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
                        {t("title")}
                    </span>

                    {audioError && (
                        <span className="px-1.5 py-0.5 rounded font-mono text-[9.5px] uppercase tracking-[0.14em] bg-status-failed-bg text-status-failed-fg">
                            {t("state.error")}
                        </span>
                    )}
                    {hasAudio && !audioError && (
                        <span className="px-1.5 py-0.5 rounded font-mono text-[9.5px] uppercase tracking-[0.14em] bg-primary/10 text-primary">
                            {t("state.ready")}
                        </span>
                    )}
                    {hasDub && (
                        <span className="px-1.5 py-0.5 rounded font-mono text-[9.5px] uppercase tracking-[0.14em] bg-emerald-500/10 text-emerald-400">
                            已覆盖
                        </span>
                    )}
                    {hasPreview && !hasDub && (
                        <span className="px-1.5 py-0.5 rounded font-mono text-[9.5px] uppercase tracking-[0.14em] bg-amber-500/10 text-amber-400">
                            预览中
                        </span>
                    )}

                    <span className="ml-auto text-[11px] text-text-muted group-hover:text-text-secondary transition-colors">
                        {hasVideo && hasAudio ? "配音工作台 →" : "语音生成 →"}
                    </span>
                </div>

                {dialogue?.trim() && (
                    <p className="mt-1 text-[11px] text-text-muted truncate">
                        「{dialogue.trim().slice(0, 60)}{dialogue.trim().length > 60 ? "..." : ""}」
                    </p>
                )}
            </button>

            <DialogueWorkbenchModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                scriptId={scriptId}
                frameId={frameId}
                dialogue={dialogue}
                voiceId={voiceId}
                audioUrl={audioUrl}
                audioError={audioError}
                snapshotInstructions={snapshotInstructions}
                onAudioUpdated={onAudioUpdated}
                onUpdateDialogue={onUpdateDialogue}
                videoUrl={videoUrl}
                videoTaskId={videoTaskId}
                previewVideoUrl={previewVideoUrl}
                dubbedVideoUrl={dubbedVideoUrl}
                dubOffsetMs={dubOffsetMs}
                onPreviewDub={onPreviewDub}
                onApplyDub={onApplyDub}
                onRevertDub={onRevertDub}
            />
        </>
    );
}


function DialogueWorkbenchModal({
    isOpen,
    onClose,
    scriptId,
    frameId,
    dialogue,
    voiceId,
    audioUrl,
    audioError,
    snapshotInstructions,
    onAudioUpdated,
    onUpdateDialogue,
    videoUrl,
    videoTaskId,
    previewVideoUrl,
    dubbedVideoUrl,
    dubOffsetMs = 0,
    onPreviewDub,
    onApplyDub,
    onRevertDub,
}: {
    isOpen: boolean;
    onClose: () => void;
    scriptId: string;
    frameId: string;
    dialogue: string | undefined;
    voiceId: string | undefined;
    audioUrl: string | undefined;
    audioError: string | null | undefined;
    snapshotInstructions?: string;
    onAudioUpdated?: () => void | Promise<void>;
    onUpdateDialogue?: (text: string) => void;
    videoUrl?: string;
    videoTaskId?: string;
    previewVideoUrl?: string;
    dubbedVideoUrl?: string;
    dubOffsetMs?: number;
    onPreviewDub?: (videoTaskId: string, offsetMs: number) => Promise<void>;
    onApplyDub?: () => Promise<void>;
    onRevertDub?: () => Promise<void>;
}) {
    const t = useTranslations("dialogueAudio");
    const [dialogueDraft, setDialogueDraft] = useState(dialogue || "");
    const [emotion, setEmotion] = useState<string>(snapshotInstructions || "");
    const [freeText, setFreeText] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [offsetMs, setOffsetMs] = useState(dubOffsetMs || 0);
    const [previewing, setPreviewing] = useState(false);
    const [applying, setApplying] = useState(false);
    const [reverting, setReverting] = useState(false);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);

    const instructions = useMemo(() => {
        const chip = EMOTION_CHIPS.includes(emotion as any) ? emotion : "";
        const free = freeText.trim();
        if (chip && free) return `${chip}; ${free}`;
        return chip || free || undefined;
    }, [emotion, freeText]);

    const canDub = !!(audioUrl && videoUrl && videoTaskId && onPreviewDub);
    const [videoDurationMs, setVideoDurationMs] = useState(5000);

    // Determine which video to show: preview > dubbed > original
    const displayVideoUrl = previewVideoUrl || dubbedVideoUrl || videoUrl;

    useEffect(() => { setDialogueDraft(dialogue || ""); }, [dialogue]);
    useEffect(() => {
        if (isOpen) { setError(null); }
    }, [isOpen]);
    useEffect(() => { return () => { audioRef.current?.pause(); }; }, []);

    const handleSaveDialogue = () => {
        if (onUpdateDialogue && dialogueDraft.trim() !== (dialogue || "").trim()) {
            onUpdateDialogue(dialogueDraft.trim());
        }
    };

    const handlePlayAudio = async () => {
        if (!audioUrl) return;
        if (audioRef.current && playing) {
            audioRef.current.pause();
            setPlaying(false);
            return;
        }
        const audio = new Audio(getAssetUrl(audioUrl));
        audio.onended = () => { setPlaying(false); audioRef.current = null; };
        audio.onerror = () => { setPlaying(false); setError(t("playFailed")); };
        audioRef.current = audio;
        setPlaying(true);
        try { await audio.play(); } catch (e: any) { setPlaying(false); setError(e?.message || t("playFailed")); }
    };

    const handleGenerate = async () => {
        if (!voiceId) { setError(t("noVoiceBound")); return; }
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; setPlaying(false); }
        setError(null);
        setBusy(true);
        try {
            const result = await api.generateLineAudio(scriptId, frameId, 1.0, 1.0, 50, instructions);
            const updatedFrame = result?.frames?.find((f: any) => f.id === frameId);
            if (updatedFrame?.audio_error) {
                setError(updatedFrame.audio_error);
            } else {
                await onAudioUpdated?.();
            }
        } catch (e: any) {
            setError(e?.message || t("generateFailed"));
        } finally {
            setBusy(false);
        }
    };

    const handleMarkStart = () => {
        if (videoRef.current) {
            const ms = Math.round(videoRef.current.currentTime * 1000);
            setOffsetMs(ms);
        }
    };

    const handlePreviewDub = async () => {
        if (!onPreviewDub || !videoTaskId) return;
        setPreviewing(true);
        setError(null);
        try {
            await onPreviewDub(videoTaskId, offsetMs);
        } catch (e: any) {
            setError(e?.response?.data?.detail || e?.message || "预览生成失败");
        } finally {
            setPreviewing(false);
        }
    };

    const handleApply = async () => {
        if (!onApplyDub) return;
        setApplying(true);
        try {
            await onApplyDub();
        } catch (e: any) {
            setError(e?.response?.data?.detail || e?.message || "应用失败");
        } finally {
            setApplying(false);
        }
    };

    const handleRevert = async () => {
        if (!onRevertDub) return;
        setReverting(true);
        setError(null);
        try {
            await onRevertDub();
        } catch (e: any) {
            setError(e?.response?.data?.detail || e?.message || "撤销失败");
        } finally {
            setReverting(false);
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="fixed inset-0 z-[100] flex items-center justify-center"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                >
                    <motion.div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

                    <motion.div
                        className="relative w-full max-w-xl mx-4 rounded-xl border border-glass-border bg-[#0a0a0f]/95 backdrop-blur-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
                        initial={{ scale: 0.95, opacity: 0, y: 10 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.95, opacity: 0, y: 10 }}
                        transition={{ type: "spring", stiffness: 300, damping: 28 }}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-glass-border/50 shrink-0">
                            <div className="flex items-center gap-3">
                                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 border border-primary/20">
                                    <Mic size={16} className="text-primary" />
                                </div>
                                <div>
                                    <h3 className="text-[14px] font-medium text-foreground">配音工作台</h3>
                                    <p className="text-[11px] text-text-muted mt-0.5">编辑对白 → 生成语音 → 覆盖到视频</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-foreground hover:bg-white/5 transition-colors"
                            >
                                ×
                            </button>
                        </div>

                        {/* Scrollable body */}
                        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
                            {/* Step 1: Dialogue text editing */}
                            <section className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-medium text-text-secondary">① 对白文本</span>
                                    {!voiceId && (
                                        <span className="text-[10px] text-amber-400">需先在「角色」中绑定音色</span>
                                    )}
                                </div>
                                <textarea
                                    value={dialogueDraft}
                                    onChange={(e) => setDialogueDraft(e.target.value)}
                                    onBlur={handleSaveDialogue}
                                    placeholder="输入该镜头的对白文本..."
                                    rows={2}
                                    className="w-full rounded-md border border-glass-border bg-black/30 px-3 py-2 text-[12px] text-foreground placeholder:text-text-muted focus:outline-none focus:border-primary/40 resize-none"
                                />
                            </section>

                            {/* Step 2: Emotion + TTS generation */}
                            <section className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-medium text-text-secondary">② 情绪与生成</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                    {EMOTION_CHIPS.map((chip) => (
                                        <button
                                            key={chip}
                                            onClick={() => setEmotion(emotion === chip ? "" : chip)}
                                            className={`px-2 py-0.5 rounded-full border font-mono text-[9.5px] uppercase tracking-[0.12em] transition-colors ${
                                                emotion === chip
                                                    ? "border-primary bg-primary/15 text-primary"
                                                    : "border-glass-border bg-black/30 text-text-muted hover:border-white/20 hover:text-text-secondary"
                                            }`}
                                        >
                                            {t(`emotion.${chip}`)}
                                        </button>
                                    ))}
                                </div>
                                <input
                                    type="text"
                                    value={freeText}
                                    onChange={(e) => setFreeText(e.target.value.slice(0, 80))}
                                    placeholder={t("freeTextPlaceholder")}
                                    className="w-full rounded-md border border-glass-border bg-black/30 px-3 py-1.5 text-[11px] text-foreground placeholder:text-text-muted focus:outline-none focus:border-primary/40"
                                />
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={handleGenerate}
                                        disabled={busy || !voiceId || !dialogueDraft.trim()}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary/40 bg-primary/10 text-[12px] font-medium text-primary hover:bg-primary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
                                        {audioUrl ? t("regenerate") : t("generate")}
                                    </button>
                                    {audioUrl && (
                                        <button
                                            onClick={handlePlayAudio}
                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-glass-border bg-black/30 text-[12px] text-text-secondary hover:border-white/20 hover:text-foreground transition-colors"
                                        >
                                            {playing ? <Pause size={12} /> : <Play size={12} />}
                                            {playing ? "暂停" : "试听TTS"}
                                        </button>
                                    )}
                                    {audioUrl && (
                                        <span className="text-[10px] text-emerald-400">✓ 已生成</span>
                                    )}
                                </div>
                            </section>

                            {/* Step 3: Dub — visible when audio + video both exist */}
                            {canDub && (
                                <section className="space-y-3 border-t border-glass-border/50 pt-4">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[12px] font-medium text-text-secondary">③ 覆盖到视频</span>
                                        {dubbedVideoUrl && !previewVideoUrl && (
                                            <span className="px-1.5 py-0.5 rounded font-mono text-[9px] uppercase tracking-[0.14em] bg-emerald-500/10 text-emerald-400">
                                                已覆盖
                                            </span>
                                        )}
                                        {previewVideoUrl && (
                                            <span className="px-1.5 py-0.5 rounded font-mono text-[9px] uppercase tracking-[0.14em] bg-amber-500/10 text-amber-400">
                                                预览版
                                            </span>
                                        )}
                                    </div>

                                    {/* Video player */}
                                    <div className="relative rounded-lg overflow-hidden border border-glass-border bg-black">
                                        <video
                                            ref={videoRef}
                                            key={displayVideoUrl}
                                            src={getAssetUrl(displayVideoUrl!)}
                                            className="w-full max-h-[200px] object-contain"
                                            controls
                                            autoPlay={!!previewVideoUrl}
                                            onLoadedMetadata={(e) => {
                                                const dur = (e.currentTarget.duration || 5) * 1000;
                                                setVideoDurationMs(Math.round(dur));
                                            }}
                                        />
                                        {previewVideoUrl && (
                                            <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-[9px] font-medium text-amber-300">
                                                预览版
                                            </div>
                                        )}
                                        {dubbedVideoUrl && !previewVideoUrl && (
                                            <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-[9px] font-medium text-emerald-300">
                                                配音版
                                            </div>
                                        )}
                                    </div>

                                    {/* Mark start point + Offset controls */}
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={handleMarkStart}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary/30 bg-primary/5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
                                            >
                                                <Crosshair size={12} />
                                                标记起始点
                                            </button>
                                            <span className="text-[10px] text-text-muted">暂停视频到口型张开处，点此标记</span>
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-text-muted shrink-0">音频位置</span>
                                            <button
                                                type="button"
                                                onClick={() => setOffsetMs(Math.max(0, offsetMs - 50))}
                                                className="w-6 h-6 flex items-center justify-center rounded border border-glass-border bg-black/30 text-text-muted hover:text-foreground hover:border-white/20 transition-colors"
                                            >
                                                <ChevronLeft size={12} />
                                            </button>
                                            <input
                                                type="number"
                                                value={offsetMs}
                                                onChange={(e) => setOffsetMs(Math.max(0, Math.min(videoDurationMs, Number(e.target.value) || 0)))}
                                                className="w-[64px] rounded border border-glass-border bg-black/40 px-1.5 py-0.5 text-center font-mono text-[11px] text-primary focus:outline-none focus:border-primary/40"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setOffsetMs(Math.min(videoDurationMs, offsetMs + 50))}
                                                className="w-6 h-6 flex items-center justify-center rounded border border-glass-border bg-black/30 text-text-muted hover:text-foreground hover:border-white/20 transition-colors"
                                            >
                                                <ChevronRight size={12} />
                                            </button>
                                            <span className="text-[10px] text-text-muted">ms</span>
                                            <input
                                                type="range"
                                                min={0}
                                                max={videoDurationMs}
                                                step={50}
                                                value={offsetMs}
                                                onChange={(e) => setOffsetMs(Number(e.target.value))}
                                                className="flex-1 accent-primary h-1 cursor-pointer"
                                            />
                                        </div>
                                    </div>

                                    {/* Action buttons — state-dependent */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {/* 预听 — always visible */}
                                        <button
                                            type="button"
                                            onClick={handlePreviewDub}
                                            disabled={previewing}
                                            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md border border-primary/40 bg-primary/10 text-[12px] font-medium text-primary hover:bg-primary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            {previewing ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />}
                                            {previewing ? "生成预览中..." : "预听"}
                                        </button>

                                        {/* 应用覆盖 — only when preview exists */}
                                        {previewVideoUrl && onApplyDub && (
                                            <button
                                                type="button"
                                                onClick={handleApply}
                                                disabled={applying}
                                                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-[12px] font-medium text-emerald-300 hover:bg-emerald-500/15 hover:border-emerald-500/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                {applying ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />}
                                                应用覆盖
                                            </button>
                                        )}

                                        {/* 撤销覆盖 — only when dubbed exists and no preview */}
                                        {dubbedVideoUrl && !previewVideoUrl && onRevertDub && (
                                            <button
                                                type="button"
                                                onClick={handleRevert}
                                                disabled={reverting}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 text-[12px] text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/50 transition-colors disabled:opacity-40"
                                            >
                                                {reverting ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                                                撤销覆盖
                                            </button>
                                        )}
                                    </div>

                                    {previewVideoUrl && (
                                        <p className="text-[10px] text-text-muted">
                                            当前为预览版——确认效果后点「应用覆盖」正式替换，或调整 offset 后重新预听。
                                        </p>
                                    )}
                                </section>
                            )}

                            {/* Error display */}
                            {(audioError || error) && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/20 bg-red-500/5 text-[11px] text-red-300">
                                    <AlertCircle size={12} className="shrink-0 text-red-400" />
                                    <span className="break-words flex-1">{audioError || error}</span>
                                    {error && (
                                        <button type="button" onClick={() => setError(null)} className="shrink-0 text-red-400/60 hover:text-red-300">×</button>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-glass-border/50 bg-black/20 shrink-0">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-secondary transition-colors"
                            >
                                关闭
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
