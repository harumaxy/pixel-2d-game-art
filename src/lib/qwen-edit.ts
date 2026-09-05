/**
 * Qwen-Image-Edit 2511 as a graph builder. Identity travels as pixels, not as
 * text: the prompt says what to change, the reference image carries who it is.
 * That is why this builds a LoRA dataset out of one hero image.
 */

import { WorkflowBuilder, type LoadImageInputs } from "../types/nodes";

const UNET = "qwen-image-edit-2511-Q5_0.gguf";
const CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors";
const VAE = "qwen_image_vae.safetensors";
const LIGHTNING_LORA = "qwen\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors";

export interface QwenEditOpts {
  /** Filename already inside ComfyUI's input/ directory. */
  image: string;
  prompt: string;
  seed: number;
  prefix: string;
}

export function buildQwenEdit(o: QwenEditOpts): ReturnType<WorkflowBuilder["build"]> {
  const w = new WorkflowBuilder();

  const unet = w.UnetLoaderGGUF({ unet_name: UNET });
  const clip = w.CLIPLoader({ clip_name: CLIP, type: "qwen_image" });
  const vae = w.VAELoader({ vae_name: VAE });

  // 4-step Lightning distill: KSampler must stay at steps 4 / cfg 1.
  const model = w.LoraLoaderModelOnly({
    model: unet.MODEL,
    lora_name: LIGHTNING_LORA,
    strength_model: 1,
  });

  const src = w.LoadImage({ image: o.image as LoadImageInputs["image"] });
  const scaled = w.ImageScaleToTotalPixels({
    image: src.IMAGE,
    upscale_method: "lanczos",
    megapixels: 0.5,
    resolution_steps: 16,
  });

  const ref = { clip: clip.CLIP, vae: vae.VAE, image1: scaled.IMAGE };
  const positive = w.TextEncodeQwenImageEditPlus({ ...ref, prompt: o.prompt });
  const negative = w.TextEncodeQwenImageEditPlus({ ...ref, prompt: "" });

  const latent = w.VAEEncode({ pixels: scaled.IMAGE, vae: vae.VAE });
  const sampled = w.KSampler({
    model: model.MODEL,
    positive: positive.CONDITIONING,
    negative: negative.CONDITIONING,
    latent_image: latent.LATENT,
    seed: o.seed,
    steps: 4,
    cfg: 1,
    sampler_name: "euler",
    scheduler: "simple",
    denoise: 1,
  });

  const decoded = w.VAEDecode({ samples: sampled.LATENT, vae: vae.VAE });
  const save = w.SaveImage({ images: decoded.IMAGE, filename_prefix: o.prefix });

  return w.build({ outputs: { images: save.__id } });
}
