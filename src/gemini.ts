const PENDING_KEY = "geminiPendingFrameworkPrompt";
const MAX_AGE_MS = 2 * 60_000;

type PendingGeminiPrompt = {
  prompt: string;
  createdAt: number;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function findPromptInput(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector<HTMLElement>('rich-textarea div[contenteditable="true"]') ||
    document.querySelector<HTMLElement>('textarea[aria-label*="prompt" i]') ||
    document.querySelector<HTMLElement>("textarea")
  );
}

function insertPrompt(input: HTMLElement, text: string) {
  input.focus();
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    setNativeValue(input, text);
    return;
  }

  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));

  if ((input.textContent || "").trim().length < 20) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  }
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function clickCanvasIfAvailable() {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("button, a, div[role='button']"));
  const canvas = candidates.find((el) => /canvas/i.test(el.textContent || el.getAttribute("aria-label") || ""));
  canvas?.click();
}

function clickSendOrEnter(input: HTMLElement) {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  const send = buttons.find((b) => {
    const label = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`;
    return !b.disabled && /(send|submit)/i.test(label);
  });
  if (send) {
    send.click();
    return;
  }
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
}

async function readPending(): Promise<PendingGeminiPrompt | null> {
  const got = await chrome.storage.local.get(PENDING_KEY);
  const pending = got[PENDING_KEY] as PendingGeminiPrompt | undefined;
  if (!pending?.prompt || Date.now() - pending.createdAt > MAX_AGE_MS) {
    await chrome.storage.local.remove(PENDING_KEY);
    return null;
  }
  return pending;
}

async function runGeminiHandoff() {
  const pending = await readPending();
  if (!pending) return;

  for (let i = 0; i < 80; i++) {
    clickCanvasIfAvailable();
    const input = findPromptInput();
    if (input) {
      insertPrompt(input, pending.prompt);
      await wait(500);
      clickCanvasIfAvailable();
      await wait(250);
      clickSendOrEnter(input);
      await chrome.storage.local.remove(PENDING_KEY);
      return;
    }
    await wait(250);
  }
}

runGeminiHandoff().catch(() => {});
