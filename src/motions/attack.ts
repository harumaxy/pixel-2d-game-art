import { basePose, clonePose, facing, type Motion } from "./index";

/** Overhead melee swing with the right arm: raised at t=0, down and forward by t=0.5. */
export const attack: Motion = {
  id: "attack",
  fps: 10,
  frames: 4,
  prompt: "swinging a melee weapon, attacking",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const depth = 1 - Math.abs(facing(dir));
    // angle: -90deg (straight up) -> +30deg (forward-down)
    const a = -Math.PI / 2 + ((Math.PI * 2) / 3) * Math.min(1, t * 2);
    const len = 0.22;
    p.relb.x = p.rsho.x + Math.cos(a) * len * 0.5 * (depth || 0.3);
    p.relb.y = p.rsho.y + Math.sin(a) * len * 0.5;
    p.rwri.x = p.rsho.x + Math.cos(a) * len * (depth || 0.3);
    p.rwri.y = p.rsho.y + Math.sin(a) * len;
    // Step forward on the downswing.
    p.rkne.x += depth * 0.04 * Math.min(1, t * 2);
    p.rank.x += depth * 0.08 * Math.min(1, t * 2);
    return p;
  },
};
