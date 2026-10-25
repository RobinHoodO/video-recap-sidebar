// Guards the "talk to this video" button so two fast presses can never open two
// voice sessions (each would grab the mic). The in-flight flag is set
// synchronously, before the first await.
export type VoiceSession = { endSession(): Promise<void> };
export type PressResult = "started" | "ended" | "cancelled";

export function createTalkToggle<S extends VoiceSession>(start: () => Promise<S>) {
  let session: S | null = null;
  let starting = false;
  let cancelRequested = false;

  const end = async (s: S) => { await s.endSession().catch(() => {}); };
  const release = () => {
    const s = session;
    session = null;
    if (s) void end(s);
  };

  return {
    // True while a session is live or still connecting.
    active: () => starting || session !== null,
    async press(): Promise<PressResult> {
      if (starting) { cancelRequested = true; return "cancelled"; }
      if (session) {
        const s = session;
        session = null;
        await end(s);
        return "ended";
      }
      starting = true;
      cancelRequested = false;
      try {
        const s = await start();
        if (cancelRequested) { await end(s); return "cancelled"; }
        session = s;
        return "started";
      } finally {
        starting = false;
        cancelRequested = false;
      }
    },
    // The session ended on its own (disconnect/error): drop it and release the mic.
    release,
    // Unmount: end a live session, or make a still-connecting one end on arrival.
    dispose() {
      if (starting) cancelRequested = true;
      release();
    },
  };
}
