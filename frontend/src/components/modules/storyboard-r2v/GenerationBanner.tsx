"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, CheckCircle2 } from "lucide-react";

export type BannerState = "idle" | "phase1" | "phase2" | "dialogue" | "summary";

export interface GenerationBannerProps {
    state: BannerState;
    phase1Captions: string[];
    refineProgress?: { current: number; total: number } | null;
    dialogueProgress?: { current: number; total: number } | null;
    summary?: { frameCount: number; dialogueReady: number; dialogueMissing: number } | null;
    onGenerateDialogue?: () => void;
}

const CAPTION_INTERVAL = 3000;

export function GenerationBanner({
    state,
    phase1Captions,
    refineProgress,
    dialogueProgress,
    summary,
    onGenerateDialogue,
}: GenerationBannerProps) {
    const [captionIndex, setCaptionIndex] = useState(0);

    useEffect(() => {
        if (state !== "phase1") {
            setCaptionIndex(0);
            return;
        }
        const timer = setInterval(() => {
            setCaptionIndex((i) => (i + 1) % phase1Captions.length);
        }, CAPTION_INTERVAL);
        return () => clearInterval(timer);
    }, [state, phase1Captions.length]);

    if (state === "idle") return null;
    if (state === "summary" && !summary) return null;

    return (
        <AnimatePresence mode="wait">
            {state === "phase1" && (
                <BannerShell key="phase1">
                    <Loader2 size={13} className="animate-spin text-primary shrink-0" />
                    <AnimatePresence mode="wait">
                        <motion.span
                            key={captionIndex}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.25 }}
                            className="text-xs text-text-secondary"
                        >
                            {phase1Captions[captionIndex]}
                        </motion.span>
                    </AnimatePresence>
                </BannerShell>
            )}

            {state === "phase2" && (
                <BannerShell key="phase2">
                    <Loader2 size={13} className="animate-spin text-amber-400 shrink-0" />
                    <span className="text-xs text-text-secondary">
                        精修第{" "}
                        <span className="text-foreground font-medium">
                            {refineProgress?.current ?? 0}/{refineProgress?.total ?? 0}
                        </span>{" "}
                        帧…
                    </span>
                </BannerShell>
            )}

            {state === "dialogue" && (
                <BannerShell key="dialogue">
                    <Loader2 size={13} className="animate-spin text-blue-400 shrink-0" />
                    <span className="text-xs text-text-secondary">
                        生成对白{" "}
                        <span className="text-foreground font-medium">
                            {dialogueProgress?.current ?? 0}/{dialogueProgress?.total ?? 0}
                        </span>
                        …
                    </span>
                </BannerShell>
            )}

            {state === "summary" && summary && (
                <SummaryBar
                    key="summary"
                    summary={summary}
                    onGenerateDialogue={onGenerateDialogue}
                />
            )}
        </AnimatePresence>
    );
}

function BannerShell({ children }: { children: React.ReactNode }) {
    return (
        <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden shrink-0"
        >
            <div className="flex items-center gap-2.5 h-10 px-6 border-b border-white/[0.06] bg-white/[0.02]">
                {children}
            </div>
        </motion.div>
    );
}

function SummaryBar({
    summary,
    onGenerateDialogue,
}: {
    summary: { frameCount: number; dialogueReady: number; dialogueMissing: number };
    onGenerateDialogue?: () => void;
}) {
    const showCTA = summary.dialogueReady > 0;

    return (
        <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden shrink-0"
        >
            <div className="flex items-center gap-2.5 h-9 px-6 border-b border-white/[0.04] bg-white/[0.01]">
                <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                <span className="text-[13px] text-text-secondary">
                    {summary.frameCount} 帧
                    {summary.dialogueReady > 0 && (
                        <span className="ml-1.5">· {summary.dialogueReady} 帧对白待生成</span>
                    )}
                    {summary.dialogueMissing > 0 && (
                        <span className="ml-1.5 text-amber-400/80">· {summary.dialogueMissing} 帧缺语音绑定</span>
                    )}
                </span>
                {showCTA && onGenerateDialogue && (
                    <button
                        type="button"
                        onClick={onGenerateDialogue}
                        title="用绑定的角色声音合成对白音频（在 Assembly 步骤中与视频合并）"
                        className="ml-2 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium text-primary bg-primary/10 hover:bg-primary/15 transition-colors"
                    >
                        🎙 合成对白语音
                    </button>
                )}
            </div>
        </motion.div>
    );
}
