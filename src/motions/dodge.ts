import { basePose, clonePose, facing, shift, type Motion } from "./index";

/** Crouching lunge: lowest at the middle frame. */
export const dodge: Motion = {
  id: "dodge",
  fps: 12,
  frames: 4,
  prompt: "dodging, crouching lunge",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const depth = 1 - Math.abs(facing(dir));
    const k = Math.sin(Math.PI * t); // 0 -> 1 -> 0
    // Drop the upper body; knees come up to meet it.
    for (const j of [
      "nose",
      "neck",
      "rsho",
      "lsho",
      "relb",
      "lelb",
      "rwri",
      "lwri",
      "rhip",
      "lhip",
      "reye",
      "leye",
      "rear",
      "lear",
    ] as const)
      p[j].y += 0.08 * k;
    p.rkne.y -= 0.03 * k;
    p.lkne.y -= 0.03 * k;
    p.rkne.x += depth * 0.05 * k;
    p.lkne.x -= depth * 0.03 * k;
    shift(p, depth * 0.04 * k, 0);
    return p;
  },
};
