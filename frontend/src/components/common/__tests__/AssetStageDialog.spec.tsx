import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AssetStageDialog from "../AssetStageDialog";
import type { Character } from "@/store/projectStore";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  API_URL: "http://localhost:17177",
  api: {
    uploadFile: vi.fn(),
  },
}));

describe("AssetStageDialog", () => {
  it("lets a stage adopt an existing base candidate and exposes the effective prompt", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const character = {
      id: "laozhao",
      name: "老赵",
      description: "中年求生者",
      full_body_asset: { selected_id: "base-1", variants: [{ id: "base-1", url: "assets/base.png", created_at: 1, prompt_used: "定妆图" }] },
      stages: [{ id: "stage-1", label: "晒黑", from_episode: 3, to_episode: 5, visual_delta: "明显晒黑", reference_images: [], locked: false, status: "pending" }],
    } as Character;

    render(<AssetStageDialog open asset={character} assetType="character" currentEpisode={3} onClose={() => {}} onAction={onAction}/>);
    expect(screen.getByDisplayValue(/角色三视图设定表：老赵/)).toBeTruthy();
    expect(screen.getByDisplayValue(/正面全身、标准侧面全身、背面全身/)).toBeTruthy();
    fireEvent.click(screen.getByAltText("基础候选").closest("button")!);
    expect(onAction).toHaveBeenCalledWith(character, "use_image", character.stages![0], expect.objectContaining({ image_url: "assets/base.png" }));

  });

  it("submits the selected batch size and aspect ratio", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const character = {
      id: "laozhao", name: "老赵", description: "中年求生者",
      stages: [{ id: "stage-1", label: "晒黑", from_episode: 3, to_episode: 5, visual_delta: "明显晒黑", reference_images: [], locked: false, status: "pending" }],
    } as Character;
    render(<AssetStageDialog open asset={character} assetType="character" onClose={() => {}} onAction={onAction}/>);
    fireEvent.click(screen.getByText("×2"));
    fireEvent.click(screen.getByText("4:3"));
    fireEvent.click(screen.getByRole("button", { name: /生成当前阶段/ }));
    expect(onAction).toHaveBeenCalledWith(character, "generate", character.stages![0], expect.objectContaining({ batch_size: 2, aspect_ratio: "4:3" }));
  });

  it("submits an edited generation prompt", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const character = {
      id: "laozhao", name: "老赵", description: "中年求生者",
      stages: [{ id: "stage-1", label: "晒黑", from_episode: 3, to_episode: 5, visual_delta: "明显晒黑", reference_images: [], locked: false, status: "pending" }],
    } as Character;
    render(<AssetStageDialog open asset={character} assetType="character" onClose={() => {}} onAction={onAction}/>);
    fireEvent.change(screen.getByLabelText("阶段生成提示词"), { target: { value: "safe custom prompt" } });
    fireEvent.click(screen.getByRole("button", { name: /生成当前阶段/ }));
    expect(onAction).toHaveBeenCalledWith(character, "generate", character.stages![0], expect.objectContaining({ prompt: "safe custom prompt" }));
  });

  it("deduplicates stage references visually and allows removing one", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const character = {
      id: "laozhao", name: "老赵", description: "中年求生者",
      stages: [{ id: "stage-1", label: "基础", from_episode: 1, to_episode: 2, visual_delta: "", selected_image_id: "dup-2", locked: false, status: "completed", reference_images: [
        { id: "dup-1", url: "assets/base.png", created_at: 1 },
        { id: "dup-2", url: "assets/base.png", created_at: 2 },
      ] }],
    } as Character;
    render(<AssetStageDialog open asset={character} assetType="character" onClose={() => {}} onAction={onAction}/>);
    expect(screen.getAllByAltText("阶段参考图")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("移除阶段参考图"));
    expect(onAction).toHaveBeenCalledWith(character, "remove_image", character.stages![0], { image_id: "dup-2" });
  });

  it("explains why generation is blocked for a locked stage", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const character = {
      id: "laozhao", name: "老赵", description: "中年求生者",
      stages: [{ id: "stage-1", label: "基础", from_episode: 1, to_episode: 2, visual_delta: "", reference_images: [], locked: true, status: "completed" }],
    } as Character;
    render(<AssetStageDialog open asset={character} assetType="character" onClose={() => {}} onAction={onAction}/>);
    expect(screen.getByText(/当前阶段已锁定。生成前请先点击/)).toBeTruthy();
    fireEvent.click(screen.getByText("生成当前阶段 ×1"));
    expect(screen.getByText("当前阶段已锁定，请先解锁后再生成。")).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("uploads an external image and adopts it as the stage reference", async () => {
    vi.mocked(api.uploadFile).mockResolvedValueOnce({ url: "uploads/stage-reference.png" });
    const onAction = vi.fn().mockResolvedValue(undefined);
    const character = {
      id: "laozhao", name: "老赵", description: "中年求生者",
      stages: [{ id: "stage-1", label: "基础", from_episode: 1, to_episode: 2, visual_delta: "", reference_images: [], locked: false, status: "completed" }],
    } as Character;
    render(<AssetStageDialog open asset={character} assetType="character" onClose={() => {}} onAction={onAction}/>);

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "manual.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled());
    expect(onAction).toHaveBeenCalledWith(character, "use_image", character.stages![0], {
      image_url: "uploads/stage-reference.png",
      prompt_used: "用户上传：manual.png",
    });
  });
});
