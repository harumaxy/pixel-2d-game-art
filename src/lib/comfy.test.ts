import { describe, expect, test } from "bun:test";
import { flag, flags, matchLora, parseLora, positional, resolveSeed } from "./comfy";

describe("flag", () => {
  test("reads --name value", () => expect(flag(["--size", "64"], "size")).toBe("64"));
  test("reads alias", () => expect(flag(["-n", "4"], "count", "n")).toBe("4"));
  test("absent is undefined", () => expect(flag(["--size", "64"], "seed")).toBeUndefined());
});

test("flags collects every repeat", () => {
  expect(flags(["--lora", "a", "--lora", "b"], "lora")).toEqual(["a", "b"]);
  expect(flags(["--lora"], "lora")).toEqual([]);
});

describe("positional", () => {
  const V = new Set(["--hero", "--size"]);
  test("skips flag values", () => expect(positional(["--hero", "x.png", "scav"], V)).toBe("scav"));
  test("name before flags", () => expect(positional(["scav", "--size", "64"], V)).toBe("scav"));
  test("none", () => expect(positional(["--size", "64"], V)).toBeUndefined());
});

test("resolveSeed pins --seed", () => expect(resolveSeed(["--seed", "42"])).toBe(42));

describe("lora", () => {
  const NAMES = ["scavenger.safetensors", "SD15\\scavenger_v2.safetensors"];
  test("parse bare", () => expect(parseLora("scav")).toEqual({ query: "scav", strength: 1 }));
  test("parse strength", () =>
    expect(parseLora("scav:0.7")).toEqual({ query: "scav", strength: 0.7 }));
  test("bad strength throws", () => expect(() => parseLora("scav:x")).toThrow());
  test("exact basename wins", () => expect(matchLora(NAMES, "scavenger")).toBe(NAMES[0]));
  test("substring", () => expect(matchLora(NAMES, "v2")).toBe(NAMES[1]));
  test("ambiguous throws", () => expect(() => matchLora(NAMES, "scav")).toThrow(/ambiguous/));
  test("missing throws", () => expect(() => matchLora(NAMES, "nope")).toThrow(/no LoRA/));
});
