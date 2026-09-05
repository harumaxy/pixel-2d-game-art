import { expect, test } from "bun:test";
import { STAGES, usage } from "./px";

test("usage lists every stage", () => {
  for (const name of Object.keys(STAGES)) expect(usage()).toContain(name);
});

test("every stage is a lazy module import", () => {
  for (const load of Object.values(STAGES)) expect(typeof load).toBe("function");
});
