/**
 * SD1.5 as a graph builder: one checkpoint, optional LoRA chain, optional
 * IP-Adapter reference, optional ControlNet chain. Used by concept (plain)
 * and sprites (LoRA + reference + openpose + depth).
 */

import {
  WorkflowBuilder,
  type ADE_LoadAnimateDiffModelInputs,
  type CheckpointLoaderSimpleInputs,
  type CLIPVisionLoaderInputs,
  type ControlNetLoaderInputs,
  type IPAdapterModelLoaderInputs,
  type KSamplerInputs,
  type LoadImageInputs,
  type LoraLoaderInputs,
} from "../types/nodes";
import type { Lora } from "./comfy";

export const SD15_CONTROLNET_OPENPOSE = "control_v11p_sd15_openpose_fp16.safetensors";
export const SD15_CONTROLNET_DEPTH = "control_v11f1p_sd15_depth_fp16.safetensors";
export const SD15_IPADAPTER = "ip-adapter-plus_sd15.safetensors";
export const SD15_CLIP_VISION = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors";
/** AnimateDiff v3: less green cast than v2 and legs that stay whole. */
export const SD15_ANIMATEDIFF = "v3_sd15_mm.ckpt";
/**
 * v3's domain adapter, as a LoRA query for resolveLoras. 0.5: at 1.0 it
 * brightens the clip but hallucinates planks under a running figure; at 0.3
 * the colour sinks back.
 */
export const SD15_ANIMATEDIFF_ADAPTER = "v3_sd15_adapter";
export const SD15_ANIMATEDIFF_ADAPTER_STRENGTH = 0.5;

export interface Ref {
  /** Reference image already in ComfyUI's input/ dir: what the character looks like. */
  image: string;
  /** IP-Adapter weight; ~0.7 keeps colours and outfit without freezing the pose. */
  weight: number;
}

export interface Control {
  /** ControlNet filename as ControlNetLoader wants it. */
  model: string;
  /**
   * Hint image already in the model's input form (openpose stick figure, depth
   * map) and already in ComfyUI's input/ dir. No preprocessor. A list is one
   * hint per frame of the batch, in order.
   */
  image: string | string[];
  strength: number;
  endPercent?: number;
}

export interface Sd15Opts {
  ckpt: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  /** Batch size; the frames of one motion when the batch is meant to cohere. */
  count: number;
  seed: number;
  /**
   * filename_prefix for SaveImage, i.e. the subpath under out/. A list is one
   * prefix per frame of the batch, each saved on its own so the files land
   * where the single-frame path puts them; undefined drops that frame (an
   * in-between generated only to give the motion module its full clip).
   */
  prefix: string | (string | undefined)[];
  steps?: number;
  cfg?: number;
  loras?: Lora[];
  /**
   * Pins appearance across frames: ControlNet says what the character is
   * doing, the reference says who it is. Applied after the LoRAs.
   */
  ref?: Ref;
  /** Applied in order; each one conditions on the previous one's output. */
  controls?: Control[];
  /**
   * Cut the subject out on the server and save RGBA: a matting model sees a
   * mask's eye-holes and the gap under a belt as subject, where a colour key
   * sees backdrop. toonout is BiRefNet tuned on anime; rmbg2 is Bria's.
   */
  matte?: Matte;
  /** AnimateDiff motion module filename; the batch becomes a clip. */
  animateDiff?: string;
}

export type Matte = "toonout" | "rmbg2";

