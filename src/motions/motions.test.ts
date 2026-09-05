import { describe, expect, test } from "bun:test";
import { DIRS5, JOINTS, MOTIONS } from "./index";

describe("MOTIONS", () => {
  test("six motions in sheet order", () => {
    expect(MOTIONS.map((m) => m.id)).toEqual(["idle", "walk", "run", "attack", "aim", "dodge"]);
  });

  test("every frame of every motion and dir stays inside 0..1", () => {
    for (const m of MOTIONS)
      for (const dir of DIRS5)
        for (let i = 0; i < m.frames; i++) {
          const p = m.key(dir, i / m.frames);
          for (const j of JOINTS) {
            expect(p[j].x).toBeGreaterThanOrEqual(0);
            expect(p[j].x).toBeLessThanOrEqual(1);
            expect(p[j].y).toBeGreaterThanOrEqual(0);
            expect(p[j].y).toBeLessThanOrEqual(1);
          }
        }
  });

  test("walk swings the legs in opposite phase (side view)", () => {
    const walk = MOTIONS.find((m) => m.id === "walk")!;
    const a = walk.key("side", 0.25);
    const b = walk.key("side", 0.75);
    expect(a.rank.x - a.lank.x).toBeGreaterThan(0.02);
    expect(b.rank.x - b.lank.x).toBeLessThan(-0.02);
  });

  test("attack raises the right wrist above the shoulder at its peak", () => {
    const attack = MOTIONS.find((m) => m.id === "attack")!;
    expect(attack.key("side", 0).rwri.y).toBeLessThan(attack.key("side", 0).rsho.y);
  });

  test("dodge lowers the whole body", () => {
    const dodge = MOTIONS.find((m) => m.id === "dodge")!;
    const base = MOTIONS.find((m) => m.id === "idle")!.key("down", 0);
    expect(dodge.key("down", 0.5).nose.y).toBeGreaterThan(base.nose.y);
  });
});
