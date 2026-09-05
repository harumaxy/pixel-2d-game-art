import { expect, test } from "bun:test";
import { MOTIONS } from "../motions";
import { motionSeed } from "./sprites";

test("motionSeed offsets by 1000 per motion index", () => {
  expect(motionSeed(42, 3)).toBe(3042);
});

test("motionSeed is independent of any --motion filtering", () => {
  const index = MOTIONS.findIndex((m) => m.id === "attack");
  expect(motionSeed(42, index)).toBe(42 + index * 1000);
});
