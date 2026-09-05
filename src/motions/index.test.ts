import { describe, expect, test } from "bun:test";
import { DIRS8, FLIP, GEN_DIRS, JOINTS, MOTIONS } from "./index";

test("JOINTS is COCO-18 in openpose order", () => {
  expect(JOINTS).toHaveLength(18);
  expect(JOINTS[0]).toBe("nose");
  expect(JOINTS[1]).toBe("neck");
  expect(JOINTS[17]).toBe("lear");
});

test("FLIP covers every Dir8 exactly once", () => {
  const covered = Object.values(FLIP).flat().filter(Boolean);
  expect(covered.slice().sort()).toEqual([...DIRS8].sort());
});

test("GEN_DIRS are a subset of DIRS8 and the keys of FLIP", () => {
  for (const d of GEN_DIRS) expect(DIRS8).toContain(d);
  expect(Object.keys(FLIP).sort()).toEqual([...GEN_DIRS].sort());
});

describe("MOTIONS", () => {
  test("ids are unique", () => {
    const ids = MOTIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("every motion names an .fbx and at least one frame", () => {
    for (const m of MOTIONS) {
      expect(m.fbx).toMatch(/\.fbx$/);
      expect(m.frames).toBeGreaterThanOrEqual(1);
      expect(m.fps).toBeGreaterThan(0);
      expect(m.prompt.length).toBeGreaterThan(0);
    }
  });
  test("sheet order starts with idle, walk, run", () => {
    expect(MOTIONS.slice(0, 3).map((m) => m.id)).toEqual(["idle", "walk", "run"]);
  });
});
