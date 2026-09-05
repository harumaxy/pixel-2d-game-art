import { expect, test } from "bun:test";
import type { Rgba } from "./pixelate";
import { composeSheet } from "./sheet";

const solid = (size: number, c: number[]): Rgba => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set(c, i * 4);
  return { width: size, height: size, data };
};
const px = (i: Rgba, x: number, y: number) =>
  Array.from(i.data.slice((y * i.width + x) * 4, (y * i.width + x) * 4 + 4));

test("composeSheet lays rows by motion and pads short rows", () => {
  const { image, meta } = composeSheet(
    [
      {
        name: "walk_down",
        fps: 8,
        frames: [solid(2, [1, 0, 0, 255]), solid(2, [2, 0, 0, 255]), solid(2, [3, 0, 0, 255])],
      },
      { name: "aim_down", fps: 4, frames: [solid(2, [9, 0, 0, 255])] },
    ],
    2,
  );
  expect(image.width).toBe(6); // 3 columns * 2
  expect(image.height).toBe(4);
  expect(px(image, 0, 0)[0]).toBe(1);
  expect(px(image, 4, 1)[0]).toBe(3);
  expect(px(image, 0, 2)[0]).toBe(9);
  expect(px(image, 2, 2)[3]).toBe(0); // padded
  expect(meta).toEqual({
    frameSize: 2,
    columns: 3,
    animations: [
      { name: "walk_down", row: 0, frames: 3, fps: 8 },
      { name: "aim_down", row: 1, frames: 1, fps: 4 },
    ],
  });
});

test("frame of the wrong size throws", () => {
  expect(() =>
    composeSheet([{ name: "x", fps: 1, frames: [solid(3, [0, 0, 0, 255])] }], 2),
  ).toThrow(/3x3/);
});
