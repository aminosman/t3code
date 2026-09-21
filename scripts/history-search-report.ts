/**
 * How agents are using t3_history_search, and where it is failing them.
 *
 *   node scripts/history-search-report.ts [--days 7] [--db ~/.t3/userdata/state.sqlite]
 *
 * Reads the usage record the server keeps (roost_history_usage), read-only.
 * What to look at, in order of how much each one says:
 *   - misses: feedback saying it did not find what was needed, with the
 *     agent's note. Each is a case for the evaluation
 *     (apps/server/src/historySearch/HistorySearch.eval.test.ts).
 *   - asked again: the same thread searching again within five minutes
 *     without opening anything — the first wording did not land.
 *   - nothing opened: searches no read followed. Either the snippets answered
 *     the question or nothing looked worth opening; the queries tell which.
 *   - opened rank: where the result an agent chose was sitting. Ranks past 3
 *     are ranking failures even when the search "worked".
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
};
const days = Number(argument("days", "7"));
const file = argument("db", NodePath.join(NodeOS.homedir(), ".t3", "userdata", "state.sqlite"));
const database = new NodeSqlite.DatabaseSync(file.replace(/^~/u, NodeOS.homedir()), {
  readOnly: true,
});
const since = new Date(Date.now() - days * 86_400_000).toISOString();

type Row = Record<string, string | number | null>;
const rows = (sql: string, ...parameters: Array<string | number>) =>
  database.prepare(sql).all(...parameters) as Array<Row>;

const exists = rows(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'roost_history_usage'",
);
if (exists.length === 0) {
  console.log(`${file} holds no usage record yet: this Roost predates history search.`);
  process.exit(0);
}

const searches = rows(
  `SELECT u.id, u.at, u.thread_id, u.provider, u.query, u.filters, u.meaning_active,
          u.result_count, u.duration_ms, t.title AS thread_title,
          (SELECT MIN(o.opened_rank) FROM roost_history_usage o
            WHERE o.kind = 'open' AND o.search_id = u.id) AS opened_rank,
          (SELECT COUNT(*) FROM roost_history_usage o
            WHERE o.kind = 'open' AND o.search_id = u.id) AS opens
   FROM roost_history_usage u
   LEFT JOIN projection_threads t ON t.thread_id = u.thread_id
   WHERE u.kind = 'search' AND u.at >= ? ORDER BY u.id`,
  since,
);
const feedback = rows(
  `SELECT f.at, f.found, f.note, s.query, s.result_count, s.results, t.title AS thread_title
   FROM roost_history_usage f
   LEFT JOIN roost_history_usage s ON s.id = f.search_id
   LEFT JOIN projection_threads t ON t.thread_id = f.thread_id
   WHERE f.kind = 'feedback' AND f.at >= ? ORDER BY f.id`,
  since,
);

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`;
const short = (value: unknown, length: number) =>
  String(value ?? "")
    .replaceAll(/\s+/gu, " ")
    .slice(0, length);

console.log(`History search, last ${days} days (${file})\n`);
console.log(`searches            ${searches.length}`);
if (searches.length === 0) process.exit(0);

const byProvider = new Map<string, number>();
for (const row of searches) {
  const key = String(row.provider ?? "?");
  byProvider.set(key, (byProvider.get(key) ?? 0) + 1);
}
console.log(`  by provider       ${[...byProvider].map(([k, v]) => `${k} ${v}`).join(", ")}`);
const empty = searches.filter((row) => row.result_count === 0);
const opened = searches.filter((row) => Number(row.opens) > 0);
const ranks = opened.map((row) => Number(row.opened_rank)).filter((rank) => rank > 0);
const durations = searches.map((row) => Number(row.duration_ms ?? 0)).toSorted((a, b) => a - b);
console.log(
  `  by meaning too    ${percent(searches.filter((r) => r.meaning_active === 1).length, searches.length)}`,
);
console.log(`  no results        ${empty.length} (${percent(empty.length, searches.length)})`);
console.log(`  something opened  ${opened.length} (${percent(opened.length, searches.length)})`);
console.log(
  `  opened rank       1st ${ranks.filter((r) => r === 1).length}, 2nd-3rd ${ranks.filter((r) => r === 2 || r === 3).length}, past 3rd ${ranks.filter((r) => r > 3).length}`,
);
console.log(`  median time       ${durations[Math.floor(durations.length / 2)]} ms`);

const found = feedback.filter((row) => row.found === 1).length;
console.log(
  `\nfeedback            ${feedback.length}: found ${found}, missed ${feedback.length - found}`,
);
for (const row of feedback.filter((entry) => entry.found !== 1)) {
  console.log(
    `  MISS  "${short(row.query, 90)}"  (${row.result_count ?? "?"} results, from "${short(row.thread_title, 40)}")`,
  );
  if (row.note) console.log(`        ${short(row.note, 300)}`);
}
for (const row of feedback.filter((entry) => entry.found === 1 && entry.note)) {
  console.log(`  ok    "${short(row.query, 90)}"\n        ${short(row.note, 300)}`);
}

// The same thread asking again within five minutes, having opened nothing.
const reasked: Array<[Row, Row]> = [];
for (const [index, row] of searches.entries()) {
  const next = searches.slice(index + 1).find((later) => later.thread_id === row.thread_id);
  if (next === undefined || Number(row.opens) > 0) continue;
  if (Date.parse(String(next.at)) - Date.parse(String(row.at)) <= 5 * 60_000)
    reasked.push([row, next]);
}
console.log(`\nasked again         ${reasked.length}`);
for (const [first, second] of reasked.slice(-15)) {
  console.log(`  "${short(first.query, 70)}"  ->  "${short(second.query, 70)}"`);
}

const lowRank = opened.filter((row) => Number(row.opened_rank) > 3);
console.log(`\nopened past 3rd     ${lowRank.length}`);
for (const row of lowRank.slice(-15))
  console.log(`  #${row.opened_rank}  "${short(row.query, 90)}"`);

const unopened = searches.filter((row) => Number(row.opens) === 0 && Number(row.result_count) > 0);
console.log(`\nnothing opened      ${unopened.length}`);
for (const row of unopened.slice(-15)) {
  console.log(`  "${short(row.query, 90)}"  ${row.filters ? `[${row.filters}]` : ""}`);
}
if (empty.length > 0) console.log("\nno results");
for (const row of empty.slice(-15))
  console.log(`  "${short(row.query, 90)}"  ${row.filters ? `[${row.filters}]` : ""}`);
