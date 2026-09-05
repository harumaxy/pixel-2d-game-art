import { basePose, clonePose, shift, type Motion } from "./index";

export const idle: Motion = {
  id: "idle",
  fps: 4,
  frames: 4,
  prompt: "standing idle",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    // Breathe: 1px-scale bob at 512 is 0.004; keep it visible at 64px.
    shift(p, 0, 0.01 * Math.sin(2 * Math.PI * t));
    return p;
  },
};
