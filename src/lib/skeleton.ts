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

export function poseSvg(pose: Pose, size: number): string {
  const pts = JOINTS.map((j) => ({ x: pose[j].x * size, y: pose[j].y * size }));
  const stroke = size / 64; // 8px at 512
  const r = size / 85; // 6px at 512

  const limbs = LIMBS.map(([a, b], i) => {
    const p = pts[a]!,
      q = pts[b]!;
    return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${rgb(i)}" stroke-width="${stroke}" stroke-linecap="round" opacity="0.6"/>`;
  });
  const joints = pts.map(
    (p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${rgb(i)}"/>`,
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#000"/>` +
    limbs.join("") +
    joints.join("") +
    `</svg>`
  );
}

export async function renderPose(pose: Pose, size: number): Promise<Buffer> {
  return sharp(Buffer.from(poseSvg(pose, size)))
    .png()
    .toBuffer();
}
