"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "framer-motion";
import { Wand2, User, MapPin, Box, ChevronRight, ChevronLeft, Save, Sparkles, Plus, Trash2, X, ScrollText, PanelRightOpen, PanelRightClose } from "lucide-react";
import { api, crudApi } from "@/lib/api";
import { useProjectStore } from "@/store/projectStore";
import { toast } from "@/store/toastStore";
import StepHeader from "@/components/shared/StepHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import PreviousEpisodeSummary from "@/components/modules/PreviousEpisodeSummary";
import ReconcileModal from "@/components/modules/ReconcileModal";

interface ScriptNode {
    type: "character" | "scene" | "prop";
    id?: string;
    name: string;
    desc: string;
    // Extended attributes
    age?: string;
    gender?: string;
    clothing?: string;
    visual_weight?: number;
}

interface NormalizePreview {
    normalized_text: string;
    counts: {
        characters: number;
        scenes: number;
        props: number;
        frames: number;
    };
}

export default function ScriptProcessor() {
    const ts = useTranslations("script");
    const tc = useTranslations("common");
    const currentProject = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const analyzeProject = useProjectStore((state) => state.analyzeProject);
    const isAnalyzing = useProjectStore((state) => state.isAnalyzing);

    // Initialize from project data. Fallback to snake_case original_text
    // in case the API wrapper didn't map it (e.g. raw axios response, or a
    // store update that spread the backend payload without re-mapping).
    const projectText = (currentProject?.originalText ?? (currentProject as any)?.original_text) || "";
    const [script, setScript] = useState(projectText);
    const [nodes, setNodes] = useState<ScriptNode[]>([]);

    // UI State
    const [selectedNode, setSelectedNode] = useState<ScriptNode | null>(null);
    const [showPanel, setShowPanel] = useState(true);
    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [isNormalizing, setIsNormalizing] = useState(false);
    const [normalizePreview, setNormalizePreview] = useState<NormalizePreview | null>(null);

    // Sync from project. Bind on currentProject.id (not the whole object) so
    // local textarea state isn't clobbered every time we mutate Zustand for
    // unrelated reasons. We still re-pull text when the user switches
    // projects, and we resync entity nodes whenever the entity arrays change.
    useEffect(() => {
        if (currentProject) {
            const txt = (currentProject as any)?.original_text ?? currentProject.originalText ?? "";
            setScript(txt || "");
        }
    }, [currentProject?.id]);

    useEffect(() => {
        if (!currentProject) {
            setNodes([]);
            return;
        }
        const newNodes: ScriptNode[] = [
            ...(currentProject.characters || []).map((c: any) => ({
                type: "character" as const,
                id: c.id,
                name: c.name,
                desc: c.description,
                age: c.age,
                gender: c.gender,
                clothing: c.clothing,
                visual_weight: c.visual_weight
            })),
            ...(currentProject.scenes || []).map((s: any) => ({
                type: "scene" as const,
                id: s.id,
                name: s.name,
                desc: s.description,
                visual_weight: s.visual_weight
            })),
            ...(currentProject.props || []).map((p: any) => ({
                type: "prop" as const,
                id: p.id,
                name: p.name,
                desc: p.description
            }))
        ];
        setNodes(newNodes);
    }, [currentProject?.id, currentProject?.characters, currentProject?.scenes, currentProject?.props]);

    // R2V v2 Phase 4 — ReconcileModal opens after a successful analyze
    // when the episode belongs to a series (series_id !== null).
    const [reconcileOpen, setReconcileOpen] = useState(false);

    useEffect(() => {
        const handler = () => setReconcileOpen(true);
        document.addEventListener("lumenx:openReconcile", handler);
        return () => document.removeEventListener("lumenx:openReconcile", handler);
    }, []);

    const handleAnalyze = async () => {
        if (!script.trim()) {
            toast.warning(ts("scriptEmpty"), {
                projectId: currentProject?.id,
                projectTitle: currentProject?.title,
            });
            return;
        }
        if (!currentProject?.id) return;
        const projectId = currentProject.id;
        const projectTitle = currentProject.title;
        useProjectStore.setState({ isAnalyzing: true });
        const toastId = toast.progress(ts("analyzingScript"), {
            projectId,
            projectTitle,
            body: ts("analyzingScriptBody"),
        });
        try {
            const preview = await api.extractPreview(projectId, script);
            toast.update(toastId, {
                kind: "success",
                title: ts("analysisDone"),
                body: ts("analysisDoneBody", {
                    c: preview.characters.length,
                    s: preview.scenes.length,
                    p: preview.props.length,
                }),
                autoCloseMs: 5000,
            });
            useProjectStore.setState({
                pendingExtraction: preview,
                pendingExtractionScript: script,
                isAnalyzing: false,
            });
        } catch (error: any) {
            useProjectStore.setState({ isAnalyzing: false });
            console.error("Failed to analyze script:", error);
            const errorMessage = error?.response?.data?.detail || error?.message || "未知错误";
            toast.update(toastId, {
                kind: "error",
                title: ts("analysisFailedShort"),
                body: String(errorMessage).slice(0, 240),
                action: {
                    label: ts("retry"),
                    onClick: () => { handleAnalyze(); },
                },
            });
        }
    };

    const handleNormalizePreview = async () => {
        if (!script.trim()) {
            toast.warning(ts("scriptEmpty"), {
                projectId: currentProject?.id,
                projectTitle: currentProject?.title,
            });
            return;
        }
        if (!currentProject?.id) return;
        const projectId = currentProject.id;
        const projectTitle = currentProject.title;
        setIsNormalizing(true);
        const toastId = toast.progress(ts("normalizingScript"), {
            projectId,
            projectTitle,
            body: ts("normalizingScriptBody"),
        });
        try {
            const preview = await api.normalizeScriptPreview(projectId, script);
            setNormalizePreview(preview);
            toast.update(toastId, {
                kind: "success",
                title: ts("normalizePreviewReady"),
                body: ts("normalizePreviewReadyBody", {
                    f: preview.counts.frames,
                    c: preview.counts.characters,
                    s: preview.counts.scenes,
                    p: preview.counts.props,
                }),
                autoCloseMs: 5000,
            });
        } catch (error: any) {
            console.error("Failed to normalize script:", error);
            toast.update(toastId, {
                kind: "error",
                title: ts("normalizeFailed"),
                body: String(error?.response?.data?.detail || error?.message || "未知错误").slice(0, 240),
                action: {
                    label: ts("retry"),
                    onClick: () => { handleNormalizePreview(); },
                },
            });
        } finally {
            setIsNormalizing(false);
        }
    };

    const handleNormalizeConfirm = async (normalizedText: string) => {
        if (!currentProject?.id) return;
        const projectId = currentProject.id;
        const projectTitle = currentProject.title;
        setIsNormalizing(true);
        const toastId = toast.progress(ts("normalizeApplying"), {
            projectId,
            projectTitle,
            body: ts("normalizeApplyingBody"),
        });
        try {
            const project = await api.normalizeAndExtractScript(projectId, script, normalizedText);
            const refreshed = await api.getProject(project.id).catch(() => project);
            updateProject(projectId, refreshed);
            setScript(refreshed.originalText ?? refreshed.original_text ?? normalizedText);
            setNormalizePreview(null);
            toast.update(toastId, {
                kind: "success",
                title: ts("normalizeDone"),
                body: ts("normalizeDoneBody", {
                    f: refreshed.frames?.length ?? 0,
                    c: refreshed.characters?.length ?? 0,
                    s: refreshed.scenes?.length ?? 0,
                    p: refreshed.props?.length ?? 0,
                }),
                autoCloseMs: 6000,
            });
            if (refreshed.series_id) {
                document.dispatchEvent(new CustomEvent("lumenx:openReconcile"));
            }
        } catch (error: any) {
            console.error("Failed to apply normalized script:", error);
            toast.update(toastId, {
                kind: "error",
                title: ts("normalizeFailed"),
                body: String(error?.response?.data?.detail || error?.message || "未知错误").slice(0, 240),
                action: {
                    label: ts("retry"),
                    onClick: () => { handleNormalizeConfirm(normalizedText); },
                },
            });
        } finally {
            setIsNormalizing(false);
        }
    };

    const handleDeleteNode = async (node: ScriptNode, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentProject) return;
        if (!confirm(ts("confirmDelete", { name: node.name }))) return;

        try {
            if (node.type === "character" && node.id) {
                await crudApi.deleteCharacter(currentProject.id, node.id);
            } else if (node.type === "scene" && node.id) {
                await crudApi.deleteScene(currentProject.id, node.id);
            } else if (node.type === "prop" && node.id) {
                await crudApi.deleteProp(currentProject.id, node.id);
            }

            const updatedProject = await api.getProject(currentProject.id);
            updateProject(currentProject.id, updatedProject);
        } catch (error) {
            console.error("Failed to delete node:", error);
            toast.error(ts("deleteFailed"), {
                projectId: currentProject?.id,
                projectTitle: currentProject?.title,
            });
        }
    };

    const handleCreateNode = async (data: any) => {
        if (!currentProject) return;
        try {
            if (data.type === "character") {
                await crudApi.createCharacter(currentProject.id, data);
            } else if (data.type === "scene") {
                await crudApi.createScene(currentProject.id, data);
            } else if (data.type === "prop") {
                await crudApi.createProp(currentProject.id, data);
            }

            const updatedProject = await api.getProject(currentProject.id);
            updateProject(currentProject.id, updatedProject);
            setIsCreateDialogOpen(false);
        } catch (error) {
            console.error("Failed to create node:", error);
            toast.error(ts("createFailed"), {
                projectId: currentProject?.id,
                projectTitle: currentProject?.title,
            });
        }
    };

    const handleNodeUpdate = (updatedNode: ScriptNode) => {
        // Update local state
        setNodes(prev => prev.map(n => n.name === updatedNode.name ? updatedNode : n));
        setSelectedNode(updatedNode);
    };

    const tStep = useTranslations("stepHeader");

    return (
        // R2V v2 Phase 3: Script step = main editor (left) + Previously on... (right).
        // Entity extraction still runs via the trailing "提取实体" button —
        // parsed entities flow to series pools and surface in Cast step.
        <div className="flex h-full w-full overflow-hidden">
            {/* Left: main script editor */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <StepHeader
                    stepNumber={1}
                    icon={<ScrollText />}
                    englishName="Script"
                    title={tStep("scriptTitle")}
                    subtitle={tStep("scriptSubtitle")}
                    trailing={(
                        <div className="flex items-center gap-2">
                            <WorkflowActionButton
                                variant="secondary"
                                loading={isNormalizing}
                                leftIcon={<Sparkles />}
                                onClick={handleNormalizePreview}
                                disabled={!script || isAnalyzing}
                            >
                                {isNormalizing ? ts("normalizingScript") : ts("normalizeAndExtract")}
                            </WorkflowActionButton>
                            <WorkflowActionButton
                                variant="primary"
                                loading={isAnalyzing}
                                leftIcon={<Wand2 />}
                                onClick={handleAnalyze}
                                disabled={!script || isNormalizing}
                            >
                                {isAnalyzing ? ts("analyzingScript") : ts("extractEntities")}
                            </WorkflowActionButton>
                        </div>
                    )}
                />
                <div className="flex-1 relative p-6 bg-surface overflow-hidden">
                    <textarea
                        value={script}
                        onChange={(e) => {
                            const newText = e.target.value;
                            setScript(newText);
                            // Update local Zustand state with BOTH the
                            // camelCase view-model key and the snake_case
                            // backend key, so any consumer that reads
                            // either name (or anything spread from a
                            // future API response) sees the same value.
                            if (currentProject) {
                                updateProject(currentProject.id, {
                                    originalText: newText,
                                    original_text: newText,
                                } as any);
                            }
                        }}
                        onBlur={async () => {
                            // Persist the in-progress text to the backend on
                            // blur so reloads / navigation don't lose work.
                            // Goes through /update_text instead of /reparse
                            // so we don't trigger a heavy LLM call just for
                            // typing — that's reserved for the explicit
                            // "提取实体" CTA.
                            if (!currentProject) return;
                            const stored = ((currentProject as any).original_text ?? currentProject.originalText) || "";
                            if (stored === script) return;
                            try {
                                await api.updateScriptText(currentProject.id, script);
                            } catch (err) {
                                console.warn("Failed to persist script text:", err);
                            }
                        }}
                        placeholder={ts("scriptPlaceholder")}
                        className="w-full h-full bg-transparent text-text-secondary font-mono text-base leading-relaxed resize-none focus:outline-none"
                        spellCheck={false}
                    />
                </div>
            </div>

            {/* Right: Previously on... rail (R2V v2 Phase 3).
                Only renders for series-affiliated projects with an
                episode index > 0; the component handles empty/first
                episode state internally with a placeholder. */}
            <div className="w-[340px] shrink-0">
                <PreviousEpisodeSummary scriptId={currentProject?.id ?? null} />
            </div>

            {/* R2V v2 Phase 4 — Reconcile modal (auto-opens after analyze
                for series-affiliated episodes; ignored for standalone). */}
            <ReconcileModal
                isOpen={reconcileOpen}
                scriptId={currentProject?.id ?? null}
                onClose={() => setReconcileOpen(false)}
            />
            <NormalizeScriptModal
                isOpen={!!normalizePreview}
                originalText={script}
                preview={normalizePreview}
                applying={isNormalizing}
                onClose={() => setNormalizePreview(null)}
                onConfirm={handleNormalizeConfirm}
            />

        </div>
    );
}

