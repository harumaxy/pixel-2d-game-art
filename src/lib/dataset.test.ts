import { describe, expect, test } from "bun:test";
import { caption, SOURCE_CAPTION, trainYaml, VARIATIONS } from "./dataset";

describe("captions", () => {
  test("substitute trigger", () =>
    expect(caption("[trigger], side view", "sc4v_char")).toBe("sc4v_char, side view"));
  test("every variation caption starts with the trigger and has no fixed studio phrase", () => {
    for (const v of Object.values(VARIATIONS)) {
      expect(v.caption.startsWith("[trigger]")).toBe(true);
      expect(v.caption).not.toMatch(/full body shot|grey background|studio lighting/);
    }
    expect(SOURCE_CAPTION).toBe("[trigger], front view");
  });
  test("prompts all keep the character", () => {
    for (const v of Object.values(VARIATIONS))
      expect(v.prompt).toContain("Keep the exact same character");
  });
});

test("trainYaml embeds name, trigger and folder", () => {
  const y = trainYaml({
    name: "scavenger",
    trigger: "sc4v_char",
    datasetDir: "C:/x/out/dataset/scavenger",
  });
  const doc = Bun.YAML.parse(y) as any;
  expect(doc.config.name).toBe("scavenger");
  const p = doc.config.process[0];
  expect(p.trigger_word).toBe("sc4v_char");
  expect(p.datasets[0].folder_path).toBe("C:/x/out/dataset/scavenger");
  expect(p.model.name_or_path).toBe("stable-diffusion-v1-5/stable-diffusion-v1-5");
  expect(p.model.is_flux).toBeUndefined();
});
