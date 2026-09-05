/**
 * SD1.5 as a graph builder: one checkpoint, optional LoRA chain, optional
 * ControlNet chain. Used by concept (plain) and sprites (LoRA + openpose + depth).
 */

import {
  WorkflowBuilder,
  type CheckpointLoaderSimpleInputs,
  type ControlNetLoaderInputs,
  type KSamplerInputs,
  type LoadImageInputs,
  type LoraLoaderInputs,
} from "../types/nodes";
import type { Lora } from "./comfy";

export const SD15_CONTROLNET_OPENPOSE = "control_v11p_sd15_openpose_fp16.safetensors";
export const SD15_CONTROLNET_DEPTH = "control_v11f1p_sd15_depth_fp16.safetensors";

export interface Control {
  /** ControlNet filename as ControlNetLoader wants it. */
  model: string;
  /**
   * Hint image already in the model's input form (openpose stick figure, depth
   * map) and already in ComfyUI's input/ dir. No preprocessor.
   */
  image: string;
  strength: number;
  endPercent?: number;
}

export interface Sd15Opts {
  ckpt: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  count: number;
  seed: number;
  /** filename_prefix for SaveImage, i.e. the subpath under out/. */
  prefix: string;
  steps?: number;
  cfg?: number;
  loras?: Lora[];
  /** Applied in order; each one conditions on the previous one's output. */
  controls?: Control[];
}

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
      image: w.LoadImage({ image: c.image as LoadImageInputs["image"] }).IMAGE,
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

  const decoded = w.VAEDecode({ samples: sampled.LATENT, vae: ckpt.VAE });
  const save = w.SaveImage({ images: decoded.IMAGE, filename_prefix: o.prefix });

  return w.build({ outputs: { images: save.__id } });
}
