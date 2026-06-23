"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Image as ImageIcon, Loader2, Lock, Plus, Trash2, Unlock, WandSparkles, X } from "lucide-react";
import type { AssetStage, Character, ImageVariant, Scene } from "@/store/projectStore";
import { getAssetUrl } from "@/lib/utils";

export type StageAsset = Character | Scene;
export type StageAction = (asset: StageAsset, action: string, stage?: AssetStage, data?: Record<string, unknown>) => Promise<void>;

interface Props {
  open: boolean;
  asset: StageAsset;
  assetType: "character" | "scene";
  currentEpisode?: number;
  onClose: () => void;
  onAction?: StageAction;
}

function baseCandidates(asset: StageAsset, type: "character" | "scene"): ImageVariant[] {
  const raw = asset as any;
  const pools: any[][] = type === "character"
    ? [raw.reference_sheet?.image_variants, raw.three_views?.image_variants, raw.three_view_asset?.variants, raw.full_body?.image_variants, raw.full_body_asset?.variants]
    : [raw.image_asset?.variants];
  const seen = new Set<string>();
  const result: ImageVariant[] = [];
  for (const pool of pools) {
    for (const item of pool || []) {
      if (item?.url && !seen.has(item.url)) { seen.add(item.url); result.push(item); }
    }
  }
  const fallback = type === "character" ? raw.full_body_image_url || raw.image_url : raw.image_url;
  if (fallback && !seen.has(fallback)) result.push({ id: `base-${result.length}`, url: fallback, created_at: 0 });
  return result;
}

