import { describe, expect, test } from "bun:test";
import {
  buildSd15,
  SD15_CLIP_VISION,
  SD15_CONTROLNET_DEPTH,
  SD15_CONTROLNET_OPENPOSE,
  SD15_IPADAPTER,
  SD15_ANIMATEDIFF,
} from "./sd15";

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

  test("one control wires openpose without a preprocessor", () => {
    const wf = buildSd15({
      ...base,
      controls: [{ model: SD15_CONTROLNET_OPENPOSE, image: "walk_down_0.png", strength: 0.65 }],
    });
    expect(byType(wf, "ControlNetLoader")[0]!.inputs.control_net_name).toBe(
      SD15_CONTROLNET_OPENPOSE,
    );
    const apply = byType(wf, "ControlNetApplyAdvanced")[0]!;
    expect(apply.inputs.strength).toBe(0.65);
    expect(apply.inputs.end_percent).toBe(0.85);
    expect(nodes(wf).some((n) => n.class_type.includes("Preprocessor"))).toBe(false);
    expect(byType(wf, "LoadImage")[0]!.inputs.image).toBe("walk_down_0.png");
  });

  test("two controls chain: the second apply consumes the first's conditioning", () => {
    const wf = buildSd15({
      ...base,
      controls: [
        { model: SD15_CONTROLNET_OPENPOSE, image: "walk_down_0.png", strength: 0.6 },
        { model: SD15_CONTROLNET_DEPTH, image: "walk_down_0.depth.png", strength: 0.5 },
      ],
    });
    const prompt = wf.prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const applies = Object.entries(prompt).filter(
      ([, n]) => n.class_type === "ControlNetApplyAdvanced",
    );
    expect(applies).toHaveLength(2);
    const [[firstId, first], [, second]] = applies as [
      string,
      { inputs: Record<string, unknown> },
    ][];
    expect(first.inputs.strength).toBe(0.6);
    expect(second.inputs.strength).toBe(0.5);
    // second.positive is a link [nodeId, outputIndex] into the first apply
    expect((second.inputs.positive as [string, number])[0]).toBe(firstId);
    expect(byType(wf, "ControlNetLoader").map((n) => n.inputs.control_net_name)).toEqual([
      SD15_CONTROLNET_OPENPOSE,
      SD15_CONTROLNET_DEPTH,
    ]);
    const ks = byType(wf, "KSampler")[0]!;
    expect((ks.inputs.positive as [string, number])[0]).toBe(applies[1]![0]);
  });

  test("ref image patches the model through IP-Adapter after the loras", () => {
    const wf = buildSd15({
      ...base,
      loras: [{ name: "a.safetensors", strength: 0.8 }],
      ref: { image: "scavenger_ref.png", weight: 0.7 },
    });
    const prompt = wf.prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const [loraId] = Object.entries(prompt).find(([, n]) => n.class_type === "LoraLoader")!;
    const [ipaId, ipa] = Object.entries(prompt).find(
      ([, n]) => n.class_type === "IPAdapterAdvanced",
    )!;
    expect(ipa.inputs.weight).toBe(0.7);
    expect((ipa.inputs.model as [string, number])[0]).toBe(loraId);
    expect(byType(wf, "IPAdapterModelLoader")[0]!.inputs.ipadapter_file).toBe(SD15_IPADAPTER);
    expect(byType(wf, "CLIPVisionLoader")[0]!.inputs.clip_name).toBe(SD15_CLIP_VISION);
    expect(byType(wf, "LoadImage").map((n) => n.inputs.image)).toContain("scavenger_ref.png");
    const ks = byType(wf, "KSampler")[0]!;
    expect((ks.inputs.model as [string, number])[0]).toBe(ipaId);
  });

  test("no ref means no IP-Adapter nodes", () => {
    expect(byType(buildSd15(base), "IPAdapterAdvanced")).toHaveLength(0);
  });

  test("matte cuts the decoded image out before saving", () => {
    const wf = buildSd15({ ...base, matte: "toonout" });
    const prompt = wf.prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const [decodeId] = Object.entries(prompt).find(([, n]) => n.class_type === "VAEDecode")!;
    const [rmbgId, rmbg] = Object.entries(prompt).find(([, n]) => n.class_type === "BiRefNetRMBG")!;
    expect(rmbg.inputs.model).toBe("BiRefNet_toonout");
    expect(rmbg.inputs.background).toBe("Alpha");
    // The node reads its optional widgets by key with no default: omit one and it raises.
    expect(rmbg.inputs.mask_blur).toBe(0);
    expect(rmbg.inputs.mask_offset).toBe(0);
    expect(rmbg.inputs.refine_foreground).toBe(false);
    expect((rmbg.inputs.image as [string, number])[0]).toBe(decodeId);
    expect((byType(wf, "SaveImage")[0]!.inputs.images as [string, number])[0]).toBe(rmbgId);
  });

  test("matte rmbg2 uses the RMBG node", () => {
    const wf = buildSd15({ ...base, matte: "rmbg2" });
    expect(byType(wf, "RMBG")[0]!.inputs.model).toBe("RMBG-2.0");
    expect(byType(wf, "BiRefNetRMBG")).toHaveLength(0);
  });

  test("no matte saves the decode directly", () => {
    const wf = buildSd15(base);
    expect(byType(wf, "BiRefNetRMBG")).toHaveLength(0);
    expect(byType(wf, "RMBG")).toHaveLength(0);
  });

  test("save prefix and batch size", () => {
    const wf = buildSd15({ ...base, count: 4 });
    expect(byType(wf, "SaveImage")[0]!.inputs.filename_prefix).toBe(base.prefix);
    expect(byType(wf, "EmptyLatentImage")[0]!.inputs.batch_size).toBe(4);
  });
});

