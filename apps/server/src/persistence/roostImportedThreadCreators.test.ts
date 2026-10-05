import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { repairImportedThreadCreators } from "./roostImportedThreadCreators.ts";

it.effect("says who started each thread copied from V1, once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const thread = (id: string, createdBy: string, historyOrigin: string | null) => {
      const payload = JSON.stringify({ id, createdBy, creationSource: "server", historyOrigin });
      return sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default',
          '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', ${payload})
      `;
    };
    const message = (threadId: string, at: string, role: string, text: string) => sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`${threadId}-${at}`}, ${threadId}, ${role}, ${text}, 0, ${at}, ${at})
    `;
    yield* thread("review", "system", "v1_import");
    yield* message(
      "review",
      "2026-09-20T00:00:01.000Z",
      "user",
      '[Started by the agent in thread "plan" (p), not typed by the user. …]\n\nReview it',
    );
    yield* message(
      "review",
      "2026-09-20T00:00:02.000Z",
      "user",
      "[Started by the agent in thread …] later",
    );
    yield* thread("asked", "system", "v1_import");
    yield* message("asked", "2026-09-20T00:00:01.000Z", "user", "Fix the login loop");
    // An agent's message later in a thread the user opened does not make it agent-started.
    yield* message(
      "asked",
      "2026-09-20T00:00:03.000Z",
      "user",
      '[Sent by the agent in thread "x" …]',
    );
    yield* thread("empty", "system", "v1_import");
    yield* thread("native", "system", null);
    yield* thread("launched", "agent", "v1_import");

    yield* repairImportedThreadCreators;
    const read = sql<{ readonly id: string; readonly createdBy: string; readonly source: string }>`
      SELECT thread_id AS id,
        json_extract(payload_json, '$.createdBy') AS createdBy,
        json_extract(payload_json, '$.creationSource') AS source
      FROM orchestration_v2_projection_threads ORDER BY thread_id
    `;
    const expected = [
      { id: "asked", createdBy: "user", source: "server" },
      { id: "empty", createdBy: "user", source: "server" },
      { id: "launched", createdBy: "agent", source: "server" },
      { id: "native", createdBy: "system", source: "server" },
      { id: "review", createdBy: "agent", source: "mcp" },
    ];
    assert.deepStrictEqual(yield* read, expected);

    // A second launch finds nothing left to do.
    yield* message(
      "asked",
      "2026-09-20T00:00:00.000Z",
      "user",
      "[Started by the agent in thread …]",
    );
    yield* repairImportedThreadCreators;
    assert.deepStrictEqual(yield* read, expected);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
