"use client";
/**
 * Cast — R2V workflow Step 3「本集素材」（per-episode asset view）。
 *
 * Design v2 决策（docs/design/r2v-workflow-v2.md Q8 / Q9）:
 *   · Cast = per-episode lens (read-only) of frame-referenced assets
 *   · Series-level CRUD lives in SeriesDetailPage (Characters/Scenes/Props tabs)
 *   · ConsistencyVault is preserved for i2v_legacy workflow only
 *   · Three sections stacked: characters / scenes / props
 *   · Each card: thumb + name + appearance count + status badge
 *     (✓ ready / ⚠ pending / 🆕 new-this-episode)
 *
 * Phase 1 scope (this file):
 *   · Read-only aggregation of frames[].character_ids / scene_id / prop_ids
 *   · Three section grid render
 *   · Status badges based on reference image presence
 *   · NO reconcile flow yet (Phase 4)
 *   · NO `+ new asset` / generation modal yet (Phase 5)
 *   · NO inspector right rail yet (Q9 decision: 3-section flat, no inspector)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, MapPin, Box, Sparkles, Plus, Upload, X, Loader2, Play, Pause, Volume2, Layers, GitMerge, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api, crudApi } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { useLightbox } from "@/components/shared/preview/LightboxProvider";
import StepHeader from "@/components/shared/StepHeader";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import VoicePickerModal from "./cast/VoicePickerModal";
import CastWorkbenchModal, { hasActivePoll } from "./cast/CastWorkbenchModal";
import AssetStageDialog, { type StageAction } from "@/components/common/AssetStageDialog";
import AssetVisualCard from "@/components/common/AssetVisualCard";
import UploadAssetModal from "../modals/UploadAssetModal";

type AssetKind = "character" | "scene" | "prop";
type CastStatus = "ready" | "pending" | "new" | "generating";

interface CastItem {
    id: string;
    name: string;
    kind: AssetKind;
    appearances: number;
    referenceImageUrl?: string;
    previewLayout?: "portrait" | "sheet";
    /** Whether this asset originates from the current episode project,
     *  from the parent series, or is a merged copy. Used to determine
     *  whether project-level deletion is effective vs. misleading. */
    source?: "episode" | "series" | "merged";
    status: CastStatus;
    persona?: string;
    asset: any;
}

type CharacterPreview = {
    url?: string;
    layout: "portrait" | "sheet";
};

function getActiveStage(asset: any, episodeNumber?: number): any {
    return asset?.stages?.find((stage: any) =>
        episodeNumber && stage.from_episode <= episodeNumber && episodeNumber <= stage.to_episode,
    ) || asset?.stages?.[0];
}

function isProcessingStatus(status: unknown): boolean {
    return String(status || "").toLowerCase() === "processing";
}

function assetHasProcessingState(asset: any, episodeNumber?: number): boolean {
    return isProcessingStatus(asset?.status) || isProcessingStatus(getActiveStage(asset, episodeNumber)?.status);
}

function isAssetRunning(
    assetId: string,
    runningOps: Record<string, boolean>,
    generatingTasks: { assetId: string }[],
): boolean {
    return !!runningOps[`stage:${assetId}`] || generatingTasks.some((task) => task.assetId === assetId);
}

function getCastStatus(hasImage: boolean, generating: boolean): CastStatus {
    if (generating) return "generating";
    return hasImage ? "ready" : "pending";
}

function resolveCharacterImage(c: any, episodeNumber?: number): CharacterPreview {
    const activeStage = getActiveStage(c, episodeNumber);
    const stageImages = activeStage?.reference_images || [];
    const stageImage = stageImages.find(
        (image: any) => image.id === activeStage.selected_image_id,
    )?.url || stageImages[stageImages.length - 1]?.url;
    if (stageImage) return { url: stageImage, layout: "portrait" };
    // New unified field (v2) — reference_sheet is a three-view sheet
    const sheet = c?.reference_sheet?.image_variants?.find(
        (v: any) => v.id === c.reference_sheet.selected_image_id,
    )?.url;
    if (sheet) return { url: sheet, layout: "sheet" };
    // Legacy AssetUnit v2: three_views is a sheet
    const threeViews = c?.three_views?.image_variants?.find(
        (v: any) => v.id === c.three_views.selected_image_id,
    )?.url;
    if (threeViews) return { url: threeViews, layout: "sheet" };
    // Legacy ImageAsset: three_view_asset is a sheet
    const threeViewAsset = c?.three_view_asset?.variants?.find(
        (v: any) => v.id === c.three_view_asset.selected_id,
    )?.url;
    if (threeViewAsset) return { url: threeViewAsset, layout: "sheet" };
    // Legacy v1: three_view_image_url is a sheet
    if (c?.three_view_image_url) return { url: c.three_view_image_url, layout: "sheet" };
    // Legacy AssetUnit v2: full_body is portrait
    const fullBody = c?.full_body?.image_variants?.find(
        (v: any) => v.id === c.full_body.selected_image_id,
    )?.url;
    if (fullBody) return { url: fullBody, layout: "portrait" };
    // Legacy ImageAsset: full_body_asset is portrait
    const fullBodyAsset = c?.full_body_asset?.variants?.find(
        (v: any) => v.id === c.full_body_asset.selected_id,
    )?.url;
    if (fullBodyAsset) return { url: fullBodyAsset, layout: "portrait" };
    // Legacy v1 url fields
    return { url: c?.full_body_image_url || c?.headshot_image_url || c?.image_url, layout: "portrait" };
}

function resolveSceneImage(s: any, episodeNumber?: number): string | undefined {
    const activeStage = getActiveStage(s, episodeNumber);
    const stageImages = activeStage?.reference_images || [];
    const stageImage = stageImages.find(
        (image: any) => image.id === activeStage.selected_image_id,
    )?.url || stageImages[stageImages.length - 1]?.url;
    if (stageImage) return stageImage;
    const selectedAssetImage = s?.image_asset?.variants?.find(
        (image: any) => image.id === s.image_asset.selected_id,
    )?.url;
    return selectedAssetImage || s?.image_url || s?.reference_image_url;
}

function resolvePropImage(p: any): string | undefined {
    const selectedAssetImage = p?.image_asset?.variants?.find(
        (image: any) => image.id === p.image_asset.selected_id,
    )?.url;
    return selectedAssetImage || p?.image_url || p?.reference_image_url;
}

  /** Safe merge: episode fields override series ONLY when non-null and non-undefined.
   *  Prevents Pydantic `null` serialization from wiping out series-level
   *  reference_sheet, full_body, or other critical image fields. */
  function safeMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      if (override[key] != null) out[key] = override[key];
    }
    return out;
  }