export function buildSd15(o: Sd15Opts): ReturnType<WorkflowBuilder["build"]> {
  const w = new WorkflowBuilder();

  const ckpt = w.CheckpointLoaderSimple({
    ckpt_name: o.ckpt as CheckpointLoaderSimpleInputs["ckpt_name"],
  });

  // Both MODEL and CLIP are patched: a character LoRA also moves what its
  // trigger means to the text encoder, so model-only would half-apply it.
  let model = ckpt.MODEL;
  let clip = ckpt.CLIP;
  for (const lora of o.loras ?? []) {
    const loaded = w.LoraLoader({
      model,
      clip,
      lora_name: lora.name as LoraLoaderInputs["lora_name"],
      strength_model: lora.strength,
      strength_clip: lora.strength,
    });
    model = loaded.MODEL;
    clip = loaded.CLIP;
  }

  if (o.ref) {
    // Plus (ViT-H) variant: 16 image tokens, enough to carry outfit details.
    // "linear" weights identity and colour, not just style.
    model = w.IPAdapterAdvanced({
      model,
      ipadapter: w.IPAdapterModelLoader({
        ipadapter_file: SD15_IPADAPTER as IPAdapterModelLoaderInputs["ipadapter_file"],
      }).IPADAPTER,
      clip_vision: w.CLIPVisionLoader({
        clip_name: SD15_CLIP_VISION as CLIPVisionLoaderInputs["clip_name"],
      }).CLIP_VISION,
      image: w.LoadImage({ image: o.ref.image as LoadImageInputs["image"] }).IMAGE,
      weight: o.ref.weight,
      weight_type: "linear",
      combine_embeds: "concat",
      start_at: 0,
      end_at: 1,
      embeds_scaling: "V only",
    }).MODEL;
  }

  if (o.animateDiff) {
    // No context options: the longest motion is under the module's 16-frame window.
    const motion = w.ADE_LoadAnimateDiffModel({
      model_name: o.animateDiff as ADE_LoadAnimateDiffModelInputs["model_name"],
    }).MOTION_MODEL;
    model = w.ADE_UseEvolvedSampling({
      model,
      beta_schedule: "autoselect",
      m_models: w.ADE_ApplyAnimateDiffModelSimple({ motion_model: motion }).M_MODELS,
    }).MODEL;
  }

  // One LoadImage per hint, folded into a batch so the apply sees frame i's hint for latent i.
  const loadHints = (images: string | string[]) =>
    (Array.isArray(images) ? images : [images])
      .map((image) => w.LoadImage({ image: image as LoadImageInputs["image"] }).IMAGE)
      .reduce((image1, image2) => w.ImageBatch({ image1, image2 }).IMAGE);

  const encoded = {
    positive: w.CLIPTextEncode({ clip, text: o.positive }),
    negative: w.CLIPTextEncode({ clip, text: o.negative }),
  };
  let cond: Pick<KSamplerInputs, "positive" | "negative"> = {
    positive: encoded.positive.CONDITIONING,
    negative: encoded.negative.CONDITIONING,
  };
  for (const c of o.controls ?? []) {
    const applied = w.ControlNetApplyAdvanced({
      positive: cond.positive,
      negative: cond.negative,
      control_net: w.ControlNetLoader({
        control_net_name: c.model as ControlNetLoaderInputs["control_net_name"],
      }).CONTROL_NET,
      image: loadHints(c.image),
      strength: c.strength,
      start_percent: 0,
      // Releasing before the end lets the last steps clean up anatomy the
      // hint was forcing; holding to 1 keeps the pose but stiffens it.
      end_percent: c.endPercent ?? 0.85,
    });
    cond = { positive: applied.positive, negative: applied.negative };
  }

  const latent = w.EmptyLatentImage({ width: o.width, height: o.height, batch_size: o.count });

  const sampled = w.KSampler({
    model,
    positive: cond.positive,
    negative: cond.negative,
    latent_image: latent.LATENT,
    seed: o.seed,
    steps: o.steps ?? 25,
    cfg: o.cfg ?? 6,
    sampler_name: "dpmpp_2m",
    scheduler: "karras",
    denoise: 1,
  });

  let image = w.VAEDecode({ samples: sampled.LATENT, vae: ckpt.VAE }).IMAGE;
  if (o.matte) {
    // comfyui-rmbg indexes its "optional" widgets without defaults, so every
    // one is spelled out; the API path has no frontend to fill them in.
    const matte = {
      image,
      mask_blur: 0,
      mask_offset: 0,
      invert_output: false,
      refine_foreground: false,
      background: "Alpha" as const,
    };
    image =
      o.matte === "toonout"
        ? w.BiRefNetRMBG({ ...matte, model: "BiRefNet_toonout" }).IMAGE
        : w.RMBG({ ...matte, model: "RMBG-2.0", sensitivity: 1, process_res: 1024 }).IMAGE;
  }
  // Split after the matte so every frame is RGBA; a lone prefix saves the batch as is.
  const prefixes = Array.isArray(o.prefix) ? o.prefix : [o.prefix];
  const outputs: Record<string, string> = {};
  prefixes.forEach((filename_prefix, i) => {
    if (filename_prefix === undefined) return;
    const images =
      prefixes.length > 1 ? w.ImageFromBatch({ image, batch_index: i, length: 1 }).IMAGE : image;
    outputs[i ? `images${i}` : "images"] = w.SaveImage({ images, filename_prefix }).__id;
  });

  return w.build({ outputs });
}
