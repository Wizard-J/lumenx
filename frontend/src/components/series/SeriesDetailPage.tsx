"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { Image as ImageIcon, Play, ChevronRight, Sparkles, Loader2, Terminal, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Series, Character, Scene, Prop, Project } from "@/store/projectStore";
import AssetCard from "@/components/common/AssetCard";
import CharacterWorkbench from "@/components/modules/CharacterWorkbench";
import { useTranslations } from "next-intl";
import { useLogStore } from "@/store/logStore";
import SeriesSidebar, { type SidebarItem } from "./SeriesSidebar";
import GlobalLogSidebar from "@/components/layout/GlobalLogPanel";

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
            />
          ) : selectedEpisode ? (
            <EpisodeContentPanel
              key={`episode-${selectedEpisode.id}`}
              episode={selectedEpisode}
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
}: {
  tab: AssetTab;
  assets: (Character | Scene | Prop)[];
  label: string;
  seriesId: string;
  series: Series | null;
  onSeriesUpdate: (s: Series) => void;
}) {
  const t = useTranslations("series");
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [generatingAll, setGeneratingAll] = useState(false);
  const [workbenchAsset, setWorkbenchAsset] = useState<(Character | Scene | Prop) | null>(null);
  const [workbenchGeneratingTypes, setWorkbenchGeneratingTypes] = useState<{ type: string; batchSize: number }[]>([]);
  const [workbenchVersion, setWorkbenchVersion] = useState(0);

  // Sync workbenchAsset when series data changes (e.g., after polling updates)
  const workbenchAssetIdRef = useRef<string | null>(null);
  useEffect(() => {
    workbenchAssetIdRef.current = workbenchAsset?.id || null;
  }, [workbenchAsset]);
  useEffect(() => {
    const assetId = workbenchAssetIdRef.current;
    if (assetId && series) {
      const assetList = tab === "characters" ? series.characters
        : tab === "scenes" ? series.scenes : series.props;
      const freshAsset = assetList.find((a: any) => a.id === assetId);
      if (freshAsset) {
        setWorkbenchAsset(freshAsset);
      }
    }
  }, [series, tab]);

  const assetTypeSingular = tab === "characters" ? "character" : tab === "scenes" ? "scene" : "prop";

  const handleWorkbenchGenerate = useCallback(async (genType: string, prompt: string, applyStyle: boolean, negativePrompt: string, batchSize: number) => {
    if (!workbenchAsset) return;
    const assetId = workbenchAsset.id;
    setWorkbenchGeneratingTypes(prev => [...prev, { type: genType, batchSize }]);
    try {
      await api.generateSeriesAsset(seriesId, assetId, assetTypeSingular, {
        generation_type: genType,
        prompt,
        apply_style: applyStyle,
        negative_prompt: negativePrompt,
        batch_size: batchSize,
      });
      const pollInterval = setInterval(async () => {
        try {
          const updatedSeries = await api.getSeries(seriesId);
          const assetList = tab === "characters" ? updatedSeries.characters
            : tab === "scenes" ? updatedSeries.scenes : updatedSeries.props;
          const asset = assetList.find((a: any) => a.id === assetId);

          // Check the specific asset type being generated (not any asset)
          const assetKeyMap: Record<string, string> = {
            full_body: 'full_body_asset',
            three_view: 'three_view_asset',
            headshot: 'headshot_asset',
          };
          // For non-character assets (scene/prop), always check image_asset
          const isNonChar = tab === "scenes" || tab === "props";
          const targetKey = isNonChar ? 'image_asset' : (assetKeyMap[genType] || 'image_asset');
          const targetAsset = asset?.[targetKey];

          if (targetAsset?.variants?.length > 0) {
            clearInterval(pollInterval);
            setWorkbenchGeneratingTypes([]);
            onSeriesUpdate(updatedSeries);
            const updatedAsset = (tab === "characters" ? updatedSeries.characters
              : tab === "scenes" ? updatedSeries.scenes : updatedSeries.props)
              .find((a: any) => a.id === assetId);
            if (updatedAsset) {
              setWorkbenchAsset(updatedAsset);
              setWorkbenchVersion(v => v + 1);
            }
          }
        } catch { /* retry */ }
      }, 3000);
      setTimeout(() => clearInterval(pollInterval), 120000);
    } catch (e) {
      console.error("Workbench generate failed:", e);
      setWorkbenchGeneratingTypes([]);
    }
  }, [workbenchAsset, seriesId, assetTypeSingular, tab]);

  const handleSelectWorkbenchVariant = useCallback((type: string, variantId: string) => {
    if (!workbenchAsset || !series) return;
    const typeMap: Record<string, string> = {
      full_body: 'full_body_asset',
      three_view: 'three_view_asset',
      headshot: 'headshot_asset',
    };
    const assetKey = typeMap[type] || 'full_body_asset';
    const updated = { ...series };
    const list = tab === 'characters' ? [...(updated.characters || [])]
      : tab === 'scenes' ? [...(updated.scenes || [])]
      : [...(updated.props || [])];
    const idx = list.findIndex((a: any) => a.id === workbenchAsset.id);
    if (idx >= 0) {
      const asset = { ...list[idx] };
      if (!asset[assetKey]) asset[assetKey] = {};
      asset[assetKey] = { ...asset[assetKey], selected_id: variantId };
      list[idx] = asset;
      if (tab === 'characters') updated.characters = list;
      else if (tab === 'scenes') updated.scenes = list;
      else updated.props = list;
      onSeriesUpdate(updated as Series);
      setWorkbenchAsset(asset);
    }
  }, [workbenchAsset, series, tab, onSeriesUpdate]);

  const handleGenerateSingle = async (assetId: string) => {
    setGeneratingIds(prev => new Set(prev).add(assetId));
    try {
      await api.generateSeriesAsset(seriesId, assetId, assetTypeSingular);
      const pollInterval = setInterval(async () => {
        try {
          const updatedSeries = await api.getSeries(seriesId);
          if (updatedSeries) {
            // Update local state with fresh data (no full page reload)
            onSeriesUpdate(updatedSeries);
            const assetList = tab === "characters" ? updatedSeries.characters
              : tab === "scenes" ? updatedSeries.scenes : updatedSeries.props;
            const asset = assetList.find((a: any) => a.id === assetId);
            if (asset?.full_body_asset?.variants?.length > 0 ||
                asset?.image_asset?.variants?.length > 0) {
              clearInterval(pollInterval);
              setGeneratingIds(prev => { const next = new Set(prev); next.delete(assetId); return next; });
            }
          }
        } catch { }
      }, 3000);
      setTimeout(() => clearInterval(pollInterval), 120000);
    } catch (e) {
      console.error("Failed to generate:", e);
      setGeneratingIds(prev => { const next = new Set(prev); next.delete(assetId); return next; });
    }
  };

  const handleGenerateAll = async () => {
    setGeneratingAll(true);
    for (const asset of assets) {
      try {
        await api.generateSeriesAsset(seriesId, asset.id, assetTypeSingular);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`Failed to generate ${asset.id}:`, e);
      }
    }
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
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6"
            initial="hidden"
            animate="visible"
            variants={{
              visible: { transition: { staggerChildren: 0.04 } },
            }}
          >
            {assets.map((asset) => (
              <motion.div
                key={asset.id}
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
                  className="relative group/card cursor-pointer"
                  onClick={() => setWorkbenchAsset(asset)}
                >
                  <AssetCard asset={asset} type={tab} />
                  <button
                    onClick={(e) => { e.stopPropagation(); handleGenerateSingle(asset.id); }}
                    disabled={generatingIds.has(asset.id)}
                    className={`absolute top-2 right-2 p-1.5 rounded-lg opacity-0 group-hover/card:opacity-100 transition-all ${
                      (asset.full_body_asset?.variants?.length > 0 || asset.image_asset?.variants?.length > 0)
                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                        : 'bg-black/60 text-amber-400 hover:bg-black/80'
                    } ${generatingIds.has(asset.id) ? 'opacity-100' : ''}`}
                    title={t("generateSingle")}
                  >
                    {generatingIds.has(asset.id) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (asset.full_body_asset?.variants?.length > 0 || asset.image_asset?.variants?.length > 0) ? (
                      <RefreshCw size={14} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                  </button>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>

      {/* Character Workbench Modal */}
      <AnimatePresence>
        {workbenchAsset && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setWorkbenchAsset(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-[90vw] max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <CharacterWorkbench
                key={`wb-${workbenchAsset.id}-v${workbenchVersion}`}
                asset={workbenchAsset}
                onClose={() => { setWorkbenchAsset(null); setWorkbenchGeneratingTypes([]); }}
                onUpdateDescription={() => {}}
                onSelectVariant={handleSelectWorkbenchVariant}
                onGenerate={handleWorkbenchGenerate}
                generatingTypes={workbenchGeneratingTypes}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Episode Content Panel ──

function EpisodeContentPanel({
  episode,
  seriesId,
  onOpenEditor,
}: {
  episode: Project;
  seriesId: string;
  onOpenEditor: () => void;
}) {
  const t = useTranslations("series");

  const frames = episode.frames || [];
  const characters = episode.characters || [];
  const scenes = episode.scenes || [];
  const originalText = episode.originalText || "";

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
              {frames.slice(0, 12).map((frame, i) => (
                <div
                  key={frame.id}
                  className="aspect-video bg-surface rounded-lg border border-glass-border overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={onOpenEditor}
                >
                  {frame.rendered_image_url ? (
                    <img
                      src={frame.rendered_image_url}
                      alt={`#${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-text-muted font-mono">
                      #{i + 1}
                    </div>
                  )}
                </div>
              ))}
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
