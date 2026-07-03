/**
 * ShotNode pure helpers — append/select T2I image history, derive
 * the active T2I image url, and migrate legacy shot drafts (where
 * the new t2iImageUrls / t2iSelectedIndex / videoTaskIdsByTab fields
 * don't exist) into the v2 shape.
 *
 * Kept free of React / state so unit tests can exercise the migration
 * + history bookkeeping independently of the UI layer.
 */
import { T2I_HISTORY_LIMIT, type ShotNode, type WorkbenchTabMode } from "./ShotCard";

export function normalizeWorkbenchTabMode(value?: string | null): WorkbenchTabMode {
    if (value === "t2i_i2v" || value === "keyframe_r2v" || value === "asset_compose") {
        return value;
    }
    if (value === "direct_r2v") return "keyframe_r2v";
    return "asset_compose";
}

/** Bring a shot from disk (localStorage draft) into the v2 shape.
 *  Idempotent — calling on an already-v2 shot returns identity. */
export function migrateShotNode(shot: ShotNode): ShotNode {
    let next = shot;
    // t2iImageUrls: seed from legacy single-image field if needed.
    if (!Array.isArray(next.t2iImageUrls)) {
        const seed = typeof next.t2iImageUrl === "string" && next.t2iImageUrl
            ? [next.t2iImageUrl]
            : [];
        next = { ...next, t2iImageUrls: seed };
    }
    // t2iSelectedIndex: default to the last image if any, else 0.
    if (typeof next.t2iSelectedIndex !== "number" || next.t2iSelectedIndex < 0) {
        next = {
            ...next,
            t2iSelectedIndex: Math.max(0, (next.t2iImageUrls?.length ?? 1) - 1),
        };
    }
    if (next.t2iImageUrls && next.t2iImageUrls.length > 0) {
        const activeIndex = Math.max(
            0,
            Math.min(next.t2iSelectedIndex ?? 0, next.t2iImageUrls.length - 1),
        );
        if (next.t2iSelectedIndex !== activeIndex || next.t2iImageUrl !== next.t2iImageUrls[activeIndex]) {
            next = {
                ...next,
                t2iSelectedIndex: activeIndex,
                t2iImageUrl: next.t2iImageUrls[activeIndex],
            };
        }
    }
    // videoTaskIdsByTab: default empty buckets.
    if (!next.videoTaskIdsByTab) {
        // Backfill: legacy single videoTaskId belongs to the shot's
        // current tabMode so the candidates panel sees it instead of
        // pretending there's no history.
        const buckets: ShotNode["videoTaskIdsByTab"] = {};
        if (next.videoTaskId) {
            buckets[next.tabMode] = [next.videoTaskId];
        }
        next = { ...next, videoTaskIdsByTab: buckets };
    }
    if (!Array.isArray(next.characterIds) || !Array.isArray(next.propIds) || next.sceneId === undefined) {
        next = {
            ...next,
            sceneId: next.sceneId ?? null,
            characterIds: Array.isArray(next.characterIds) ? next.characterIds : [],
            propIds: Array.isArray(next.propIds) ? next.propIds : [],
        };
    }
    return next;
}

/** Append a new T2I image URL to the shot's history and make it
 *  the active selection. Caps at T2I_HISTORY_LIMIT (oldest dropped
 *  FIFO). De-dupes by URL: re-generating the same URL just bumps it
 *  to active without duplicating in history.
 *
 *  Also updates the legacy t2iImageUrl field so existing reads keep
 *  working until the rewrite removes them. */
export function appendT2IImage(shot: ShotNode, url: string): ShotNode {
    if (!url) return shot;
    const migrated = migrateShotNode(shot);
    const existing = migrated.t2iImageUrls ?? [];
    const dedupedIdx = existing.indexOf(url);
    let nextUrls: string[];
    let nextIndex: number;
    if (dedupedIdx >= 0) {
        nextUrls = existing;
        nextIndex = dedupedIdx;
    } else {
        const appended = [...existing, url];
        nextUrls = appended.length > T2I_HISTORY_LIMIT
            ? appended.slice(appended.length - T2I_HISTORY_LIMIT)
            : appended;
        nextIndex = nextUrls.length - 1;
    }
    return {
        ...migrated,
        t2iImageUrls: nextUrls,
        t2iSelectedIndex: nextIndex,
        t2iImageUrl: nextUrls[nextIndex],
    };
}

