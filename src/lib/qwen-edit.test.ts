import { describe, expect, test } from "bun:test";
import { buildQwenEdit } from "./qwen-edit";

const base = {
  image: "scavenger_00001_.png",
  prompt: "Rotate the character 90 degrees to a full side profile facing left.",
  seed: 42,
  prefix: "dataset/scavenger/side",
};

const nodes = (wf: ReturnType<typeof buildQwenEdit>) =>
  Object.values(
    wf.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  );
const byType = (wf: ReturnType<typeof buildQwenEdit>, t: string) =>
  nodes(wf).filter((n) => n.class_type === t);

describe("buildQwenEdit", () => {
  test("loaders wired with the expected model files", () => {
    const wf = buildQwenEdit(base);
    expect(byType(wf, "UnetLoaderGGUF")).toHaveLength(1);
    expect(byType(wf, "UnetLoaderGGUF")[0]!.inputs.unet_name).toBe(
      "qwen-image-edit-2511-Q5_0.gguf",
    );
    expect(byType(wf, "CLIPLoader")).toHaveLength(1);
    expect(byType(wf, "CLIPLoader")[0]!.inputs.type).toBe("qwen_image");
    expect(byType(wf, "VAELoader")).toHaveLength(1);
    const lora = byType(wf, "LoraLoaderModelOnly")[0]!;
    expect(lora.inputs.lora_name).toBe(
      "qwen\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    );
    expect(lora.inputs.strength_model).toBe(1);
  });

  test("image in, image out", () => {
    const wf = buildQwenEdit(base);
    expect(byType(wf, "LoadImage")[0]!.inputs.image).toBe(base.image);
    const scaled = byType(wf, "ImageScaleToTotalPixels")[0]!;
    expect(scaled.inputs.megapixels).toBe(1);
    expect(scaled.inputs.resolution_steps).toBe(16);
    expect(byType(wf, "VAEEncode")).toHaveLength(1);
    expect(byType(wf, "VAEDecode")).toHaveLength(1);
    expect(byType(wf, "SaveImage")[0]!.inputs.filename_prefix).toBe(base.prefix);
  });

  test("positive and negative text encode, no preprocessor", () => {
    const wf = buildQwenEdit(base);
    const encoders = byType(wf, "TextEncodeQwenImageEditPlus");
    expect(encoders).toHaveLength(2);
    expect(encoders.map((e) => e.inputs.prompt).sort()).toEqual(["", base.prompt].sort());
    expect(nodes(wf).some((n) => n.class_type.includes("Preprocessor"))).toBe(false);
  });

  test("KSampler locked to the 4-step Lightning settings", () => {
    const wf = buildQwenEdit(base);
    const ks = byType(wf, "KSampler")[0]!;
    expect(ks.inputs.seed).toBe(42);
    expect(ks.inputs.steps).toBe(4);
    expect(ks.inputs.cfg).toBe(1);
    expect(ks.inputs.sampler_name).toBe("euler");
    expect(ks.inputs.scheduler).toBe("simple");
    expect(ks.inputs.denoise).toBe(1);
  });
});
