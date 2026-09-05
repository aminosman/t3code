import {
  DEFAULT_VOICE_REALTIME_MODEL,
  DEFAULT_VOICE_REALTIME_VOICE,
  type VoiceSettings,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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

export function VoiceSettingsPanel() {
  const voice = usePrimarySettings((settings) => settings.voice);
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
    </SettingsPageContainer>
  );
}
