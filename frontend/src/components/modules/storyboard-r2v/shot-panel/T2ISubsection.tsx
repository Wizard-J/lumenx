"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Pin, Sparkles, Upload, X } from "lucide-react";
import clsx from "clsx";
import { useTranslations } from "next-intl";
import { PendingTaskAffordance } from "@/components/shared/PendingTaskAffordance";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import { debugLog } from "@/lib/debugLog";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type T2IUploadError =
    | "type"
    | "size"
    | "network"
    | { code: "type" | "size" | "network" | "not_found" | "server"; detail: string };

interface T2ISubsectionProps {
    imageUrls: string[];
    selectedIndex: number;
    storyboardFrameUrl?: string;
    promptIsEmpty: boolean;
    generating: boolean;
    inFlightTaskId?: string;
    inFlightStatus?: "pending" | "processing" | "completed" | "failed";
    onSelect: (index: number) => void;
    onRemove: (index: number) => void;
    onGenerate: () => void;
    onUpload: (file: File) => Promise<T2IUploadError | void>;
    resolveUrl?: (url: string) => string;
}

function formatUploadError(err: T2IUploadError, t: ReturnType<typeof useTranslations>): string {
    const code = typeof err === "string" ? err : err.code;
    const detail = typeof err === "string" ? "" : err.detail;
    const base =
        code === "type" ? t("t2iHeroUploadInvalidType") :
        code === "size" ? t("t2iHeroUploadTooLarge") :
        code === "not_found" ? "镜头还未保存到服务器，先添加描述再上传首帧。" :
        code === "server" ? "服务端处理失败。" :
        t("t2iHeroUploadFailed");
    return detail ? `${base}（${detail}）` : base;
}

