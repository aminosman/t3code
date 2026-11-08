// The card back's checks: for each column that has them, what Roost found
// (reviews, the branch, merges, tests, regression), and the test matrix and
// regression run the agent recorded.
import type { BoardColumn, BoardSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, CircleDashedIcon, XIcon } from "lucide-react";

import { useEnvironmentQuery } from "~/state/query";
import { boardEnvironment } from "./boardAtoms";

export function CardChecks({
  environmentId,
  threadId,
  columns,
  currentStage,
  summary,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  columns: ReadonlyArray<BoardColumn>;
  currentStage: string;
  summary: BoardSummary | undefined;
}) {
  const query = useEnvironmentQuery(
    boardEnvironment.boardChecks({ environmentId, input: { threadId: threadId as ThreadId } }),
  );
  const at = columns.findIndex((column) => column.id === currentStage);
  const tests = summary?.tests ?? null;
  const regression = summary?.regression ?? null;
  return (
    <div className="grid gap-2 text-sm">
      {query.data === null ? (
        <p className="text-xs text-muted-foreground">{query.error ?? "Checking…"}</p>
      ) : (
        <ol className="grid gap-1.5">
          {query.data.columns.map(({ stage, results }) => {
            const column = columns.find((entry) => entry.id === stage);
            const index = columns.findIndex((entry) => entry.id === stage);
            const passed = results.every((result) => result.ok);
            return (
              <li key={stage} className="grid gap-0.5">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {passed ? (
                    <CheckIcon className="size-3.5 text-success" />
                  ) : (
                    <CircleDashedIcon className="size-3.5 text-muted-foreground" />
                  )}
                  {column?.title ?? stage}
                  {index >= 0 && index <= at ? (
                    <span className="font-normal text-muted-foreground">· passed through</span>
                  ) : null}
                </span>
                <ul className="grid gap-0.5 pl-5">
                  {results.map((result) => (
                    <li
                      key={`${result.kind}:${result.into ?? ""}`}
                      className="flex items-baseline gap-1.5 text-xs"
                    >
                      {result.ok ? (
                        <CheckIcon className="size-3 shrink-0 translate-y-0.5 text-success" />
                      ) : (
                        <XIcon className="size-3 shrink-0 translate-y-0.5 text-destructive" />
                      )}
                      <span className="text-muted-foreground">{result.detail}</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      {tests !== null && tests.length > 0 ? (
        <div className="grid gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            Test matrix · {tests.filter((entry) => entry.result === "pass").length}/{tests.length}{" "}
            passing
          </h4>
          <ul className="grid gap-0.5 rounded-md border border-border p-2">
            {tests.map((entry) => (
              <li key={entry.case} className="flex items-baseline gap-1.5 text-xs">
                {entry.result === "pass" ? (
                  <CheckIcon className="size-3 shrink-0 translate-y-0.5 text-success" />
                ) : entry.result === "fail" ? (
                  <XIcon className="size-3 shrink-0 translate-y-0.5 text-destructive" />
                ) : (
                  <CircleDashedIcon className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">{entry.case}</span>
                {entry.note ? <span className="text-muted-foreground">{entry.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {regression !== null ? (
        <p className="flex items-baseline gap-1.5 text-xs">
          {regression.passed ? (
            <CheckIcon className="size-3 shrink-0 translate-y-0.5 text-success" />
          ) : (
            <XIcon className="size-3 shrink-0 translate-y-0.5 text-destructive" />
          )}
          <span>
            Regression {regression.passed ? "passed" : "failed"}: <code>{regression.command}</code>
            {regression.summary ? ` (${regression.summary})` : ""}
          </span>
        </p>
      ) : null}
    </div>
  );
}
