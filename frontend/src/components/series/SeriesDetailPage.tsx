"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { Image as ImageIcon, Play, ChevronRight, Sparkles, Loader2, Terminal, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Series, Character, Scene, Prop, Project, AssetStage } from "@/store/projectStore";
import AssetCard from "@/components/common/AssetCard";
import CastWorkbenchModal from "@/components/modules/cast/CastWorkbenchModal";
import { useTranslations } from "next-intl";
import { useLogStore } from "@/store/logStore";
import SeriesSidebar, { type SidebarItem } from "./SeriesSidebar";
import GlobalLogSidebar from "@/components/layout/GlobalLogPanel";
import { getAssetUrl } from "@/lib/utils";

const SeriesModelSettingsModal = dynamic(() => import("./SeriesModelSettingsModal"), { ssr: false });
const SeriesPromptConfigModal = dynamic(() => import("./SeriesPromptConfigModal"), { ssr: false });
const ImportAssetsDialog = dynamic(() => import("./ImportAssetsDialog"), { ssr: false });
const SeriesArtDirectionPanel = dynamic(() => import("./SeriesArtDirectionPanel"), { ssr: false });

interface SeriesDetailPageProps {
  seriesId: string;
}

type AssetTab = "characters" | "scenes" | "props";

export default function SeriesDetailPage({ seriesId }: SeriesDetailPageProps) {
  const [series, setSeries] = useState<Series | null>(null);
  const [episodes, setEpisodes] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeItem, setActiveItem] = useState<SidebarItem>({ kind: "asset", tab: "characters" });
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [showAddEpisode, setShowAddEpisode] = useState(false);
  const [newEpisodeTitle, setNewEpisodeTitle] = useState("");
  const [isCreatingEpisode, setIsCreatingEpisode] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showPromptConfig, setShowPromptConfig] = useState(false);
  const [showImportAssets, setShowImportAssets] = useState(false);
  const { showLogs, toggleLogs, setShowLogs } = useLogStore();

  const t = useTranslations("series");
  const tc = useTranslations("common");

  const ASSET_LABELS: Record<AssetTab, string> = {
    characters: t("characterLabel"),
    scenes: t("sceneLabel"),
    props: t("propLabel"),
  };

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [seriesData, episodesData] = await Promise.all([
          api.getSeries(seriesId),
          api.getSeriesEpisodes(seriesId),
        ]);
        setSeries(seriesData);
        setEpisodes(episodesData);
        setEditTitle(seriesData.title);
      } catch (error) {
        console.error("Failed to fetch series data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [seriesId]);

  const handleBackToHome = () => {
    window.location.hash = "";
  };

  const handleTitleSave = async () => {
    if (!editTitle.trim() || !series) return;
    try {
      await api.updateSeries(seriesId, { title: editTitle.trim() });
      setSeries({ ...series, title: editTitle.trim() });
    } catch (error) {
      console.error("Failed to update series title:", error);
      setEditTitle(series.title);
    }
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleTitleSave();
    if (e.key === "Escape") {
      setEditTitle(series?.title || "");
      setIsEditingTitle(false);
    }
  };

  const handleAddEpisode = async () => {
    if (!newEpisodeTitle.trim()) return;
    setIsCreatingEpisode(true);
    try {
      const nextEpNum = episodes.length + 1;
      const workflowMode = series?.workflow_mode || "i2v_legacy";
      await api.createEpisodeForSeries(seriesId, newEpisodeTitle.trim(), nextEpNum, workflowMode);
      const updatedEpisodes = await api.getSeriesEpisodes(seriesId);
      setEpisodes(updatedEpisodes);
      setNewEpisodeTitle("");
      setShowAddEpisode(false);
    } catch (error) {
      console.error("Failed to add episode:", error);
    } finally {
      setIsCreatingEpisode(false);
    }
  };

  const handleAddEpisodeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleAddEpisode();
    if (e.key === "Escape") setShowAddEpisode(false);
  };

  const handleOpenEpisode = (episodeId: string) => {
    window.location.hash = `#/series/${seriesId}/episode/${episodeId}`;
  };

  const refreshSeriesData = async () => {
    try {
      const [seriesData, episodesData] = await Promise.all([
        api.getSeries(seriesId),
        api.getSeriesEpisodes(seriesId),
      ]);
      setSeries(seriesData);
      setEpisodes(episodesData);
    } catch (error) {
      console.error("Failed to refresh series data:", error);
    }
  };

  const handleStageAction = async (asset: Character | Scene | Prop, action: string, stage?: AssetStage, data: Record<string, unknown> = {}) => {
    const episodeId = episodes[0]?.id;
    if (!episodeId) throw new Error("请先为系列创建剧集，再管理阶段资产");
    const assetType = activeItem.kind === "asset" && activeItem.tab === "scenes" ? "scene" : "character";
    const response = await api.mutateAssetStage(episodeId, asset.id, assetType, action, stage?.id, data);
    if (response?._task_id) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const status = await api.getTaskStatus(response._task_id);
        if (status?.status === "completed") break;
        if (status?.status === "failed") throw new Error(status.error || "阶段生成失败");
      }
    }
    await refreshSeriesData();
  };

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-text-secondary">{tc("loading")}</div>
      </div>
    );
  }

  // ── Error ──
  if (!series) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <p className="text-text-secondary mb-4">{t("notFound")}</p>
          <a href="#/" className="text-primary hover:underline">{t("backToHome")}</a>
        </div>
      </div>
    );
  }

  // ── Derive content ──
  const getAssets = (tab: AssetTab): (Character | Scene | Prop)[] => {
    if (tab === "characters") return series.characters || [];
    if (tab === "scenes") return series.scenes || [];
    return series.props || [];
  };

  const selectedEpisode =
    activeItem.kind === "episode"
      ? episodes.find((ep) => ep.id === activeItem.episodeId)
      : null;

  return (
    <main className="flex h-screen w-screen bg-background overflow-hidden">
      {/* ── Sidebar ── */}
      <SeriesSidebar
        series={series}
        episodes={episodes}
        activeItem={activeItem}
        onItemChange={setActiveItem}
        onBack={handleBackToHome}
        isEditingTitle={isEditingTitle}
        editTitle={editTitle}
        onEditTitleChange={setEditTitle}
        onTitleDoubleClick={() => setIsEditingTitle(true)}
        onTitleSave={handleTitleSave}
        onTitleKeyDown={handleTitleKeyDown}
        showAddEpisode={showAddEpisode}
        newEpisodeTitle={newEpisodeTitle}
        isCreatingEpisode={isCreatingEpisode}
        onShowAddEpisode={setShowAddEpisode}
        onNewEpisodeTitleChange={setNewEpisodeTitle}
        onAddEpisode={handleAddEpisode}
        onAddEpisodeKeyDown={handleAddEpisodeKeyDown}
        onOpenModelSettings={() => setShowModelSettings(true)}
        onOpenPromptConfig={() => setShowPromptConfig(true)}
        onOpenImportAssets={() => setShowImportAssets(true)}
      />

      {/* ── Content Area ── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-surface">
        <AnimatePresence mode="wait">
          {activeItem.kind === "art_direction" ? (
            <SeriesArtDirectionPanel
              key="art-direction"
              seriesId={seriesId}
              onSaved={refreshSeriesData}
            />
          ) : activeItem.kind === "asset" ? (
            <AssetContentPanel
              key={`asset-${activeItem.tab}`}
              tab={activeItem.tab}
              assets={getAssets(activeItem.tab)}
              label={ASSET_LABELS[activeItem.tab]}
              seriesId={seriesId}
              series={series}
              onSeriesUpdate={setSeries}
              onStageAction={handleStageAction}
              episodes={episodes}
            />
          ) : selectedEpisode ? (
            <EpisodeContentPanel
              key={`episode-${selectedEpisode.id}`}
              episode={selectedEpisode}
              series={series}
              seriesId={seriesId}
              onOpenEditor={() => handleOpenEpisode(selectedEpisode.id)}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {/* ── Modals ── */}
      <SeriesModelSettingsModal
        isOpen={showModelSettings}
        onClose={() => setShowModelSettings(false)}
        seriesId={seriesId}
        onSaved={refreshSeriesData}
      />
      <SeriesPromptConfigModal
        isOpen={showPromptConfig}
        onClose={() => setShowPromptConfig(false)}
        seriesId={seriesId}
        onSaved={refreshSeriesData}
      />
      <ImportAssetsDialog
        isOpen={showImportAssets}
        onClose={() => setShowImportAssets(false)}
        seriesId={seriesId}
        onImported={refreshSeriesData}
      />

      {/* Global Log Sidebar */}
      <GlobalLogSidebar open={showLogs} onClose={() => setShowLogs(false)} />
    </main>
  );
}