function NormalizeScriptModal({
    isOpen,
    originalText,
    preview,
    applying,
    onClose,
    onConfirm,
}: {
    isOpen: boolean;
    originalText: string;
    preview: NormalizePreview | null;
    applying: boolean;
    onClose: () => void;
    onConfirm: (normalizedText: string) => void;
}) {
    const ts = useTranslations("script");
    if (!isOpen || !preview) return null;
    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm"
                onClick={onClose}
            >
                <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.96, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="flex max-h-[86vh] w-[min(1180px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl border border-glass-border bg-elevated shadow-[0_24px_64px_-12px_rgba(0,0,0,0.75)]"
                    onClick={(event) => event.stopPropagation()}
                >
                    <header className="flex items-center gap-3 border-b border-glass-border px-6 py-5">
                        <div className="grid h-9 w-9 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                            <Sparkles size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 className="font-display text-display font-medium text-foreground">{ts("normalizePreviewTitle")}</h2>
                            <p className="mt-0.5 text-xs text-text-secondary">{ts("normalizePreviewSubtitle")}</p>
                        </div>
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-hover-bg hover:text-foreground"
                        >
                            <X size={16} />
                        </button>
                    </header>

                    <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-6 lg:grid-cols-2">
                        <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-xl border border-glass-border bg-black/20">
                            <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
                                <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-text-secondary">{ts("normalizeOriginal")}</h3>
                                <span className="font-mono text-[10px] text-text-muted">{originalText.length}</span>
                            </div>
                            <textarea
                                value={originalText}
                                readOnly
                                className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-text-muted outline-none custom-scrollbar"
                            />
                        </section>
                        <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-xl border border-primary/30 bg-primary/[0.035]">
                            <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3">
                                <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-primary">{ts("normalizeStructured")}</h3>
                                <span className="font-mono text-[10px] text-text-muted">
                                    {ts("normalizeCounts", {
                                        f: preview.counts.frames,
                                        c: preview.counts.characters,
                                        s: preview.counts.scenes,
                                        p: preview.counts.props,
                                    })}
                                </span>
                            </div>
                            <textarea
                                value={preview.normalized_text}
                                readOnly
                                className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-text-secondary outline-none custom-scrollbar"
                            />
                        </section>
                    </div>

                    <footer className="flex items-center gap-3 border-t border-glass-border px-6 py-4">
                        <p className="min-w-0 flex-1 text-xs text-text-muted">{ts("normalizeOverwriteHint")}</p>
                        <WorkflowActionButton variant="ghost" size="sm" onClick={onClose} disabled={applying}>
                            {ts("extractDiscard")}
                        </WorkflowActionButton>
                        <WorkflowActionButton
                            variant="primary"
                            size="sm"
                            loading={applying}
                            rightIcon={<ChevronRight />}
                            onClick={() => onConfirm(preview.normalized_text)}
                        >
                            {ts("normalizeApply")}
                        </WorkflowActionButton>
                    </footer>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}

function CreateEntityDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (data: any) => void }) {
    const ts = useTranslations("script");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [desc, setDesc] = useState("");
    const [type, setType] = useState<"character" | "scene" | "prop">("character");

    const handleSubmit = () => {
        if (!name.trim()) {
            toast.warning(ts("nameRequired"));
            return;
        }
        onCreate({ name, description: desc, type });
    };

    return (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm" onClick={onClose}>
            <div className="w-[400px] bg-elevated border border-glass-border rounded-xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
                <h3 className="font-bold text-foreground">{ts("addEntity")}</h3>

                <div className="flex gap-2 p-1 bg-surface rounded-lg">
                    {(["character", "scene", "prop"] as const).map(t => (
                        <button
                            key={t}
                            onClick={() => setType(t)}
                            className={`flex-1 py-1.5 text-xs font-bold rounded capitalize ${type === t ? "bg-primary text-foreground" : "text-text-muted hover:text-foreground"}`}
                        >
                            {t}
                        </button>
                    ))}
                </div>

                <div>
                    <label className="text-xs text-text-muted">{ts("nameLabel")}</label>
                    <input
                        className="glass-input w-full"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder={ts("entityNamePlaceholder")}
                    />
                </div>

                <div>
                    <label className="text-xs text-text-muted">{ts("descriptionLabel")}</label>
                    <textarea
                        className="glass-input w-full h-24 resize-none"
                        value={desc}
                        onChange={e => setDesc(e.target.value)}
                        placeholder={ts("visualDescPlaceholder")}
                    />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                    <button onClick={onClose} className="px-4 py-2 text-xs text-text-secondary hover:text-foreground">{tc("cancel")}</button>
                    <button onClick={handleSubmit} className="px-4 py-2 bg-primary text-foreground rounded text-xs font-bold">{tc("create")}</button>
                </div>
            </div>
        </div>
    );
}
