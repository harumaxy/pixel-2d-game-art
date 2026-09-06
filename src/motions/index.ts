/**
 * The joint model every stage shares (COCO-18 in openpose order) and the
 * motion catalogue. Skeletons are no longer authored here: `px poses` renders
 * them from the Mixamo clips named below via scripts/mixamo_poses.py.
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
  /** Normalised image coords, 0..1, y down. */
  x: number;
  y: number;
  /** false = occluded (e.g. the face seen from behind); drawn as absent. Default true. */
  visible?: boolean;
}
export type Pose = Record<Joint, Pt>;

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

/** Directions we actually generate; pixelate mirrors them into the rest. */
export const GEN_DIRS = ["down", "downright", "right", "upright", "up"] as const;
export type GenDir = (typeof GEN_DIRS)[number];

/** Which Dir8s each generated direction becomes; the second is the mirror. */
export const FLIP: Record<GenDir, [Dir8, Dir8?]> = {
  down: ["down"],
  up: ["up"],
  right: ["right", "left"],
  downright: ["downright", "downleft"],
  upright: ["upright", "upleft"],
};

/**
 * Hints are rendered at HINT_STEP x a motion's frame count: the motion module
 * was trained on 16-frame clips, so an 8-frame walk is generated as 16 and
 * every other frame is kept. Sprite frame i is hint frame i * HINT_STEP.
 */
export const HINT_STEP = 2;

export interface Motion {
  id: string;
  /** File name under mixamo/. */
  fbx: string;
  frames: number;
  /** true: the last frame stops just before the clip wraps (walk cycles). false: the last frame is the clip's end (jump). */
  loop: boolean;
  /** Playback fps written to the sheet JSON. */
  fps: number;
  /** One phrase appended to the sprite prompt. */
  prompt: string;
}

/** Sheet row order. */
export const MOTIONS: Motion[] = [
  { id: "idle", fbx: "idle.fbx", frames: 4, loop: true, fps: 4, prompt: "standing idle" },
  { id: "walk", fbx: "walking.fbx", frames: 8, loop: true, fps: 8, prompt: "walking" },
  { id: "run", fbx: "running.fbx", frames: 8, loop: true, fps: 10, prompt: "running" },
  { id: "jump", fbx: "jumping up.fbx", frames: 6, loop: false, fps: 8, prompt: "jumping up" },
  {
    id: "fall",
    fbx: "falling idle.fbx",
    frames: 4,
    loop: true,
    fps: 6,
    prompt: "falling in the air",
  },
  {
    id: "land",
    fbx: "hard landing.fbx",
    frames: 6,
    loop: false,
    fps: 8,
    prompt: "landing from a fall, crouching",
  },
  {
    id: "sneak",
    fbx: "crouched sneaking right.fbx",
    frames: 8,
    loop: true,
    fps: 8,
    prompt: "sneaking crouched",
  },
];
