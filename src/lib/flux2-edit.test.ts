import { describe, expect, test } from "bun:test";
import { buildFlux2Edit } from "./flux2-edit";

const base = {
  image: "scavenger_00001_.png",
  prompt: "Rotate the character 90 degrees to a full side profile facing left.",
  seed: 42,
  prefix: "dataset/scavenger/side",
  model: "klein9b" as const,
};

type Node = { class_type: string; inputs: Record<string, unknown> };
const nodes = (wf: ReturnType<typeof buildFlux2Edit>) =>
  Object.values(wf.prompt as Record<string, Node>);
const byType = (wf: ReturnType<typeof buildFlux2Edit>, t: string) =>
  nodes(wf).filter((n) => n.class_type === t);

describe("buildFlux2Edit", () => {
  test("model picks the matching unet + text encoder", () => {
    const wf9 = buildFlux2Edit(base);
    expect(byType(wf9, "UNETLoader")[0]!.inputs.unet_name).toBe("flux-2-klein-9b-fp8.safetensors");
    expect(byType(wf9, "CLIPLoader")[0]!.inputs.clip_name).toBe("qwen_3_8b_fp8mixed.safetensors");
    expect(byType(wf9, "CLIPLoader")[0]!.inputs.type).toBe("flux2");
    const wf4 = buildFlux2Edit({ ...base, model: "klein4b" });
    expect(byType(wf4, "UNETLoader")[0]!.inputs.unet_name).toBe("flux-2-klein-4b-fp8.safetensors");
    expect(byType(wf4, "CLIPLoader")[0]!.inputs.clip_name).toBe("qwen_3_4b.safetensors");
  });

  test("reference image feeds both conditionings and the latent size", () => {
    const wf = buildFlux2Edit(base);
    expect(byType(wf, "ImageScaleToTotalPixels")[0]!.inputs.megapixels).toBe(0.5);
    expect(byType(wf, "ReferenceLatent")).toHaveLength(2);
    expect(byType(wf, "ConditioningZeroOut")).toHaveLength(1);
    // width/height are links to GetImageSize, not literals.
    const sched = byType(wf, "Flux2Scheduler")[0]!;
    expect(Array.isArray(sched.inputs.width)).toBe(true);
    expect(byType(wf, "EmptyFlux2LatentImage")[0]!.inputs.width).toEqual(sched.inputs.width);
  });

  test("distilled settings: 4 steps, cfg 1, seeded", () => {
    const wf = buildFlux2Edit(base);
    expect(byType(wf, "Flux2Scheduler")[0]!.inputs.steps).toBe(4);
    expect(byType(wf, "CFGGuider")[0]!.inputs.cfg).toBe(1);
    expect(byType(wf, "RandomNoise")[0]!.inputs.noise_seed).toBe(42);
    expect(byType(wf, "SaveImage")[0]!.inputs.filename_prefix).toBe(base.prefix);
  });
});
