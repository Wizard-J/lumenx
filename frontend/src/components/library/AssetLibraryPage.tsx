"use client";

import { useState, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search, Users, MapPin, Package, Image as ImageIcon, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import AssetCard from "@/components/common/AssetCard";
import type { Series, Project, Character, Scene, Prop } from "@/store/projectStore";

type AssetTab = "characters" | "scenes" | "props";

interface AssetSource {
  id: string;
  name: string;
  type: "series" | "project";
  characters: Character[];
  scenes: Scene[];
  props: Prop[];
}

export default function AssetLibraryPage() {
  const t = useTranslations("library");
  const tc = useTranslations("common");
  const [sources, setSources] = useState<AssetSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AssetTab>("characters");
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadAssets();
  }, []);

  const loadAssets = async () => {
    setLoading(true);
    try {
      const [seriesList, projects] = await Promise.all([
        api.listSeries(),
        api.getProjects(),
      ]);

      const result: AssetSource[] = [];

      for (const s of seriesList as Series[]) {
        if ((s.characters?.length || 0) + (s.scenes?.length || 0) + (s.props?.length || 0) > 0) {
          result.push({
            id: `series-${s.id}`,
            name: s.title,
            type: "series",
            characters: s.characters || [],
            scenes: s.scenes || [],
            props: s.props || [],
          });
        }
      }

      const standaloneProjects = (projects as Project[]).filter((p) => !p.series_id);
      for (const p of standaloneProjects) {
        if ((p.characters?.length || 0) + (p.scenes?.length || 0) + (p.props?.length || 0) > 0) {
          result.push({
            id: `project-${p.id}`,
            name: p.title,
            type: "project",
            characters: p.characters || [],
            scenes: p.scenes || [],
            props: p.props || [],
          });
        }
      }

      setSources(result);
    } catch (error) {
      console.error("Failed to load asset library:", error);
    } finally {
      setLoading(false);
    }
  };

  const tabs: { id: AssetTab; label: string; icon: typeof Users }[] = [
    { id: "characters", label: t("characterLabel"), icon: Users },
    { id: "scenes", label: t("sceneLabel"), icon: MapPin },
    { id: "props", label: t("propLabel"), icon: Package },
  ];

  const filteredSources = useMemo(() => {
    if (!searchQuery.trim()) return sources;
    const q = searchQuery.toLowerCase();
    return sources
      .map((source) => ({
        ...source,
        characters: source.characters.filter((a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q)),
        scenes: source.scenes.filter((a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q)),
        props: source.props.filter((a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q)),
      }))
      .filter((s) => {
        const count = activeTab === "characters" ? s.characters.length : activeTab === "scenes" ? s.scenes.length : s.props.length;
        return count > 0;
      });
  }, [sources, searchQuery, activeTab]);

  const totalCount = filteredSources.reduce((acc, s) => {
    return acc + (activeTab === "characters" ? s.characters.length : activeTab === "scenes" ? s.scenes.length : s.props.length);
  }, 0);

  const toggleCollapse = (sourceId: string) => {
    setCollapsedSources((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  return (
    <div className="w-full px-8 py-8">
      <div className="mx-auto max-w-[1500px]">
        <div className="flex items-center justify-between gap-6 mb-6">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">{t("title")}</h1>
          </div>
          <div className="relative w-80">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full bg-glass border border-glass-border rounded-lg pl-9 pr-4 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary/50 transition-colors"
          />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-glass-border mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-text-secondary hover:text-foreground"
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <span className="self-center text-xs text-text-muted">{t("assetCount", { count: totalCount })}</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-text-secondary">{tc("loading")}</div>
          </div>
        ) : filteredSources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-text-muted">
            <ImageIcon size={48} className="mb-3 text-text-muted" />
            <p className="text-sm">{t("noAssets")}</p>
            <p className="text-xs text-text-muted mt-1">{t("noAssetsHint")}</p>
          </div>
        ) : (
          <div className="space-y-7">
            {filteredSources.map((source) => {
              const assets: (Character | Scene | Prop)[] =
                activeTab === "characters" ? source.characters : activeTab === "scenes" ? source.scenes : source.props;
              if (assets.length === 0) return null;
              const isCollapsed = collapsedSources.has(source.id);

              return (
                <div key={source.id}>
                  <button
                    onClick={() => toggleCollapse(source.id)}
                    className="flex items-center gap-2 mb-3 text-sm text-text-secondary hover:text-foreground transition-colors"
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className="font-medium">{source.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-glass text-text-muted">
                      {source.type === "series" ? t("series") : t("project")} · {assets.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="grid grid-cols-2 gap-4 pl-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[1800px]:grid-cols-7">
                      {assets.map((asset) => (
                        <AssetCard key={asset.id} asset={asset} type={activeTab} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
