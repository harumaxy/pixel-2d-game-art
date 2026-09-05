import { basePose, clonePose, facing, type Motion } from "./index";

/** Two-handed rifle stance, both wrists forward at shoulder height; frame 2 is recoil. */
export const aim: Motion = {
  id: "aim",
  fps: 4,
  frames: 2,
  prompt: "aiming a rifle, two-handed stance",
  key(dir, t) {
    const p = clonePose(basePose(dir));
    const depth = 1 - Math.abs(facing(dir));
    const reach = 0.18 * (depth || 0.35);
    const recoil = t >= 0.5 ? -0.02 : 0;
    p.relb.x = p.rsho.x + reach * 0.5 + recoil;
    p.relb.y = p.rsho.y + 0.02;
    p.rwri.x = p.rsho.x + reach + recoil;
    p.rwri.y = p.rsho.y;
    p.lelb.x = p.lsho.x + reach * 0.6 + recoil;
    p.lelb.y = p.lsho.y + 0.01;
    p.lwri.x = p.lsho.x + reach * 1.1 + recoil;
    p.lwri.y = p.lsho.y - 0.01;
    return p;
  },
};
