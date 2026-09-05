/**
 * FLUX.2 Klein image edit as a graph builder — the faster alternative to
 * qwen-edit.ts for the dataset stage. Same contract: reference image in, one
 * edited image out. Mirrors ComfyUI's built-in
 * `image_flux2_klein_image_edit_*` templates: the reference goes in through
 * ReferenceLatent on both conditionings, and Flux2Scheduler's sigmas force
 * SamplerCustomAdvanced instead of KSampler.
 */

import { WorkflowBuilder, type LoadImageInputs, type UNETLoaderInputs } from "../types/nodes";

export const KLEIN = {
  klein4b: { unet: "flux-2-klein-4b-fp8.safetensors", clip: "qwen_3_4b.safetensors" },
  klein9b: { unet: "flux-2-klein-9b-fp8.safetensors", clip: "qwen_3_8b_fp8mixed.safetensors" },
} as const;
export type KleinModel = keyof typeof KLEIN;

const VAE = "flux2-vae.safetensors";

export interface Flux2EditOpts {
  /** Filename already inside ComfyUI's input/ directory. */
  image: string;
  prompt: string;
  seed: number;
  prefix: string;
  model: KleinModel;
}

export function buildFlux2Edit(o: Flux2EditOpts): ReturnType<WorkflowBuilder["build"]> {
  const w = new WorkflowBuilder();
  const m = KLEIN[o.model];

  const unet = w.UNETLoader({
    unet_name: m.unet as UNETLoaderInputs["unet_name"],
    weight_dtype: "default",
  });
  const clip = w.CLIPLoader({ clip_name: m.clip, type: "flux2" });
  const vae = w.VAELoader({ vae_name: VAE });

  const src = w.LoadImage({ image: o.image as LoadImageInputs["image"] });
  const scaled = w.ImageScaleToTotalPixels({
    image: src.IMAGE,
    upscale_method: "lanczos",
    megapixels: 0.5,
    resolution_steps: 16,
  });
  // Output latent must match the reference's aspect, so take the size off the
  // scaled image. The codegen types INT inputs as `number`, but ComfyUI accepts
  // a link there just fine.
  const size = w.GetImageSize({ image: scaled.IMAGE });
  const width = size.width as unknown as number;
  const height = size.height as unknown as number;

  const text = w.CLIPTextEncode({ clip: clip.CLIP, text: o.prompt });
  // Distilled klein: cfg 1, negative is the zeroed positive.
  const zero = w.ConditioningZeroOut({ conditioning: text.CONDITIONING });
  const refLatent = w.VAEEncode({ pixels: scaled.IMAGE, vae: vae.VAE });
  const positive = w.ReferenceLatent({ conditioning: text.CONDITIONING, latent: refLatent.LATENT });
  const negative = w.ReferenceLatent({ conditioning: zero.CONDITIONING, latent: refLatent.LATENT });

  const guider = w.CFGGuider({
    model: unet.MODEL,
    positive: positive.CONDITIONING,
    negative: negative.CONDITIONING,
    cfg: 1,
  });
  const sigmas = w.Flux2Scheduler({ steps: 4, width, height });
  const sampler = w.KSamplerSelect({ sampler_name: "euler" });
  const noise = w.RandomNoise({ noise_seed: o.seed });
  const latent = w.EmptyFlux2LatentImage({ width, height, batch_size: 1 });

  const sampled = w.SamplerCustomAdvanced({
    noise: noise.NOISE,
    guider: guider.GUIDER,
    sampler: sampler.SAMPLER,
    sigmas: sigmas.SIGMAS,
    latent_image: latent.LATENT,
  });

  const decoded = w.VAEDecode({ samples: sampled.output, vae: vae.VAE });
  const save = w.SaveImage({ images: decoded.IMAGE, filename_prefix: o.prefix });

  return w.build({ outputs: { images: save.__id } });
}
