"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { AlertTriangle, Box, Layers, Loader2, MapPin, Maximize2, Sparkles, Users, Wand2 } from "lucide-react";
import { useTranslations } from "next-intl";
import PreviewImage from "@/components/shared/preview/PreviewImage";

export type AssetVisualKind = "character" | "scene" | "prop";
export type AssetVisualStatus = "ready" | "pending" | "new" | "generating";

interface AssetVisualCardProps {
  kind: AssetVisualKind;
  name: string;
  imageUrl?: string;
  meta?: string;
  description?: string;
  status?: AssetVisualStatus;
  className?: string;
  imageClassName?: string;
  onCardClick?: () => void;
  onImageClick?: () => void;
  onMagnify?: () => void;
  imageOverlay?: ReactNode;
  children?: ReactNode;
  /** When true and the loaded image is wide (≥1.3 aspect), apply
   *  object-cover object-left so three-view/reference sheets crop to
   *  the front/left character inside the portrait card. */
  autoCropWideCharacterSheet?: boolean;
}

function CornerMarks() {
  const size = 10;
  const stroke = "rgba(255,255,255,0.16)";
  return (
    <>
      <svg className="pointer-events-none absolute left-2 top-2" width={size} height={size} aria-hidden="true">
        <path d={`M0 ${size} V0 H${size}`} fill="none" stroke={stroke} strokeWidth="1" />
      </svg>
      <svg className="pointer-events-none absolute right-2 top-2" width={size} height={size} aria-hidden="true">
        <path d={`M0 0 H${size} V${size}`} fill="none" stroke={stroke} strokeWidth="1" />
      </svg>
      <svg className="pointer-events-none absolute bottom-2 left-2" width={size} height={size} aria-hidden="true">
        <path d={`M0 0 V${size} H${size}`} fill="none" stroke={stroke} strokeWidth="1" />
      </svg>
      <svg className="pointer-events-none absolute bottom-2 right-2" width={size} height={size} aria-hidden="true">
        <path d={`M${size} 0 V${size} H0`} fill="none" stroke={stroke} strokeWidth="1" />
      </svg>
    </>
  );
}

export function AssetStatusBadge({ status }: { status: AssetVisualStatus }) {
  const t = useTranslations("cast");
  if (status === "ready") {
    return (
      <span className="inline-flex items-center rounded-full bg-[rgba(100,108,255,0.12)] px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-[#a5aaff]">
        {t("statusReady")}
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(245,158,11,0.12)] px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-[#fbbf24]">
        <AlertTriangle size={9} aria-hidden="true" />
        {t("statusPending")}
      </span>
    );
  }
  if (status === "generating") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(100,108,255,0.14)] px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-[#a5aaff]">
        <Loader2 size={9} className="animate-spin" aria-hidden="true" />
        {t("statusGenerating")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(236,72,153,0.14)] px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-[#f472b6]">
      {t("statusNew")}
    </span>
  );
}

