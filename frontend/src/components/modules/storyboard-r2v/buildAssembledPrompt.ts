import type { ShotNode } from "./ShotCard";

/**
 * Real-time compute the final assembled prompt from the user's textarea
 * (visual narrative) + structured fields (camera language metadata).
 *
 * Rules (grill-me 2026-05-28, corrected):
 * - duration → NOT in prompt (唯一的特殊字段，走 API `duration` 参数)
 * - shot_size + camera_angle → appended to prompt tail
 * - camera_movement → appended to prompt tail (自然语言描述，含速度)
 * - transition_hint → appended to prompt tail (可选，多分镜视频内转场)
 *
 * Final = textarea visual narrative + 运镜 + 景别/机位 + 转场
 */
export function buildAssembledPrompt(shot: ShotNode): string {
    let base = (shot.prompt || "").trim();

    // Strip existing reference tags from the display — they're handled
    // separately as reference_image URLs in the API call
    base = base.replace(/\[character\d+:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();

    const suffixes: string[] = [];

    // Camera movement (natural language, speed naturally embedded)
    if (shot.cameraMovementStructured) {
        const desc = shot.cameraMovementStructured.description || shot.cameraMovementStructured.primary;
        if (desc) suffixes.push(desc);
    }

    // Shot size + camera angle (grouped)
    const framingParts: string[] = [];
    if (shot.shotSize) framingParts.push(shot.shotSize);
    if (shot.cameraAngle) framingParts.push(shot.cameraAngle);
    if (framingParts.length > 0) {
        suffixes.push(framingParts.join("，"));
    }

    // Transition hint (optional, for multi-shot internal transitions)
    if (shot.transitionHint) {
        suffixes.push(shot.transitionHint);
    }

    if (suffixes.length === 0) return base;

    const separator = base.endsWith("。") || base.endsWith(".") || base.endsWith("，") || base.endsWith(",")
        ? ""
        : "，";
    return base + separator + suffixes.join("，");
}

export function buildReferenceTags(
    shot: ShotNode,
    characters: any[] = [],
    scenes: any[] = [],
    props: any[] = [],
    initialSeen: Set<string> = new Set(),
    startSlot = 1,
): string {
    const tags: string[] = [];
    const seen = new Set(initialSeen);
    let slot = Math.max(1, startSlot);

    const pushByName = (name?: string | null) => {
        if (!name || seen.has(name)) return;
        tags.push(`[character${slot}:${name}]`);
        seen.add(name);
        slot += 1;
    };

    (shot.characterIds ?? []).forEach((id) => {
        const character = characters.find((c: any) => c.id === id);
        pushByName(character?.name);
    });

    if (shot.sceneId) {
        const scene = scenes.find((s: any) => s.id === shot.sceneId);
        pushByName(scene?.name);
    }

    (shot.propIds ?? []).forEach((id) => {
        const prop = props.find((p: any) => p.id === id);
        pushByName(prop?.name);
    });

    return tags.join(" ");
}

export function buildPromptWithReferenceTags(
    shot: ShotNode,
    characters: any[] = [],
    scenes: any[] = [],
    props: any[] = [],
): string {
    const prompt = buildAssembledPrompt(shot);
    const existingMatches = Array.from((shot.prompt || "").matchAll(/\[character(\d*):([^\]]+)\]/g));
    const existingNames = new Set(existingMatches.map((match) => match[2]));
    const maxExistingSlot = existingMatches.reduce((max, match) => {
        const slot = parseInt(match[1], 10);
        return Number.isFinite(slot) ? Math.max(max, slot) : max;
    }, 0);
    const existingTags = existingMatches.map((match) => match[0]).join(" ");
    const generatedTags = buildReferenceTags(shot, characters, scenes, props, existingNames, maxExistingSlot + 1);
    const tags = [existingTags, generatedTags].filter(Boolean).join(" ").trim();
    return [tags, prompt].filter(Boolean).join(" ").trim();
}

export function normalizeReferenceTokensForEditor(text: string, taggedPrompt: string): string {
    const slotNames = new Map<number, string>();
    const tagPattern = /\[character(\d+):([^\]]+)\]/g;
    let match;
    while ((match = tagPattern.exec(taggedPrompt)) !== null) {
        const slot = parseInt(match[1], 10);
        if (Number.isFinite(slot)) {
            slotNames.set(slot, match[2]);
        }
    }

    let next = text || "";
    slotNames.forEach((name, slot) => {
        next = next.replace(new RegExp(`\\bcharacter${slot}\\b`, "gi"), name);
    });
    return next
        .replace(/\[character\d+:[^\]]+\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
