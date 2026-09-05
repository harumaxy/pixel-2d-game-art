/**
 * SD1.5 as a graph builder: one checkpoint, optional LoRA chain, optional
 * openpose ControlNet. Used by concept (plain) and sprites (LoRA + CN).
 */

import {
  WorkflowBuilder,
  type CheckpointLoaderSimpleInputs,
  type ControlNetLoaderInputs,
  type LoadImageInputs,
  type LoraLoaderInputs,
} from "../types/nodes";
import type { Lora } from "./comfy";

export const SD15_CONTROLNET_OPENPOSE = "control_v11p_sd15_openpose_fp16.safetensors";

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
  /**
   * Pose hint already in openpose form and already in ComfyUI's input/ dir.
   * No preprocessor: running a detector over a stick figure finds no body.
   */
  control?: { image: string; strength: number; endPercent?: number };
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

  const positive = w.CLIPTextEncode({ clip, text: o.positive });
  const negative = w.CLIPTextEncode({ clip, text: o.negative });

  const guided = o.control
    ? w.ControlNetApplyAdvanced({
        positive: positive.CONDITIONING,
        negative: negative.CONDITIONING,
        control_net: w.ControlNetLoader({
          control_net_name: SD15_CONTROLNET_OPENPOSE as ControlNetLoaderInputs["control_net_name"],
        }).CONTROL_NET,
        image: w.LoadImage({ image: o.control.image as LoadImageInputs["image"] }).IMAGE,
        strength: o.control.strength,
        start_percent: 0,
        // Releasing before the end lets the last steps clean up anatomy the
        // skeleton was forcing; holding to 1 keeps the pose but stiffens it.
        end_percent: o.control.endPercent ?? 0.85,
      })
    : undefined;

  const latent = w.EmptyLatentImage({ width: o.width, height: o.height, batch_size: o.count });

  const sampled = w.KSampler({
    model,
    positive: guided?.positive ?? positive.CONDITIONING,
    negative: guided?.negative ?? negative.CONDITIONING,
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
