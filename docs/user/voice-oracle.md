# Voice Oracle

The voice oracle is a live voice companion for a thread. Open it, talk about what you're
building, and it manages the coding agent for you: it can read the conversation, send the agent
new instructions, and tells you out loud what the agent did when it finishes a turn.

The oracle runs on the OpenAI Realtime API. Audio flows directly between your browser and
OpenAI over an encrypted connection; the T3 server only issues short-lived session tokens, and
your API key never leaves the server.

## Setup

1. Open **Settings → Voice**.
2. Paste an OpenAI API key. It is stored encrypted on the server and never sent to clients.
3. Optionally pick a different realtime model or voice. The defaults work well.

## Using it

Open a thread and press the voice button (the waveform icon) in the thread header. Grant
microphone access when your browser asks. A full-screen orb appears and the oracle opens by
telling you where things stand — what you last asked for, what the agent last said, and whether
it is still working. Then just talk.

Things you can say:

- "What's the agent working on right now?"
- "What did it change in the last turn?"
- "Tell it to also add tests for the new endpoint."
- "Summarize this conversation for me."

When you ask the oracle to instruct the agent, it composes the message and sends it as a new
turn in the thread — exactly as if you typed it in the composer, using the thread's current
model and permission mode.

## Short calls, not an open line

The oracle hangs up on its own. Once it has handed work to the agent, or you are done talking,
it says a closing line and closes the overlay rather than sitting on a live microphone while a
turn runs for ten minutes.

Tap the voice button again whenever you want it back. Each session reopens caught up: the
oracle reads the agent's latest message and the current status before it speaks, so you never
have to re-explain the thread. If you stay on the call while the agent works, it announces the
outcome as soon as the turn finishes.

Use the microphone button to mute yourself, the X button or Escape to end the session early.
Voice sessions are per-thread and nothing is recorded: closing the overlay ends the call.

## Microphone access

The first session asks for the microphone. On the desktop app for macOS the request comes from
the system, so it appears once and is remembered; if you declined it earlier, re-enable T3 Code
under System Settings → Privacy & Security → Microphone. In the browser it is the usual
site permission prompt.

If the microphone is blocked, the overlay says so and names which layer blocked it, rather than
failing silently.

## Limits

- Voice needs a conversation that has already started; send the first message from the
  composer.
- Voice is available in the browser and desktop apps. On mobile, keep directing the agent by
  text for now.
- Remote environments connected through T3 Connect relays cannot mint voice sessions yet;
  direct and tailnet connections work.
