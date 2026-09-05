import { expect, test } from "bun:test";
import { MOTIONS } from "../motions";
import { motionSeed, spritePrompt } from "./sprites";

test("motionSeed offsets by 1000 per motion index", () => {
  expect(motionSeed(42, 3)).toBe(3042);
});

test("motionSeed is independent of any --motion filtering", () => {
  const index = MOTIONS.findIndex((m) => m.id === "jump");
  expect(motionSeed(42, index)).toBe(42 + index * 1000);
});

const char = { trigger: "sc4v_char", positive: "1boy, gas mask" };

test("prompt is trigger, character, motion, suffix", () => {
  const p = spritePrompt(char, "walking", "down");
  expect(p.startsWith("sc4v_char, 1boy, gas mask, walking,")).toBe(true);
  expect(p).not.toContain("chibi");
  expect(p).not.toContain("from behind");
});

test("back views say so, since the skeleton has no face to show it", () => {
  expect(spritePrompt(char, "walking", "up")).toContain("from behind");
  expect(spritePrompt(char, "walking", "upright")).toContain("from behind");
  expect(spritePrompt(char, "walking", "right")).not.toContain("from behind");
});
