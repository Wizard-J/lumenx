import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, API_URL } from '@/lib/api';
import type { FrontendModelSettings } from '@/lib/modelCatalog';
export {
    I2I_MODELS,
    I2V_MODELS,
    IMAGE_MODELS,
    T2I_MODELS,
} from '@/lib/modelCatalog';
export type {
    DurationConfig,
    I2VModelConfig,
    ModelParamSupport,
    ModelOption,
} from '@/lib/modelCatalog';

export interface ImageVariant {
    id: string;
    url: string;
    created_at: number;
    prompt_used?: string;
}

export interface ImageAsset {
    selected_id: string | null;
    variants: ImageVariant[];
}

export interface VideoTask {
    id: string;
    project_id: string;
    asset_id?: string;
    frame_id?: string;
    image_url: string;
    prompt: string;
    status: string;
    video_url?: string;
    duration?: number;
    created_at: number;
    model?: string;
    generation_mode?: string;  // 'i2v' or 'r2v'
    reference_video_urls?: string[];  // Reference videos for R2V
}

export interface Character {
    id: string;
    name: string;
    description?: string;
    age?: string;
    gender?: string;
    clothing?: string;
    visual_weight?: number;

    // Legacy fields
    image_url?: string;
    avatar_url?: string;
    full_body_image_url?: string;
    three_view_image_url?: string;
    headshot_image_url?: string;

    // New Asset Containers
    full_body_asset?: ImageAsset;
    three_view_asset?: ImageAsset;
    headshot_asset?: ImageAsset;

    // Video Assets
    video_assets?: VideoTask[];
    video_prompt?: string;

    voice_id?: string;
    voice_name?: string;
    locked?: boolean;
    status?: string;
    is_consistent?: boolean;
    full_body_updated_at?: number;
    three_view_updated_at?: number;
    headshot_updated_at?: number;
    /** Backend-derived: where this asset actually lives.
     *  "episode" — in the script's own characters[] (episode-local
     *  override or standalone-project local)
     *  "series" — in the parent Series.characters[] (shared across
     *  all episodes in the series)
     *  Drives UI badges + the "high-cost action" confirm modal
     *  (A2 design decision). Not persisted; set fresh on every
     *  GET /projects/{id} response. */
    source?: "episode" | "series";
}

export interface Scene {
    id: string;
    name: string;
    description: string;
    image_url?: string;
    image_asset?: ImageAsset;
    video_assets?: VideoTask[];
    video_prompt?: string;
    status?: string;
    locked?: boolean;
    time_of_day?: string;
    lighting_mood?: string;
    source?: "episode" | "series";
}

export interface Prop {
    id: string;
    name: string;
    description: string;
    image_url?: string;
    image_asset?: ImageAsset;
    video_assets?: VideoTask[];
    video_prompt?: string;
    status?: string;
    locked?: boolean;
    source?: "episode" | "series";
}

export interface StoryboardFrame {
    id: string;
    scene_id: string;
    image_url?: string;
    image_asset?: ImageAsset;
    rendered_image_url?: string;
    rendered_image_asset?: ImageAsset;
    status?: string;
    locked?: boolean;
    // ... other fields
}

export interface StylePresetCategory {
    id: string;
    name: string;
    name_zh: string;
    sort_order: number;
}

export interface StylePreset {
    id: string;
    category: string;
    name: string;
    name_zh: string;
    subtitle_zh?: string;
    description?: string;
    best_for?: string[];
    avoid_for?: string[];
    positive_prompt: string;
    negative_prompt: string;
    sample_prompt?: string;
    thumbnail: string | null;
    object_position?: string;
}

export interface StyleConfig {
    id: string;
    name: string;
    description?: string;
    positive_prompt: string;
    negative_prompt: string;
    thumbnail_url?: string;
    is_custom: boolean;
    reason?: string; // For AI recommendations
}