export default function AssetVisualCard({
  kind,
  name,
  imageUrl,
  meta,
  description,
  status,
  className = "",
  imageClassName,
  onCardClick,
  onImageClick,
  onMagnify,
  imageOverlay,
  children,
  autoCropWideCharacterSheet = false,
}: AssetVisualCardProps) {
  const t = useTranslations("cast");
  const [isWideImage, setIsWideImage] = useState(false);
  const styleByKind: Record<AssetVisualKind, {
    aspect: string;
    emptyPattern: CSSProperties;
    chipLabel: string;
    hoverAccent: string;
    watermarkIcon: ReactNode;
    ctaIcon: ReactNode;
    ctaLabel: string;
    imageFit: string;
    radius: string;
  }> = {
    character: {
      aspect: "aspect-[3/4]",
      emptyPattern: {
        backgroundImage: "repeating-linear-gradient(0deg, transparent 0, transparent 23px, rgba(255,255,255,0.025) 23px, rgba(255,255,255,0.025) 24px)",
      },
      chipLabel: t("tabCharacters"),
      hoverAccent: "rgba(167,139,250,0.55)",
      watermarkIcon: <Users size={48} className="text-white/[0.04]" strokeWidth={1} />,
      ctaIcon: <Wand2 size={14} strokeWidth={1.75} />,
      ctaLabel: t("generateReference"),
      imageFit: "object-contain object-top",
      radius: "rounded-lg",
    },
    scene: {
      aspect: "aspect-[16/9]",
      emptyPattern: {
        backgroundImage: [
          "linear-gradient(to bottom, transparent calc(33% - 0.5px), rgba(255,255,255,0.03) 33%, transparent calc(33% + 0.5px))",
          "linear-gradient(to bottom, transparent calc(66% - 0.5px), rgba(255,255,255,0.05) 66%, transparent calc(66% + 0.5px))",
        ].join(", "),
      },
      chipLabel: t("tabScenes"),
      hoverAccent: "rgba(110,231,183,0.5)",
      watermarkIcon: <MapPin size={64} className="text-white/[0.035]" strokeWidth={0.75} />,
      ctaIcon: <Sparkles size={14} strokeWidth={1.75} />,
      ctaLabel: t("generateScene"),
      imageFit: "object-cover object-center",
      radius: "rounded-md",
    },
    prop: {
      aspect: "aspect-square",
      emptyPattern: {
        backgroundImage: "radial-gradient(rgba(255,255,255,0.04) 0.8px, transparent 0.8px)",
        backgroundSize: "10px 10px",
        backgroundPosition: "5px 5px",
      },
      chipLabel: t("tabProps"),
      hoverAccent: "rgba(252,211,77,0.5)",
      watermarkIcon: <Box size={40} className="text-white/[0.04]" strokeWidth={1} />,
      ctaIcon: <Layers size={13} strokeWidth={1.75} />,
      ctaLabel: t("generateProp"),
      imageFit: "object-contain object-center",
      radius: "rounded-lg",
    },
  };
  const style = styleByKind[kind];

  const handleImageLoad = (img: HTMLImageElement) => {
    if (autoCropWideCharacterSheet) {
      setIsWideImage(img.naturalWidth / img.naturalHeight >= 1.3);
    }
  };

  const effectiveImageClassName = imageClassName
    || (kind === "character" && autoCropWideCharacterSheet && isWideImage
        ? "object-cover object-left"
        : style.imageFit);
  const isGenerating = status === "generating";

  return (
    <div
      onClick={onCardClick}
      className={`group/cast-card relative flex h-full min-w-0 flex-col gap-2 ${style.radius} border border-glass-border bg-glass p-2 transition-[border-color,background-color] duration-fast ease-out-quart hover:border-white/15 ${onCardClick ? "cursor-pointer" : ""} ${className}`}
    >
      <span className="absolute right-2.5 top-2.5 z-10 pointer-events-none inline-flex items-center rounded-sm border border-white/10 bg-black/40 px-1.5 py-[1px] font-mono text-[8.5px] uppercase tracking-[0.18em] text-text-muted backdrop-blur-sm">
        {style.chipLabel}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-2 top-0 h-px opacity-0 transition-opacity group-hover/cast-card:opacity-100"
        style={{ background: style.hoverAccent }}
      />
      <div
        className={`${style.aspect} relative shrink-0 overflow-hidden rounded-md bg-black/40 cursor-pointer`}
        onClick={(event) => {
          event.stopPropagation();
          onImageClick?.();
        }}
      >
        {imageUrl ? (
          <>
            <PreviewImage src={imageUrl} alt={name} className="h-full w-full bg-white/[.03]" imageClassName={effectiveImageClassName} noLightbox onImageLoad={handleImageLoad} />
            {onMagnify && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onMagnify();
                }}
                aria-label="放大查看"
                title="放大查看"
                className="absolute left-1.5 top-1.5 z-10 grid h-6 w-6 place-items-center rounded bg-black/55 text-white/80 opacity-0 backdrop-blur transition-opacity hover:bg-black/75 group-hover/cast-card:opacity-100"
              >
                <Maximize2 size={11} />
              </button>
            )}
          </>
        ) : (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onImageClick?.();
            }}
            className="relative grid h-full w-full place-items-center overflow-hidden bg-black/20 text-text-secondary transition-colors hover:text-foreground"
            style={style.emptyPattern}
          >
            <span className="pointer-events-none absolute inset-0 grid place-items-center">{style.watermarkIcon}</span>
            {kind === "scene" && (
              <>
                <span className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-black/30 to-transparent" aria-hidden="true" />
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-black/30 to-transparent" aria-hidden="true" />
              </>
            )}
            <CornerMarks />
            <span className="relative z-10 flex flex-col items-center gap-1.5">
              {isGenerating ? <Loader2 size={14} className="animate-spin" strokeWidth={1.75} /> : style.ctaIcon}
              <span className="text-[10px] font-medium tracking-wide">
                {isGenerating ? t("statusGenerating") : style.ctaLabel}
              </span>
            </span>
          </button>
        )}
        {imageOverlay}
      </div>
      <div className="space-y-1 px-0.5">
        <p className="truncate font-sans text-[13px] font-medium text-foreground" title={name}>
          {name}
        </p>
        {(meta || description || status) && (
          <div className="flex items-start justify-between gap-2">
            <span className={`${description ? "line-clamp-2 normal-case tracking-normal" : "uppercase tracking-[0.12em]"} min-h-[1.25rem] flex-1 font-mono text-[10px] text-text-muted`}>
              {description || meta}
            </span>
            {status && <AssetStatusBadge status={status} />}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
