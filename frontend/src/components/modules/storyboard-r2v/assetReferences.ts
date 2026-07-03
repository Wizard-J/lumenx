import type { ShotNode } from "./ShotCard";

export type AssetKind = "character" | "scene" | "prop";

export interface AssetPools {
    characters: any[];
    scenes: any[];
    props: any[];
}

export interface ParsedReferenceResult {
    urls: string[];
    unresolved: string[];
    items: ParsedReferenceItem[];
}

export interface ParsedReferenceItem {
    slot: number;
    name: string;
    tagType: AssetKind;
    resolvedKind: AssetKind;
    url: string;
}

export const REFERENCE_TAG_PATTERN = /\[(character(\d*)?|scene|prop):([^\]]+)\]/g;

function selectedFromUnit(unit: any): string | undefined {
    if (!unit) return undefined;
    const variants = unit.image_variants || unit.variants || [];
    const selectedId = unit.selected_image_id || unit.selected_id;
    return variants.find((item: any) => item.id === selectedId)?.url || variants[0]?.url;
}

export function normalizeAssetName(value?: string | null): string {
    return (value || "")
        .toLowerCase()
        .replace(/^[\s\-—–·・]+/, "")
        .replace(/\s+/g, "");
}

function selectedFromStage(asset: any, stageId?: string | null): string | undefined {
    const stages = asset?.stages || [];
    const explicitStage = stageId
        ? stages.find((item: any) => item.id === stageId)
        : undefined;
    const stage = explicitStage
        || stages.find((item: any) => (item?.reference_images || []).length > 0)
        || stages[0];
    const variants = stage?.reference_images || [];
    return variants.find((item: any) => item.id === stage?.selected_image_id)?.url
        || variants[variants.length - 1]?.url
        || variants[0]?.url;
}

export function resolveAssetReferenceImage(
    asset: any,
    kind: AssetKind,
    stageId?: string | null,
): string | undefined {
    if (!asset) return undefined;
    const stageImage = selectedFromStage(asset, stageId);
    if (stageImage) return stageImage;

    if (kind === "character") {
        return selectedFromUnit(asset.reference_sheet)
            || selectedFromUnit(asset.three_views)
            || selectedFromUnit(asset.three_view_asset)
            || selectedFromUnit(asset.full_body)
            || selectedFromUnit(asset.full_body_asset)
            || asset.three_view_image_url
            || asset.full_body_image_url
            || asset.image_url;
    }
    return selectedFromUnit(asset.image_asset)
        || asset.image_url
        || asset.reference_image_url;
}

function assetDisplayKey(asset: any): string {
    return String(asset?.id || asset?.name || "").trim();
}

function assetHasReferenceImage(asset: any, kind: AssetKind): boolean {
    return !!resolveAssetReferenceImage(asset, kind);
}

export function mergeAssetPools(
    episodeAssets: any[] = [],
    seriesAssets: any[] = [],
    kind: AssetKind,
): any[] {
    const byKey = new Map<string, any>();
    const remember = (asset: any) => {
        const key = assetDisplayKey(asset);
        if (key) byKey.set(key, asset);
        const name = String(asset?.name || "").trim();
        if (name) byKey.set(`name:${name}`, asset);
    };

    for (const seriesAsset of seriesAssets) {
        remember({ ...seriesAsset, __assetSource: "series" });
    }

    for (const episodeAsset of episodeAssets) {
        const existing = byKey.get(assetDisplayKey(episodeAsset))
            || byKey.get(`name:${String(episodeAsset?.name || "").trim()}`);
        const episodeHasImage = assetHasReferenceImage(episodeAsset, kind);
        const existingHasImage = assetHasReferenceImage(existing, kind);
        const merged = existing
            ? (
                existingHasImage && !episodeHasImage
                    ? { ...episodeAsset, ...existing, __assetSource: "merged" }
                    : { ...existing, ...episodeAsset, stages: episodeAsset.stages || existing.stages, __assetSource: "merged" }
            )
            : { ...episodeAsset, __assetSource: "episode" };
        remember(merged);
    }

    const unique = new Map<string, any>();
    for (const asset of Array.from(byKey.values())) {
        const key = assetDisplayKey(asset) || `name:${asset?.name}`;
        if (key) unique.set(key, asset);
    }
    return Array.from(unique.values());
}

