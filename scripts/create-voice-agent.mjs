// Setup + update script for the private ElevenLabs Conversational AI agent
// behind the "Talk to this video" feature.
// Create:  oprun --env-file /Users/robinsverd/Thrivbe-AI/Thrivbe-OS/.env -- node scripts/create-voice-agent.mjs
//          Then add the printed agent id as VITE_ELEVENLABS_AGENT_ID, and the
//          same ELEVENLABS_API_KEY value/reference as VITE_ELEVENLABS_API_KEY,
//          to this repo's local .env (gitignored).
// Update:  same command, but with ELEVENLABS_AGENT_ID (or VITE_ELEVENLABS_AGENT_ID)
//          set in the environment — PATCHes the existing agent with this same
//          config instead of creating a new one, so this file stays the
//          single source of truth for the live agent.

const BASE = 'https://api.elevenlabs.io';
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George — multilingual, works fine with flash v2.5

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey || apiKey.startsWith('op://')) {
  console.error('ELEVENLABS_API_KEY must be a resolved value. Run via: oprun --env-file <workspace .env> -- node scripts/create-voice-agent.mjs');
  process.exit(1);
}
const existingAgentId = process.env.ELEVENLABS_AGENT_ID || process.env.VITE_ELEVENLABS_AGENT_ID;

const PROMPT = `You are a learning coach embedded in a YouTube video-recap browser extension. Your job is to help the user learn, understand, integrate, and apply the ideas in the video they're watching — not just answer trivia about it.

Video title: {{video_title}}
Video channel: {{video_channel}}
Video summary: {{video_summary}}
Video transcript: {{video_transcript}}

This is a spoken conversation. Be very concise: 1-2 short sentences per turn, plain spoken style, no lists, no preamble, never say "great question."

Default mode is coaching, one step at a time:
- Ask one question at a time. Never stack multiple questions in one turn.
- Check understanding by asking the user to explain a point back in their own words.
- Connect the video's ideas to the user's own work or life when it fits naturally.
- Suggest one concrete way to apply an idea, then let the user react before moving on.

If the user asks a plain factual question, answer it directly and briefly first. You may then add one short follow-up question, but never force one.

Ground every claim in the summary and transcript above. If they don't cover something the user asks about, say so plainly instead of guessing. When it helps, mention the rough timestamp where an idea comes up. Reply in the language the user speaks to you in.`;

async function el(path, method, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

const conversationConfig = {
  agent: {
    first_message: 'Hi — what do you want to get out of {{video_title}}?',
    // Interruptible: the client "interruption" event stays enabled (default),
    // and the first message itself can be interrupted too.
    disable_first_message_interruptions: false,
    prompt: {
      prompt: PROMPT,
      llm: 'gemini-2.5-flash-lite',
      // Cap per-turn output to enforce the "very concise" brief at the API
      // level, not just via prompt instructions.
      max_tokens: 150,
    },
  },
  conversation: {
    // Explicit allow-list of client events; "interruption" must stay in it
    // for the SDK to let the user cut the agent off mid-speech.
    client_events: ['audio', 'interruption', 'agent_response', 'user_transcript', 'agent_response_correction', 'agent_tool_response'],
  },
  // The API rejects eleven_flash_v2_5 and eleven_turbo_v2_5 for an agent
  // whose default language is "en" ("English Agents must use turbo or
  // flash v2" — confirmed live against the API, not from docs). Only
  // eleven_turbo_v2 / eleven_flash_v2 are accepted. eleven_flash_v2 is the
  // fastest and cheapest of the two, matching the brief's "fast, cheap"
  // requirement, at the cost of the v2_5 models' full 32-language range.
  tts: { voice_id: VOICE_ID, model_id: 'eleven_flash_v2' },
};

if (existingAgentId) {
  await el(`/v1/convai/agents/${existingAgentId}`, 'PATCH', { conversation_config: conversationConfig });
  console.log(existingAgentId);
} else {
  const agent = await el('/v1/convai/agents/create', 'POST', {
    conversation_config: conversationConfig,
    platform_settings: {
      auth: { enable_auth: true },
    },
  });
  console.log(agent.agent_id);
}
