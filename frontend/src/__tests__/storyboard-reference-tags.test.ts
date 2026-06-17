import { describe, expect, it } from "vitest";
import {
    buildAssembledPrompt,
    buildPromptWithReferenceTags,
    normalizeReferenceTokensForEditor,
} from "@/components/modules/storyboard-r2v/buildAssembledPrompt";
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
            prompt: "[character1:林砚] 林砚蹲在棚屋门口",
            tabMode: "direct_r2v",
            shotSize: "近景",
        } satisfies ShotNode;

        expect(buildAssembledPrompt(shot)).toBe("林砚蹲在棚屋门口，近景");
    });

    it("generates hidden reference tags from structured frame references", () => {
        const shot = {
            id: "shot-1",
            prompt: "林砚蹲在棚屋门口，用骨片刮鞋底裂口",
            tabMode: "direct_r2v",
            sceneId: "scene-1",
            characterIds: ["char-1", "char-2"],
            propIds: ["prop-1"],
        } satisfies ShotNode;

        expect(buildPromptWithReferenceTags(shot, characters, scenes, props)).toBe(
            "[character1:林砚] [character2:暗变蜥蜴] [character3:棚户区-林砚棚屋门口] [character4:骨片] 林砚蹲在棚屋门口，用骨片刮鞋底裂口",
        );
    });

    it("does not duplicate existing tags and continues slot numbering", () => {
        const shot = {
            id: "shot-1",
            prompt: "[character2:林砚] 林砚蹲在棚屋门口",
            tabMode: "direct_r2v",
            sceneId: "scene-1",
            characterIds: ["char-1"],
            propIds: ["prop-1"],
        } satisfies ShotNode;

        expect(buildPromptWithReferenceTags(shot, characters, scenes, props)).toBe(
            "[character2:林砚] [character3:棚户区-林砚棚屋门口] [character4:骨片] 林砚蹲在棚屋门口",
        );
    });

    it("converts polished slot tokens back to readable asset names for the editor", () => {
        const taggedPrompt = "[character1:林砚] [character2:棚户区-林砚棚屋门口] [character3:骨片] 林砚蹲在棚屋门口";
        const polished = "character2的黄沙棚屋门口，character1蹲坐门边，右手用character3刮除鞋底磨损。";

        expect(normalizeReferenceTokensForEditor(polished, taggedPrompt)).toBe(
            "棚户区-林砚棚屋门口的黄沙棚屋门口，林砚蹲坐门边，右手用骨片刮除鞋底磨损。",
        );
    });
});
