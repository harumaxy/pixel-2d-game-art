import { basePose, clonePose, swingArm, swingLeg, type Motion } from "./index";

export const walk: Motion = {
  id: "walk",
  fps: 8,
  frames: 6,
  prompt: "walking",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const s = Math.sin(2 * Math.PI * t);
    swingLeg(p, "r", dir, 0.06 * s);
    swingLeg(p, "l", dir, -0.06 * s);
    swingArm(p, "r", dir, -0.05 * s);
    swingArm(p, "l", dir, 0.05 * s);
    return p;
  },
};