describe("buildSd15 batch", () => {
  const prompt = (wf: ReturnType<typeof buildSd15>) =>
    wf.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const batch = {
    ...base,
    count: 3,
    prefix: ["p/0", "p/1", "p/2"],
    controls: [
      { model: SD15_CONTROLNET_OPENPOSE, image: ["a.png", "b.png", "c.png"], strength: 0.6 },
    ],
  };

  test("hint list becomes one ImageBatch chain feeding a single ControlNet apply", () => {
    const wf = buildSd15(batch);
    expect(byType(wf, "LoadImage").map((n) => n.inputs.image)).toEqual(["a.png", "b.png", "c.png"]);
    expect(byType(wf, "ImageBatch")).toHaveLength(2);
    expect(byType(wf, "ControlNetApplyAdvanced")).toHaveLength(1);
    expect(byType(wf, "EmptyLatentImage")[0]!.inputs.batch_size).toBe(3);
  });

  test("prefix list splits the batch into one SaveImage per frame, all in the output map", () => {
    const wf = buildSd15({ ...batch, matte: "toonout" });
    const p = prompt(wf);
    const splits = byType(wf, "ImageFromBatch");
    expect(splits.map((n) => n.inputs.batch_index)).toEqual([0, 1, 2]);
    expect(splits.every((n) => n.inputs.length === 1)).toBe(true);
    // the split happens after the matte, so every frame is RGBA
    const [matteId] = Object.entries(p).find(([, n]) => n.class_type === "BiRefNetRMBG")!;
    expect((splits[0]!.inputs.image as [string, number])[0]).toBe(matteId);
    const saves = byType(wf, "SaveImage");
    expect(saves.map((n) => n.inputs.filename_prefix)).toEqual(["p/0", "p/1", "p/2"]);
    expect(Object.keys(wf.mapOutputKeys)).toHaveLength(3);
  });

  test("an undefined prefix drops that frame: no split, no save", () => {
    const wf = buildSd15({ ...batch, prefix: ["p/0", undefined, "p/1"] });
    expect(byType(wf, "ImageFromBatch").map((n) => n.inputs.batch_index)).toEqual([0, 2]);
    expect(byType(wf, "SaveImage").map((n) => n.inputs.filename_prefix)).toEqual(["p/0", "p/1"]);
    expect(byType(wf, "EmptyLatentImage")[0]!.inputs.batch_size).toBe(3);
  });

  test("single prefix keeps the plain SaveImage", () => {
    const wf = buildSd15(base);
    expect(byType(wf, "ImageFromBatch")).toHaveLength(0);
    expect(byType(wf, "ImageBatch")).toHaveLength(0);
  });

  test("styleAligned patches the model after the ref, before the sampler", () => {
    const wf = buildSd15({ ...batch, ref: { image: "r.png", weight: 0.7 }, styleAligned: true });
    const p = prompt(wf);
    const [ipaId] = Object.entries(p).find(([, n]) => n.class_type === "IPAdapterAdvanced")!;
    const [saId, sa] = Object.entries(p).find(
      ([, n]) => n.class_type === "StyleAlignedBatchAlign",
    )!;
    expect(sa.inputs.share_norm).toBe("both");
    expect(sa.inputs.share_attn).toBe("q+k+v");
    expect((sa.inputs.model as [string, number])[0]).toBe(ipaId);
    expect((byType(wf, "KSampler")[0]!.inputs.model as [string, number])[0]).toBe(saId);
  });

  test("animateDiff wraps the model in evolved sampling with the motion module", () => {
    const wf = buildSd15({ ...batch, animateDiff: SD15_ANIMATEDIFF });
    const p = prompt(wf);
    expect(byType(wf, "ADE_LoadAnimateDiffModel")[0]!.inputs.model_name).toBe(SD15_ANIMATEDIFF);
    const [evoId, evo] = Object.entries(p).find(
      ([, n]) => n.class_type === "ADE_UseEvolvedSampling",
    )!;
    expect(evo.inputs.beta_schedule).toBe("autoselect");
    expect(byType(wf, "ADE_ApplyAnimateDiffModelSimple")).toHaveLength(1);
    expect((byType(wf, "KSampler")[0]!.inputs.model as [string, number])[0]).toBe(evoId);
  });
});