export function hasAssetReferenceTags(prompt: string): boolean {
    return /\[(?:character\d*|scene|prop):[^\]]+\]/.test(prompt);
}

function findByName(assets: any[], name: string): any | undefined {
    const trimmed = name.trim();
    return assets.find((asset: any) => asset.name === trimmed)
        || assets.find((asset: any) => normalizeAssetName(asset.name) === normalizeAssetName(trimmed));
}

function resolveTaggedAssetReference(
    tagType: AssetKind,
    name: string,
    pools: AssetPools,
    shot?: ShotNode,
): { url: string; resolvedKind: AssetKind } | undefined {
    if (tagType === "character") {
        const char = findByName(pools.characters, name);
        const charUrl = resolveAssetReferenceImage(
            char,
            "character",
            char ? shot?.characterStageRefs?.[char.id] : undefined,
        );
        if (charUrl) return { url: charUrl, resolvedKind: "character" };

        const scene = findByName(pools.scenes, name);
        const sceneUrl = resolveAssetReferenceImage(scene, "scene", shot?.sceneStageRef);
        if (sceneUrl) return { url: sceneUrl, resolvedKind: "scene" };

        const prop = findByName(pools.props, name);
        const propUrl = resolveAssetReferenceImage(prop, "prop");
        return propUrl ? { url: propUrl, resolvedKind: "prop" } : undefined;
    }

    if (tagType === "scene") {
        const scene = findByName(pools.scenes, name);
        const sceneUrl = resolveAssetReferenceImage(scene, "scene", shot?.sceneStageRef);
        return sceneUrl ? { url: sceneUrl, resolvedKind: "scene" } : undefined;
    }

    const prop = findByName(pools.props, name);
    const propUrl = resolveAssetReferenceImage(prop, "prop");
    return propUrl ? { url: propUrl, resolvedKind: "prop" } : undefined;
}

export function parseAssetReferenceTags(
    prompt: string,
    pools: AssetPools,
    shot?: ShotNode,
): ParsedReferenceResult {
    const items: ParsedReferenceItem[] = [];
    const unresolved: string[] = [];
    const tagPattern = new RegExp(REFERENCE_TAG_PATTERN.source, "g");
    let match;
    while ((match = tagPattern.exec(prompt)) !== null) {
        const tagType = match[1].startsWith("character") ? "character" : match[1] as AssetKind;
        const explicitSlot = parseInt(match[2], 10);
        const slotNum = Number.isFinite(explicitSlot) ? explicitSlot : items.length + 1;
        const name = match[3].trim();
        const resolved = resolveTaggedAssetReference(tagType, name, pools, shot);
        if (resolved) {
            items.push({
                slot: slotNum,
                name,
                tagType,
                resolvedKind: resolved.resolvedKind,
                url: resolved.url,
            });
        } else {
            unresolved.push(name);
        }
    }

    items.sort((a, b) => a.slot - b.slot);
    return {
        urls: items.map((item) => item.url),
        unresolved,
        items,
    };
}

export function referenceUrlsForVideoModel(
    parsed: ParsedReferenceResult,
    modelId?: string | null,
): string[] {
    if (modelId?.startsWith("agnes-")) {
        // Agnes treats `extra_body.image` as visual/keyframe material, not as
        // an unordered asset library. Never send character sheets here. The
        // StoryboardR2V submit path replaces these asset refs with complete
        // shot keyframes when the active model is Agnes.
        return parsed.items
            .filter((item) => item.resolvedKind !== "character")
            .map((item) => item.url);
    }
    return parsed.urls;
}

export function stripAssetReferenceTags(prompt: string): string {
    return prompt.replace(/\[(?:character\d*|scene|prop):[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
}
