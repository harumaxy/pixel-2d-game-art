import { expect, test } from "bun:test";
import sharp from "sharp";
import { JOINTS, type Pose } from "../motions";
import { poseFromJson, poseSvg, renderPose } from "./skeleton";

/** Every joint at a distinct spot inside the canvas. */
const standing = (): Pose =>
  Object.fromEntries(JOINTS.map((j, i) => [j, { x: 0.3 + i * 0.02, y: 0.2 + i * 0.03 }])) as Pose;

test("svg has 18 joints and 17 limbs", () => {
  const svg = poseSvg(standing(), 512);
  expect(svg.match(/<circle /g)).toHaveLength(18);
  expect(svg.match(/<line /g)).toHaveLength(17);
  expect(svg).toContain('fill="#000"');
});

test("an invisible joint drops its circle and every limb touching it", () => {
  const p = standing();
  p.nose.visible = false; // nose touches neck, reye, leye -> 3 limbs
  const svg = poseSvg(p, 512);
  expect(svg.match(/<circle /g)).toHaveLength(17);
  expect(svg.match(/<line /g)).toHaveLength(14);
});

test("renders a 512px png with a black background and coloured pixels", async () => {
  const png = await renderPose(standing(), 512);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(512);
  expect(info.height).toBe(512);
  expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
  let coloured = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i]! + data[i + 1]! + data[i + 2]! > 0) coloured++;
  expect(coloured).toBeGreaterThan(500);
});

test("poseFromJson accepts the blender output and defaults visible to true", () => {
  const raw = Object.fromEntries(JOINTS.map((j) => [j, { x: 0.5, y: 0.5 }]));
  (raw.nose as { visible?: boolean }).visible = false;
  const p = poseFromJson(raw, "walk/down/0");
  expect(p.nose.visible).toBe(false);
  expect(p.neck.visible).toBe(true);
  expect(p.lank).toEqual({ x: 0.5, y: 0.5, visible: true });
});

test("poseFromJson rejects a missing joint", () => {
  const raw = Object.fromEntries(JOINTS.slice(1).map((j) => [j, { x: 0.5, y: 0.5 }]));
  expect(() => poseFromJson(raw, "walk/down/0")).toThrow(/walk\/down\/0.*nose/);
});
