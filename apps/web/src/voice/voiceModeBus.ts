// Tiny event bus allowing any component (header button, keybinding, command
// palette) to open the voice oracle overlay without owning its React state.
// Mirrors commandPaletteBus.
const VOICE_MODE_OPEN_EVENT = "t3code:open-voice-mode";

export function openVoiceMode(): void {
  window.dispatchEvent(new CustomEvent(VOICE_MODE_OPEN_EVENT));
}

export function onOpenVoiceMode(listener: () => void): () => void {
  window.addEventListener(VOICE_MODE_OPEN_EVENT, listener);
  return () => window.removeEventListener(VOICE_MODE_OPEN_EVENT, listener);
}