export interface ArtDirection {
    selected_style_id: string;
    style_config: StyleConfig;
    custom_styles: StyleConfig[];
    ai_recommendations: StyleConfig[];
}

export type ModelSettings = FrontendModelSettings;

export const ASPECT_RATIOS = [
    { id: '9:16', name: '9:16', description: 'Portrait (576×1024)' },
    { id: '3:4', name: '3:4', description: 'Portrait mild (768×1024)' },
    { id: '1:1', name: '1:1', description: 'Square (1024×1024)' },
    { id: '4:3', name: '4:3', description: 'Landscape mild (1024×768)' },
    { id: '16:9', name: '16:9', description: 'Landscape (1024×576)' },
];

export interface VideoParams {
    resolution: string;
    duration: number;
    seed: number | undefined;
    generateAudio: boolean;
    audioUrl: string;
    promptExtend: boolean;
    negativePrompt: string;
    batchSize: number;
    cameraMovement: string;
    subjectMotion: string;
    model: string;
    shotType: string;
    generationMode: string;
    referenceVideoUrls: string[];
    // Kling
    mode: string;
    sound: boolean;
    cfgScale: number;
    // Vidu
    viduAudio: boolean;
    movementAmplitude: string;
}

/** 将动态列数映射为完整的 Tailwind class（避免 JIT 扫描不到动态拼接） */
export const GRID_COLS_CLASS: Record<number, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    5: 'grid-cols-5',
};

export interface PromptConfig {
    storyboard_polish: string;
    video_polish: string;
    r2v_polish: string;
}

export interface Series {
    id: string;
    title: string;
    description: string;
    characters: Character[];
    scenes: Scene[];
    props: Prop[];
    art_direction?: ArtDirection;
    prompt_config?: PromptConfig;
    model_settings?: ModelSettings;
    workflow_mode?: "r2v" | "i2v_legacy";
    /** PR-3e — Visual control preference. 'r2v' = 节奏优先 (new shots default
     *  direct_r2v); 'i2v' = 画面优先 (new shots default t2i_i2v). */
    default_generation_mode?: "r2v" | "i2v";
    episode_ids: string[];
    created_at: number;
    updated_at: number;
}

export interface Project {
    id: string;
    title: string;
    originalText: string;
    characters: Character[];
    scenes: Scene[];
    props: Prop[];
    frames: any[]; // Keeping as any for now to avoid breaking too much, but ideally StoryboardFrame[]
    video_tasks?: any[];
    status: string;
    createdAt: string;
    updatedAt: string;
    aspectRatio?: string;
    style_preset?: string;
    art_direction?: ArtDirection;
    model_settings?: ModelSettings;
    prompt_config?: PromptConfig;
    workflow_mode?: "i2v_legacy" | "r2v";
    /** PR-3e — Inherited from series; used by StoryboardR2V addShot to
     *  pick default tabMode for new shots. */
    default_generation_mode?: "r2v" | "i2v";
    merged_video_url?: string;
    /** PR-3k · Assembly Mix phase fields */
    bgm_url?: string | null;
    mix_settings?: Record<string, number>;
    series_id?: string;
    episode_number?: number;
}

interface ProjectStore {
    projects: Project[];
    currentProject: Project | null;
    isLoading: boolean;
    isAnalyzing: boolean;
    isAnalyzingArtStyle: boolean;

    // Entity extraction confirmation (persists across step switches)
    pendingExtraction: { characters: any[]; scenes: any[]; props: any[] } | null;
    pendingExtractionScript: string | null;
    confirmExtraction: () => Promise<void>;
    discardExtraction: () => void;

    // Global Selection State
    selectedFrameId: string | null;

