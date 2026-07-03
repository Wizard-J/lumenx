import { describe, expect, it } from "vitest";
import {
    buildAssembledPrompt,
    buildPromptWithReferenceTags,
    normalizeReferenceTokensForEditor,
    resolveAssetReferenceImage,
} from "@/components/modules/storyboard-r2v/buildAssembledPrompt";
import {
    mergeAssetPools,
    parseAssetReferenceTags,
    referenceUrlsForVideoModel,
} from "@/components/modules/storyboard-r2v/assetReferences";
import type { ShotNode } from "@/components/modules/storyboard-r2v/ShotCard";

describe("storyboard prompt reference tags", () => {
    const characters = [
        { id: "char-1", name: "林砚" },
        { id: "char-2", name: "暗变蜥蜴" },
    ];
    const scenes = [{ id: "scene-1", name: "棚户区-林砚棚屋门口" }];
    const props = [{ id: "prop-1", name: "骨片" }];

    it("keeps the editable assembled prompt clean", () => {
        const shot = {
            id: "shot-1",
            prompt: "[character1:林砚] [scene:棚户区] [prop:骨片] 林砚蹲在棚屋门口",
            tabMode: "keyframe_r2v",
            shotSize: "近景",
        } satisfies ShotNode;

        expect(buildAssembledPrompt(shot)).toBe("林砚蹲在棚屋门口，近景");
    });

    it("generates a scene reference tag when stored scene name has a leading dash", () => {
        const shot = {
            id: "shot-1",
            prompt: "晨雾中原始森林上空鸟瞰全景",
            tabMode: "keyframe_r2v",
            sceneId: "scene-dashed",
        } satisfies ShotNode;

        expect(buildPromptWithReferenceTags(
            shot,
            [],
            [{ id: "scene-dashed", name: "- 原始森林上空" }],
            [],
        )).toBe(
            "[character1:- 原始森林上空] 晨雾中原始森林上空鸟瞰全景",
        );
    });

    it("generates hidden reference tags from structured frame references", () => {
        const shot = {
            id: "shot-1",
            prompt: "林砚蹲在棚屋门口，用骨片刮鞋底裂口",
            tabMode: "keyframe_r2v",
            sceneId: "scene-1",
            characterIds: ["char-1", "char-2"],
            propIds: ["prop-1"],
        } satisfies ShotNode;

        // Scene "棚户区-林砚棚屋门口" is filtered because the prompt only
        // contains "棚屋门口" (partial match). Characters and props always
        // remain. No rename — HappyHorse handles sparse slot arrays.
        expect(buildPromptWithReferenceTags(shot, characters, scenes, props)).toBe(
            "[character1:林砚] [character2:暗变蜥蜴] [character4:骨片] 林砚蹲在棚屋门口，用骨片刮鞋底裂口",
        );
    });

    it("does not duplicate existing tags and continues slot numbering", () => {
        const shot = {
            id: "shot-1",
            prompt: "[character2:林砚] 林砚蹲在棚屋门口",
            tabMode: "keyframe_r2v",
            sceneId: "scene-1",
            characterIds: ["char-1"],
            propIds: ["prop-1"],
        } satisfies ShotNode;

        // Scene name doesn't appear in prompt → filtered.
        // Only the manually placed [character2:林砚] + auto prop remain.
        expect(buildPromptWithReferenceTags(shot, characters, scenes, props)).toBe(
            "[character2:林砚] [character4:骨片] 林砚蹲在棚屋门口",
        );
    });

    it("converts polished slot tokens back to readable asset names for the editor", () => {
        const taggedPrompt = "[character1:林砚] [character2:棚户区-林砚棚屋门口] [character3:骨片] 林砚蹲在棚屋门口";
        const polished = "character2的黄沙棚屋门口，character1蹲坐门边，右手用character3刮除鞋底磨损。";

        expect(normalizeReferenceTokensForEditor(polished, taggedPrompt)).toBe(
            "棚户区-林砚棚屋门口的黄沙棚屋门口，林砚蹲坐门边，右手用骨片刮除鞋底磨损。",
        );
    });

    it("resolves the frozen stage image before legacy base image fields", () => {
        const scene = {
            image_url: "assets/legacy-scene.png",
            stages: [{
                id: "stage-forest",
                selected_image_id: "stage-image",
                reference_images: [
                    { id: "stage-image", url: "assets/stages/forest.png" },
                ],
            }],
        };
        expect(resolveAssetReferenceImage(scene, "scene", "stage-forest")).toBe(
            "assets/stages/forest.png",
        );
    });

    it("uses the first stage reference image when no explicit stage is selected", () => {
        const scene = {
            image_url: "assets/legacy-scene.png",
            stages: [{
                id: "stage-forest",
                selected_image_id: "stage-image",
                reference_images: [
                    { id: "stage-image", url: "assets/stages/forest.png" },
                ],
            }],
        };
        expect(resolveAssetReferenceImage(scene, "scene")).toBe(
            "assets/stages/forest.png",
        );
    });

    it("falls back to an available stage image when the stored stage id is stale", () => {
        const scene = {
            image_asset: { selected_id: null, variants: [] },
            stages: [{
                id: "series-stage",
                selected_image_id: "stage-image",
                reference_images: [
                    { id: "stage-image", url: "assets/stages/crash-site.png" },
                ],
            }],
        };

        expect(resolveAssetReferenceImage(scene, "scene", "episode-stage")).toBe(
            "assets/stages/crash-site.png",
        );
    });

    it("resolves a scene tag through the merged series asset when the episode asset is empty", () => {
        const pools = {
            characters: [],
            scenes: mergeAssetPools(
                [{ id: "scene-1", name: "飞机残骸区", image_asset: { selected_id: null, variants: [] } }],
                [{
                    id: "scene-1",
                    name: "飞机残骸区",
                    stages: [{
                        id: "series-stage",
                        selected_image_id: "selected",
                        reference_images: [
                            { id: "older", url: "assets/stages/older.png" },
                            { id: "selected", url: "assets/stages/plane-crash.png" },
                        ],
                    }],
                }],
                "scene",
            ),
            props: [],
        };
        const shot = {
            id: "shot-1",
            prompt: "[scene:飞机残骸区] 晨雾中森林上空",
            tabMode: "keyframe_r2v",
            sceneStageRef: "stale-episode-stage",
        } satisfies ShotNode;

        const parsed = parseAssetReferenceTags(shot.prompt, pools, shot);
        expect(parsed.urls).toEqual(["assets/stages/plane-crash.png"]);
        expect(parsed.unresolved).toEqual([]);
        expect(parsed.items[0]).toMatchObject({
            name: "飞机残骸区",
            resolvedKind: "scene",
            url: "assets/stages/plane-crash.png",
        });
    });

    it("filters character sheets out of Agnes video references while keeping scene refs", () => {
        const pools = {
            characters: [{
                id: "char-1",
                name: "老赵",
                stages: [{
                    id: "char-stage",
                    selected_image_id: "char-image",
                    reference_images: [{ id: "char-image", url: "assets/stages/laozhao-sheet.png" }],
                }],
            }],
            scenes: [{
                id: "scene-1",
                name: "机舱内",
                stages: [{
                    id: "scene-stage",
                    selected_image_id: "scene-image",
                    reference_images: [{ id: "scene-image", url: "assets/stages/cabin.png" }],
                }],
            }],
            props: [],
        };
        const shot = {
            id: "shot-1",
            prompt: "[character1:老赵] [character2:机舱内] 老赵坐在机舱里",
            tabMode: "keyframe_r2v",
        } satisfies ShotNode;

        const parsed = parseAssetReferenceTags(shot.prompt, pools, shot);

        expect(parsed.urls).toEqual([
            "assets/stages/laozhao-sheet.png",
            "assets/stages/cabin.png",
        ]);
        expect(referenceUrlsForVideoModel(parsed, "agnes-video-v2.0")).toEqual([
            "assets/stages/cabin.png",
        ]);
        expect(referenceUrlsForVideoModel(parsed, "happyhorse-1.0-r2v")).toEqual(parsed.urls);
    });

    it("does not use legacy character full-body fields as Agnes video refs", () => {
        const pools = {
            characters: [{
                id: "char-1",
                name: "老赵",
                full_body_asset: {
                    selected_id: "fullbody",
                    variants: [{ id: "fullbody", url: "assets/characters/laozhao-fullbody.png" }],
                },
                stages: [{
                    id: "char-stage",
                    selected_image_id: "sheet",
                    reference_images: [{ id: "sheet", url: "assets/stages/laozhao-sheet.png" }],
                }],
            }],
            scenes: [{
                id: "scene-1",
                name: "机舱内",
                stages: [{
                    id: "scene-stage",
                    selected_image_id: "scene-image",
                    reference_images: [{ id: "scene-image", url: "assets/stages/cabin.png" }],
                }],
            }],
            props: [],
        };
        const shot = {
            id: "shot-1",
            prompt: "[character1:老赵] [character2:机舱内] 老赵坐在机舱里",
            tabMode: "keyframe_r2v",
        } satisfies ShotNode;

        const parsed = parseAssetReferenceTags(shot.prompt, pools, shot);

        expect(parsed.urls).toEqual([
            "assets/stages/laozhao-sheet.png",
            "assets/stages/cabin.png",
        ]);
        expect(referenceUrlsForVideoModel(parsed, "agnes-video-v2.0")).toEqual([
            "assets/stages/cabin.png",
        ]);
    });
});
