import {
  McpConnectionId,
  type EnvironmentId,
  type McpConnection,
  type McpConnectionStatus,
  type ProjectId,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { Plus as PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AddMcpConnectionDialog } from "./AddMcpConnectionDialog";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings > MCP connections. Definitions are per environment; sign-in state
 * is per project, so the project scope picks which project's rows show. At
 * environment scope every project on that environment is listed.
 */
export function McpConnectionsSettingsPanel() {
  const { environment: selected, scope, groups } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;
  const connections = connected ? selected.serverConfig.settings.mcpConnections : {};
  const projects = useMemo(() => {
    if (environmentId === null) return [];
    const members =
      scope.kind === "project" || scope.kind === "checkout"
        ? scope.members
        : groups.flatMap((group) => group.memberProjects);
    return members
      .filter((member) => member.environmentId === environmentId)
      .map((member) => ({ id: member.id, title: member.title }));
  }, [environmentId, groups, scope]);
  const [adding, setAdding] = useState(false);

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("mcp-connections")}
        title="MCP connections"
        headerAction={
          environmentId !== null ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add connection
            </Button>
          ) : null
        }
      >
        {environmentId === null ? (
          <SettingsRow title="Select a connected environment." />
        ) : Object.keys(connections).length === 0 ? (
          <SettingsRow
            title="No connections yet."
            description="Add an MCP server once and every agent on this environment gets it, signed in per project."
          />
        ) : (
          Object.entries(connections).map(([rawId, config]) => (
            <McpConnectionRows
              key={rawId}
              environmentId={environmentId}
              environmentLabel={selected?.label ?? "this environment"}
              id={McpConnectionId.make(rawId)}
              config={config}
              projects={projects}
            />
          ))
        )}
      </SettingsSection>
      {adding && environmentId !== null ? (
        <AddMcpConnectionDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={selected?.label ?? "this environment"}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function describeTransport(config: McpConnection): string {
  if (config.transport.type === "stdio") {
    return `Local command · ${[config.transport.command, ...config.transport.args].join(" ")}`;
  }
  const host = (() => {
    try {
      return new URL(config.transport.url).host;
    } catch {
      return config.transport.url;
    }
  })();
  const auth =
    config.transport.auth === "oauth"
      ? "Sign in"
      : config.transport.auth === "bearer"
        ? "API key"
        : "No auth";
  return `${host} · ${auth}`;
}

function McpConnectionRows({
  environmentId,
  environmentLabel,
  id,
  config,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly id: McpConnectionId;
  readonly config: McpConnection;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}) {
  const statuses = useEnvironmentQuery(
    serverEnvironment.mcpConnectionStatuses({ environmentId, input: {} }),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertMcpConnection, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const perProject = config.transport.type === "http" && config.transport.auth !== "none";
  const statusFor = (projectId: ProjectId | null) =>
    statuses.data?.find((status) => status.connectionId === id && status.projectId === projectId);

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {config.name}
            {!config.enabled ? <Badge variant="secondary">Off</Badge> : null}
          </span>
        }
        description={<span className="break-all">{describeTransport(config)}</span>}
        control={
          <span className="flex items-center gap-2">
            {!perProject ? (
              <TestButton environmentId={environmentId} id={id} projectId={null} />
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <RemoveConnectionButton environmentId={environmentId} id={id} name={config.name} />
            <Switch
              aria-label={`Enable ${config.name}`}
              checked={config.enabled}
              onCheckedChange={(enabled) =>
                void upsert({ environmentId, input: { id, config: { ...config, enabled } } })
              }
            />
          </span>
        }
      />
      {perProject ? (
        projects.length === 0 ? (
          <SettingsRow
            className="pl-6"
            title="No projects on this environment yet."
            description="Sign-ins are per project; add a project to connect."
          />
        ) : (
          projects.map((project) => (
            <ProjectAuthRow
              key={project.id}
              environmentId={environmentId}
              id={id}
              config={config}
              project={project}
              status={statusFor(project.id)}
            />
          ))
        )
      ) : null}
      {editing ? (
        <AddMcpConnectionDialog
          open
          onOpenChange={setEditing}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          existing={{ id, config }}
        />
      ) : null}
    </>
  );
}

function statusBadge(status: McpConnectionStatus | undefined) {
  if (status === undefined || status.state === "needs_sign_in") {
    return <Badge variant="warning">Needs sign-in</Badge>;
  }
  if (status.state === "error") return <Badge variant="error">Error</Badge>;
  return <Badge variant="success">Connected</Badge>;
}

function ProjectAuthRow({
  environmentId,
  id,
  config,
  project,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectionId;
  readonly config: McpConnection;
  readonly project: { readonly id: ProjectId; readonly title: string };
  readonly status: McpConnectionStatus | undefined;
}) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const options = { reportFailure: false, reportDefect: false };
  const connect = useAtomCommand(serverEnvironment.connectMcpConnection, options);
  const disconnect = useAtomCommand(serverEnvironment.disconnectMcpConnection, options);
  const setKey = useAtomCommand(serverEnvironment.setMcpConnectionBearerToken, options);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    } finally {
      setPending(false);
    }
  }

  const signIn = async () => {
    // The redirect must land on this server as the browser reaches it, not
    // on the desktop renderer's own origin.
    const callbackOrigin = httpBaseUrl ?? window.location.origin;
    // Browsers block tabs opened after an await; reserve one first on the web.
    const reserved = window.desktopBridge ? null : window.open("", "_blank");
    if (reserved) reserved.opener = null;
    const result = await run(() =>
      connect({
        environmentId,
        input: {
          id,
          projectId: project.id,
          callbackOrigin,
          returnUrl: `${window.location.origin}/settings/mcp`,
        },
      }),
    );
    const authorizationUrl = result?.authorizationUrl;
    if (!authorizationUrl) {
      reserved?.close();
      return;
    }
    try {
      if (reserved) reserved.location.href = authorizationUrl;
      else await ensureLocalApi().shell.openExternal(authorizationUrl);
    } catch {
      reserved?.close();
      setError("Could not open the sign-in page.");
    }
  };

  return (
    <SettingsRow
      className="pl-6"
      title={project.title}
      status={statusBadge(status)}
      description={
        error ? (
          <span role="alert" className="text-destructive-foreground">
            {error}
          </span>
        ) : status?.detail ? (
          status.detail
        ) : bearer ? (
          connected ? (
            "An API key is stored for this project."
          ) : (
            "Paste this project's API key."
          )
        ) : connected ? (
          "Signed in for this project."
        ) : (
          "Sign in once in your browser."
        )
      }
      control={
        <span className="flex items-center gap-2">
          {connected ? (
            <TestButton environmentId={environmentId} id={id} projectId={project.id} />
          ) : null}
          {bearer ? (
            <DraftInput
              aria-label={`${config.name} API key for ${project.title}`}
              type="password"
              autoComplete="off"
              size="sm"
              placeholder={connected ? "Stored - enter a new key to replace" : "API key"}
              value=""
              onCommit={(next) => {
                if (next.trim().length === 0) return;
                void run(() =>
                  setKey({ environmentId, input: { id, projectId: project.id, token: next } }),
                );
              }}
            />
          ) : connected ? null : (
            <Button size="xs" variant="outline" disabled={pending} onClick={() => void signIn()}>
              Connect
            </Button>
          )}
          {connected ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void run(() => disconnect({ environmentId, input: { id, projectId: project.id } }))
              }
            >
              Disconnect
            </Button>
          ) : null}
        </span>
      }
    />
  );
}

