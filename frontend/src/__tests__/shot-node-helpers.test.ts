import { describe, expect, it } from "vitest";

import { migrateShotNode } from "@/components/modules/storyboard-r2v/shotNodeHelpers";

describe("shotNodeHelpers", () => {
    it("mirrors the selected T2I history URL into the legacy active URL field", () => {
        const shot = migrateShotNode({
            id: "shot-1",
            prompt: "demo",
            tabMode: "t2i_i2v",
            sceneId: null,
            characterIds: [],
            propIds: [],
            t2iImageUrls: ["storyboard/a.png", "storyboard/b.png"],
            t2iSelectedIndex: 1,
        } as any);

        expect(shot.t2iSelectedIndex).toBe(1);
        expect(shot.t2iImageUrl).toBe("storyboard/b.png");
    });

    it("clamps a stale selected T2I index when restoring from persisted frame data", () => {
        const shot = migrateShotNode({
            id: "shot-1",
            prompt: "demo",
            tabMode: "t2i_i2v",
            sceneId: null,
            characterIds: [],
            propIds: [],
            t2iImageUrls: ["storyboard/a.png"],
            t2iSelectedIndex: 9,
        } as any);

        expect(shot.t2iSelectedIndex).toBe(0);
        expect(shot.t2iImageUrl).toBe("storyboard/a.png");
    });
});
