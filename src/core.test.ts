// ponytail: no test framework in this project (see IMPROVEMENT-PLAN.md), so
// this is a plain assert self-check for parseJsonLoose. Run: node --experimental-strip-types src/core.test.ts
import assert from "node:assert";
import { parseJsonLoose } from "./core.ts";

// plain JSON
assert.deepStrictEqual(parseJsonLoose("{\"a\":1}"), { a: 1 });

// fenced JSON with lang tag
assert.deepStrictEqual(parseJsonLoose("```json\n{\"a\":1}\n```"), { a: 1 });

// JSON embedded in prose (no fence)
assert.deepStrictEqual(parseJsonLoose("here you go: {\"a\":1} thanks"), { a: 1 });

// degenerate response: stray fence marker, no braces anywhere — must throw
// a readable error, not a raw JSON.parse "Unexpected token" crash
assert.throws(() => parseJsonLoose("```"), /Model returned no JSON/);
assert.throws(() => parseJsonLoose(""), /Model returned no JSON/);

console.log("core.test.ts: all checks passed");
