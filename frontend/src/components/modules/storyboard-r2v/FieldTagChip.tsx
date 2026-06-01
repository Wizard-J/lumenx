"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pencil, Plus } from "lucide-react";

export type FieldType = "duration" | "shotSize" | "cameraAngle" | "cameraMovement" | "transitionHint";

interface DurationEditorConfig {
    type: "duration";
    min: number;
    max: number;
    step: number;
}

interface PresetEditorConfig {
    type: "preset";
    presets: string[];
    allowCustom?: boolean;
}

export type EditorConfig = DurationEditorConfig | PresetEditorConfig;

const FIELD_COLORS: Record<FieldType, { bg: string; border: string; text: string; hoverBorder: string }> = {
    duration: {
        bg: "bg-emerald-500/10",
        border: "border-emerald-500/25",
        text: "text-emerald-200",
        hoverBorder: "hover:border-emerald-400/50",
    },
    shotSize: {
        bg: "bg-sky-500/10",
        border: "border-sky-500/25",
        text: "text-sky-200",
        hoverBorder: "hover:border-sky-400/50",
    },
    cameraAngle: {
        bg: "bg-sky-500/10",
        border: "border-sky-500/25",
        text: "text-sky-200",
        hoverBorder: "hover:border-sky-400/50",
    },
    cameraMovement: {
        bg: "bg-teal-500/10",
        border: "border-teal-500/25",
        text: "text-teal-200",
        hoverBorder: "hover:border-teal-400/50",
    },
    transitionHint: {
        bg: "bg-purple-500/10",
        border: "border-purple-500/25",
        text: "text-purple-200",
        hoverBorder: "hover:border-purple-400/50",
    },
};

const FIELD_LABELS: Record<FieldType, string> = {
    duration: "时长",
    shotSize: "景别",
    cameraAngle: "机位",
    cameraMovement: "运镜",
    transitionHint: "转场",
};

interface FieldTagChipProps {
    field: FieldType;
    value: string | number | null | undefined;
    editorConfig: EditorConfig;
    onChange: (value: string | number | null) => void;
}

