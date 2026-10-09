# MCP connections

An MCP connection is a third-party MCP server you add to Roost once. Every agent in every
thread gets it, whatever provider it runs on, already signed in. You never configure a
provider's CLI, and no agent ever holds the server's token: Roost proxies each call and puts
the real credential on it.

## Adding a server

Open **Settings → MCP connections → Add connection**. Give it a name, and Roost derives the
server key agents will see (for example `oneleet`, so Claude shows tools as
`mcp__oneleet__…`). Then pick the kind:

- **Remote server (HTTP)** with the server's MCP URL and how it authenticates:
  - **Sign in (OAuth)** for servers that follow the MCP authorization spec (Oneleet, PostHog
    and most hosted MCP servers). Roost registers itself with the server's authorization server
    when it offers that, otherwise paste the client id the vendor issued you under _Advanced_.
  - **API key** for servers that take a static bearer token.
  - **None** for servers without authentication.
- **Local command (stdio)** with the command line to run. Roost runs it once and shares it with
  every agent. Mark environment variables as secret and their values live in the server's
  secret store, never in settings.

## Signing in per project

Sign-ins and API keys belong to a project, so one project can use one Oneleet workspace and
another project a different one. Pick the project in the settings scope, then on the connection's
row click **Connect** and finish in your browser, or paste the project's API key. Agents in
that project get the server on their next session; projects that are not signed in do not see
it at all.

Use **Test** to list the server's tools through the stored credential. **Disconnect** forgets
the project's sign-in. **Remove** deletes the connection and every project's credential for it.

The phone app shows the same connections under **Settings → MCP connections** and can sign a
project in or paste a key; adding and editing connections is done on web or desktop.

## Notes

- OAuth access tokens are refreshed by Roost in the background. If a server revokes the
  sign-in, the row shows **Needs sign-in** and the agent is told to ask you to reconnect.
- Claude sessions load only the servers Roost gives them, so entries in `~/.claude.json` are
  not loaded twice.
- Tool calls from a connection show the connection's name and site icon in the timeline.
