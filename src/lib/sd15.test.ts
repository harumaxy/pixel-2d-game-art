import { describe, expect, test } from "bun:test";
import { buildSd15, SD15_CONTROLNET_OPENPOSE } from "./sd15";

const base = {
  ckpt: "aziibpixelmix_v10.safetensors",
  positive: "sc4v_char, walking",
  negative: "blurry",
  width: 512,
  height: 512,
  count: 1,
  seed: 42,
  prefix: "sprites/scavenger/walk/down/0",
};

const nodes = (wf: ReturnType<typeof buildSd15>) =>
  Object.values(
    wf.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  );
const byType = (wf: ReturnType<typeof buildSd15>, t: string) =>
  nodes(wf).filter((n) => n.class_type === t);

describe("buildSd15", () => {
  test("plain t2i has no lora / controlnet", () => {
    const wf = buildSd15(base);
    expect(byType(wf, "CheckpointLoaderSimple")).toHaveLength(1);
    expect(byType(wf, "LoraLoader")).toHaveLength(0);
    expect(byType(wf, "ControlNetApplyAdvanced")).toHaveLength(0);
    const ks = byType(wf, "KSampler")[0]!;
    expect(ks.inputs.seed).toBe(42);
    expect(ks.inputs.steps).toBe(25);
    expect(ks.inputs.cfg).toBe(6);
    expect(ks.inputs.sampler_name).toBe("dpmpp_2m");
    expect(ks.inputs.scheduler).toBe("karras");
  });

  test("loras chain in order", () => {
    const wf = buildSd15({
      ...base,
      loras: [
        { name: "a.safetensors", strength: 0.8 },
        { name: "b.safetensors", strength: 0.5 },
      ],
    });
    const loras = byType(wf, "LoraLoader");
    expect(loras.map((l) => l.inputs.lora_name)).toEqual(["a.safetensors", "b.safetensors"]);
    expect(loras[0]!.inputs.strength_model).toBe(0.8);
    expect(loras[0]!.inputs.strength_clip).toBe(0.8);
  });

  test("control wires openpose without a preprocessor", () => {
    const wf = buildSd15({ ...base, control: { image: "walk_down_0.png", strength: 0.65 } });
    expect(byType(wf, "ControlNetLoader")[0]!.inputs.control_net_name).toBe(
      SD15_CONTROLNET_OPENPOSE,
    );
    const apply = byType(wf, "ControlNetApplyAdvanced")[0]!;
    expect(apply.inputs.strength).toBe(0.65);
    expect(apply.inputs.end_percent).toBe(0.85);
    expect(nodes(wf).some((n) => n.class_type.includes("Preprocessor"))).toBe(false);
    expect(byType(wf, "LoadImage")[0]!.inputs.image).toBe("walk_down_0.png");
  });

  test("save prefix and batch size", () => {
    const wf = buildSd15({ ...base, count: 4 });
    expect(byType(wf, "SaveImage")[0]!.inputs.filename_prefix).toBe(base.prefix);
    expect(byType(wf, "EmptyLatentImage")[0]!.inputs.batch_size).toBe(4);
  });
});