export default function Cast() {
    const tStep = useTranslations("stepHeader");
    const t = useTranslations("cast");
    const currentProject = useProjectStore((state) => state.currentProject);
    const runningOps = useProjectStore((state) => state.runningOps);
    const generatingTasks = useProjectStore((state) => state.generatingTasks);
    
    // Series-level asset fallback — Episode characters may lack image variants
    const [seriesAssets, setSeriesAssets] = useState<{ characters: any[]; scenes: any[]; props: any[] } | null>(null);
    const loadSeriesAssets = useCallback(() => {
        const sid = currentProject?.series_id;
        if (sid) {
            return api.getSeries(sid).then((s: any) => {
                setSeriesAssets({ characters: s.characters || [], scenes: s.scenes || [], props: s.props || [] });
            });
        }
        return Promise.resolve();
    }, [currentProject?.series_id, currentProject?.updatedAt]);
    useEffect(() => { loadSeriesAssets().catch(() => {}); }, [loadSeriesAssets]);

    const handleStageAction: StageAction = async (asset, action, stage, data = {}) => {
        if (!currentProject?.id) throw new Error("当前剧集未加载");
        const isCharacter = [...(currentProject.characters || []), ...(seriesAssets?.characters || [])].some((item: any) => item.id === asset.id);
        const assetType = isCharacter ? "character" : "scene";
        const trackGeneration = action === "generate";
        if (trackGeneration) {
            useProjectStore.getState().setRunningOp(`stage:${asset.id}`, true);
        }
        try {
            const response = await api.mutateAssetStage(currentProject.id, asset.id, assetType, action, stage?.id, data);
            if (response?._task_id) {
                for (let attempt = 0; attempt < 120; attempt += 1) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    const status = await api.getTaskStatus(response._task_id);
                    if (status?.status === "completed") break;
                    if (status?.status === "failed") throw new Error(status.error || "阶段生成失败");
                }
            }
            await Promise.all([loadSeriesAssets(), useProjectStore.getState().selectProject(currentProject.id)]);
        } finally {
            if (trackGeneration) useProjectStore.getState().setRunningOp(`stage:${asset.id}`, false);
        }
    };

    // R2V v2 Phase 5 — add new asset modal (placeholder for full
    // generation flow which lands in a follow-up patch). For now this
    // opens a TODO dialog showing the planned two-tab interface.
    const [addModalOpen, setAddModalOpen] = useState<null | "character" | "scene" | "prop">(null);
    // PR-3* · Cast redesign — tab filter + workbench launcher.
    const [activeTab, setActiveTab] = useState<"all" | "character" | "scene" | "prop">("all");
    const [workbench, setWorkbench] = useState<{ kind: "character" | "scene" | "prop"; entityId: string } | null>(null);
    const [uploadTarget, setUploadTarget] = useState<CastItem | null>(null);

    const updateProject = useProjectStore((s) => s.updateProject);

    // Merge mode state (props only)
    const [mergeSource, setMergeSource] = useState<{ id: string; name: string } | null>(null);

    const handleStartMerge = (sourceId: string, sourceName: string) => {
        setMergeSource({ id: sourceId, name: sourceName });
    };

    const handleDeleteAsset = async (item: CastItem) => {
        if (!currentProject?.id) return;

        // Route delete to the correct owner: series-level or project-level.
        const isSeriesOwned = item.source === "series" || item.source === "merged";
        const label = item.kind === "character" ? "角色" : item.kind === "scene" ? "场景" : "道具";

        if (isSeriesOwned) {
            if (!currentProject?.series_id) {
                alert("当前项目不属于任何系列，无法删除系列素材。");
                return;
            }
            if (!confirm(`这是系列公共${label}。确定从整个系列中删除「${item.name}」吗？所有剧集都将不再继承它。`)) return;
        } else {
            if (!confirm(`确定删除当前剧集的${label}「${item.name}」吗？\n\n删除后会从当前项目素材中移除，相关引用可能需要重新检查。`)) return;
        }

        try {
            if (isSeriesOwned) {
                const seriesId = currentProject.series_id!;
                if (item.kind === "character") await crudApi.deleteSeriesCharacter(seriesId, item.id);
                else if (item.kind === "scene") await crudApi.deleteSeriesScene(seriesId, item.id);
                else await crudApi.deleteSeriesProp(seriesId, item.id);
            } else {
                if (item.kind === "character") await crudApi.deleteCharacter(currentProject.id, item.id);
                else if (item.kind === "scene") await crudApi.deleteScene(currentProject.id, item.id);
                else await crudApi.deleteProp(currentProject.id, item.id);
            }
            // Reliable refresh for both project and series pools
            await Promise.all([
                loadSeriesAssets(),
                useProjectStore.getState().selectProject(currentProject.id),
            ]);
        } catch (error: any) {
            console.error("Failed to delete asset:", error);
            if (error?.response?.status === 404) {
                alert("删除失败：素材不存在或已被删除，请刷新后重试。");
            } else {
                alert(error?.response?.data?.detail || error?.message || "删除素材失败");
            }
        }
    };

    const handleUploadComplete = async (updatedProject: any) => {
        if (!currentProject?.id) return;
        if (updatedProject?.id) {
            updateProject(currentProject.id, updatedProject);
        }
        await Promise.all([
            loadSeriesAssets(),
            useProjectStore.getState().selectProject(currentProject.id),
        ]);
        setUploadTarget(null);
    };

    const handleCancelMerge = () => {
        setMergeSource(null);
    };

    const handleConfirmMerge = async (targetId: string, targetName: string) => {
        if (!currentProject || !mergeSource) return;
        if (!confirm(`Merge "${mergeSource.name}" → "${targetName}"?\n\nThis will move all references and variants, then delete "${mergeSource.name}".`)) return;
        try {
            const updated = await crudApi.mergeProp(currentProject.id, mergeSource.id, targetId);
            updateProject(currentProject.id, updated);
            setMergeSource(null);
        } catch (error: any) {
            const detail = error?.response?.data?.detail || error?.message || "Unknown error";
            console.error("Failed to merge prop:", detail, error);
            alert(`Merge failed: ${detail}`);
            setMergeSource(null);
        }
    };

    const removeGeneratingTask = useProjectStore((s) => s.removeGeneratingTask);
    useEffect(() => {
        if (generatingTasks.length === 0) return;
        for (const task of generatingTasks) {
            if (!hasActivePoll(task.assetId, task.generationType)) {
                removeGeneratingTask(task.assetId, task.generationType);
            }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * Aggregate per-asset appearance counts from frame references, then
     * union with the project's entity pool so freshly-extracted assets
     * (which have NO frame references yet — frames are created in a
     * separate '生成分镜' step) still show up in Cast.
     *
     * Earlier this only listed entities discovered through frame iteration,
     * which silently dropped every extracted character/scene/prop until
     * the user generated frames. The toast said 'extraction done' but
     * Cast looked empty.
     */
    const { characters, scenes, props } = useMemo(() => {
        const characterCounts = new Map<string, number>();
        const sceneCounts = new Map<string, number>();
        const propCounts = new Map<string, number>();
        const frames: any[] = currentProject?.frames ?? [];
        for (const f of frames) {
            if (f?.scene_id) sceneCounts.set(f.scene_id, (sceneCounts.get(f.scene_id) ?? 0) + 1);
            for (const cid of f?.character_ids ?? []) {
                characterCounts.set(cid, (characterCounts.get(cid) ?? 0) + 1);
            }
            for (const pid of f?.prop_ids ?? []) {
                propCounts.set(pid, (propCounts.get(pid) ?? 0) + 1);
            }
        }
        // Merge Episode + Series pools, preferring Series items that have image variants
        const epChars: any[] = currentProject?.characters ?? [];
        const epScenes: any[] = currentProject?.scenes ?? [];
        const epProps: any[] = currentProject?.props ?? [];
        const seriesChars = seriesAssets?.characters ?? [];
        const seriesScenes = seriesAssets?.scenes ?? [];
        const seriesProps = seriesAssets?.props ?? [];
        
        // For characters: prefer Series version if it has image variants and Episode doesn't
        const characterPool: any[] = epChars.map((ec: any) => {
            const sc = seriesChars.find((s: any) => s.id === ec.id);
            if (sc) {
                const epHasImg = !!(ec?.full_body_asset?.variants?.length || ec?.full_body?.image_variants?.length);
                const scHasImg = !!(sc?.full_body_asset?.variants?.length || sc?.full_body?.image_variants?.length);
                if (!epHasImg && scHasImg) return { ...ec, ...sc, __castSource: "merged" };
                return { ...safeMerge(sc, ec), stages: sc.stages || ec.stages || [], __castSource: "merged" };
            }
            return { ...ec, __castSource: "episode" };
        });
        // Add Series-only characters not in Episode (reconciled entities)
        const epCharIds = new Set(characterPool.map((c: any) => c.id));
        for (const sc of seriesChars) {
            if (!epCharIds.has(sc.id)) {
                characterPool.push({ ...sc, __castSource: "series" });
            }
        }

        const scenePool: any[] = epScenes.map((es: any) => {
            const ss = seriesScenes.find((s: any) => s.id === es.id);
            if (ss) return { ...ss, ...es, image_url: es.image_url || ss.image_url, image_asset: es.image_asset?.variants?.length ? es.image_asset : ss.image_asset, stages: ss.stages || es.stages || [], __castSource: "merged" };
            return { ...es, __castSource: "episode" };
        });
        const epSceneIds = new Set(scenePool.map((s: any) => s.id));
        for (const ss of seriesScenes) {
            if (!epSceneIds.has(ss.id)) scenePool.push({ ...ss, __castSource: "series" });
        }

        const propPool: any[] = epProps.map((ep: any) => {
            const sp = seriesProps.find((s: any) => s.id === ep.id);
            if (sp && !ep.image_url && sp.image_url) return { ...ep, image_url: sp.image_url, image_asset: sp.image_asset, __castSource: "merged" };
            return { ...ep, __castSource: "episode" };
        });
        const epPropIds = new Set(propPool.map((p: any) => p.id));
        for (const sp of seriesProps) {
            if (!epPropIds.has(sp.id)) propPool.push({ ...sp, __castSource: "series" });
        }

        const characters: CastItem[] = characterPool.map((c: any) => {
            const { url, layout } = resolveCharacterImage(c, currentProject?.episode_number);
            const generating = isAssetRunning(c.id, runningOps, generatingTasks) || assetHasProcessingState(c, currentProject?.episode_number);
            return {
                id: c.id,
                name: c.name ?? c.id,
                kind: "character" as const,
                appearances: characterCounts.get(c.id) ?? 0,
                referenceImageUrl: url,
                previewLayout: layout,
                source: c.__castSource,
                status: getCastStatus(!!url, generating),
                persona: c.persona ?? "",
                asset: c,
            };
        }).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

        const scenes: CastItem[] = scenePool.map((s: any) => {
            const imageUrl = resolveSceneImage(s, currentProject?.episode_number);
            const generating = isAssetRunning(s.id, runningOps, generatingTasks) || assetHasProcessingState(s, currentProject?.episode_number);
            return {
                id: s.id,
                name: s.name ?? s.id,
                kind: "scene" as const,
                appearances: sceneCounts.get(s.id) ?? 0,
                referenceImageUrl: imageUrl,
                source: s.__castSource,
                status: getCastStatus(!!imageUrl, generating),
                asset: s,
            };
        }).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

        const props: CastItem[] = propPool.map((p: any) => {
            const imageUrl = resolvePropImage(p);
            const generating = isAssetRunning(p.id, runningOps, generatingTasks) || assetHasProcessingState(p, currentProject?.episode_number);
            return {
                id: p.id,
                name: p.name ?? p.id,
                kind: "prop" as const,
                appearances: propCounts.get(p.id) ?? 0,
                referenceImageUrl: imageUrl,
                source: p.__castSource,
                status: getCastStatus(!!imageUrl, generating),
                asset: p,
            };
        }).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

        return { characters, scenes, props };
    }, [currentProject?.frames, currentProject?.characters, currentProject?.scenes, currentProject?.props, currentProject?.episode_number, seriesAssets, runningOps, generatingTasks]);

    const totalCast = characters.length + scenes.length + props.length;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden">
            <StepHeader
                stepNumber={3}
                icon={<Users />}
                englishName="Cast"
                title={tStep("castTitle")}
                subtitle={tStep("castSubtitle")}
                trailing={(
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
                        <span className="text-foreground font-medium">{totalCast}</span>
                        <span className="ml-1.5">{t("totalCast")}</span>
                    </span>
                )}
            />

            {/* Empty state — no entities extracted yet */}
            {totalCast === 0 ? (
                <div className="flex flex-1 items-center justify-center bg-surface">
                    <div className="max-w-md text-center">
                        <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full border border-glass-border bg-glass">
                            <Sparkles size={24} className="text-text-muted" />
                        </div>
                        <h3 className="font-display text-display font-medium text-foreground">
                            {t("emptyTitle")}
                        </h3>
                        <p className="mt-2 text-sm text-text-secondary leading-relaxed">
                            {t("emptyBody")}
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    {/* Tab bar — '全部' is the default so users coming in fresh see
                        the full inventory before filtering down. Counts are
                        always visible so empty kinds telegraph themselves. */}
                    <div className="shrink-0 flex items-center gap-1 px-6 pt-3 border-b border-glass-border bg-surface">
                        {([
                            { id: "all" as const, label: t("tabAll"), icon: <Layers size={11} />, count: totalCast },
                            { id: "character" as const, label: t("tabCharacters"), icon: <Users size={11} />, count: characters.length },
                            { id: "scene" as const, label: t("tabScenes"), icon: <MapPin size={11} />, count: scenes.length },
                            { id: "prop" as const, label: t("tabProps"), icon: <Box size={11} />, count: props.length },
                        ]).map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`relative inline-flex items-center gap-1.5 px-3 pb-2 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${
                                    activeTab === tab.id
                                        ? "text-foreground"
                                        : "text-text-muted hover:text-text-secondary"
                                }`}
                            >
                                {tab.icon}
                                {tab.label}
                                <span className={`ml-0.5 ${activeTab === tab.id ? "text-foreground" : "text-text-muted/60"}`}>
                                    ({tab.count})
                                </span>
                                {activeTab === tab.id && (
                                    <span className="absolute bottom-0 left-2 right-2 h-px bg-primary" aria-hidden="true" />
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Merge banner (props only) */}
                    {(activeTab === "prop" || activeTab === "all") && mergeSource && (
                        <div className="mx-8 mt-2 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-between shrink-0">
                            <p className="text-sm text-amber-100">
                                Merging <strong>"{mergeSource.name}"</strong> → select a target prop below
                            </p>
                            <button
                                onClick={handleCancelMerge}
                                className="text-xs text-amber-300 hover:text-amber-100 underline"
                            >
                                Cancel
                            </button>
                        </div>
                    )}

                    <div className="flex-1 overflow-y-auto bg-surface px-8 py-6 space-y-10 custom-scrollbar">
                        {(activeTab === "all" || activeTab === "character") && (
                            <CastSection
                                kind="character"
                                icon={<Users size={14} />}
                                title={t("sectionCharacters")}
                                items={characters}
                                emptyLabel={t("sectionEmptyCharacters")}
                                onAddNew={() => setAddModalOpen("character")}
                                addLabel={t("addCharacter")}
                                groupByPersona
                                onOpenWorkbench={(id) => setWorkbench({ kind: "character", entityId: id })}
                                hideHeader={activeTab === "character"}
                                onStageAction={handleStageAction}
                                onDeleteAsset={handleDeleteAsset}
                                onUploadAsset={setUploadTarget}
                            />
                        )}
                        {(activeTab === "all" || activeTab === "scene") && (
                            <CastSection
                                kind="scene"
                                icon={<MapPin size={14} />}
                                title={t("sectionScenes")}
                                items={scenes}
                                emptyLabel={t("sectionEmptyScenes")}
                                onAddNew={() => setAddModalOpen("scene")}
                                addLabel={t("addScene")}
                                onOpenWorkbench={(id) => setWorkbench({ kind: "scene", entityId: id })}
                                hideHeader={activeTab === "scene"}
                                onStageAction={handleStageAction}
                                onDeleteAsset={handleDeleteAsset}
                                onUploadAsset={setUploadTarget}
                            />
                        )}
                        {(activeTab === "all" || activeTab === "prop") && (
                            <CastSection
                                kind="prop"
                                icon={<Box size={14} />}
                                title={t("sectionProps")}
                                items={props}
                                emptyLabel={t("sectionEmptyProps")}
                                onAddNew={() => setAddModalOpen("prop")}
                                addLabel={t("addProp")}
                                onOpenWorkbench={(id) => setWorkbench({ kind: "prop", entityId: id })}
                                hideHeader={activeTab === "prop"}
                                mergeSource={mergeSource}
                                onStartMerge={handleStartMerge}
                                onConfirmMerge={handleConfirmMerge}
                                onCancelMerge={handleCancelMerge}
                                onDeleteAsset={handleDeleteAsset}
                                onUploadAsset={setUploadTarget}
                            />
                        )}
                    </div>
                </>
            )}

            {/* Workbench — per-entity generate / pick reference image */}
            <CastWorkbenchModal
                isOpen={workbench !== null}
                kind={workbench?.kind ?? null}
                entityId={workbench?.entityId ?? null}
                onClose={async () => {
                    setWorkbench(null);
                    // Refresh project data so the card thumbnail updates
                    if (currentProject?.id) {
                        await Promise.all([
                            loadSeriesAssets(),
                            useProjectStore.getState().selectProject(currentProject.id),
                        ]);
                    }
                }}
            />

            {/* R2V v2 Phase 5 — real Add new cast modal (AI / upload tabs). */}
            <AddCastPlaceholderModal
                kind={addModalOpen}
                seriesId={currentProject?.series_id ?? null}
                onClose={() => setAddModalOpen(null)}
                onCreated={() => {
                    // Trigger a project refresh by re-selecting; simplest
                    // way to surface the new series asset in this episode.
                    if (currentProject?.id) {
                        useProjectStore.getState().selectProject(currentProject.id);
                    }
                }}
            />
            {uploadTarget && currentProject?.id && (
                <UploadAssetModal
                    isOpen={!!uploadTarget}
                    onClose={() => setUploadTarget(null)}
                    assetId={uploadTarget.id}
                    assetType={uploadTarget.kind}
                    assetName={uploadTarget.name}
                    defaultDescription={uploadTarget.asset?.description || ""}
                    scriptId={currentProject.id}
                    onUploadComplete={handleUploadComplete}
                />
            )}
        </div>
    );
}

// R2V v2 Phase 5 — real "+ 新素材" modal.
// Two-tab UX: AI generate vs upload image. Both paths POST to
// /series/{id}/{kind} with a name/persona/description payload + optional
// image_url for upload. AI generation is a placeholder hand-off (creates
// the asset blank, then user can trigger generation from the card detail
// view) — full async generation queue ships when generation pipeline
// supports series-scope without project context.
function AddCastPlaceholderModal({
    kind,
    seriesId,
    onClose,
    onCreated,
}: {
    kind: null | "character" | "scene" | "prop";
    seriesId: string | null;
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations("cast");
    const [tab, setTab] = useState<"ai" | "upload">("ai");
    const [name, setName] = useState("");
    const [persona, setPersona] = useState("");
    const [description, setDescription] = useState("");
    const [voiceId, setVoiceId] = useState("");  // P2-c — character voice binding
    const [uploading, setUploading] = useState(false);
    const [imageUrl, setImageUrl] = useState<string>("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset state when modal closes / kind changes
    const reset = () => {
        setName(""); setPersona(""); setDescription(""); setVoiceId("");
        setImageUrl(""); setError(null); setTab("ai");
    };

    if (!kind) return null;
    const label = kind === "character" ? t("sectionCharacters")
        : kind === "scene" ? t("sectionScenes")
        : t("sectionProps");

    const handleUpload = async (file: File) => {
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const result = await api.uploadFile(file);
            setImageUrl(result.url || "");
        } catch (err: any) {
            setError(err?.response?.data?.detail || err?.message || "Upload failed");
        } finally {
            setUploading(false);
        }
    };

    const handleSubmit = async () => {
        if (!seriesId) {
            setError(t("seriesRequired"));
            return;
        }
        if (!name.trim()) {
            setError(t("nameRequired"));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const kindMap = { character: "characters", scene: "scenes", prop: "props" } as const;
            await api.createSeriesAsset(seriesId, kindMap[kind], {
                name: name.trim(),
                description: description.trim() || undefined,
                persona: kind === "character" ? (persona.trim() || undefined) : undefined,
                voice_id: kind === "character" ? (voiceId.trim() || undefined) : undefined,
                image_url: imageUrl || undefined,
            });
            onCreated();
            reset();
            onClose();
        } catch (err: any) {
            setError(err?.response?.data?.detail || err?.message || "Create failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm" onClick={() => { reset(); onClose(); }}>
            <div
                className="w-full max-w-md rounded-2xl border border-glass-border bg-elevated p-6 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start gap-3 mb-4">
                    <div className="grid h-9 w-9 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                        <Plus size={16} />
                    </div>
                    <div className="flex-1">
                        <h3 className="font-display text-display font-medium text-foreground">
                            {t("addModalTitle", { kind: label })}
                        </h3>
                        <p className="text-xs text-text-secondary mt-1">{t("addModalSubtitle")}</p>
                    </div>
                    <button onClick={() => { reset(); onClose(); }} className="p-2 hover:bg-hover-bg rounded-lg text-text-muted hover:text-foreground transition-colors">
                        <X size={16} />
                    </button>
                </div>

                {/* Tab switcher */}
                <div className="flex gap-1 mb-4 p-1 rounded-lg border border-glass-border bg-glass">
                    <button
                        onClick={() => setTab("ai")}
                        className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            tab === "ai" ? "bg-primary/15 text-primary" : "text-text-secondary hover:text-foreground"
                        }`}
                    >
                        <Sparkles size={14} />
                        {t("addTabAi")}
                    </button>
                    <button
                        onClick={() => setTab("upload")}
                        className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            tab === "upload" ? "bg-primary/15 text-primary" : "text-text-secondary hover:text-foreground"
                        }`}
                    >
                        <Upload size={14} />
                        {t("addTabUpload")}
                    </button>
                </div>

                {/* Common fields */}
                <div className="space-y-3">
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t("fieldName")} *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t("fieldNamePlaceholder")}
                            className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary"
                            autoFocus
                        />
                    </div>
                    {kind === "character" && (
                        <>
                            <div>
                                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                                    {t("fieldPersona")} <span className="text-text-muted">({t("fieldPersonaHint")})</span>
                                </label>
                                <input
                                    type="text"
                                    value={persona}
                                    onChange={(e) => setPersona(e.target.value)}
                                    placeholder={t("fieldPersonaPlaceholder")}
                                    className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                                    {t("fieldVoice")} <span className="text-text-muted">({t("fieldVoiceHint")})</span>
                                </label>
                                <select
                                    value={voiceId}
                                    onChange={(e) => setVoiceId(e.target.value)}
                                    className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                                >
                                    <option value="">{t("fieldVoiceNone")}</option>
                                    <option value="longanyang">{t("voiceLonganyang")}</option>
                                    <option value="longshu">{t("voiceLongshu")}</option>
                                    <option value="longtong">{t("voiceLongtong")}</option>
                                    <option value="longfei_v2">{t("voiceLongfei")}</option>
                                    <option value="longxiaobai_v2">{t("voiceLongxiaobai")}</option>
                                </select>
                            </div>
                        </>
                    )}
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t("fieldDescription")}</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={tab === "ai" ? t("fieldDescriptionAiPlaceholder") : t("fieldDescriptionPlaceholder")}
                            rows={3}
                            className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary resize-none"
                        />
                    </div>

                    {/* Upload tab — file dropzone + preview */}
                    {tab === "upload" && (
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t("fieldImageUpload")}</label>
                            {imageUrl ? (
                                <div className="relative">
                                    <PreviewImage src={imageUrl} className="w-full aspect-video rounded-lg" />
                                    <button
                                        onClick={() => setImageUrl("")}
                                        className="absolute top-2 right-2 p-1.5 bg-overlay rounded-md text-text-secondary hover:text-foreground transition-colors"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ) : (
                                <label className="block w-full aspect-video rounded-lg border-2 border-dashed border-glass-border hover:border-primary/40 cursor-pointer transition-colors">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
                                        className="hidden"
                                        disabled={uploading}
                                    />
                                    <div className="h-full flex flex-col items-center justify-center text-text-muted">
                                        {uploading ? (
                                            <Loader2 size={20} className="animate-spin" />
                                        ) : (
                                            <>
                                                <Upload size={20} />
                                                <span className="mt-2 text-xs">{t("clickToUpload")}</span>
                                            </>
                                        )}
                                    </div>
                                </label>
                            )}
                        </div>
                    )}

                    {/* AI tab hint */}
                    {tab === "ai" && (
                        <div className="rounded-lg bg-primary/[0.06] border border-primary/20 px-3 py-2.5">
                            <p className="text-[11.5px] text-text-secondary leading-relaxed">
                                {t("aiTabHint")}
                            </p>
                        </div>
                    )}

                    {error && (
                        <div className="rounded-lg border border-status-failed-border/40 bg-status-failed-bg/50 px-3 py-2 text-status-failed-fg text-xs">
                            {error}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 mt-5">
                    <WorkflowActionButton variant="ghost" size="sm" onClick={() => { reset(); onClose(); }} className="flex-1">
                        {t("cancel")}
                    </WorkflowActionButton>
                    <WorkflowActionButton
                        variant="primary"
                        size="sm"
                        loading={submitting}
                        onClick={handleSubmit}
                        disabled={!name.trim() || !seriesId}
                        className="flex-1"
                    >
                        {tab === "ai" ? t("createAndGenerate") : t("create")}
                    </WorkflowActionButton>
                </div>
            </div>
        </div>
    );
}

interface CastSectionProps {
    kind: AssetKind;
    icon: React.ReactNode;
    title: string;
    items: CastItem[];
    emptyLabel: string;
    onAddNew?: () => void;
    addLabel?: string;
    /** P1-a: when true, characters with shared `persona` cluster under
     *  a sub-header showing the persona label (only applies when at
     *  at least one item has a non-empty persona). */
    groupByPersona?: boolean;
    /** Cast redesign — clicking a card (or its empty CTA) launches the
     *  per-entity generation workbench in the parent. */
    onOpenWorkbench?: (entityId: string) => void;
    /** When the parent's tab filter is already focused on this kind,
     *  the section's own header becomes redundant — hide it. */
    hideHeader?: boolean;
    onStageAction?: StageAction;
    /** Prop merge mode */
    mergeSource?: { id: string; name: string } | null;
    onStartMerge?: (sourceId: string, sourceName: string) => void;
    onConfirmMerge?: (targetId: string, targetName: string) => void;
    onCancelMerge?: () => void;
    onDeleteAsset?: (item: CastItem) => void;
    onUploadAsset?: (item: CastItem) => void;
}

function CastSection({ kind, icon, title, items, emptyLabel, onAddNew, addLabel, groupByPersona, onOpenWorkbench, hideHeader, onStageAction, mergeSource, onStartMerge, onConfirmMerge, onCancelMerge, onDeleteAsset, onUploadAsset }: CastSectionProps) {
    const t = useTranslations("cast");
    // R2V v2 P1-a — persona grouping (characters only)
    const groups = useMemo(() => {
        if (!groupByPersona) return null;
        // Items with persona cluster under that key; persona-less stay solo
        const buckets = new Map<string, CastItem[]>();
        const ungrouped: CastItem[] = [];
        for (const item of items) {
            const p = (item.persona ?? "").trim();
            if (p) {
                const arr = buckets.get(p) ?? [];
                arr.push(item);
                buckets.set(p, arr);
            } else {
                ungrouped.push(item);
            }
        }
        // Multi-member groups only — single-member personas inline back
        const out: Array<{ persona: string | null; items: CastItem[] }> = [];
        const single: CastItem[] = [...ungrouped];
        for (const [p, arr] of Array.from(buckets.entries())) {
            if (arr.length >= 2) out.push({ persona: p, items: arr });
            else single.push(...arr);
        }
        // Sort: groups (by persona name), then ungrouped
        out.sort((a, b) => (a.persona ?? "").localeCompare(b.persona ?? ""));
        if (single.length) out.push({ persona: null, items: single });
        return out;
    }, [items, groupByPersona]);

    // Keep asset cards at inspectable catalog sizes instead of stretching
    // each column to fill ultra-wide workspaces.
    const gridCols = kind === "scene"
        ? "grid-cols-[repeat(auto-fill,minmax(280px,360px))]"
        : kind === "character"
            ? "grid-cols-[repeat(auto-fill,minmax(170px,220px))]"
            : "grid-cols-[repeat(auto-fill,minmax(150px,200px))]";
    return (
        <section>
            {!hideHeader && (
                <header className="mb-3 flex items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded text-text-muted">{icon}</span>
                    <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
                        {title}
                    </h3>
                    <span className="font-mono text-[10px] text-text-muted">({items.length})</span>
                    <div aria-hidden="true" className="ml-3 h-px flex-1 bg-glass-border" />
                    {onAddNew && (
                        <WorkflowActionButton
                            variant="ghost"
                            size="sm"
                            leftIcon={<Plus />}
                            onClick={onAddNew}
                        >
                            {addLabel}
                        </WorkflowActionButton>
                    )}
                </header>
            )}
            {hideHeader && onAddNew && (
                <div className="mb-3 flex items-center justify-end">
                    <WorkflowActionButton variant="ghost" size="sm" leftIcon={<Plus />} onClick={onAddNew}>
                        {addLabel}
                    </WorkflowActionButton>
                </div>
            )}
            {items.length === 0 ? (
                <p className="font-sans text-[12.5px] text-text-muted italic px-1">{emptyLabel}</p>
            ) : groups && groups.some(g => g.persona) ? (
                <div className="space-y-4">
                    {groups.map((group) => (
                        <div key={group.persona ?? "_solo"}>
                            {group.persona && (
                                <div className="flex items-center gap-2 mb-2 px-1">
                                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-pink-300/90 bg-pink-300/10 px-2 py-0.5 rounded">
                                        <Users size={10} /> {t("personaGroup", { persona: group.persona })}
                                    </span>
                                    <span className="font-mono text-[10px] text-text-muted">
                                        {t("personaGroupCount", { count: group.items.length })}
                                    </span>
                                </div>
                            )}
                            <div className={`grid gap-3 ${gridCols}`}>
                                {group.items.map(item => <CastCard key={item.id} item={item} onOpenWorkbench={() => onOpenWorkbench?.(item.id)} onStageAction={onStageAction} mergeSource={mergeSource} onStartMerge={onStartMerge} onConfirmMerge={onConfirmMerge} onDelete={() => onDeleteAsset?.(item)} onUpload={() => onUploadAsset?.(item)} />)}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className={`grid gap-3 ${gridCols}`}>
                    {items.map(item => <CastCard key={item.id} item={item} onOpenWorkbench={() => onOpenWorkbench?.(item.id)} onStageAction={onStageAction} mergeSource={mergeSource} onStartMerge={onStartMerge} onConfirmMerge={onConfirmMerge} onDelete={() => onDeleteAsset?.(item)} onUpload={() => onUploadAsset?.(item)} />)}
                </div>
            )}
        </section>
    );
}

function CastCard({ item, onOpenWorkbench, onStageAction, mergeSource, onStartMerge, onConfirmMerge, onDelete, onUpload }: { item: CastItem; onOpenWorkbench?: () => void; onStageAction?: StageAction; mergeSource?: { id: string; name: string } | null; onStartMerge?: (sourceId: string, sourceName: string) => void; onConfirmMerge?: (targetId: string, targetName: string) => void; onDelete?: () => void; onUpload?: () => void }) {
    const t = useTranslations("cast");
    const { open: openLightbox } = useLightbox();
    const currentProject = useProjectStore((state) => state.currentProject);
    const generatingTasks = useProjectStore((state) => state.generatingTasks);
    const stageGenerating = useProjectStore((state) => !!state.runningOps[`stage:${item.id}`]);
    const isGenerating = item.status === "generating" || stageGenerating || generatingTasks.some((task) => task.assetId === item.id);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [previewing, setPreviewing] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [stageOpen, setStageOpen] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Look up full character to read voice_id / voice_name (CastItem is a
    // read-only aggregation, doesn't carry voice fields).
    const character = item.kind === "character"
        ? currentProject?.characters?.find((c: any) => c.id === item.id) || item.asset
        : null;
    const voiceId: string | undefined = character?.voice_id;
    const voiceName: string | undefined = character?.voice_name;

    // PR-3g · Voice bind handler: persist via existing bindVoice API
    const handleApplyVoice = async (newVoiceId: string, newVoiceName: string) => {
        if (!currentProject || !character) return;
        try {
            await api.bindVoice(currentProject.id, character.id, newVoiceId, newVoiceName);
            await useProjectStore.getState().selectProject(currentProject.id);
        } catch (e) {
            console.error("Failed to bind voice:", e);
            throw e;
        }
    };

    // PR-3g · inline preview from CastCard (uses currently-bound voice)
    const handleInlinePreview = async () => {
        if (!voiceId) return;
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
            if (playing) {
                setPlaying(false);
                return;
            }
        }
        setPreviewing(true);
        try {
            const sampleText = item.name
                ? `你好，我是${item.name}。今天遇到件有趣的事，让我慢慢说给你听。`
                : "你好，这是音色试听。今天遇到件有趣的事，让我慢慢说给你听。";
            const { url } = await api.previewVoice({ voice_id: voiceId, text: sampleText });
            const audio = new Audio(getAssetUrl(url));
            audio.onended = () => { setPlaying(false); audioRef.current = null; };
            audio.onerror = () => { setPlaying(false); audioRef.current = null; };
            audioRef.current = audio;
            setPlaying(true);
            await audio.play();
        } catch (e) {
            console.error("Voice preview failed:", e);
        } finally {
            setPreviewing(false);
        }
    };

    // Cleanup on unmount
    useEffect(() => () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
    }, []);

    const isMergeSource = mergeSource?.id === item.id;
    const isMergeTargetable = mergeSource && mergeSource.id !== item.id && item.kind === "prop";
    const showMergeOption = !mergeSource && item.kind === "prop";

    const handleCardClick = () => {
        if (isMergeTargetable && onConfirmMerge) {
            onConfirmMerge(item.id, item.name);
            return;
        }
        if (item.kind === "prop") {
            onOpenWorkbench?.();
        } else {
            setStageOpen(true);
        }
    };

    const handleImageClick = () => {
        if (isMergeTargetable) return;
        if (item.kind === "prop") {
            onOpenWorkbench?.();
        } else {
            setStageOpen(true);
        }
    };

    return (
        <>
            <AssetVisualCard
                kind={item.kind}
                name={item.name}
                imageUrl={item.referenceImageUrl}
                imageClassName={item.kind === "character" && item.previewLayout === "sheet" ? "object-cover object-left" : undefined}
                autoCropWideCharacterSheet={item.kind === "character"}
                meta={t("appearancesCount", { count: item.appearances })}
                status={item.status}
                onCardClick={handleCardClick}
                onImageClick={isMergeTargetable ? handleCardClick : handleImageClick}
                onMagnify={item.referenceImageUrl && !isMergeTargetable ? () => openLightbox({ src: getAssetUrl(item.referenceImageUrl!), alt: item.name, kind: "image" }) : undefined}
                className={`${
                    isMergeSource
                        ? 'border-amber-500/70 bg-amber-500/5'
                        : isMergeTargetable
                            ? 'border-amber-500/30 bg-amber-500/[0.03] hover:border-amber-500/50 cursor-pointer'
                            : ''
                }`}
                imageOverlay={(
                    <>
                        {isMergeTargetable && (
                            <div className="absolute inset-0 z-20 bg-amber-500/10 backdrop-blur-[2px] border-2 border-amber-500/40 rounded-md flex items-center justify-center pointer-events-none">
                                <span className="text-amber-200 text-xs font-bold px-3 py-1.5 rounded-full bg-amber-500/20 backdrop-blur-md">
                                    Merge → here
                                </span>
                            </div>
                        )}
                        {isMergeSource && (
                            <div className="absolute top-2 left-2 z-20 px-2 py-1 rounded-full backdrop-blur-md bg-amber-500/30 text-amber-200 text-[11px] font-medium flex items-center gap-1">
                                <GitMerge size={11} /> Source
                            </div>
                        )}
                        {showMergeOption && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onStartMerge?.(item.id, item.name);
                                }}
                                className="absolute right-1.5 top-1.5 z-20 grid h-7 w-7 place-items-center rounded bg-amber-500/25 text-amber-300 backdrop-blur opacity-0 group-hover/cast-card:opacity-100 transition-opacity hover:bg-amber-500/40"
                                title="Merge"
                            >
                                <GitMerge size={13} />
                            </button>
                        )}
                        {isGenerating && (
                            <div className="absolute inset-0 z-20 grid place-items-center bg-black/60 backdrop-blur-sm rounded-md">
                                <div className="flex flex-col items-center gap-1.5">
                                    <Loader2 size={20} className="animate-spin text-primary" />
                                    <span className="text-[10px] text-text-secondary">生成中...</span>
                                </div>
                            </div>
                        )}
                        {onUpload && !isMergeTargetable && !isMergeSource && !isGenerating && (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onUpload();
                                }}
                                className="absolute right-1.5 bottom-1.5 z-20 grid h-7 w-7 place-items-center rounded bg-black/55 text-white/80 opacity-0 backdrop-blur transition-opacity hover:bg-primary/35 hover:text-white group-hover/cast-card:opacity-100"
                                title="上传参考图"
                                aria-label={`上传${item.name}参考图`}
                            >
                                <Upload size={13} />
                            </button>
                        )}
                        {onDelete && !isMergeTargetable && !isMergeSource && !isGenerating && (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete();
                                }}
                                className="absolute left-1.5 bottom-1.5 z-20 grid h-7 w-7 place-items-center rounded bg-red-500/20 text-red-200 opacity-0 backdrop-blur transition-opacity hover:bg-red-500/35 group-hover/cast-card:opacity-100"
                                title="删除素材"
                                aria-label={`删除${item.name}`}
                            >
                                <Trash2 size={13} />
                            </button>
                        )}
                    </>
                )}
            >
                {/* PR-3g Stage B · Voice binding hover bar (Q2 A · characters only).
                    Bound state: 🔊 voice_name + ▶ inline preview + ▼ open picker.
                    Unbound state: 🔊 + 添加音色 (clickable, opens picker). */}
                {item.kind === "character" && (
                    <div className="flex items-center gap-1 px-0.5 opacity-0 group-hover/cast-card:opacity-100 transition-opacity">
                        <button
                            onClick={(e) => { e.stopPropagation(); setPickerOpen(true); }}
                            className="flex-1 inline-flex items-center gap-1.5 rounded-md border border-glass-border bg-black/30 px-2 py-1 text-[10px] text-text-secondary hover:border-white/20 hover:text-foreground transition-colors min-w-0"
                            title={voiceId ? t("voiceBindChange") : t("voiceBindAdd")}
                        >
                            <Volume2 size={10} className={voiceId ? "text-primary" : "text-text-muted"} />
                            <span className="truncate flex-1 text-left">
                                {voiceName || (voiceId ? voiceId : t("voiceBindNone"))}
                            </span>
                            <span className="font-mono text-[8px] text-text-muted shrink-0">▼</span>
                        </button>
                        {voiceId && (
                            <button
                                onClick={(e) => { e.stopPropagation(); handleInlinePreview(); }}
                                aria-label={playing ? "Stop preview" : "Play preview"}
                                className={`shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors ${
                                    playing
                                        ? "border-primary bg-primary/15 text-primary"
                                        : "border-glass-border bg-black/30 text-text-secondary hover:border-white/20 hover:text-foreground"
                                }`}
                            >
                                {previewing ? <Loader2 size={10} className="animate-spin" /> : playing ? <Pause size={10} /> : <Play size={10} />}
                            </button>
                        )}
                    </div>
                )}
                {/* P1-c — history (cross-episode appearances) trigger.
                    Only for characters in series-affiliated episodes. */}
                {item.kind === "character" && currentProject?.series_id && (
                    <button
                        onClick={(e) => { e.stopPropagation(); setHistoryOpen(true); }}
                        className="absolute top-1 right-1 p-1 rounded bg-overlay/0 text-text-muted opacity-0 group-hover/cast-card:opacity-100 hover:text-foreground hover:bg-overlay transition-all"
                        title={t("viewHistory")}
                    >
                        <Sparkles size={11} />
                    </button>
                )}
            </AssetVisualCard>
            {historyOpen && currentProject?.series_id && (
                <CharacterHistoryPopover
                    seriesId={currentProject.series_id}
                    characterId={item.id}
                    onClose={() => setHistoryOpen(false)}
                />
            )}
            {pickerOpen && character && (
                <VoicePickerModal
                    isOpen={pickerOpen}
                    onClose={() => setPickerOpen(false)}
                    characterName={item.name}
                    characterGender={character.gender}
                    currentVoiceId={voiceId}
                    onApply={handleApplyVoice}
                    seriesId={currentProject?.series_id || null}
                    characterDescription={character.description}
                />
            )}
            {item.kind !== "prop" && (
                <AssetStageDialog open={stageOpen} asset={item.asset} assetType={item.kind} currentEpisode={currentProject?.episode_number} onClose={() => setStageOpen(false)} onAction={onStageAction}/>
            )}
        </>
    );
}

