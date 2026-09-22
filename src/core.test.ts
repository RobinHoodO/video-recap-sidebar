// ponytail: no test framework in this project (see IMPROVEMENT-PLAN.md), so
// this is a plain assert self-check for parseJsonLoose. Run: node --experimental-strip-types src/core.test.ts
import assert from "node:assert";
import { parseJsonLoose, buildVoiceTranscript, VOICE_TRANSCRIPT_CHAR_CAP, type Segment } from "./core.ts";

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

// buildVoiceTranscript: under-cap transcript passes through unchanged
const short: Segment[] = [{ tStartMs: 0, text: "hello" }, { tStartMs: 30000, text: "world" }];
assert.strictEqual(buildVoiceTranscript(short), "[0:00] hello\n[0:30] world");

// buildVoiceTranscript: over-cap transcript is truncated in the middle, keeping
// the start and end, and never exceeds the cap plus the truncation marker
const long: Segment[] = [{ tStartMs: 0, text: "x".repeat(VOICE_TRANSCRIPT_CHAR_CAP * 2) }];
const truncated = buildVoiceTranscript(long);
assert.ok(truncated.includes("...[truncated]..."));
assert.ok(truncated.startsWith("[0:00] " + "x".repeat(10)));
assert.ok(truncated.endsWith("x".repeat(10)));
assert.ok(truncated.length <= VOICE_TRANSCRIPT_CHAR_CAP + 40);

console.log("core.test.ts: all checks passed");
