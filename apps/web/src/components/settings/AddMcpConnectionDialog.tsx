import {
  McpConnectionId,
  MCP_CONNECTION_RESERVED_IDS,
  type EnvironmentId,
  type McpConnection,
  type McpConnectionHttpAuth,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

type Transport = "http" | "stdio";

const AUTH_LABELS: Readonly<Record<McpConnectionHttpAuth, string>> = {
  oauth: "Sign in (OAuth)",
  bearer: "API key",
  none: "None",
};

/** A slug every CLI accepts as a server key: lowercase, dashes, 32 chars. */
export function mcpConnectionIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

const isValidId = (value: string) =>
  /^[a-z0-9][a-z0-9-]{0,31}$/u.test(value) && !MCP_CONNECTION_RESERVED_IDS.has(value);

/** Split a command line into argv the way a shell would for simple cases. */
function splitArgs(value: string): string[] {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^(["'])(.*)\1$/u, "$2"));
}

interface EnvRow {
  /** Stable per row so edits keep focus; env names are not unique while typing. */
  readonly key: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
}

/**
 * Adds or edits one user MCP connection on one environment. Secrets (an API
 * key, a sensitive env value) are sent once through their own RPC and kept in
 * that server's secret store; settings only carry the definition.
 */
export function AddMcpConnectionDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  existing,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** When set, the dialog edits this connection instead of adding one. */
  readonly existing?: { readonly id: McpConnectionId; readonly config: McpConnection };
}) {
  const upsert = useAtomCommand(serverEnvironment.upsertMcpConnection, {
    reportFailure: false,
    reportDefect: false,
  });
  const initialTransport = existing?.config.transport;
  const [name, setName] = useState(existing?.config.name ?? "");
  const [id, setId] = useState<string>(existing?.id ?? "");
  const [idTouched, setIdTouched] = useState(existing !== undefined);
  const [transport, setTransport] = useState<Transport>(initialTransport?.type ?? "http");
  const [url, setUrl] = useState(initialTransport?.type === "http" ? initialTransport.url : "");
  const [auth, setAuth] = useState<McpConnectionHttpAuth>(
    initialTransport?.type === "http" ? initialTransport.auth : "oauth",
  );
  const [scopes, setScopes] = useState(
    initialTransport?.type === "http" ? (initialTransport.scopes ?? "") : "",
  );
  const [clientId, setClientId] = useState(
    initialTransport?.type === "http" ? (initialTransport.oauthClientId ?? "") : "",
  );
  const [commandLine, setCommandLine] = useState(
    initialTransport?.type === "stdio"
      ? [initialTransport.command, ...initialTransport.args].join(" ")
      : "",
  );
  const [env, setEnv] = useState<ReadonlyArray<EnvRow>>(() =>
    initialTransport?.type === "stdio"
      ? initialTransport.env.map((row, index) => ({ ...row, key: `${index}` }))
      : [],
  );
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveId = idTouched ? id : mcpConnectionIdFromName(name);
  const trimmedUrl = url.trim();
  const commandParts = splitArgs(commandLine.trim());
  const canSave =
    name.trim().length > 0 &&
    isValidId(effectiveId) &&
    (transport === "http" ? /^https?:\/\//u.test(trimmedUrl) : commandParts.length > 0);

  const close = () => {
    setError(null);
    onOpenChange(false);
  };

  const save = async () => {
    if (!canSave || pending) return;
    const config: McpConnection =
      transport === "http"
        ? {
            name: name.trim(),
            enabled: existing?.config.enabled ?? true,
            transport: {
              type: "http",
              url: trimmedUrl,
              auth,
              ...(auth === "oauth" && scopes.trim() ? { scopes: scopes.trim() } : {}),
              ...(auth === "oauth" && clientId.trim() ? { oauthClientId: clientId.trim() } : {}),
            },
          }
        : {
            name: name.trim(),
            enabled: existing?.config.enabled ?? true,
            transport: {
              type: "stdio",
              command: commandParts[0]!,
              args: commandParts.slice(1),
              env: env
                .filter((row) => row.name.trim().length > 0)
                .map((row): ProviderInstanceEnvironmentVariable => ({
                  name: row.name.trim(),
                  value: row.value,
                  sensitive: row.sensitive,
                  ...(row.valueRedacted ? { valueRedacted: true } : {}),
                })),
            },
          };
    setPending(true);
    setError(null);
    try {
      const result = await upsert({
        environmentId,
        input: { id: McpConnectionId.make(effectiveId), config },
      });
      if (result._tag === "Success") {
        close();
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save the connection.");
    } finally {
      setPending(false);
    }
  };

  const updateEnv = (index: number, patch: Partial<EnvRow>) =>
    setEnv((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.config.name}` : "Add an MCP connection"}
          </DialogTitle>
          <DialogDescription>
            Every agent on {environmentLabel} gets this server, already signed in. Sign-ins and keys
            stay on that server, per project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-connection-name">Name</Label>
              <Input
                id="mcp-connection-name"
                placeholder="Oneleet"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus={existing === undefined}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-connection-id">Server key</Label>
              <Input
                id="mcp-connection-id"
                placeholder="oneleet"
                value={effectiveId}
                disabled={existing !== undefined}
                onChange={(event) => {
                  setIdTouched(true);
                  setId(event.target.value.toLowerCase());
                }}
              />
              <p className="text-xs text-muted-foreground">
                How agents name the server, as in <code>mcp__{effectiveId || "key"}__tool</code>.
                Lowercase letters, digits and dashes.
              </p>
            </div>
            {existing === undefined ? (
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-connection-transport">Kind</Label>
                <Select
                  value={transport}
                  onValueChange={(value) => setTransport((value as Transport | null) ?? "http")}
                >
                  <SelectTrigger id="mcp-connection-transport">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="http">Remote server (HTTP)</SelectItem>
                    <SelectItem value="stdio">Local command (stdio)</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {transport === "http" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-connection-url">Server URL</Label>
                  <Input
                    id="mcp-connection-url"
                    placeholder="https://api.oneleet.com/mcp"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-connection-auth">Authentication</Label>
                  <Select
                    value={auth}
                    onValueChange={(value) =>
                      setAuth((value as McpConnectionHttpAuth | null) ?? "oauth")
                    }
                  >
                    <SelectTrigger id="mcp-connection-auth">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {(Object.keys(AUTH_LABELS) as ReadonlyArray<McpConnectionHttpAuth>).map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {AUTH_LABELS[value]}
                          </SelectItem>
                        ),
                      )}
                    </SelectPopup>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {auth === "oauth"
                      ? "Each project signs in from its own row once the connection exists."
                      : auth === "bearer"
                        ? "Each project pastes its key on its own row once the connection exists."
                        : "The server takes requests without credentials."}
                  </p>
                </div>
                {auth === "oauth" ? (
                  <div className="grid gap-2">
                    <button
                      type="button"
                      className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => setAdvanced((value) => !value)}
                    >
                      {advanced ? "Hide advanced" : "Advanced"}
                    </button>
                    {advanced ? (
                      <>
                        <div className="grid gap-1.5">
                          <Label htmlFor="mcp-connection-scopes">Scopes (optional)</Label>
                          <Input
                            id="mcp-connection-scopes"
                            placeholder="Space-separated; defaults to what the server advertises"
                            value={scopes}
                            onChange={(event) => setScopes(event.target.value)}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="mcp-connection-client-id">Client id (optional)</Label>
                          <Input
                            id="mcp-connection-client-id"
                            placeholder="Only for servers without dynamic client registration"
                            value={clientId}
                            onChange={(event) => setClientId(event.target.value)}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-connection-command">Command</Label>
                  <Input
                    id="mcp-connection-command"
                    placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp"
                    value={commandLine}
                    onChange={(event) => setCommandLine(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Roost runs it once and shares it with every agent.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Environment</Label>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setEnv((rows) => [
                          ...rows,
                          {
                            key: `${Date.now()}-${rows.length}`,
                            name: "",
                            value: "",
                            sensitive: true,
                          },
                        ])
                      }
                    >
                      Add variable
                    </Button>
                  </div>
                  {env.map((row, index) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2"
                    >
                      <Input
                        aria-label="Variable name"
                        placeholder="API_KEY"
                        value={row.name}
                        onChange={(event) => updateEnv(index, { name: event.target.value })}
                      />
                      <Input
                        aria-label="Variable value"
                        type={row.sensitive ? "password" : "text"}
                        autoComplete="off"
                        placeholder={
                          row.valueRedacted ? "Stored secret - enter a new value to replace" : ""
                        }
                        value={row.value}
                        onChange={(event) => updateEnv(index, { value: event.target.value })}
                      />
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={row.sensitive}
                          onChange={(event) =>
                            updateEnv(index, {
                              sensitive: event.target.checked,
                              ...(event.target.checked ? {} : { valueRedacted: false }),
                            })
                          }
                        />
                        secret
                      </label>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        aria-label="Remove variable"
                        onClick={() => setEnv((rows) => rows.filter((_, i) => i !== index))}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave || pending}>
            {existing ? "Save" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