function CharacterHistoryPopover({ seriesId, characterId, onClose }: { seriesId: string; characterId: string; onClose: () => void }) {
    const t = useTranslations("cast");
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.getCharacterAppearances(seriesId, characterId)
            .then(d => { if (!cancelled) setData(d); })
            .catch(err => { if (!cancelled) setError(err?.response?.data?.detail || err?.message || "Load failed"); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [seriesId, characterId]);

    return (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-md rounded-2xl border border-glass-border bg-elevated p-6 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start gap-3 mb-4">
                    <div className="grid h-9 w-9 place-items-center rounded-full border border-pink-400/40 bg-pink-400/10 text-pink-300">
                        <Sparkles size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-display text-display font-medium text-foreground truncate">
                            {data?.character?.name || t("loading")}
                        </h3>
                        {data?.character?.persona && (
                            <p className="text-xs text-text-secondary mt-0.5">Persona · {data.character.persona}</p>
                        )}
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-hover-bg rounded-lg text-text-muted hover:text-foreground transition-colors">
                        <X size={16} />
                    </button>
                </div>
                {loading ? (
                    <div className="grid place-items-center py-8 text-text-muted"><Loader2 className="animate-spin" size={18} /></div>
                ) : error ? (
                    <p className="rounded-lg border border-status-failed-border/40 bg-status-failed-bg/50 px-3 py-2 text-status-failed-fg text-xs">{error}</p>
                ) : (
                    <div className="space-y-3">
                        <p className="text-xs text-text-secondary">
                            {t("totalAppearances", { count: data?.total_frames ?? 0, episodes: data?.appearances?.length ?? 0 })}
                        </p>
                        <div className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar">
                            {(data?.appearances || []).map((app: any) => (
                                <div key={app.episode_id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-glass-border bg-glass">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-foreground truncate">
                                            EP{app.episode_number ?? "?"} · {app.episode_title}
                                        </p>
                                    </div>
                                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-pink-300">
                                        {t("appearancesCount", { count: app.frame_count })}
                                    </span>
                                </div>
                            ))}
                            {data?.appearances?.length === 0 && (
                                <p className="text-center py-4 text-xs text-text-muted">{t("noAppearancesYet")}</p>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
