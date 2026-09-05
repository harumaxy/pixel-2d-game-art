import { expect, test } from "bun:test";
import { depthPath, findBlender, posePath } from "./poses";

test("depthPath sits next to posePath", () => {
  expect(depthPath("walk", "right", 3)).toBe(
    posePath("walk", "right", 3).replace(/\.png$/, ".depth.png"),
  );
});

test("an explicit exe wins without being checked", async () => {
  expect(await findBlender("C:\\nowhere\\blender.exe")).toBe("C:\\nowhere\\blender.exe");
});
