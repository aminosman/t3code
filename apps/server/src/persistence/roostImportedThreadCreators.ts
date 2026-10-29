import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// V1 agent-created threads identify their creator in the first message.
// Correct only imported projection rows still marked system; they have no V2 events.
// Run after migrations without consuming upstream’s migration sequence.
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