/** Set the active T2I image by index. Clamps to range; updates the
 *  legacy t2iImageUrl mirror so consumers that haven't migrated keep
 *  reading the right URL. No-op if the index is already active. */
export function setActiveT2IIndex(shot: ShotNode, index: number): ShotNode {
    const migrated = migrateShotNode(shot);
    const urls = migrated.t2iImageUrls ?? [];
    if (urls.length === 0) return migrated;
    const clamped = Math.max(0, Math.min(index, urls.length - 1));
    if (clamped === migrated.t2iSelectedIndex) return migrated;
    return {
        ...migrated,
        t2iSelectedIndex: clamped,
        t2iImageUrl: urls[clamped],
    };
}

/** Remove a T2I image at index. If the removed one was active, the
 *  active selection falls back to the nearest remaining image
 *  (prefer the one that took its slot, else the previous). Returns
 *  shot unchanged when index is out of range. */
export function removeT2IImage(shot: ShotNode, index: number): ShotNode {
    const migrated = migrateShotNode(shot);
    const urls = migrated.t2iImageUrls ?? [];
    if (index < 0 || index >= urls.length) return migrated;
    const nextUrls = [...urls.slice(0, index), ...urls.slice(index + 1)];
    let nextIndex = migrated.t2iSelectedIndex ?? 0;
    if (nextIndex === index) {
        // Removed the active one — bias toward the slot's new occupant
        // (the next image now sits at this index), else clamp back.
        nextIndex = Math.min(index, nextUrls.length - 1);
    } else if (nextIndex > index) {
        nextIndex -= 1;
    }
    if (nextUrls.length === 0) {
        // Empty history — surface back to "no T2I yet" so the legacy
        // empty-state UI still renders cleanly.
        return {
            ...migrated,
            t2iImageUrls: [],
            t2iSelectedIndex: 0,
            t2iImageUrl: undefined,
        };
    }
    return {
        ...migrated,
        t2iImageUrls: nextUrls,
        t2iSelectedIndex: Math.max(0, nextIndex),
        t2iImageUrl: nextUrls[Math.max(0, nextIndex)],
    };
}

/** Read the currently-active T2I image URL (or the legacy single
 *  field if the shot was never migrated). Convenience used by I2V
 *  to know "what's my first frame". */
export function getActiveT2IImageUrl(shot: ShotNode): string | undefined {
    if (shot.t2iImageUrls && shot.t2iImageUrls.length > 0) {
        const i = Math.max(0, Math.min(shot.t2iSelectedIndex ?? 0, shot.t2iImageUrls.length - 1));
        return shot.t2iImageUrls[i];
    }
    return shot.t2iImageUrl;
}

/** Append a freshly-created video task id to the per-tab bucket so
 *  the candidates panel can list it (cross-referenced against the
 *  script's video_tasks array). Idempotent on dup ids. */
export function appendVideoTaskId(
    shot: ShotNode,
    tabMode: WorkbenchTabMode,
    taskId: string,
): ShotNode {
    if (!taskId) return shot;
    const migrated = migrateShotNode(shot);
    const buckets = { ...(migrated.videoTaskIdsByTab ?? {}) };
    const existing = buckets[tabMode] ?? [];
    if (existing.includes(taskId)) return migrated;
    buckets[tabMode] = [...existing, taskId];
    return {
        ...migrated,
        videoTaskIdsByTab: buckets,
        // Mirror to legacy single-id field so existing renderers
        // (and the spinner-state hooks) keep reading the latest task.
        videoTaskId: taskId,
    };
}

/** Per-tab task id list, with legacy single-id fallback. */
export function videoTaskIdsForTab(
    shot: ShotNode,
    tabMode: WorkbenchTabMode,
): string[] {
    const direct = shot.videoTaskIdsByTab?.[tabMode]
        ?? (tabMode === "keyframe_r2v" ? shot.videoTaskIdsByTab?.direct_r2v : undefined);
    if (Array.isArray(direct)) return direct;
    // Legacy: only one task in shot.videoTaskId, assume it belonged
    // to the shot's current tabMode (which is the same tab as it was
    // generated under, since this snapshot is pre-multi-tab).
    if (shot.videoTaskId && shot.tabMode === tabMode) {
        return [shot.videoTaskId];
    }
    return [];
}