// ── Shared animation config ──

const contentTransition = {
  duration: 0.25,
  ease: [0.25, 1, 0.5, 1] as const, // ease-out-quart
};

// ── Asset Content Panel ──

function AssetContentPanel({
  tab,
  assets,
  label,
  seriesId,
  series,
  onSeriesUpdate,
  onStageAction,
  episodes,
}: {
  tab: AssetTab;
  assets: (Character | Scene | Prop)[];
  label: string;
  seriesId: string;
  series: Series | null;
  onSeriesUpdate: (s: Series) => void;
  onStageAction: (asset: Character | Scene | Prop, action: string, stage?: AssetStage, data?: Record<string, unknown>) => Promise<void>;
  episodes?: Project[];
}) {
  const t = useTranslations("series");
  const currentEpisode = episodes?.[0]?.episode_number;
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [generatingAll, setGeneratingAll] = useState(false);
  const [workbenchEntity, setWorkbenchEntity] = useState<{ id: string; kind: "character" | "scene" | "prop" } | null>(null);
  const pollTimersRef = useRef<Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>>(new Set());
  const gridClassName = tab === "characters"
    ? "grid grid-cols-[repeat(auto-fill,minmax(220px,260px))] gap-5"
    : tab === "scenes"
      ? "grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5"
      : "grid grid-cols-[repeat(auto-fill,minmax(200px,240px))] gap-5";

  const assetTypeSingular = tab === "characters" ? "character" : tab === "scenes" ? "scene" : "prop";
  const hasGeneratedImage = (asset: Character | Scene | Prop) => {
    const a = asset as any;
    if (tab === "characters") {
      // Check stages first, then legacy image assets
      if (a.stages?.some((s: any) => s?.reference_images?.length)) return true;
      return ((a.full_body_asset?.variants?.length ?? 0) > 0);
    }
    // Scene/Prop: check stages, reference_sheet, image_asset, legacy urls
    if (a.stages?.some((s: any) => s?.reference_images?.length)) return true;
    if (a.reference_sheet?.image_variants?.length) return true;
    return ((a.image_asset?.variants?.length ?? 0) > 0);
  };

  useEffect(() => {
    return () => {
      pollTimersRef.current.forEach((timer) => {
        clearInterval(timer as ReturnType<typeof setInterval>);
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      });
      pollTimersRef.current.clear();
    };
  }, []);

  const refreshSeries = async () => {
    const updatedSeries = await api.getSeries(seriesId);
    if (updatedSeries) {
      onSeriesUpdate(updatedSeries);
    }
    return updatedSeries;
  };

  const pollGenerationTask = (assetId: string, taskId: string) => {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = async (ok: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        pollTimersRef.current.delete(interval);
        pollTimersRef.current.delete(timeout);
        try {
          await refreshSeries();
        } catch (refreshError) {
          console.error("Failed to refresh series after generation:", refreshError);
        }
        setGeneratingIds(prev => { const next = new Set(prev); next.delete(assetId); return next; });
        if (ok) resolve();
        else reject(error);
      };

      const interval = setInterval(async () => {
        try {
          const status = await api.getTaskStatus(taskId);
          if (status?.status === "completed") {
            await finish(true);
          } else if (status?.status === "failed") {
            await finish(false, new Error(status?.error || "Generation failed"));
          }
        } catch (error) {
          await finish(false, error);
        }
      }, 2500);

      const timeout = setTimeout(() => {
        finish(false, new Error("Generation polling timed out"));
      }, 120000);

      pollTimersRef.current.add(interval);
      pollTimersRef.current.add(timeout);
    });
  };

  const handleGenerateSingle = async (assetId: string) => {
    setGeneratingIds(prev => new Set(prev).add(assetId));
    try {
      const response = await api.generateSeriesAsset(seriesId, assetId, assetTypeSingular);
      const taskId = response?._task_id;
      if (!taskId) {
        await refreshSeries();
        setGeneratingIds(prev => { const next = new Set(prev); next.delete(assetId); return next; });
        return;
      }
      await pollGenerationTask(assetId, taskId);
    } catch (e) {
      console.error("Failed to generate:", e);
      setGeneratingIds(prev => { const next = new Set(prev); next.delete(assetId); return next; });
    }
  };

  const handleGenerateAll = async () => {
    setGeneratingAll(true);
    const taskPromises: Promise<void>[] = [];
    for (const asset of assets) {
      setGeneratingIds(prev => new Set(prev).add(asset.id));
      try {
        const response = await api.generateSeriesAsset(seriesId, asset.id, assetTypeSingular);
        const taskId = response?._task_id;
        if (taskId) {
          taskPromises.push(pollGenerationTask(asset.id, taskId));
        } else {
          setGeneratingIds(prev => { const next = new Set(prev); next.delete(asset.id); return next; });
        }
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`Failed to generate ${asset.id}:`, e);
        setGeneratingIds(prev => { const next = new Set(prev); next.delete(asset.id); return next; });
      }
    }
    await Promise.allSettled(taskPromises);
    setGeneratingAll(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={contentTransition}
      className="flex-1 flex flex-col overflow-hidden bg-surface"
    >
      {/* Header */}
      <div className="p-6 border-b border-glass-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-display font-bold text-foreground">
              {label}
              <span className="text-sm font-normal text-text-secondary ml-2">
                {t("itemCount", { count: assets.length })}
              </span>
            </h2>
            <p className="text-xs text-text-muted mt-1">
              {t("sharedAssetsEditHint")}
            </p>
          </div>
          {assets.length > 0 && (
            <button
              onClick={handleGenerateAll}
              disabled={generatingAll}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-50 transition-all shrink-0"
            >
              {generatingAll ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {generatingAll ? t("generating") : t("generateAllImages")}
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-text-secondary">
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="w-16 h-16 rounded-2xl bg-glass border border-glass-border flex items-center justify-center mb-4"
            >
              <ImageIcon size={28} className="text-text-muted" />
            </motion.div>
            <p className="text-sm font-medium">{t("noAssets", { label })}</p>
            <p className="text-xs text-text-muted mt-1">{t("assetsSharedHint")}</p>
          </div>
        ) : (
          <motion.div
            className={gridClassName}
            initial="hidden"
            animate="visible"
            variants={{
              visible: { transition: { staggerChildren: 0.04 } },
            }}
          >
            {assets.map((asset) => {
              const generated = hasGeneratedImage(asset);
              const workbenchKind = tab === "characters" ? "character" : tab === "scenes" ? "scene" : "prop";
              return (
              <motion.div
                key={asset.id}
                className="h-full"
                variants={{
                  hidden: { opacity: 0, y: 16, scale: 0.97 },
                  visible: {
                    opacity: 1,
                    y: 0,
                    scale: 1,
                    transition: { duration: 0.3, ease: [0.25, 1, 0.5, 1] },
                  },
                }}
              >
                <div
                  className="relative group/card h-full"
                >
                  <AssetCard
                    asset={asset}
                    type={tab}
                    variant="gallery"
                    currentEpisode={currentEpisode}
                    onOpenWorkbench={() => setWorkbenchEntity({ id: asset.id, kind: workbenchKind })}
                    onStageAction={onStageAction}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); handleGenerateSingle(asset.id); }}
                    disabled={generatingIds.has(asset.id)}
                    className={`absolute top-2 right-2 p-1.5 rounded-lg opacity-0 group-hover/card:opacity-100 transition-all ${
                      generated
                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                        : 'bg-black/60 text-amber-400 hover:bg-black/80'
                    } ${generatingIds.has(asset.id) ? 'opacity-100' : ''}`}
                    title={t("generateSingle")}
                  >
                    {generatingIds.has(asset.id) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : generated ? (
                      <RefreshCw size={14} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                  </button>
                </div>
              </motion.div>
              );
            })}
          </motion.div>
        )}
      </div>

      {/* Unified Asset Workbench Modal (uses CastWorkbenchModal) */}
      <CastWorkbenchModal
        isOpen={workbenchEntity !== null}
        kind={workbenchEntity?.kind ?? null}
        entityId={workbenchEntity?.id ?? null}
        seriesId={seriesId}
        onSeriesUpdated={(updated: Series) => {
          onSeriesUpdate(updated);
        }}
        onClose={() => setWorkbenchEntity(null)}
      />
    </motion.div>
  );
}

