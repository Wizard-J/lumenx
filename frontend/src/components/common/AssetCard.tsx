"use client";

import { useState } from "react";
import type { Character, Scene, Prop, AssetStage } from "@/store/projectStore";
import { getAssetUrl } from "@/lib/utils";
import { useLightbox } from "@/components/shared/preview/LightboxProvider";
import AssetVisualCard, { type AssetVisualKind } from "./AssetVisualCard";
import AssetStageDialog from "./AssetStageDialog";

type AssetTab = "characters" | "scenes" | "props";

interface AssetCardProps {
  asset: Character | Scene | Prop;
  type: AssetTab;
  variant?: "compact" | "gallery";
  currentEpisode?: number;
  onOpenWorkbench?: (asset: Character | Scene | Prop) => void;
  onStageAction?: (asset: Character | Scene | Prop, action: string, stage?: AssetStage, data?: Record<string, unknown>) => Promise<void>;
}

type CharacterPreview = {
  url?: string;
  layout: "portrait" | "sheet";
};

function selectedVariantUrl(container: any, variantsKey: "variants" | "image_variants" | "reference_images", selectedKey: "selected_id" | "selected_image_id"): string | undefined {
  const variants = container?.[variantsKey];
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  const selected = variants.find((item: any) => item.id === container?.[selectedKey]);
  return selected?.url || variants[variants.length - 1]?.url || variants[0]?.url;
}

function activeOrFirstStage(asset: any, currentEpisode?: number): any {
  const stages = asset?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return undefined;
  return stages.find((stage: any) =>
    currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode,
  ) || stages[0];
}

function getImageUrl(asset: Character | Scene | Prop, type: AssetTab, currentEpisode?: number): CharacterPreview {
  if (type === "characters") {
    const char = asset as any;
    const activeStage = activeOrFirstStage(char, currentEpisode);
    const stageImage = selectedVariantUrl(activeStage, "reference_images", "selected_image_id");
    if (stageImage) return { url: stageImage, layout: "portrait" };
    const sheet = selectedVariantUrl(char.reference_sheet, "image_variants", "selected_image_id");
    if (sheet) return { url: sheet, layout: "sheet" };
    const threeViews = selectedVariantUrl(char.three_views, "image_variants", "selected_image_id");
    if (threeViews) return { url: threeViews, layout: "sheet" };
    const threeViewAsset = selectedVariantUrl(char.three_view_asset, "variants", "selected_id");
    if (threeViewAsset) return { url: threeViewAsset, layout: "sheet" };
    if (char.three_view_image_url) return { url: char.three_view_image_url, layout: "sheet" };
    const fullBody = selectedVariantUrl(char.full_body, "image_variants", "selected_image_id");
    if (fullBody) return { url: fullBody, layout: "portrait" };
    const fullBodyAsset = selectedVariantUrl(char.full_body_asset, "variants", "selected_id");
    if (fullBodyAsset) return { url: fullBodyAsset, layout: "portrait" };
    return { url: char.full_body_image_url || char.headshot_image_url || char.image_url, layout: "portrait" };
  }
  const scene = asset as any;
  const activeStage = activeOrFirstStage(scene, currentEpisode);
  const stageImage = selectedVariantUrl(activeStage, "reference_images", "selected_image_id");
  if (stageImage) return { url: stageImage, layout: "portrait" };
  const sheet = selectedVariantUrl(scene.reference_sheet, "image_variants", "selected_image_id");
  if (sheet) return { url: sheet, layout: "portrait" };
  const imageAsset = selectedVariantUrl(scene.image_asset, "variants", "selected_id");
  if (imageAsset) return { url: imageAsset, layout: "portrait" };
  return { url: scene.image_url || scene.reference_image_url, layout: "portrait" };
}

export default function AssetCard({ asset, type, variant = "compact", currentEpisode, onOpenWorkbench, onStageAction }: AssetCardProps) {
  const preview = getImageUrl(asset, type, currentEpisode);
  const { open: openLightbox } = useLightbox();
  const [stageOpen, setStageOpen] = useState(false);
  const stages = type === "props" ? [] : ((asset as Character | Scene).stages || []);
  const currentStage = stages.find((stage) => currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode) || stages[0];
  const kind: AssetVisualKind = type === "characters" ? "character" : type === "scenes" ? "scene" : "prop";
  const handleOpen = () => {
    if (type === "props") {
      onOpenWorkbench?.(asset);
      return;
    }
    setStageOpen(true);
  };

  return <>
    <AssetVisualCard
      kind={kind}
      name={asset.name}
      imageUrl={preview.url}
      imageClassName={type === "characters" && preview.layout === "sheet" ? "object-cover object-left" : undefined}
      autoCropWideCharacterSheet={type === "characters"}
      description={asset.description}
      status={preview.url ? "ready" : "pending"}
      className={variant === "gallery" ? "" : "rounded-xl"}
      onCardClick={handleOpen}
      onImageClick={handleOpen}
      onMagnify={preview.url ? () => openLightbox({ src: getAssetUrl(preview.url), alt: asset.name, kind: "image" }) : undefined}
    >
      {stages.length > 0 && (
        <div className="mt-auto flex items-center gap-1 px-0.5 pt-1 text-[10px] font-mono text-primary">
          <span>{stages.length} STAGES</span>
          <span className="text-text-muted">·</span>
          <span className="truncate">{currentStage?.label}</span>
        </div>
      )}
    </AssetVisualCard>
    {type !== "props" && (
      <AssetStageDialog open={stageOpen} asset={asset as Character | Scene} assetType={type === "characters" ? "character" : "scene"} currentEpisode={currentEpisode} onClose={() => setStageOpen(false)} onAction={onStageAction as any}/>
    )}
  </>;
}
