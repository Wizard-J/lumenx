"use client";

import { Image as ImageIcon, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Character, Scene, Prop } from "@/store/projectStore";
import { getAssetUrl } from "@/lib/utils";

type AssetTab = "characters" | "scenes" | "props";

interface AssetCardProps {
  asset: Character | Scene | Prop;
  type: AssetTab;
  variant?: "compact" | "gallery";
}

function getImageUrl(asset: Character | Scene | Prop, type: AssetTab): string | undefined {
  if (type === "characters") {
    const char = asset as Character;
    if (char.full_body_asset?.variants?.length) {
      const selected = char.full_body_asset.variants.find(
        (v) => v.id === char.full_body_asset?.selected_id
      );
      return selected?.url || char.full_body_asset.variants[0]?.url;
    }
    return char.image_url || char.full_body_image_url;
  }
  if (type === "scenes") {
    const scene = asset as Scene;
    if (scene.image_asset?.variants?.length) {
      const selected = scene.image_asset.variants.find(
        (v) => v.id === scene.image_asset?.selected_id
      );
      return selected?.url || scene.image_asset.variants[0]?.url;
    }
    return scene.image_url;
  }
  const prop = asset as Prop;
  if (prop.image_asset?.variants?.length) {
    const selected = prop.image_asset.variants.find(
      (v) => v.id === prop.image_asset?.selected_id
    );
    return selected?.url || prop.image_asset.variants[0]?.url;
  }
  return prop.image_url;
}

export default function AssetCard({ asset, type, variant = "compact" }: AssetCardProps) {
  const imageUrl = getImageUrl(asset, type);
  const t = useTranslations("assetCard");
  // Series-shared assets get a subtle top-right badge so the user
  // knows mutations here will propagate across episodes (A1 design
  // decision). Episode-local stays unbadged — the more common case.
  const isShared = (asset as Character | Scene | Prop).source === "series";

  const isGallery = variant === "gallery";
  const mediaClassName = (() => {
    if (!isGallery) return "aspect-square";
    if (type === "characters") return "aspect-[4/5]";
    if (type === "scenes") return "aspect-video";
    return "aspect-square";
  })();
  const imageFitClassName = type === "characters"
    ? "object-cover object-top"
    : type === "scenes"
      ? "object-cover object-center"
      : "object-contain object-center";

  return (
    <div className={`glass-panel overflow-hidden relative transition-all duration-200 hover:border-white/15 hover:shadow-lg hover:shadow-black/20 ${isGallery ? "rounded-2xl" : "rounded-xl"}`}>
      {isShared ? (
        <span
          className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full border border-status-starred-border bg-status-starred-bg px-2 py-[2px] font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-status-starred-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[2px]"
          title={t("seriesSharedTooltip")}
        >
          <Share2 size={10} aria-hidden="true" />
          {t("seriesSharedBadge")}
        </span>
      ) : null}
      <div className={`${mediaClassName} bg-elevated/50 flex items-center justify-center overflow-hidden`}>
        {imageUrl ? (
          <img
            src={getAssetUrl(imageUrl || "")}
            alt={asset.name}
            className={`w-full h-full ${imageFitClassName} transition-transform duration-300 group-hover/card:scale-[1.03]`}
          />
        ) : (
          <ImageIcon size={isGallery ? 38 : 32} className="text-text-muted" />
        )}
      </div>
      <div className={isGallery ? "px-4 py-3" : "p-3"}>
        <h4 className={`${isGallery ? "text-[15px]" : "text-sm"} font-medium text-foreground truncate`}>{asset.name}</h4>
        {asset.description && (
          <p className={`${isGallery ? "text-[12px] leading-5" : "text-xs"} text-text-secondary mt-1 line-clamp-2`}>{asset.description}</p>
        )}
      </div>
    </div>
  );
}
