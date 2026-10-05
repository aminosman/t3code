import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Roost: say who started each thread copied over from V1.
 *
 * Upstream's V1 import writes every copied thread as created by "system", so
 * nothing tells a thread the user opened from one an agent started — and the
 * sidebar marks agent-started threads (Amin, Oct 5 2026: "show an icon or
 * indicator on a thread of if it was a user or an agent that created a
 * thread"). V1 had no such field, but every thread Roost's old
 * t3_thread_create started with a prompt opened with the line it wrote:
 * "[Started by the agent in thread …". So a copied thread whose first user
 * message begins that way was started by an agent; any other was opened by the
 * user (from the app, or by tui on the user's word).
 *
 * Copied threads have no V2 events behind them — the projection row is the
 * record — so the row is corrected in place. Runs at every launch after the
 * migrations and touches only rows still marked "system", so it is a no-op
 * once done. Not a numbered migration: upstream owns that sequence.
 */
export const repairImportedThreadCreators = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('orchestration_v2_projection_threads', 'projection_thread_messages')
  `;
  if (tables.length < 2) return;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = CASE
      WHEN (
        SELECT message.text FROM projection_thread_messages AS message
        WHERE message.thread_id = orchestration_v2_projection_threads.thread_id
          AND message.role = 'user'
        ORDER BY message.created_at, message.message_id
        LIMIT 1
      ) LIKE '[Started by the agent in thread%'
      THEN json_set(payload_json, '$.createdBy', 'agent', '$.creationSource', 'mcp')
      ELSE json_set(payload_json, '$.createdBy', 'user')
    END
    WHERE json_extract(payload_json, '$.historyOrigin') = 'v1_import'
      AND json_extract(payload_json, '$.createdBy') = 'system'
  `;
});
