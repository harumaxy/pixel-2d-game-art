import { describe, expect, test } from "bun:test";
import { parseChar } from "./chars";

const OK = `name: scavenger
trigger: sc4v_char
positive: |
  gas mask, torn leather coat,
  bandaged arms
negative: blurry, extra limbs
`;

describe("parseChar", () => {
  test("joins multi-line tags", () => {
    const c = parseChar(OK);
    expect(c.positive).toBe("gas mask, torn leather coat, bandaged arms");
    expect(c.negative).toBe("blurry, extra limbs");
    expect(c.lora).toBeUndefined();
    expect(c.strength).toBe(0.8);
  });
  test("lora + strength", () => {
    const c = parseChar(`${OK}lora: scavenger\nstrength: 0.6\n`);
    expect(c.lora).toBe("scavenger");
    expect(c.strength).toBe(0.6);
  });
  test("strips # comments inside block scalars", () => {
    expect(parseChar(OK.replace("bandaged arms", "bandaged arms # todo")).positive).toBe(
      "gas mask, torn leather coat, bandaged arms",
    );
  });
  test("unknown key throws", () => expect(() => parseChar(`${OK}colour: red\n`)).toThrow(/colour/));
  test("missing trigger throws", () =>
    expect(() => parseChar(OK.replace("trigger: sc4v_char\n", ""))).toThrow(/trigger/));
  test("non-mapping throws", () => expect(() => parseChar("just text")).toThrow());
});