export default function FieldTagChip({ field, value, editorConfig, onChange }: FieldTagChipProps) {
    const [open, setOpen] = useState(false);
    const chipRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    const colors = FIELD_COLORS[field];
    const label = FIELD_LABELS[field];
    const isEmpty = value === null || value === undefined || value === "";

    useEffect(() => {
        if (!open) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (
                popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
                chipRef.current && !chipRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEsc);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEsc);
        };
    }, [open]);

    const displayValue = isEmpty
        ? `${label}?`
        : field === "duration"
            ? `${value}s`
            : String(value);

    return (
        <div className="relative inline-flex">
            <button
                ref={chipRef}
                type="button"
                onClick={() => setOpen(v => !v)}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium cursor-pointer transition-all duration-150 ease-out group/chip ${
                    isEmpty
                        ? `border border-dashed border-white/20 bg-white/[0.02] text-text-muted hover:border-white/40 hover:text-text-secondary`
                        : `border ${colors.border} ${colors.bg} ${colors.text} ${colors.hoverBorder} hover:scale-[1.02]`
                }`}
            >
                <span>{displayValue}</span>
                {isEmpty ? (
                    <Plus size={10} strokeWidth={2.5} className="opacity-60" />
                ) : (
                    <Pencil size={9} strokeWidth={2} className="opacity-0 group-hover/chip:opacity-60 transition-opacity" />
                )}
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        ref={popoverRef}
                        initial={{ opacity: 0, y: -4, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        className="absolute top-full left-0 mt-1.5 z-50 min-w-[180px] rounded-lg border border-white/[0.08] bg-[#0a0a0f]/95 backdrop-blur-xl shadow-xl p-2"
                    >
                        {editorConfig.type === "duration" ? (
                            <DurationEditor
                                min={editorConfig.min}
                                max={editorConfig.max}
                                step={editorConfig.step}
                                value={typeof value === "number" ? value : editorConfig.min}
                                onChange={(v) => { onChange(v); setOpen(false); }}
                            />
                        ) : (
                            <PresetEditor
                                presets={editorConfig.presets}
                                allowCustom={editorConfig.allowCustom ?? true}
                                value={typeof value === "string" ? value : ""}
                                onChange={(v) => { onChange(v || null); setOpen(false); }}
                            />
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function DurationEditor({ min, max, step, value, onChange }: {
    min: number; max: number; step: number; value: number;
    onChange: (v: number) => void;
}) {
    const [local, setLocal] = useState(value);

    const options = [];
    for (let i = min; i <= max; i += step) {
        options.push(i);
    }

    const showGrid = options.length <= 15;

    if (showGrid) {
        return (
            <div className="grid grid-cols-4 gap-1">
                {options.map(n => (
                    <button
                        key={n}
                        type="button"
                        onClick={() => onChange(n)}
                        className={`rounded-md px-2 py-1.5 text-[12px] font-mono font-medium transition-colors ${
                            n === value
                                ? "bg-emerald-500/20 border border-emerald-400/40 text-emerald-200"
                                : "bg-white/[0.04] border border-white/[0.06] text-text-secondary hover:bg-white/[0.08] hover:text-foreground"
                        }`}
                    >
                        {n}s
                    </button>
                ))}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={local}
                onChange={(e) => setLocal(Number(e.target.value))}
                onMouseUp={() => onChange(local)}
                onTouchEnd={() => onChange(local)}
                className="w-full accent-emerald-400"
            />
            <div className="flex items-center justify-between text-[11px] font-mono text-text-muted">
                <span>{min}s</span>
                <span className="text-emerald-200 font-medium">{local}s</span>
                <span>{max}s</span>
            </div>
        </div>
    );
}

function PresetEditor({ presets, allowCustom, value, onChange }: {
    presets: string[]; allowCustom: boolean; value: string;
    onChange: (v: string) => void;
}) {
    const [custom, setCustom] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === "Enter" && custom.trim()) {
            onChange(custom.trim());
        }
    }, [custom, onChange]);

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1">
                {presets.map(p => (
                    <button
                        key={p}
                        type="button"
                        onClick={() => onChange(p)}
                        className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                            p === value
                                ? "bg-primary/20 border border-primary/40 text-primary"
                                : "bg-white/[0.04] border border-white/[0.06] text-text-secondary hover:bg-white/[0.08] hover:text-foreground"
                        }`}
                    >
                        {p}
                    </button>
                ))}
            </div>
            {allowCustom && (
                <input
                    ref={inputRef}
                    type="text"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="自定义…"
                    className="w-full rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[11px] text-foreground placeholder:text-text-muted outline-none focus:border-primary/40 transition-colors"
                />
            )}
        </div>
    );
}

export function AddFieldButton({ onAdd }: { onAdd: (field: FieldType) => void }) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (
                menuRef.current && !menuRef.current.contains(e.target as Node) &&
                btnRef.current && !btnRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [open]);

    const fields: { key: FieldType; label: string }[] = [
        { key: "shotSize", label: "景别" },
        { key: "cameraAngle", label: "机位" },
        { key: "cameraMovement", label: "运镜" },
        { key: "transitionHint", label: "转场" },
    ];

    return (
        <div className="relative inline-flex">
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen(v => !v)}
                className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-white/15 px-1.5 py-1 text-[11px] text-text-muted hover:border-white/30 hover:text-text-secondary transition-colors cursor-pointer"
            >
                <Plus size={10} strokeWidth={2.5} />
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div
                        ref={menuRef}
                        initial={{ opacity: 0, y: -4, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.96 }}
                        transition={{ duration: 0.12 }}
                        className="absolute top-full left-0 mt-1 z-50 min-w-[100px] rounded-lg border border-white/[0.08] bg-[#0a0a0f]/95 backdrop-blur-xl shadow-xl p-1"
                    >
                        {fields.map(f => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => { onAdd(f.key); setOpen(false); }}
                                className="w-full text-left rounded-md px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-white/[0.06] hover:text-foreground transition-colors"
                            >
                                {f.label}
                            </button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
