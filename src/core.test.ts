// ponytail: no test framework in this project, so these are plain assert
// self-checks. Run: node --experimental-strip-types src/core.test.ts
import assert from "node:assert";
import { buildVoiceTranscript, VOICE_TRANSCRIPT_CHAR_CAP, type Segment } from "./core.ts";
import { createTalkToggle, type VoiceSession } from "./voice.ts";

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

// createTalkToggle: harness with a start() that resolves on demand
function harness() {
  const sessions: { ended: number }[] = [];
  let release: (() => void) | undefined;
  const gate = () => new Promise<void>((r) => { release = r; });
  const toggle = createTalkToggle(async (): Promise<VoiceSession> => {
    await gate();
    const s = { ended: 0, endSession: async () => { s.ended++; } };
    sessions.push(s);
    return s;
  });
  return { sessions, toggle, finish: () => release?.() };
}

// two fast presses while the first is still starting open ONE session
{
  const h = harness();
  const a = h.toggle.press();
  const b = h.toggle.press();
  h.finish();
  await Promise.all([a, b]);
  assert.strictEqual(h.sessions.length, 1, "double press must start exactly one session");
  // the second press asked to cancel, so the lone session is ended (mic released)
  assert.strictEqual(h.sessions[0].ended, 1);
  assert.strictEqual(h.toggle.active(), false);
}

// a press while active ends the session; a later press can start a new one
{
  const h = harness();
  const a = h.toggle.press();
  h.finish();
  assert.strictEqual(await a, "started");
  assert.strictEqual(h.toggle.active(), true);
  assert.strictEqual(await h.toggle.press(), "ended");
  assert.strictEqual(h.sessions[0].ended, 1);
  const c = h.toggle.press();
  h.finish();
  assert.strictEqual(await c, "started");
  assert.strictEqual(h.sessions.length, 2);
}

// dispose while starting still ends the session that finishes starting
{
  const h = harness();
  const a = h.toggle.press();
  h.toggle.dispose();
  h.finish();
  await a;
  assert.strictEqual(h.sessions[0].ended, 1);
}

// a failed start clears the in-flight flag so the next press can retry
{
  let fail = true;
  const t = createTalkToggle(async (): Promise<VoiceSession> => {
    if (fail) throw new Error("boom");
    return { endSession: async () => {} };
  });
  await assert.rejects(t.press(), /boom/);
  fail = false;
  assert.strictEqual(await t.press(), "started");
}

console.log("core.test.ts: all checks passed");