/** Lists the server's tools through the stored credential, proving the path agents will use. */
function TestButton({
  environmentId,
  id,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectionId;
  readonly projectId: ProjectId | null;
}) {
  const test = useAtomCommand(serverEnvironment.testMcpConnection, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    readonly serverName?: string;
    readonly tools: ReadonlyArray<{ readonly name: string }>;
  } | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void test({ environmentId, input: { id, projectId } })
                .then((outcome) => {
                  if (outcome._tag === "Success") {
                    setResult(outcome.value);
                    setOpen(true);
                  } else {
                    const failure = squashAtomCommandFailure(outcome);
                    toastManager.add({
                      type: "error",
                      title: "Connection test failed",
                      description:
                        failure instanceof Error ? failure.message : "The server did not answer.",
                    });
                  }
                })
                .finally(() => setPending(false));
            }}
          >
            {pending ? "Testing…" : "Test"}
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="end" width="md">
        <div className="grid gap-2">
          <p className="text-sm font-semibold leading-tight text-foreground">
            {result?.serverName ?? "Tools"} · {result?.tools.length ?? 0}
          </p>
          <ul className="max-h-64 overflow-auto text-xs text-muted-foreground">
            {result?.tools.map((tool) => (
              <li key={tool.name} className="font-mono">
                {tool.name}
              </li>
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Removing a connection deletes every project's sign-in and key for it. */
function RemoveConnectionButton({
  environmentId,
  id,
  name,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectionId;
  readonly name: string;
}) {
  const remove = useAtomCommand(serverEnvironment.removeMcpConnection, { reportFailure: false });
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Every project's sign-in and key for this server is deleted. Agents lose its tools on
              their next session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                void remove({ environmentId, input: { id } });
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
