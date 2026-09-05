import { describe, expect, test } from "bun:test";
import { basePose, DIRS5, DIRS8, facing, FLIP, JOINTS } from "./index";

describe("basePose", () => {
  test("every joint inside 0..1 for every dir", () => {
    for (const dir of DIRS5) {
      const p = basePose(dir);
      for (const j of JOINTS) {
        expect(p[j].x).toBeGreaterThanOrEqual(0);
        expect(p[j].x).toBeLessThanOrEqual(1);
        expect(p[j].y).toBeGreaterThanOrEqual(0);
        expect(p[j].y).toBeLessThanOrEqual(1);
      }
    }
  });
  test("front view: character's right shoulder is on the viewer's left", () => {
    const p = basePose("down");
    expect(p.rsho.x).toBeLessThan(p.lsho.x);
  });
  test("back view mirrors", () => {
    const p = basePose("up");
    expect(p.rsho.x).toBeGreaterThan(p.lsho.x);
  });
  test("side view collapses shoulders onto one x", () => {
    const p = basePose("side");
    expect(p.rsho.x).toBeCloseTo(p.lsho.x, 5);
    expect(facing("side")).toBe(0);
  });
  test("head above hips above ankles", () => {
    const p = basePose("down");
    expect(p.nose.y).toBeLessThan(p.rhip.y);
    expect(p.rhip.y).toBeLessThan(p.rank.y);
  });
});

test("FLIP covers every Dir8 exactly once", () => {
  const covered = Object.values(FLIP).flat().filter(Boolean);
  expect(covered.slice().sort()).toEqual([...DIRS8].sort());
});
