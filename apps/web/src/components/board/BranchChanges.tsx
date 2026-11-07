// A card's mini pull request on its back: the branch against the default
// branch, as it would merge. Commits ahead, files changed, and what is not
// committed yet, with a way into the full diff beside the chat.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, GitBranchIcon, GitCommitHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { Button } from "../ui/button";

const FILES_FIRST = 8;
const COMMITS_FIRST = 6;

const lines = (insertions: number, deletions: number) => (
  <span className="tabular-nums">
    <span className="text-success">+{insertions}</span>{" "}
    <span className="text-destructive">−{deletions}</span>
  </span>
);

export function BranchChanges({
  environmentId,
  threadId,
  pullRequests,
  onViewDiff,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  pullRequests: ReadonlyArray<{ readonly url: string; readonly number: number }>;
  onViewDiff: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.boardBranch({ environmentId, input: { threadId: threadId as ThreadId } }),
  );
  const [allFiles, setAllFiles] = useState(false);
  const view = query.data;
  if (view === null) {
    return <p className="text-xs text-muted-foreground">{query.error ?? "Reading the branch…"}</p>;
  }
  if (view.base === null || view.branch === null) {
    return <p className="text-xs text-muted-foreground">No git branch to compare.</p>;
  }
  const baseName = view.base.replace(/^origin\//, "");
  const sameAsBase = view.branch === baseName;
  const nothing = view.ahead === 0 && (view.uncommitted?.files ?? 0) === 0;
  const files = allFiles ? view.files : view.files.slice(0, FILES_FIRST);
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GitBranchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{view.branch}</span>
        <span className="text-muted-foreground">into</span>
        <span className="font-medium">{view.base}</span>
        {pullRequests.map((pr) => (
          <a
            key={pr.url}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            PR #{pr.number}
            <ExternalLinkIcon className="size-3" />
          </a>
        ))}
        <Button size="xs" variant="outline" className="ml-auto" onClick={onViewDiff}>
          View diff
        </Button>
      </div>
      {nothing ? (
        <p className="text-xs text-muted-foreground">
          Nothing to merge: {sameAsBase ? "every commit is pushed" : `level with ${view.base}`}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {view.ahead === 0
            ? "Nothing committed yet"
            : `${view.ahead} commit${view.ahead === 1 ? "" : "s"}${sameAsBase ? " not pushed" : " ahead"}`}
          {view.behind > 0 ? `, ${view.behind} behind` : ""}
          {view.files.length > 0 ? (
            <>
              {" · "}
              {view.files.length} file{view.files.length === 1 ? "" : "s"}{" "}
              {lines(view.insertions, view.deletions)}
            </>
          ) : null}
          {view.uncommitted !== null && view.uncommitted.files > 0 ? (
            <>
              {" · "}
              {view.uncommitted.files} uncommitted{" "}
              {lines(view.uncommitted.insertions, view.uncommitted.deletions)}
            </>
          ) : null}
        </p>
      )}
      {view.commits.length > 0 ? (
        <ol className="grid gap-0.5">
          {view.commits.slice(0, COMMITS_FIRST).map((commit) => (
            <li key={commit.sha} className="flex items-baseline gap-2 text-xs">
              <GitCommitHorizontalIcon className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
              <code className="shrink-0 text-muted-foreground">{commit.sha}</code>
              <span className="truncate">{commit.subject}</span>
            </li>
          ))}
          {view.commits.length > COMMITS_FIRST ? (
            <li className="pl-5 text-xs text-muted-foreground">
              and {view.commits.length - COMMITS_FIRST} more
            </li>
          ) : null}
        </ol>
      ) : null}
      {view.files.length > 0 ? (
        <ul className="grid gap-0.5 rounded-md border border-border p-2">
          {files.map((file) => (
            <li key={file.path} className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              {lines(file.insertions, file.deletions)}
            </li>
          ))}
          {view.files.length > FILES_FIRST && !allFiles ? (
            <li>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setAllFiles(true)}
              >
                Show all {view.files.length} files
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
