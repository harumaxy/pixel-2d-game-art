/**
 * Skeleton model shared by every motion: COCO-18 joints in openpose order,
 * a chibi body in normalised coordinates, and the five generated directions.
 *
 * All poses are authored facing RIGHT for side-ish views; the pixelate stage
 * mirrors them to get the left-facing half of the 8 directions.
 */

export const JOINTS = [
  "nose",
  "neck",
  "rsho",
  "relb",
  "rwri",
  "lsho",
  "lelb",
  "lwri",
  "rhip",
  "rkne",
  "rank",
  "lhip",
  "lkne",
  "lank",
  "reye",
  "leye",
  "rear",
  "lear",
] as const;
export type Joint = (typeof JOINTS)[number];

export interface Pt {
  x: number;
  y: number;
}
export type Pose = Record<Joint, Pt>;

export const DIRS5 = ["down", "up", "side", "downside", "upside"] as const;
export type Dir5 = (typeof DIRS5)[number];

export const DIRS8 = [
  "down",
  "downright",
  "right",
  "upright",
  "up",
  "upleft",
  "left",
  "downleft",
] as const;
export type Dir8 = (typeof DIRS8)[number];

/** Which 8-way directions each generated 5-way one becomes; the second is the mirror. */
export const FLIP: Record<Dir5, [Dir8, Dir8?]> = {
  down: ["down"],
  up: ["up"],
  side: ["right", "left"],
  downside: ["downright", "downleft"],
  upside: ["upright", "upleft"],
};

/**
 * 2-3 heads tall on a square canvas: head fills the top third, legs are
 * short. Tune here, not per motion.
 */
export const BODY = {
  headR: 0.11,
  noseY: 0.24,
  neckY: 0.36,
  shoulderY: 0.4,
  shoulderHalf: 0.12,
  elbowDrop: 0.1,
  wristDrop: 0.2,
  hipY: 0.58,
  hipHalf: 0.07,
  kneeY: 0.74,
  ankleY: 0.9,
  centerX: 0.5,
} as const;

/** +1 facing the viewer, -1 facing away, 0 in profile. Scales left/right spread. */
export const facing = (dir: Dir5): number =>
  ({ down: 1, downside: 0.5, side: 0, upside: -0.5, up: -1 })[dir];

/** Standing upright, arms down. Every motion starts from this. */
export function basePose(dir: Dir5): Pose {
  const f = facing(dir);
  const B = BODY;
  const cx = B.centerX;
  // In profile the body's depth axis is the viewer's x, so shift the whole
  // figure so the nose leads to the right.
  const lean = (1 - Math.abs(f)) * 0.03;

  // Character's RIGHT is on the viewer's LEFT when facing the viewer (f > 0).
  const rx = (half: number) => cx - half * f;
  const lx = (half: number) => cx + half * f;

  return {
    nose: { x: cx + lean, y: B.noseY },
    neck: { x: cx, y: B.neckY },
    rsho: { x: rx(B.shoulderHalf), y: B.shoulderY },
    relb: { x: rx(B.shoulderHalf + 0.02), y: B.shoulderY + B.elbowDrop },
    rwri: { x: rx(B.shoulderHalf + 0.03), y: B.shoulderY + B.wristDrop },
    lsho: { x: lx(B.shoulderHalf), y: B.shoulderY },
    lelb: { x: lx(B.shoulderHalf + 0.02), y: B.shoulderY + B.elbowDrop },
    lwri: { x: lx(B.shoulderHalf + 0.03), y: B.shoulderY + B.wristDrop },
    rhip: { x: rx(B.hipHalf), y: B.hipY },
    rkne: { x: rx(B.hipHalf), y: B.kneeY },
    rank: { x: rx(B.hipHalf), y: B.ankleY },
    lhip: { x: lx(B.hipHalf), y: B.hipY },
    lkne: { x: lx(B.hipHalf), y: B.kneeY },
    lank: { x: lx(B.hipHalf), y: B.ankleY },
    reye: { x: rx(0.04) + lean, y: B.noseY - 0.03 },
    leye: { x: lx(0.04) + lean, y: B.noseY - 0.03 },
    rear: { x: rx(B.headR * 0.9), y: B.noseY - 0.01 },
    lear: { x: lx(B.headR * 0.9), y: B.noseY - 0.01 },
  };
}

export interface Motion {
  id: string;
  fps: number;
  frames: number;
  /** One phrase appended to the sprite prompt, e.g. "walking". */
  prompt: string;
  /** Pose at normalised time t in [0, 1). */
  key(dir: Dir5, t: number): Pose;
}

/** Deep-copy helper so a motion can mutate a base pose freely. */
export const clonePose = (p: Pose): Pose =>
  Object.fromEntries(JOINTS.map((j) => [j, { ...p[j] }])) as Pose;

/**
 * Swing one leg forward/back by `amt` (positive = forward). Forward is +x in
 * profile and, when facing the viewer, a slightly lower ankle with a bent
 * knee; the mix follows `facing`.
 */
export function swingLeg(p: Pose, side: "r" | "l", dir: Dir5, amt: number): void {
  const f = facing(dir);
  const depth = 1 - Math.abs(f); // 1 in profile, 0 front/back
  const kne = p[`${side}kne`],
    ank = p[`${side}ank`];
  kne.x += depth * amt * 0.6;
  ank.x += depth * amt * 1.2;
  // Facing the viewer a forward leg reads as knee bend + shorter shin.
  kne.y -= Math.abs(amt) * (1 - depth) * 0.08;
  ank.y -= Math.abs(amt) * (1 - depth) * 0.04 * (amt > 0 ? 1 : 0);
}

/** Swing one arm like swingLeg; wrist leads. */
export function swingArm(p: Pose, side: "r" | "l", dir: Dir5, amt: number): void {
  const depth = 1 - Math.abs(facing(dir));
  const elb = p[`${side}elb`],
    wri = p[`${side}wri`];
  elb.x += depth * amt * 0.5;
  wri.x += depth * amt * 1.0;
  wri.y -= Math.abs(amt) * 0.06;
}

/** Move every joint by (dx, dy). */
export function shift(p: Pose, dx: number, dy: number): void {
  for (const j of JOINTS) {
    p[j].x += dx;
    p[j].y += dy;
  }
}

import { idle } from "./idle";
import { walk } from "./walk";
import { run } from "./run";
import { attack } from "./attack";
import { aim } from "./aim";
import { dodge } from "./dodge";

/** Sheet row order. */
export const MOTIONS: Motion[] = [idle, walk, run, attack, aim, dodge];
export const motionById = (id: string): Motion | undefined => MOTIONS.find((m) => m.id === id);
