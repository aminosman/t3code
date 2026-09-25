/**
 * Claude shadow home. Mirrors `CodexHomeLayout` so one account's credentials
 * stay private while every instance sharing a `homePath` reads one store of
 * skills, plugins, plans and transcripts.
 *
 * Claude Code derives its macOS Keychain service name from `CLAUDE_CONFIG_DIR`
 * (`Claude Code-credentials-<hash>`), so pointing two instances at two shadow
 * homes is enough to hold two logins. Note that setting `CLAUDE_CONFIG_DIR` at
 * all — even to `~/.claude` — selects a different slot than leaving it unset,
 * so a shadow never inherits the default install's login.
 *
 * Sharing `projects/` is what lets a thread started on one account resume on
 * another: the transcript `--resume` reads lives in the shared store.
 *
 * Kept separate from `CodexHomeLayout` rather than generalised: the two differ
 * in entry classification, and a shared abstraction would widen the conflict
 * surface against upstream, which is still moving both files.
 *
 * @module provider/Drivers/ClaudeHomeLayout
 */
import * as NodeOS from "node:os";

import { ProviderDriverKind, type ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export interface ClaudeHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

/** Created in the shared home when absent so a fresh shadow still links them. */
const KNOWN_SHARED_DIRECTORIES = [
  "projects",
  "plugins",
  "skills",
  "plans",
  "sessions",
  "shell-snapshots",
  "todos",
  "cache",
] as const;

/**
 * Identity. `.claude.json` carries `oauthAccount`; symlinking it would merge
 * two accounts onto one record. `.credentials.json` is the plaintext fallback
 * Claude Code writes when the Keychain is unavailable.
 */
const PRIVATE_ENTRY_NAMES = new Set([".claude.json", ".credentials.json"]);

/** Machine-local churn: pointless or harmful to share between accounts. */
const SHADOW_LOCAL_ENTRY_NAMES = new Set([
  "backups",
  "debug",
  "ide",
  "session-env",
  "tasks",
  "telemetry",
  "statsig",
  ".claude.json.lock",
  ".DS_Store",
  ".last-cleanup",
  ".last-update-result.json",
]);

/** Runtime dirs safe to replace when a real path squats the link. */
const REPLACEABLE_SHARED_RUNTIME_DIRECTORIES = new Set(["cache"]);

/**
 * Where a shadow's own copy of a shared file goes when the shared home already
 * has one of that name. Under `backups`, which is shadow-local, so nothing a
 * Claude Code run wrote is ever discarded — only set aside where it can be read.
 */
const SHADOW_MERGE_BACKUP_DIRECTORY = ["backups", "shadow-merge"] as const;

/**
 * The config dir itself, unlike `resolveClaudeHomePath`, which answers `$HOME`
 * for a default install because `CLAUDE_CONFIG_DIR` is then left unset.
 */
function resolveSharedHomePath(path: Path.Path, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return path.resolve(
    trimmed.length > 0 ? expandHomePath(trimmed) : path.join(NodeOS.homedir(), ".claude"),
  );
}

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveSharedHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      // Preserve "unset means the default install": an empty homePath must
      // keep CLAUDE_CONFIG_DIR out of the environment, not pin it to ~/.claude.
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `claude:home:${sharedHomePath}`,
    };
  }

  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath: path.resolve(expandHomePath(shadowHomePath)),
    continuationKey: `claude:home:${sharedHomePath}`,
  };
});

const ClaudeShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class ClaudeShadowHomeFileSystemError extends Schema.TaggedError<ClaudeShadowHomeFileSystemError>()(
  "ClaudeShadowHomeFileSystemError",
  {
    ...ClaudeShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "stat",
      "rename",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Claude shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class ClaudeShadowHomePathConflictError extends Schema.TaggedError<ClaudeShadowHomePathConflictError>()(
  "ClaudeShadowHomePathConflictError",
  ClaudeShadowHomeContext,
) {
  override get message(): string {
    return `Claude shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class ClaudeShadowHomeEntryConflictError extends Schema.TaggedError<ClaudeShadowHomeEntryConflictError>()(
  "ClaudeShadowHomeEntryConflictError",
  {
    ...ClaudeShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Claude shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class ClaudeShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<ClaudeShadowHomePrivateEntrySymlinkError>()(
  "ClaudeShadowHomePrivateEntrySymlinkError",
  {
    ...ClaudeShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Claude shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const ClaudeShadowHomeError = Schema.Union([
  ClaudeShadowHomeFileSystemError,
  ClaudeShadowHomePathConflictError,
  ClaudeShadowHomeEntryConflictError,
  ClaudeShadowHomePrivateEntrySymlinkError,
]);
export type ClaudeShadowHomeError = typeof ClaudeShadowHomeError.Type;

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("ClaudeHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, ClaudeShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new ClaudeShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("ClaudeHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: privatePath });
  if (state._tag !== "Symlink") return;
  yield* input.fileSystem.remove(privatePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new ClaudeShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "remove",
          path: privatePath,
          entryName: input.entryName,
          cause,
        }),
    }),
  );
});

/**
 * Fold a real directory squatting a shared link into the shared home. Returns
 * false when the squatter is not a directory, or the shared entry exists and is
 * not one, so the caller can surface the conflict instead.
 */
const mergeShadowDirectoryIntoShared = Effect.fn("ClaudeHomeLayout.mergeShadowDirectoryIntoShared")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly entryName: string;
    readonly link: string;
    readonly target: string;
  }): Effect.fn.Return<boolean, ClaudeShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const fail =
      (
        operation: "stat" | "rename" | "readDirectory" | "makeDirectory" | "remove",
        at: string,
        to?: string,
      ) =>
      (cause: PlatformError.PlatformError) =>
        new ClaudeShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation,
          path: at,
          ...(to === undefined ? {} : { targetPath: to }),
          entryName: input.entryName,
          cause,
        });
    const statType = (at: string) =>
      input.fileSystem.stat(at).pipe(
        Effect.map((info) => info.type),
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed<"Missing">("Missing"),
        ),
        Effect.mapError(fail("stat", at)),
      );
    const rename = (from: string, to: string) =>
      input.fileSystem.rename(from, to).pipe(Effect.mapError(fail("rename", from, to)));

    if ((yield* statType(input.link)) !== "Directory") return false;
    const targetType = yield* statType(input.target);
    if (targetType === "Missing") {
      // Nothing shared yet: the shadow's copy becomes the shared one.
      yield* rename(input.link, input.target);
      return true;
    }
    if (targetType !== "Directory") return false;

    const names = yield* input.fileSystem
      .readDirectory(input.link)
      .pipe(Effect.mapError(fail("readDirectory", input.link)));
    const backupDirectory = path.join(
      input.effectiveHomePath,
      ...SHADOW_MERGE_BACKUP_DIRECTORY,
      input.entryName,
    );
    for (const name of names) {
      const from = path.join(input.link, name);
      const to = path.join(input.target, name);
      if ((yield* statType(to)) === "Missing") {
        yield* rename(from, to);
        continue;
      }
      yield* input.fileSystem
        .makeDirectory(backupDirectory, { recursive: true })
        .pipe(Effect.mapError(fail("makeDirectory", backupDirectory)));
      const setAside = path.join(backupDirectory, name);
      yield* rename(from, setAside);
      yield* Effect.logWarning("claude shadow home kept the shared copy of an entry", {
        entryName: input.entryName,
        name,
        sharedPath: to,
        setAside,
      });
    }
    yield* input.fileSystem
      .remove(input.link, { recursive: true })
      .pipe(Effect.mapError(fail("remove", input.link)));
    return true;
  },
);

const ensureSymlink = Effect.fn("ClaudeHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: link });

  const removeAt = (removePath: string, options?: { readonly recursive: boolean }) =>
    input.fileSystem.remove(removePath, options).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new ClaudeShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: removePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new ClaudeShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );

  if (state._tag === "NotSymlink") {
    // Claude Code rewrites some entries by atomic rename, which replaces the
    // link with a real path. Known-disposable runtime dirs are recreated.
    if (REPLACEABLE_SHARED_RUNTIME_DIRECTORIES.has(input.entryName)) {
      yield* removeAt(link, { recursive: true });
      return yield* createLink;
    }
    // A directory a newer Claude Code created inside the shadow before the
    // shared home had one of that name (`state`, Sep 2026) is folded into the
    // shared one — its files move over, and any name the shared home already
    // holds is set aside under the shadow's backups — then linked like the
    // rest. A real file is still surfaced, never silently discarded.
    const merged = yield* mergeShadowDirectoryIntoShared({ ...input, link, target });
    if (!merged) {
      return yield* new ClaudeShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }
    return yield* createLink;
  }

  if (state._tag === "Missing") return yield* createLink;

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* removeAt(link);
    yield* createLink;
  }
});

const ensureShadowIdentityIsPrivate = Effect.fn("ClaudeHomeLayout.ensureShadowIdentityIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void, ClaudeShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const identityPath = path.join(input.effectiveHomePath, input.entryName);
    const state = yield* readLinkState({ ...input, linkPath: identityPath });
    if (state._tag === "Symlink") {
      return yield* new ClaudeShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        path: identityPath,
      });
    }
  },
);

export const materializeClaudeShadowHome = Effect.fn("materializeClaudeShadowHome")(function* (
  layout: ClaudeHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new ClaudeShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new ClaudeShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new ClaudeShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
      entries.add(entryName);
    }
  }

  // A shadow that once shared an identity file keeps the stale link until it
  // is cleared, which would send this account's login back to the shared home.
  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      removePrivateSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) =>
      ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      }),
    { discard: true },
  );

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      ensureShadowIdentityIsPrivate({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      }),
    { discard: true },
  );
});

export function claudeContinuationIdentity(layout: ClaudeHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationKey: layout.continuationKey,
  };
}
