# Roost card wall: where it attaches to upstream

The card wall (board) is Roost-only. Its code lives in its own folders, which
upstream T3 Code never touches:

- `apps/server/src/board/`: storage (`BoardService`), the summarizer, approvals,
  nudges, checks, the mini PR, the automatic reviewers, the agents' `t3_card_update` toolkit (`board/mcp/`), and the RPC handlers and
  layers (`BoardServer.ts`, `rpcRegistry.ts`).
- `apps/web/src/components/board/`: every board UI, its styles (`board.css`), its
  client atoms (`boardAtoms.ts`) and its entry points (`BoardEntryPoints.tsx`).
- `packages/contracts/src/board.ts` (types) and `boardRpc.ts` (the RPC group).

Agents learn the board only from the `t3_card_update` tool description. Roost
adds nothing to their prompts, first messages or turn ends; each project's
agent file (AGENTS.md, CLAUDE.md) says when to update the card.

Everything else is a hook-in: a line or two in an upstream file that points at
those folders. On an upstream merge, a conflict in one of these files is resolved
by keeping upstream's version and putting the hook-in back. This is the list.

## Server

| File                                                                | Hook-in                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts`                                         | import `BoardServer`; `Layer.provide(BoardServer.layer)` in `layerMakeRoutes`                                                                                                                           |
| `apps/server/src/ws.ts`                                             | import `BoardServer`; `yield* BoardServer.rpcHandlers` and `...boardHandlers` first in `ServerWsRpcGroup.of`; `yield* BoardServer.captureLayer` and `Layer.provide(boardLayer)` in the per-socket layer |
| `apps/server/src/auth/RpcAuthorization.ts`                          | import; `...BOARD_RPC_REQUIRED_SCOPES` at the end of `RPC_REQUIRED_SCOPES`                                                                                                                              |
| `apps/server/src/observability/RpcInstrumentation.ts`               | import; `...BOARD_RPC_AGGREGATES` at the end of `RPC_AGGREGATES`                                                                                                                                        |
| `apps/server/src/mcp/McpHttpServer.ts`                              | import `BoardToolkit` and `BoardHandlers`; `toolkitRegistration(BoardToolkit, BoardHandlers.layer)` at the end of `layerTools`                                                                          |
| `apps/server/src/ws.test.ts`, `provider/AgentContextBudget.test.ts` | `BoardServer.layerUnused` beside the other unused mocks                                                                                                                                                 |
| `apps/server/src/provider/agentContextBudget.json`                  | the measured prompt and tool bytes, which include the board's                                                                                                                                           |

## Shared packages

| File                                           | Hook-in                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                | import; `...BOARD_WS_METHODS` at the end of `WS_METHODS`; `...BOARD_RPCS` at the end of `WsRpcGroup` |
| `packages/contracts/src/index.ts`              | `export * from "./board.ts"` and `"./boardRpc.ts"`                                                   |
| `packages/shared/src/t3McpToolPresentation.ts` | the `t3_card_update` presentation entry                                                              |
| `packages/client-runtime/src/t3ToolSummary.ts` | the `t3_card_update` summary case                                                                    |

## Web

| File                                                             | Hook-in                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/index.css`                                         | `@import "./components/board/board.css"`                                                                                                                                                                             |
| `apps/web/src/routes/_chat.board.tsx`, `routeTree.gen.ts`        | the `/board` route (the tree is generated)                                                                                                                                                                           |
| `apps/web/src/rightPanelStore.ts`                                | `"board"` in `RIGHT_PANEL_KINDS`, the surface union and `singletonSurface`                                                                                                                                           |
| `apps/web/src/components/RightPanelTabs.tsx`                     | import; `onAddBoard` props; `...boardSurfaceMenuItems(props.onAddBoard)` in both add menus; the `"board"` cases in `surfaceTitle` and `SurfaceIcon`                                                                  |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`      | the `"board"` case rendering `BoardPanel`                                                                                                                                                                            |
| `apps/web/src/components/ChatView.tsx`                           | `onAddBoard` on `ChatRightPanel`; also `widthStorageKey="t3code:preview-panel-width"`, one right-panel width for every thread (upstream keys it per thread, which resized the panel when a card opened another chat) |
| `apps/web/src/components/chat/ChatHeader.tsx`                    | `ThreadBoardButton`                                                                                                                                                                                                  |
| `apps/web/src/components/Sidebar.tsx`                            | `SidebarBoardEntry` under the meetings entry                                                                                                                                                                         |
| `apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx` | `ProjectBoardButton` in the hover actions                                                                                                                                                                            |
| `apps/web/src/components/LegacySidebar.tsx`                      | `SidebarBoardEntry` and `LegacyProjectBoardButton`                                                                                                                                                                   |

Data lives in `roost_*` tables the board creates itself (`CREATE TABLE IF NOT
EXISTS`), never in upstream's numbered migrations, so a merge never collides on
a migration number.

## After a merge

1. `vp run typecheck`: the auth and instrumentation maps are exhaustive, so an
   RPC that lost its hook-in fails here.
2. `vp test run src/board src/mcp src/provider/AgentContextBudget.test.ts src/ws.test.ts`
   in `apps/server`, and `vp test run src/components/board` in `apps/web`.
3. Open a thread with the Board tab beside it: the card wall, the sidebar entry,
   the project button and the header button should all be there.