    // Actions
    setProjects: (projects: Project[]) => void;  // For syncing from backend
    createProject: (title: string, text: string, skipAnalysis?: boolean, workflowMode?: string) => Promise<void>;
    analyzeProject: (script: string) => Promise<void>;
    analyzeArtStyle: (scriptId: string, text: string) => Promise<void>;
    loadProjects: () => void;
    selectProject: (id: string) => Promise<void>;
    updateProject: (id: string, data: Partial<Project>) => void;
    deleteProject: (id: string) => Promise<void>;
    clearCurrentProject: () => void;



    // Selection Actions
    // Selection Actions
    setSelectedFrameId: (id: string | null) => void;

    // Asset Generation State
    generatingTasks: { assetId: string; generationType: string; batchSize: number }[];
    addGeneratingTask: (assetId: string, generationType: string, batchSize: number) => void;
    removeGeneratingTask: (assetId: string, generationType: string) => void;

    // Storyboard Frame Rendering State
    renderingFrames: Set<string>;  // Set of frame IDs currently being rendered
    addRenderingFrame: (frameId: string) => void;
    removeRenderingFrame: (frameId: string) => void;

    // Storyboard Analysis State (persists across tab switches)
    isAnalyzingStoryboard: boolean;
    setIsAnalyzingStoryboard: (value: boolean) => void;

    // Global async operation tracker — persists across step/tab switches
    runningOps: Record<string, boolean>;
    setRunningOp: (key: string, running: boolean) => void;

    // Series State
    seriesList: Series[];
    currentSeries: Series | null;
    fetchSeriesList: () => Promise<void>;
    fetchSeries: (id: string) => Promise<void>;
    createSeries: (title: string, description?: string, workflowMode?: string) => Promise<Series>;
    deleteSeries: (id: string) => Promise<void>;
    setCurrentSeries: (series: Series | null) => void;
}

