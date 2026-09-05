import { expect, test } from "bun:test";
import sharp from "sharp";
import { basePose } from "../motions";
import { poseSvg, renderPose } from "./skeleton";

test("svg has 18 joints and 17 limbs", () => {
  const svg = poseSvg(basePose("down"), 512);
  expect(svg.match(/<circle /g)).toHaveLength(18);
  expect(svg.match(/<line /g)).toHaveLength(17);
  expect(svg).toContain('fill="#000"'); // black background
});

test("renders a 512px png with a black background and coloured pixels", async () => {
  const png = await renderPose(basePose("down"), 512);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(512);
  expect(info.height).toBe(512);
  // corner is black
  expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
  // something is not black
  let coloured = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i]! + data[i + 1]! + data[i + 2]! > 0) coloured++;
  expect(coloured).toBeGreaterThan(500);
});
