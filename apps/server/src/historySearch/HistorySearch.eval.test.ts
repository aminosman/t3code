/**
 * A yardstick for ranking changes, run against a real history.
 *
 * Search quality cannot be judged on a fixture of five messages: everything
 * is findable in a haystack that small. This runs the real service over a copy
 * of a real state database and scores it on questions whose right answers are
 * known — by where the first right thread or meeting lands. The cases name
 * private threads and meetings, so they live outside the repository:
 *
 *   HISTORY_EVAL_DB=/tmp/state-copy.sqlite \
 *   HISTORY_EVAL_CASES=~/.config/roost/history-eval.json \
 *   vp test run src/historySearch/HistorySearch.eval.test.ts --silent=false
 *
 * `{ "cases": [{ "query": "...", "expect": ["<id prefix>", ...] }] }`. Use a
 * COPY of the database; the index is written into it. HISTORY_EVAL_WORDS_ONLY=1
 * scores word search alone. Skipped when the variables are not set.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import * as Embedder from "./Embedder.ts";
import * as HistorySearch from "./HistorySearch.ts";

const database = process.env.HISTORY_EVAL_DB;
const casesFile = process.env.HISTORY_EVAL_CASES;
const wordsOnly = process.env.HISTORY_EVAL_WORDS_ONLY === "1";

const Cases = Schema.fromJsonString(
  Schema.Struct({
    cases: Schema.Array(
      Schema.Struct({ query: Schema.String, expect: Schema.Array(Schema.String) }),
    ),
  }),
);

const decodeCases = Schema.decodeUnknownEffect(Cases);

it.live.skipIf(database === undefined || casesFile === undefined)(
  "ranks the known answers of a real history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { cases } = yield* decodeCases(
        yield* fs.readFileString(casesFile!.replace(/^~/u, process.env.HOME ?? "~")),
      );
      const search = yield* HistorySearch.HistorySearch;
      const state = yield* search.refresh;
      const lines = [
        `index: ${state.messages} messages, ${state.meetings} meetings, ${state.embedded} embedded` +
          (wordsOnly ? " (words only)" : ""),
      ];
      let reciprocal = 0;
      let inTopFive = 0;
      for (const item of cases) {
        const found = yield* search.search({ query: item.query, limit: 20 });
        const rank =
          found.results.findIndex((result) =>
            item.expect.some((prefix) => result.id.startsWith(prefix)),
          ) + 1;
        reciprocal += rank === 0 ? 0 : 1 / rank;
        if (rank >= 1 && rank <= 5) inTopFive += 1;
        const top = found.results[0];
        lines.push(
          `${rank === 0 ? " -" : String(rank).padStart(2)}  ${item.query}` +
            (rank === 1 ? "" : `   [first: ${top?.title.slice(0, 40).replaceAll("\n", " ")}]`),
        );
      }
      lines.push(
        `top-5: ${inTopFive}/${cases.length}   MRR: ${(reciprocal / cases.length).toFixed(3)}`,
      );
      yield* Effect.sync(() => process.stdout.write(`${lines.join("\n")}\n`));
    }).pipe(
      Effect.provide(
        HistorySearch.layer.pipe(
          Layer.provide(wordsOnly ? Embedder.layerNone : Embedder.layerOllama),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeSqliteClient.layer({ filename: database ?? ":memory:" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  600_000,
);
