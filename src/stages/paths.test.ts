import { expect, test } from "bun:test";
import { pxPath } from "./pixelate";
import { posePath } from "./poses";

const norm = (p: string) => p.replaceAll("\\", "/");

test("posePath", () => {
  expect(norm(posePath("walk", "side", 3))).toEndWith("out/poses/walk/side/3.png");
});

test("pxPath", () => {
  expect(norm(pxPath("scav", "walk", "left", 3))).toEndWith("out/px/scav/walk/left/3.png");
});
