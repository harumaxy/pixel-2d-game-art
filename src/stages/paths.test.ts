import { expect, test } from "bun:test";
import { pxPath } from "./pixelate";
import { posePath } from "./poses";
import { GEN_DIR, genPrefix } from "../lib/paths";

const norm = (p: string) => p.replaceAll("\\", "/");

test("posePath", () => {
  expect(norm(posePath("walk", "right", 3))).toEndWith("out/poses/walk/right/3.png");
});

test("pxPath", () => {
  expect(norm(pxPath("scav", "walk", "left", 3))).toEndWith("out/px/scav/walk/left/3.png");
});

test("genPrefix namespaces ComfyUI outputs under px/", () => {
  expect(genPrefix("concept", "scav", "scav")).toBe("px/concept/scav/scav");
  expect(norm(GEN_DIR)).toEndWith("out/gen");
});
