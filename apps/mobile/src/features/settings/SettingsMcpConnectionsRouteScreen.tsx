import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  McpConnectionId,
  type McpConnection,
  type McpConnectionStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

/**
 * MCP connections on each connected environment: which servers exist and,
 * per project, whether this project is signed in. Adding and editing happens
 * in web or desktop Settings; here a project signs in, pastes a key, or
 * disconnects.
 */
export function SettingsMcpConnectionsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="MCP connections" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentConnections key={environment.environmentId} environment={environment} />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentConnections({ environment }: { readonly environment: SettingsTarget }) {
  const connections = Object.entries(environment.serverConfig.settings.mcpConnections);
  const projects = useProjects().filter(
    (project) => project.environmentId === environment.environmentId,
  );
  const statuses = useEnvironmentQuery(
    serverEnvironment.mcpConnectionStatuses({
      environmentId: environment.environmentId,
      input: {},
    }),
  );
  return (
    <SettingsSection title={environment.label}>
      {connections.length === 0 ? (
        <Text className="p-4 text-foreground-muted">
          No MCP connections. Add one in web or desktop Settings.
        </Text>
      ) : (
        connections.map(([rawId, config]) => (
          <ConnectionCard
            key={rawId}
            environment={environment}
            id={McpConnectionId.make(rawId)}
            config={config}
            projects={projects}
            statuses={statuses.data ?? []}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ConnectionCard({
  environment,
  id,
  config,
  projects,
  statuses,
}: {
  readonly environment: SettingsTarget;
  readonly id: McpConnectionId;
  readonly config: McpConnection;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly statuses: ReadonlyArray<McpConnectionStatus>;
}) {
  const perProject = config.transport.type === "http" && config.transport.auth !== "none";
  const summary =
    config.transport.type === "stdio"
      ? "Local command"
      : config.transport.auth === "none"
        ? "No sign-in needed"
        : config.transport.auth === "bearer"
          ? "API key per project"
          : "Sign in per project";
  return (
    <View className="border-b border-border-subtle">
      <View className="gap-1 p-4">
        <Text className="text-lg font-semibold text-foreground">
          {config.name}
          {config.enabled ? "" : " (off)"}
        </Text>
        <Text className="text-sm text-foreground-muted">{summary}</Text>
      </View>
      {perProject
        ? projects.map((project) => (
            <ProjectRow
              key={project.id}
              environment={environment}
              id={id}
              config={config}
              project={project}
              status={statuses.find(
                (status) => status.connectionId === id && status.projectId === project.id,
              )}
            />
          ))
        : null}
    </View>
  );
}

function ProjectRow({
  environment,
  id,
  config,
  project,
  status,
}: {
  readonly environment: SettingsTarget;
  readonly id: McpConnectionId;
  readonly config: McpConnection;
  readonly project: { readonly id: ProjectId; readonly title: string };
  readonly status: McpConnectionStatus | undefined;
}) {
  const environmentId = environment.environmentId;
  const prepared = usePreparedConnection(environmentId);
  const httpBaseUrl = prepared._tag === "Some" ? prepared.value.httpBaseUrl : null;
  const options = { reportFailure: false, reportDefect: false };
  const connect = useAtomCommand(serverEnvironment.connectMcpConnection, options);
  const disconnect = useAtomCommand(serverEnvironment.disconnectMcpConnection, options);
  const setKey = useAtomCommand(serverEnvironment.setMcpConnectionBearerToken, options);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKeyDraft] = useState("");
  const bearer = config.transport.type === "http" && config.transport.auth === "bearer";
  const connected = status?.state === "connected";

  async function run<A>(command: () => Promise<AtomCommandResult<A, unknown>>): Promise<A | null> {
    setPending(true);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Success") return result.value;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The request failed.");
      return null;
    } catch {
      setError("The request failed.");
      return null;
    } finally {
      setPending(false);
    }
  }

  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-base font-medium text-foreground">{project.title}</Text>
      <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
        {error ??
          status?.detail ??
          (connected ? "Connected." : bearer ? "Paste this project's API key." : "Needs sign-in.")}
      </Text>
      {bearer && !pending ? (
        <>
          <TextInput
            accessibilityLabel={`${config.name} API key`}
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={connected ? "Stored - enter a new key to replace" : "API key"}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={key}
            onChangeText={setKeyDraft}
          />
          <SettingsActionRow
            icon="link"
            label="Save key"
            disabled={key.trim().length === 0}
            onPress={() => {
              void run(() =>
                setKey({ environmentId, input: { id, projectId: project.id, token: key } }),
              ).then((saved) => {
                if (saved !== null) setKeyDraft("");
              });
            }}
          />
        </>
      ) : null}
      {!bearer && !connected ? (
        <SettingsActionRow
          icon="globe"
          label="Sign in"
          loading={pending}
          disabled={pending || httpBaseUrl === null}
          onPress={() => {
            if (httpBaseUrl === null) return;
            void run(() =>
              connect({
                environmentId,
                input: { id, projectId: project.id, callbackOrigin: httpBaseUrl },
              }),
            ).then((result) => {
              if (result === null) return;
              Linking.openURL(result.authorizationUrl).catch(() =>
                setError("Could not open the sign-in page."),
              );
            });
          }}
        />
      ) : null}
      {connected ? (
        <SettingsActionRow
          icon="xmark"
          label="Disconnect"
          disabled={pending}
          onPress={() => {
            void run(() => disconnect({ environmentId, input: { id, projectId: project.id } }));
          }}
        />
      ) : null}
    </View>
  );
}
