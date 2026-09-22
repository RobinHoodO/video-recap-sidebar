// One-time setup: creates the private ElevenLabs Conversational AI agent for
// the "Talk to this video" feature.
// Run: oprun --env-file /Users/robinsverd/Thrivbe-AI/Thrivbe-OS/.env -- node scripts/create-voice-agent.mjs
// Then add the printed agent id as VITE_ELEVENLABS_AGENT_ID, and the same
// ELEVENLABS_API_KEY value/reference as VITE_ELEVENLABS_API_KEY, to this
// repo's local .env (gitignored).

const BASE = 'https://api.elevenlabs.io';
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George — multilingual, works fine with flash v2.5

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey || apiKey.startsWith('op://')) {
  console.error('ELEVENLABS_API_KEY must be a resolved value. Run via: oprun --env-file <workspace .env> -- node scripts/create-voice-agent.mjs');
  process.exit(1);
}
if (process.env.ELEVENLABS_AGENT_ID) {
  console.error('ELEVENLABS_AGENT_ID is already set — an agent exists. Delete the ElevenLabs dashboard agent (and the VITE_ELEVENLABS_AGENT_ID in .env) to recreate.');
  process.exit(1);
}

const PROMPT = `You are a helpful voice assistant embedded in a YouTube video-recap browser extension. You answer questions about the video the user is currently watching, using the context provided below.

Video title: {{video_title}}
Video channel: {{video_channel}}
Video summary: {{video_summary}}
Video transcript: {{video_transcript}}

Be brief and conversational — this is a spoken conversation, not a written one. If the video's summary or transcript does not cover something the user asks about, say so plainly instead of guessing. Reply in the language the user speaks to you in.`;

async function el(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

const agent = await el('/v1/convai/agents/create', {
  conversation_config: {
    agent: {
      first_message: 'Hi — ask me anything about {{video_title}}.',
      prompt: { prompt: PROMPT, llm: 'gemini-2.5-flash-lite' },
    },
    // The API rejects eleven_flash_v2_5 and eleven_turbo_v2_5 for an agent
    // whose default language is "en" ("English Agents must use turbo or
    // flash v2" — confirmed live against the API, not from docs). Only
    // eleven_turbo_v2 / eleven_flash_v2 are accepted. eleven_flash_v2 is the
    // fastest and cheapest of the two, matching the brief's "fast, cheap"
    // requirement, at the cost of the v2_5 models' full 32-language range.
    tts: { voice_id: VOICE_ID, model_id: 'eleven_flash_v2' },
  },
  platform_settings: {
    auth: { enable_auth: true },
  },
});

console.log(agent.agent_id);