export const useProjectStore = create<ProjectStore>()(
    persist(
        (set, get) => ({
            projects: [],
            currentProject: null,
            isLoading: false,
            isAnalyzing: false,
            selectedFrameId: null,

            // Entity extraction confirmation
            pendingExtraction: null,
            pendingExtractionScript: null,
            confirmExtraction: async () => {
                const { currentProject, pendingExtractionScript } = get();
                if (!currentProject?.id || !pendingExtractionScript) return;
                set({ isAnalyzing: true });
                try {
                    const project = await api.reparseProject(currentProject.id, pendingExtractionScript);
                    set((state) => ({
                        projects: state.projects.map((p) =>
                            p.id === project.id ? { ...project, updatedAt: new Date().toISOString() } : p
                        ),
                        currentProject: { ...project, updatedAt: new Date().toISOString() },
                        pendingExtraction: null,
                        pendingExtractionScript: null,
                        isAnalyzing: false,
                    }));
                } catch (error) {
                    console.error("Failed to apply extraction:", error);
                    set({ isAnalyzing: false });
                    throw error;
                }
            },
            discardExtraction: () => {
                set({ pendingExtraction: null, pendingExtractionScript: null });
            },

            // Sync projects from backend
            setProjects: (projects: Project[]) => set({ projects }),

            createProject: async (title: string, text: string, skipAnalysis: boolean = false, workflowMode: string = "r2v") => {
                set({ isLoading: true });
                try {
                    const project = await api.createProject(title, text, skipAnalysis, workflowMode);
                    set((state) => ({
                        projects: [...state.projects, project],
                        currentProject: project,
                        isLoading: false,
                    }));
                } catch (error) {
                    console.error('Failed to create project:', error);
                    set({ isLoading: false });
                    throw error;
                }
            },

            analyzeProject: async (script: string) => {
                const { currentProject, updateProject, createProject } = get();
                set({ isAnalyzing: true });

                try {
                    let project: Project;
                    if (currentProject && currentProject.id) {
                        project = await api.reparseProject(currentProject.id, script);
                        // Update the store with the new/updated project
                        set((state) => ({
                            projects: state.projects.map((p) =>
                                p.id === project.id ? { ...project, updatedAt: new Date().toISOString() } : p
                            ),
                            currentProject: { ...project, updatedAt: new Date().toISOString() }
                        }));
                    } else {
                        // If no current project, create one (assuming title is available or default)
                        // This case might be rare if we always create project first, but handling it just in case
                        await createProject(currentProject?.title || "New Project", script);
                    }
                } catch (error) {
                    console.error("Failed to analyze script:", error);
                    throw error;
                } finally {
                    set({ isAnalyzing: false });
                }
            },

            loadProjects: () => {
                // Projects are already loaded from localStorage via persist middleware
                // This is mainly for future API sync if needed
            },

            selectProject: async (id: string) => {
                // First, try to set from local cache for immediate feedback
                const cachedProject = get().projects.find((p) => p.id === id);
                if (cachedProject) {
                    set({ currentProject: cachedProject });
                }

                // Then fetch latest data from backend
                try {
                    const response = await fetch(`${API_URL}/projects/${id}`);
                    if (response.ok) {
                        const rawData = await response.json();
                        // Transform data to match frontend model (snake_case -> camelCase for specific fields)
                        const latestProject = {
                            ...rawData,
                            originalText: rawData.original_text
                        };

                        // Update both currentProject and projects array with latest data
                        set((state) => ({
                            currentProject: latestProject,
                            projects: state.projects.map((p) =>
                                p.id === id ? latestProject : p
                            ),
                        }));

                        // Auto-load parent series for style inheritance (always fetch fresh for up-to-date art_direction)
                        const seriesId = latestProject.series_id;
                        if (seriesId) {
                            const cached = get().seriesList.find((s) => s.id === seriesId);
                            if (cached) {
                                set({ currentSeries: cached });
                            }
                            get().fetchSeries(seriesId);
                        } else {
                            set({ currentSeries: null });
                        }
                    }
                } catch (error) {
                    console.error('Failed to fetch latest project data:', error);
                    // Keep using cached version if fetch fails
                }
            },

            updateProject: (id: string, data: Partial<Project>) => {
                set((state) => ({
                    projects: state.projects.map((p) =>
                        p.id === id ? { ...p, ...data, updatedAt: new Date().toISOString() } : p
                    ),
                    currentProject:
                        state.currentProject?.id === id
                            ? { ...state.currentProject, ...data, updatedAt: new Date().toISOString() }
                            : state.currentProject,
                }));
            },

            deleteProject: async (id: string) => {
                try {
                    // Delete from backend first
                    await api.deleteProject(id);
                    // Then remove from local state
                    set((state) => ({
                        projects: state.projects.filter((p) => p.id !== id),
                        currentProject: state.currentProject?.id === id ? null : state.currentProject
                    }));
                } catch (error) {
                    console.error('Failed to delete project from backend:', error);
                    // Still remove from local state for UX, but warn user
                    set((state) => ({
                        projects: state.projects.filter((p) => p.id !== id),
                        currentProject: state.currentProject?.id === id ? null : state.currentProject
                    }));
                }
            },

            isAnalyzingArtStyle: false,

            analyzeArtStyle: async (scriptId: string, text: string) => {
                set({ isAnalyzingArtStyle: true });
                try {
                    const data = await api.analyzeScriptForStyles(scriptId, text);

                    // Update the project with new recommendations
                    // We need to fetch the latest project state to ensure we don't overwrite other changes
                    // But for now, let's assume we just want to update the recommendations

                    // Actually, analyzeScriptForStyles just returns recommendations, it doesn't save them to the project yet
                    // The user needs to select one.
                    // BUT, to persist them, we should probably save them to the project immediately if possible?
                    // Or just return them?
                    // The issue is: if we navigate away, we lose the return value.
                    // So we MUST save them to the project or store them in the store.

                    // Let's store them in the current project in the store
                    const current = get().currentProject;
                    if (current) {
                        const updatedArtDirection = {
                            ...current.art_direction,
                            ai_recommendations: data.recommendations
                        } as ArtDirection;

                        // Update local state
                        set((state) => ({
                            currentProject: state.currentProject ? {
                                ...state.currentProject,
                                art_direction: updatedArtDirection
                            } : null
                        }));

                        // Also try to save to backend if we have an active art direction
                        // If not, we just keep it in memory until user saves
                    }

                } catch (error) {
                    console.error("Failed to analyze art style:", error);
                    throw error;
                } finally {
                    set({ isAnalyzingArtStyle: false });
                }
            },

            clearCurrentProject: () => {
                set({ currentProject: null });
            },



            setSelectedFrameId: (id) => set({ selectedFrameId: id }),

            // Asset Generation State
            generatingTasks: [],
            addGeneratingTask: (assetId: string, generationType: string, batchSize: number) => set((state) => ({
                generatingTasks: [...state.generatingTasks, { assetId, generationType, batchSize }]
            })),
            removeGeneratingTask: (assetId: string, generationType: string) => set((state) => ({
                generatingTasks: state.generatingTasks.filter((t) => !(t.assetId === assetId && t.generationType === generationType))
            })),

            // Storyboard Frame Rendering State
            renderingFrames: new Set<string>(),
            addRenderingFrame: (frameId: string) => set((state) => {
                const newSet = new Set(state.renderingFrames);
                newSet.add(frameId);
                return { renderingFrames: newSet };
            }),
            removeRenderingFrame: (frameId: string) => set((state) => {
                const newSet = new Set(state.renderingFrames);
                newSet.delete(frameId);
                return { renderingFrames: newSet };
            }),

            // Storyboard Analysis State
            isAnalyzingStoryboard: false,
            setIsAnalyzingStoryboard: (value: boolean) => set({ isAnalyzingStoryboard: value }),

            // Global async operation tracker
            runningOps: {},
            setRunningOp: (key: string, running: boolean) => set((state) => {
                const next = { ...state.runningOps };
                if (running) next[key] = true;
                else delete next[key];
                return { runningOps: next };
            }),

            // Series State
            seriesList: [],
            currentSeries: null,

            fetchSeriesList: async () => {
                try {
                    const seriesList = await api.listSeries();
                    set({ seriesList });
                } catch (error) {
                    console.error('Failed to fetch series list:', error);
                }
            },

            fetchSeries: async (id: string) => {
                try {
                    const series = await api.getSeries(id);
                    set((state) => ({
                        currentSeries: series,
                        seriesList: state.seriesList.some((s) => s.id === id)
                            ? state.seriesList.map((s) => s.id === id ? series : s)
                            : state.seriesList,
                    }));
                } catch (error) {
                    console.error('Failed to fetch series:', error);
                }
            },

            createSeries: async (title: string, description?: string, workflowMode?: string) => {
                try {
                    const series = await api.createSeries(title, description, workflowMode);
                    set((state) => ({
                        seriesList: [...state.seriesList, series],
                    }));
                    return series;
                } catch (error) {
                    console.error('Failed to create series:', error);
                    throw error;
                }
            },

            deleteSeries: async (id: string) => {
                try {
                    await api.deleteSeries(id);
                    set((state) => ({
                        seriesList: state.seriesList.filter((s) => s.id !== id),
                        currentSeries: state.currentSeries?.id === id ? null : state.currentSeries,
                    }));
                } catch (error) {
                    console.error('Failed to delete series:', error);
                    throw error;
                }
            },

            setCurrentSeries: (series: Series | null) => set((state) => ({
                currentSeries: series,
                seriesList: series
                    ? state.seriesList.map((s) => s.id === series.id ? series : s)
                    : state.seriesList,
            })),
        }),
        {
            name: 'project-storage',
            partialize: (state) => ({
                projects: state.projects,

                generatingTasks: state.generatingTasks // Now persisting this to maintain state across refreshes
            }),
        }
    )
);
