import {
  DEFAULT_VOICE_REALTIME_MODEL,
  DEFAULT_VOICE_REALTIME_VOICE,
  type PushSettings,
  type VoiceSettings,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function VoiceTextSetting({
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Input
      className="w-full sm:w-56"
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed !== value) onCommit(trimmed);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function VoiceApiKeyControl({
  voice,
  onUpdate,
}: {
  voice: VoiceSettings;
  onUpdate: (patch: { openaiApiKey: string; openaiApiKeyRedacted: boolean }) => void;
}) {
  const [draft, setDraft] = useState("");
  const configured = voice.openaiApiKeyRedacted === true;

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    onUpdate({ openaiApiKey: trimmed, openaiApiKeyRedacted: false });
    setDraft("");
  };

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
      <Input
        type="password"
        autoComplete="off"
        className="w-full sm:w-64"
        value={draft}
        placeholder={configured ? "Configured — enter a new key to replace" : "sk-…"}
        aria-label="OpenAI API key for voice sessions"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        onBlur={commit}
      />
      {configured && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onUpdate({ openaiApiKey: "", openaiApiKeyRedacted: false })}
        >
          Remove key
        </Button>
      )}
    </div>
  );
}

type MicrophoneCheckState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "result"; readonly granted: boolean; readonly detail: string };

function MicrophoneAccessControl() {
  const [state, setState] = useState<MicrophoneCheckState>({ kind: "idle" });

  const request = async () => {
    setState({ kind: "checking" });
    // Desktop first: resolves the macOS-level (TCC) grant and raises the
    // system prompt when the user has never been asked.
    const osStatus = await window.desktopBridge
      ?.requestMicrophoneAccess?.()
      .catch(() => "unknown" as const);
    if (osStatus === "denied" || osStatus === "restricted") {
      setState({
        kind: "result",
        granted: false,
        detail:
          "macOS reports microphone access as denied. Enable T3 Code in System Settings → Privacy & Security → Microphone, then request again.",
      });
      return;
    }
    // Browser layer: triggers the in-app prompt and proves capture works.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setState({ kind: "result", granted: true, detail: "Microphone access is granted." });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setState({
        kind: "result",
        granted: false,
        detail:
          name === "NotAllowedError" || name === "SecurityError"
            ? osStatus === "not-determined" || osStatus === "unknown"
              ? "The system never showed a permission prompt. Quit and relaunch the app from Finder, then request again."
              : "Microphone access was denied at the browser layer. Allow the microphone for this app and request again."
            : name === "NotFoundError"
              ? "No microphone device was found."
              : "Could not open the microphone.",
      });
    }
  };

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={state.kind === "checking"}
        onClick={() => void request()}
      >
        {state.kind === "checking" ? "Requesting…" : "Request microphone access"}
      </Button>
      {state.kind === "result" && (
        <p
          className={`max-w-72 text-xs ${state.granted ? "text-muted-foreground" : "text-destructive"}`}
        >
          {state.detail}
        </p>
      )}
    </div>
  );
}


function PushAuthKeyControl({
  push,
  onUpdate,
}: {
  push: PushSettings;
  onUpdate: (patch: { authKey: string; authKeyRedacted: boolean }) => void;
}) {
  const [draft, setDraft] = useState("");
  const configured = push.authKeyRedacted === true;

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    onUpdate({ authKey: trimmed, authKeyRedacted: false });
    setDraft("");
  };

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
      <Input
        type="password"
        autoComplete="off"
        className="w-full sm:w-64"
        value={draft}
        placeholder={configured ? "Configured — paste a new key to replace" : "-----BEGIN PRIVATE KEY-----"}
        aria-label="APNs auth key"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        onBlur={commit}
      />
      {configured && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onUpdate({ authKey: "", authKeyRedacted: false })}
        >
          Remove key
        </Button>
      )}
    </div>
  );
}

export function VoiceSettingsPanel() {
  const voice = usePrimarySettings((settings) => settings.voice);
  const push = usePrimarySettings((settings) => settings.push);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice oracle">
        <SettingsRow
          {...searchableSetting("voice-openai-api-key")}
          description="Voice sessions run on the OpenAI Realtime API. The key is stored encrypted on the server and never sent to clients; only short-lived session tokens reach the browser."
          control={
            <VoiceApiKeyControl
              voice={voice}
              onUpdate={(patch) => updateSettings({ voice: patch })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("voice-realtime-model")}
          description={`Realtime speech model for the oracle. Leave blank for ${DEFAULT_VOICE_REALTIME_MODEL}.`}
          control={
            <VoiceTextSetting
              value={voice.model}
              placeholder={DEFAULT_VOICE_REALTIME_MODEL}
              ariaLabel="Voice realtime model"
              onCommit={(model) => updateSettings({ voice: { model } })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("voice-microphone-access")}
          description="Trigger the system microphone permission prompt without starting a voice session, and see exactly what the OS reports. Useful when a session says the microphone is blocked."
          control={<MicrophoneAccessControl />}
        />
        <SettingsRow
          {...searchableSetting("voice-oracle-voice")}
          description={`How the oracle sounds. Any OpenAI Realtime voice name works. Leave blank for ${DEFAULT_VOICE_REALTIME_VOICE}.`}
          control={
            <VoiceTextSetting
              value={voice.voice}
              placeholder={DEFAULT_VOICE_REALTIME_VOICE}
              ariaLabel="Oracle voice"
              onCommit={(next) => updateSettings({ voice: { voice: next } })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Phone notifications">
        <SettingsRow
          {...searchableSetting("push-enabled")}
          description="Notify paired phones when an agent finishes, fails, or needs you. This server talks to Apple directly with the key below — no T3 Connect account and nothing in between."
          control={
            <Switch
              checked={push.enabled}
              aria-label="Deliver push notifications from this server"
              onCheckedChange={(enabled) => updateSettings({ push: { enabled } })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("push-apns-auth-key")}
          description="The .p8 auth key from developer.apple.com → Certificates, Identifiers & Profiles → Keys. Stored encrypted on the server and never sent to clients."
          control={
            <PushAuthKeyControl push={push} onUpdate={(patch) => updateSettings({ push: patch })} />
          }
        />
        <SettingsRow
          {...searchableSetting("push-apns-key-id")}
          description="Key ID shown next to the auth key in the Apple developer portal."
          control={
            <VoiceTextSetting
              value={push.keyId}
              placeholder="ABCD123456"
              ariaLabel="APNs key id"
              onCommit={(keyId) => updateSettings({ push: { keyId } })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("push-apns-team-id")}
          description="Your Apple Developer team id."
          control={
            <VoiceTextSetting
              value={push.teamId}
              placeholder="ABCD123456"
              ariaLabel="Apple team id"
              onCommit={(teamId) => updateSettings({ push: { teamId } })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("push-bundle-id")}
          description="Bundle id of the mobile app that receives the notifications."
          control={
            <VoiceTextSetting
              value={push.bundleId}
              placeholder="co.example.app"
              ariaLabel="Mobile app bundle id"
              onCommit={(bundleId) => updateSettings({ push: { bundleId } })}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