// ── Episode Content Panel ──

function EpisodeContentPanel({
  episode,
  series,
  seriesId,
  onOpenEditor,
}: {
  episode: Project;
  series: Series | null;
  seriesId: string;
  onOpenEditor: () => void;

}) {
  const t = useTranslations("series");

  const frames = episode.frames || [];
  const characters = (episode.characters?.length ? episode.characters : series?.characters) || [];
  const scenes = (episode.scenes?.length ? episode.scenes : series?.scenes) || [];
  const originalText = episode.originalText || (episode as any).original_text || "";
  const getFrameThumbUrl = (frame: any): string | undefined => {
    if (frame.rendered_image_url) return frame.rendered_image_url;
    if (frame.image_url) return frame.image_url;
    if (Array.isArray(frame.t2i_image_urls) && frame.t2i_image_urls.length > 0) {
      const idx = Math.max(0, Math.min(frame.t2i_selected_index ?? 0, frame.t2i_image_urls.length - 1));
      return frame.t2i_image_urls[idx];
    }
    return undefined;
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={contentTransition}
      className="flex-1 flex flex-col overflow-hidden bg-surface"
    >
      {/* Header */}
      <div className="px-8 pt-6 pb-4 flex items-start justify-between border-b border-glass-border">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xs bg-primary/20 text-primary px-2.5 py-1 rounded-lg font-mono font-bold">
              EP{episode.episode_number || "?"}
            </span>
            <h2 className="text-xl font-display font-bold text-foreground">
              {episode.title}
            </h2>
          </div>
          <p className="text-xs text-text-secondary">
            {episode.workflow_mode === "r2v" ? "R2V" : "I2V Legacy"} · {t("frameCount", { count: frames.length })}
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onOpenEditor}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-primary/20 hover:shadow-primary/30"
        >
          <Play size={14} />
          {t("enterEditor")}
          <ChevronRight size={14} />
        </motion.button>
      </div>

      {/* Episode Overview */}
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
        {/* Script Summary */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t("scriptSummary")}</h3>
          {originalText ? (
            <p className="text-xs text-text-secondary leading-relaxed line-clamp-4 bg-surface rounded-lg p-3 border border-glass-border">
              {originalText.slice(0, 300)}{originalText.length > 300 ? "..." : ""}
            </p>
          ) : (
            <p className="text-xs text-text-muted italic">{t("noScript")}</p>
          )}
        </div>

        {/* Storyboard Overview */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t("storyboardOverview")}</h3>
          {frames.length === 0 ? (
            <div className="flex items-center gap-3 bg-surface rounded-lg p-4 border border-glass-border">
              <div className="w-10 h-10 rounded-lg bg-glass border border-glass-border flex items-center justify-center">
                <Play size={16} className="text-text-muted" />
              </div>
              <div>
                <p className="text-xs font-medium text-text-secondary">{t("noFrames")}</p>
                <p className="text-[11px] text-text-muted">{t("startCreating")}</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-4 lg:grid-cols-6 gap-2">
              {frames.slice(0, 12).map((frame, i) => {
                const thumbUrl = getFrameThumbUrl(frame);
                return (
                <div
                  key={frame.id}
                  className="aspect-video bg-surface rounded-lg border border-glass-border overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={onOpenEditor}
                >
                  {thumbUrl ? (
                    <img
                      src={getAssetUrl(thumbUrl)}
                      alt={`#${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-text-muted font-mono">
                      #{i + 1}
                    </div>
                  )}
                </div>
                );
              })}
              {frames.length > 12 && (
                <div className="aspect-video bg-surface rounded-lg border border-glass-border flex items-center justify-center text-xs text-text-muted">
                  +{frames.length - 12}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Characters & Scenes count */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-surface rounded-lg p-3 border border-glass-border text-center">
            <p className="text-lg font-bold text-foreground">{characters.length}</p>
            <p className="text-[11px] text-text-muted">{t("characters")}</p>
          </div>
          <div className="bg-surface rounded-lg p-3 border border-glass-border text-center">
            <p className="text-lg font-bold text-foreground">{scenes.length}</p>
            <p className="text-[11px] text-text-muted">{t("scenes")}</p>
          </div>
          <div className="bg-surface rounded-lg p-3 border border-glass-border text-center">
            <p className="text-lg font-bold text-foreground">{frames.length}</p>
            <p className="text-[11px] text-text-muted">{t("storyboardFrames")}</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
