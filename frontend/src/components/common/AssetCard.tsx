"use client";

import { useState } from "react";
import { Image as ImageIcon, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Character, Scene, Prop, AssetStage } from "@/store/projectStore";
import { getAssetUrl } from "@/lib/utils";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import AssetStageDialog from "./AssetStageDialog";

type AssetTab = "characters" | "scenes" | "props";

interface AssetCardProps {
  asset: Character | Scene | Prop;
  type: AssetTab;
  variant?: "compact" | "gallery";
  currentEpisode?: number;
  onStageAction?: (asset: Character | Scene | Prop, action: string, stage?: AssetStage, data?: Record<string, unknown>) => Promise<void>;
}

function getImageUrl(asset: Character | Scene | Prop, type: AssetTab, currentEpisode?: number): string | undefined {
  if (type === "characters") {
    const char = asset as any;
    // 1) Episode-stage reference images
    const activeStage = char?.stages?.find((stage: any) =>
      currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode,
    );
    const stageImage = activeStage?.reference_images?.find(
      (image: any) => image.id === activeStage.selected_image_id,
    )?.url;
    if (stageImage) return stageImage;
    // 2) reference_sheet (new unified field)
    const sheet = char.reference_sheet;
    const sheetSelected = sheet?.image_variants?.find((item: any) => item.id === sheet.selected_image_id);
    if (sheetSelected?.url) return sheetSelected.url;
    // 3) full_body variants (legacy AssetUnit v2)
    const fullBody = char.full_body?.image_variants?.find(
      (v: any) => v.id === char.full_body?.selected_image_id,
    )?.url;
    if (fullBody) return fullBody;
    // 4) full_body_asset variants (alternate legacy)
    if (char.full_body_asset?.variants?.length) {
      const selected = char.full_body_asset.variants.find((v: any) => v.id === char.full_body_asset?.selected_id);
      if (selected?.url) return selected.url;
    }
    // 5) Legacy fallback url fields
    return char.full_body_image_url || char.three_view_image_url || char.headshot_image_url || char.image_url;
  }
  const scene = asset as any;
  // Scene/Prop: same multi-level chain as characters but adapted
  // 1) Episode-stage reference images
  const activeStage = scene?.stages?.find((stage: any) =>
    currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode,
  );
  const stageImage = activeStage?.reference_images?.find(
    (image: any) => image.id === activeStage.selected_image_id,
  )?.url;
  if (stageImage) return stageImage;
  // 2) reference_sheet (unified field, if present)
  const sheet = scene.reference_sheet;
  const sheetSelected = sheet?.image_variants?.find((item: any) => item.id === sheet.selected_image_id);
  if (sheetSelected?.url) return sheetSelected.url;
  // 3) image_asset variants
  const imageAsset = scene.image_asset;
  if (imageAsset?.variants?.length) {
    const selected = imageAsset.variants.find((v: any) => v.id === imageAsset.selected_id);
    if (selected?.url) return selected.url;
  }
  // 4) Legacy fallback
  return scene.image_url || scene.reference_image_url;
}

export default function AssetCard({ asset, type, variant = "compact", currentEpisode, onStageAction }: AssetCardProps) {
  const imageUrl = getImageUrl(asset, type, currentEpisode);
  const t = useTranslations("assetCard");
  const [stageOpen, setStageOpen] = useState(false);
  const stages = type === "props" ? [] : ((asset as Character | Scene).stages || []);
  const currentStage = stages.find((stage) => currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode) || stages[0];
  const isShared = asset.source === "series";
  const isGallery = variant === "gallery";
  const mediaClassName = !isGallery ? "aspect-square" : type === "characters" ? "aspect-[3/4]" : type === "scenes" ? "aspect-video" : "aspect-square";
  const imageFitClassName = type === "characters" ? "object-contain object-top" : type === "scenes" ? "object-cover object-center" : "object-contain object-center";

  return <>
    <button onClick={(event) => { if (type !== "props") { event.stopPropagation(); setStageOpen(true); } }} className={`text-left glass-panel overflow-hidden relative transition-all duration-200 hover:border-white/15 hover:shadow-lg hover:shadow-black/20 ${isGallery ? "rounded-2xl" : "rounded-xl"} ${type !== "props" ? "cursor-pointer" : "cursor-default"}`}>
      {isShared && <span className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full border border-status-starred-border bg-status-starred-bg px-2 py-[2px] font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-status-starred-fg backdrop-blur-[2px]" title={t("seriesSharedTooltip")}><Share2 size={10}/>{t("seriesSharedBadge")}</span>}
      <div className={`${mediaClassName} bg-black/40 flex items-center justify-center overflow-hidden`}>{imageUrl ? <PreviewImage src={imageUrl} alt={asset.name} className={`h-full w-full ${imageFitClassName} bg-white/[.03]`} /> : <ImageIcon size={isGallery ? 38 : 32} className="text-text-muted"/>}</div>
      <div className={isGallery ? "px-4 py-3" : "p-3"}><h4 className={`${isGallery ? "text-[15px]" : "text-sm"} font-medium text-foreground truncate`}>{asset.name}</h4>{asset.description && <p className={`${isGallery ? "text-[12px] leading-5" : "text-xs"} mt-1 line-clamp-2 text-text-secondary`}>{asset.description}</p>}{stages.length > 0 && <div className="mt-2 flex items-center gap-1 text-[10px] font-mono text-primary"><span>{stages.length} STAGES</span><span className="text-text-muted">·</span><span className="truncate">{currentStage?.label}</span></div>}</div>
    </button>
    {type !== "props" && (
      <AssetStageDialog open={stageOpen} asset={asset as Character | Scene} assetType={type === "characters" ? "character" : "scene"} currentEpisode={currentEpisode} onClose={() => setStageOpen(false)} onAction={onStageAction as any}/>
    )}
  </>;
}
