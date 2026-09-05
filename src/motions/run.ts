import { basePose, clonePose, facing, shift, swingArm, swingLeg, type Motion } from "./index";

export const run: Motion = {
  id: "run",
  fps: 12,
  frames: 6,
  prompt: "running",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const s = Math.sin(2 * Math.PI * t);
    swingLeg(p, "r", dir, 0.1 * s);
    swingLeg(p, "l", dir, -0.1 * s);
    swingArm(p, "r", dir, -0.08 * s);
    swingArm(p, "l", dir, 0.08 * s);
    // Lean into the run in profile; bob everywhere.
    const depth = 1 - Math.abs(facing(dir));
    for (const j of ["nose", "neck", "rsho", "lsho", "reye", "leye", "rear", "lear"] as const)
      p[j].x += 0.03 * depth;
    shift(p, 0, 0.015 * Math.abs(s));
    return p;
  },
};
