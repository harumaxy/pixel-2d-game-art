/**
 * Pose -> openpose-style image. The colours and limb order match
 * controlnet_aux's draw_bodypose exactly, which is what
 * control_v11p_sd15_openpose was trained on; anything else reads as noise.
 * Background is pure black, as the ControlNet expects.
 */

import sharp from "sharp";
import { JOINTS, type Pose } from "../motions";

/** Limb pairs by joint index, in openpose order (colour i goes with limb i). */
const LIMBS: [number, number][] = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17],
];

const COLORS = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85],
];

const rgb = (i: number) => `rgb(${COLORS[i]!.join(",")})`;

/** Which face joints to draw: all five, the nose alone, or none (the neck stays). */
export type Face = "all" | "nose" | "none";
export const FACES: readonly Face[] = ["all", "nose", "none"];
const FACE_JOINTS = new Set<string>(["nose", "reye", "leye", "rear", "lear"]);

export function poseSvg(pose: Pose, size: number, face: Face = "all"): string {
  // A small figure's five face points collapse into one blob the ControlNet
  // reads as a tiny boxy head; fewer points leave the head to depth + reference.
  const drawn = (j: string) =>
    !FACE_JOINTS.has(j) || face === "all" || (face === "nose" && j === "nose");
  const pts = JOINTS.map((j) => ({
    x: pose[j].x * size,
    y: pose[j].y * size,
    visible: pose[j].visible !== false && drawn(j),
  }));
  const stroke = size / 64; // 8px at 512
  const r = size / 85; // 6px at 512

  // An occluded joint is simply absent, the way a detector would report it.
  const limbs = LIMBS.flatMap(([a, b], i) => {
    const p = pts[a]!,
      q = pts[b]!;
    if (!p.visible || !q.visible) return [];
    return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${rgb(i)}" stroke-width="${stroke}" stroke-linecap="round" opacity="0.6"/>`;
  });
  const joints = pts.flatMap((p, i) =>
    p.visible
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${rgb(i)}"/>`
      : [],
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#000"/>` +
    limbs.join("") +
    joints.join("") +
    `</svg>`
  );
}

export async function renderPose(pose: Pose, size: number, face: Face = "all"): Promise<Buffer> {
  return sharp(Buffer.from(poseSvg(pose, size, face)))
    .png()
    .toBuffer();
}

/** Parse one `<k>.json` written by scripts/mixamo_poses.py. `label` names the frame in errors. */
export function poseFromJson(raw: unknown, label: string): Pose {
  const obj = (raw ?? {}) as Record<string, { x?: unknown; y?: unknown; visible?: unknown }>;
  const pose = {} as Pose;
  for (const j of JOINTS) {
    const p = obj[j];
    if (!p || typeof p.x !== "number" || typeof p.y !== "number")
      throw new Error(`${label}: joint ${j} missing or not {x, y}`);
    pose[j] = { x: p.x, y: p.y, visible: p.visible !== false };
  }
  return pose;
}