export default function AssetStageDialog({ open, asset, assetType, currentEpisode, onClose, onAction }: Props) {
  const stages = asset.stages || [];
  const initial = useMemo(() => stages.find((stage) => currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode) || stages[0], [stages, currentEpisode]);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftDelta, setDraftDelta] = useState("");
  const [draftFrom, setDraftFrom] = useState(1);
  const [draftTo, setDraftTo] = useState(1);
  const [batchSize, setBatchSize] = useState(1);
  const [aspectRatio, setAspectRatio] = useState(assetType === "character" ? "16:9" : "16:9");
  const selected = stages.find((stage) => stage.id === selectedId) || initial;
  const candidates = useMemo(() => baseCandidates(asset, assetType), [asset, assetType]);
  const stageCandidates = useMemo(() => {
    if (!selected) return [];
    const byUrl = new Map<string, ImageVariant>();
    for (const image of selected.reference_images) {
      if (!byUrl.has(image.url) || image.id === selected.selected_image_id) byUrl.set(image.url, image);
    }
    return Array.from(byUrl.values());
  }, [selected]);
  const effectivePrompt = selected ? (assetType === "character"
    ? `角色三视图设定表：${asset.name}。${asset.description || ""}。阶段：${draftLabel || selected.label}。${draftDelta}。同一张图严格包含同一角色的正面全身、标准侧面全身、背面全身三个独立视图，等比例从左到右排列；每个视图完整露出头到脚，站立中性姿势，五官、发型、体型、服装、材质、颜色、破损和配饰完全一致；浅色纯净影棚背景，无场景、无道具、无文字、无数字、无 logo、无水印。`
    : `场景参考图：${asset.name}。${asset.description || ""}。阶段：${draftLabel || selected.label}。${draftDelta}。无文字、无数字、无 logo、无水印。`) : "";

  useEffect(() => { if (initial && !stages.some((stage) => stage.id === selectedId)) setSelectedId(initial.id); }, [initial, selectedId, stages]);
  useEffect(() => {
    if (!selected) return;
    setDraftLabel(selected.label); setDraftDelta(selected.visual_delta); setDraftFrom(selected.from_episode); setDraftTo(selected.to_episode);
  }, [selected?.id, selected?.label, selected?.visual_delta, selected?.from_episode, selected?.to_episode]);
  if (!open) return null;

  const run = async (action: string, data: Record<string, unknown> = {}, stage = selected) => {
    if (!onAction || (!stage && action !== "create")) return;
    setBusy(action); setError(null);
    try { await onAction(asset, action, stage, data); }
    catch (cause: any) { setError(cause?.response?.data?.detail || cause?.message || "阶段操作失败"); }
    finally { setBusy(null); }
  };
  const selectedImage = selected?.reference_images.find((item) => item.id === selected.selected_image_id);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="glass-panel w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-[#09090f]/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4"><div><h3 className="font-display text-lg font-semibold text-foreground">{asset.name} · 阶段资产</h3><p className="mt-1 text-xs text-text-muted">阶段候选独立保存；分镜生成时按当前集冻结引用</p></div><button onClick={onClose} className="glass-button p-2"><X size={16}/></button></header>
        <div className="flex gap-2 overflow-x-auto border-b border-white/10 px-5 py-4">
          {stages.map((stage) => { const active = stage.id === selected?.id; const episodeActive = !!currentEpisode && stage.from_episode <= currentEpisode && currentEpisode <= stage.to_episode; return <button key={stage.id} onClick={() => setSelectedId(stage.id)} className={`shrink-0 rounded-lg border px-3 py-2 text-left transition ${active ? "border-primary bg-primary/15 text-foreground" : episodeActive ? "border-primary/40 bg-primary/5 text-text-secondary" : "border-white/10 bg-white/[.03] text-text-muted"}`}><span className="block text-[10px] font-mono">EP{stage.from_episode}{stage.to_episode !== stage.from_episode ? `-${stage.to_episode}` : ""}</span><span className="text-sm font-medium">{stage.label}</span></button>; })}
          {stages.length > 0 && <button disabled={!!busy} onClick={() => { const last = stages.reduce((a, b) => a.to_episode > b.to_episode ? a : b); run("create", { label: `阶段 ${stages.length + 1}`, from_episode: last.to_episode + 1, to_episode: last.to_episode + 1, visual_delta: "" }, undefined); }} className="glass-button flex shrink-0 items-center gap-1 text-xs"><Plus size={13}/>阶段</button>}
        </div>
        {!selected ? <div className="flex flex-col items-center gap-3 px-5 py-16 text-center"><ImageIcon size={36} className="text-text-muted"/><div><p className="text-sm text-foreground">还没有阶段资产</p><p className="mt-1 text-xs text-text-muted">创建后即可从现有参考图中指定该阶段使用的图片。</p></div><button disabled={!!busy} onClick={() => run("create", { label: "基础阶段", from_episode: 1, to_episode: 12, visual_delta: "" }, undefined)} className="glass-button text-xs text-primary">创建 EP1–12 基础阶段</button></div> :
        <div className="grid max-h-[72vh] gap-5 overflow-y-auto p-5 md:grid-cols-[300px_1fr]">
          <div><div className="aspect-[4/5] overflow-hidden rounded-xl border border-white/10 bg-white/[.03]">{selectedImage ? <img src={getAssetUrl(selectedImage.url)} className="h-full w-full object-cover object-top" alt={`${asset.name} ${selected.label}`}/> : <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-text-muted"><ImageIcon size={32}/><span>尚未选择阶段参考图</span></div>}</div>{selectedImage && <p className="mt-2 truncate text-[10px] text-text-muted" title={selectedImage.prompt_used}>{selectedImage.prompt_used || "现有资产候选"}</p>}</div>
          <div className="min-w-0 space-y-4">
            <div className="grid grid-cols-[1fr_72px_72px_auto] items-end gap-2"><label className="text-[10px] text-text-muted">阶段名<input value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} onBlur={() => draftLabel !== selected.label && run("update", {label:draftLabel})} className="glass-input mt-1 w-full px-2 py-1.5 text-xs"/></label><label className="text-[10px] text-text-muted">起始集<input type="number" min={1} value={draftFrom} onChange={(e) => setDraftFrom(Number(e.target.value))} onBlur={() => draftFrom !== selected.from_episode && run("update", {from_episode:draftFrom})} className="glass-input mt-1 w-full px-2 py-1.5 text-xs"/></label><label className="text-[10px] text-text-muted">结束集<input type="number" min={1} value={draftTo} onChange={(e) => setDraftTo(Number(e.target.value))} onBlur={() => draftTo !== selected.to_episode && run("update", {to_episode:draftTo})} className="glass-input mt-1 w-full px-2 py-1.5 text-xs"/></label><span className="mb-2 flex items-center gap-1 text-xs text-text-muted">{(busy === "generate" || selected.status === "processing") && <Loader2 size={13} className="animate-spin text-primary"/>}{selected.locked ? <Lock size={13}/> : <Unlock size={13}/>} {busy === "generate" ? "生成中" : selected.status}</span></div>
            <div><label className="mb-1 block text-xs text-text-muted">视觉变化 visual_delta</label><textarea value={draftDelta} onChange={(e) => setDraftDelta(e.target.value)} onBlur={() => draftDelta !== selected.visual_delta && run("update", {visual_delta:draftDelta})} className="glass-input min-h-20 w-full resize-none p-3 text-sm"/></div>
            <div className="rounded-lg border border-primary/15 bg-primary/[.04] p-3"><div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-primary">阶段生成提示词</div><p className="text-xs leading-5 text-text-secondary">{selected.last_generation_prompt || effectivePrompt}</p><p className="mt-1 text-[10px] text-text-muted">{selected.last_generation_prompt ? "上次实际提交" : "将按当前内容提交"}</p></div>
            <div><div className="mb-2 flex items-center justify-between"><span className="text-xs text-text-muted">本阶段参考图 · 点击切换当前使用图</span><span className="text-[10px] text-text-muted">{stageCandidates.length} 张</span></div><div className="flex min-h-20 gap-2 overflow-x-auto">{stageCandidates.map((image) => <button key={image.id} disabled={!!busy} onClick={() => run("select", {image_id:image.id})} className={`group relative h-24 w-20 shrink-0 overflow-hidden rounded-lg border ${image.id === selected.selected_image_id ? "border-primary ring-1 ring-primary/30" : "border-white/10"}`}><img src={getAssetUrl(image.url)} className="h-full w-full object-cover" alt="阶段参考图"/>{image.id === selected.selected_image_id && <Check size={15} className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-white"/>}<span role="button" aria-label="移除阶段参考图" onClick={(event) => { event.stopPropagation(); run("remove_image", {image_id:image.id}); }} className="absolute left-1 top-1 rounded bg-black/75 p-1 text-white opacity-0 transition group-hover:opacity-100"><Trash2 size={11}/></span></button>)}{stageCandidates.length === 0 && <span className="self-center text-xs text-text-muted">暂无参考图，可从下方采用或生成</span>}</div></div>
            {candidates.length > 0 && <div><div className="mb-2 text-xs text-text-muted">可复用的基础资产图片 · 采用后加入本阶段（相同图片不会重复）</div><div className="flex min-h-20 gap-2 overflow-x-auto">{candidates.map((image) => <button key={`${image.id}-${image.url}`} disabled={!!busy} onClick={() => run("use_image", {image_url:image.url,prompt_used:image.prompt_used || "基础资产候选"})} className="group relative h-24 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 hover:border-primary/60"><img src={getAssetUrl(image.url)} className="h-full w-full object-cover" alt="基础候选"/><span className="absolute inset-x-0 bottom-0 bg-black/75 py-1 text-[9px] text-white opacity-0 group-hover:opacity-100">采用到本阶段</span></button>)}</div></div>}
            <div className="grid gap-3 rounded-lg border border-white/10 bg-white/[.025] p-3 sm:grid-cols-2">
              <div><span className="mb-2 block text-[10px] font-mono uppercase tracking-wider text-text-muted">生成张数</span><div className="flex gap-2">{[1, 2, 4].map((count) => <button key={count} disabled={!!busy} onClick={() => setBatchSize(count)} className={`rounded-md border px-3 py-1.5 font-mono text-xs transition ${batchSize === count ? "border-primary bg-primary/15 text-primary" : "border-white/10 text-text-muted hover:border-white/20"}`}>×{count}</button>)}</div></div>
              <div><span className="mb-2 block text-[10px] font-mono uppercase tracking-wider text-text-muted">生成比例</span><div className="flex flex-wrap gap-2">{["9:16", "3:4", "1:1", "4:3", "16:9"].map((ratio) => <button key={ratio} disabled={!!busy} onClick={() => setAspectRatio(ratio)} className={`rounded-md border px-2.5 py-1.5 font-mono text-xs transition ${aspectRatio === ratio ? "border-primary bg-primary/15 text-primary" : "border-white/10 text-text-muted hover:border-white/20"}`}>{ratio}</button>)}</div></div>
            </div>
            {selected.locked && <p className="rounded-lg border border-amber-400/20 bg-amber-400/[.06] px-3 py-2 text-xs text-amber-200">当前阶段已锁定。生成前请先点击右侧“解锁”。</p>}
            {error && <p className="rounded-lg border border-status-failed-border bg-status-failed-bg px-3 py-2 text-xs text-status-failed-fg">{error}</p>}
            <div className="flex flex-wrap gap-2"><button disabled={!!busy} onClick={() => selected.locked ? setError("当前阶段已锁定，请先解锁后再生成。") : run("generate", {prompt:effectivePrompt, batch_size:batchSize, aspect_ratio:aspectRatio})} className={`glass-button flex items-center gap-2 text-xs ${selected.locked ? "text-text-muted" : "text-primary"}`}>{busy === "generate" ? <Loader2 size={14} className="animate-spin"/> : <WandSparkles size={14}/>}生成当前阶段 ×{batchSize}</button><button disabled={!!busy} onClick={() => run("copy_previous")} className="glass-button flex items-center gap-2 text-xs"><Copy size={14}/>复用上一阶段</button>{candidates.length > 0 && <button disabled={!!busy} onClick={() => run("use_base")} className="glass-button text-xs">使用当前基础主图</button>}<button disabled={!!busy} onClick={() => run("toggle_lock")} className="glass-button ml-auto flex items-center gap-2 text-xs">{selected.locked ? <Unlock size={14}/> : <Lock size={14}/>} {selected.locked ? "解锁" : "锁定"}</button></div>
          </div>
        </div>}
      </div>
    </div>
  );
}