export default function T2ISubsection({
    imageUrls,
    selectedIndex,
    storyboardFrameUrl,
    promptIsEmpty,
    generating,
    inFlightTaskId,
    inFlightStatus,
    onSelect,
    onRemove,
    onGenerate,
    onUpload,
    resolveUrl,
}: T2ISubsectionProps) {
    void resolveUrl;
    const t = useTranslations("storyboardR2V");
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<T2IUploadError | null>(null);
    const [hoveredCandidate, setHoveredCandidate] = useState<number | null>(null);

    const safeIndex = imageUrls.length === 0
        ? -1
        : Math.max(0, Math.min(selectedIndex, imageUrls.length - 1));
    const activeUrl = safeIndex >= 0 ? imageUrls[safeIndex] : storyboardFrameUrl;
    const activeIsStoryboard = safeIndex < 0 && !!storyboardFrameUrl;
    const generateDisabled = promptIsEmpty || generating;
    const uploadDisabled = uploading || generating;

    const handleFile = async (file: File) => {
        setUploadError(null);
        if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
            setUploadError("type");
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            setUploadError("size");
            return;
        }
        setUploading(true);
        try {
            const result = await onUpload(file);
            if (result) setUploadError(result);
        } catch (e) {
            debugLog.error("Studio", "T2I upload failed", e);
            setUploadError("network");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="border-t border-white/[0.06] p-3">
            <div className="overflow-hidden rounded-lg border border-glass-border bg-black/30">
                <div className="flex items-center justify-between border-b border-glass-border px-3 py-2">
                    <span className="text-[12px] font-semibold text-foreground">分镜图</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                        {activeUrl ? "Ready" : generating ? "Generating" : "Required"}
                    </span>
                </div>

                <div className="p-3">
                    <div className="grid max-w-[460px] gap-2 sm:grid-cols-[220px_minmax(150px,1fr)] xl:max-w-[520px] xl:grid-cols-[260px_minmax(170px,1fr)]">
                    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-glass-border bg-black/45">
                        {activeUrl ? (
                            <>
                                <PreviewImage
                                    src={activeUrl}
                                    alt="分镜图"
                                    className="absolute inset-0 h-full w-full"
                                    imageClassName="object-cover"
                                />
                                {activeIsStoryboard ? (
                                    <span className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-text-secondary">
                                        <Pin size={9} aria-hidden="true" />
                                        storyboard
                                    </span>
                                ) : null}
                                {generating ? (
                                    <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[1px]">
                                        <PendingTaskAffordance
                                            statusLabel={inFlightStatus === "pending" ? "Queued" : "Generating"}
                                            taskId={inFlightTaskId}
                                            compact
                                        />
                                    </div>
                                ) : null}
                            </>
                        ) : (
                            <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
                                {generating ? (
                                    <PendingTaskAffordance
                                        statusLabel={inFlightStatus === "pending" ? "Queued" : "Generating"}
                                        taskId={inFlightTaskId}
                                        compact
                                    />
                                ) : (
                                    <>
                                        <ImageIcon size={22} />
                                        <span className="text-[12px]">请先生成或上传分镜图</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex min-w-0 flex-col gap-2">
                        <div className="grid grid-cols-1 gap-2">
                            <button
                                type="button"
                                onClick={onGenerate}
                                disabled={generateDisabled}
                                title={promptIsEmpty ? t("t2iHeroGenerateDisabledTooltip") : undefined}
                                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 text-[12px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/16 disabled:cursor-not-allowed disabled:opacity-45"
                            >
                                {generating ? (
                                    <Loader2 size={13} className="animate-spin" />
                                ) : (
                                    <Sparkles size={13} />
                                )}
                                {activeUrl ? "重新生成" : "生成"}
                            </button>
                            <button
                                type="button"
                                onClick={() => inputRef.current?.click()}
                                disabled={uploadDisabled}
                                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-glass-border bg-black/25 px-2.5 text-[12px] font-semibold text-text-secondary transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
                            >
                                {uploading ? (
                                    <Loader2 size={13} className="animate-spin" />
                                ) : (
                                    <Upload size={13} />
                                )}
                                上传
                            </button>
                            <input
                                ref={inputRef}
                                type="file"
                                accept={ALLOWED_UPLOAD_TYPES.join(",")}
                                className="sr-only"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) void handleFile(file);
                                    e.target.value = "";
                                }}
                            />
                        </div>

                        {(storyboardFrameUrl || imageUrls.length > 0) ? (
                            <div>
                                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                                    可选分镜图
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {storyboardFrameUrl ? (
                                        <div
                                            aria-label="使用原始分镜图"
                                            title="原始分镜图"
                                            className={clsx(
                                                "group relative h-12 w-16 overflow-hidden rounded border transition-colors",
                                                activeIsStoryboard
                                                    ? "border-primary bg-primary/10"
                                                    : "border-glass-border bg-black/30 opacity-70 hover:border-white/25 hover:opacity-100",
                                            )}
                                        >
                                            <PreviewImage src={storyboardFrameUrl} alt="" className="h-full w-full" imageClassName="object-cover" />
                                            <Pin size={9} className="absolute left-1 top-1 text-white/85" />
                                        </div>
                                    ) : null}
                                    {imageUrls.map((url, idx) => {
                                        const active = idx === safeIndex;
                                        return (
                                            <div
                                                key={`${url}-${idx}`}
                                                onMouseEnter={() => setHoveredCandidate(idx)}
                                                onMouseLeave={() => setHoveredCandidate((current) => current === idx ? null : current)}
                                                className={clsx(
                                                    "group relative h-12 w-16 overflow-hidden rounded border transition-colors",
                                                    active
                                                        ? "border-primary bg-primary/10"
                                                        : "border-glass-border bg-black/30 hover:border-white/25",
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => onSelect(idx)}
                                                    aria-label={`选择分镜图候选 ${idx + 1}`}
                                                    className="h-full w-full"
                                                >
                                                    <PreviewImage src={url} alt="" className="h-full w-full" imageClassName="object-cover" />
                                                </button>
                                                {hoveredCandidate === idx ? (
                                                    <button
                                                        type="button"
                                                        aria-label={`删除分镜图候选 ${idx + 1}`}
                                                        title="删除"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onRemove(idx);
                                                        }}
                                                        onKeyDown={(e) => {
                                                            if (e.key === "Enter" || e.key === " ") {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                onRemove(idx);
                                                            }
                                                        }}
                                                        className="absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-black/75 text-white/95 transition-colors hover:bg-status-failed-fg"
                                                    >
                                                        <X size={9} />
                                                    </button>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : null}

                        {uploadError ? (
                            <p role="alert" className="font-sans text-body-sm text-status-failed-fg">
                                {formatUploadError(uploadError, t)}
                            </p>
                        ) : null}
                    </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
