import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ClaudeUsageReader, ClaudeUsageReaderLive } from "./claudeUsageReader.ts";

const keychainLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(
          new TextEncoder().encode(JSON.stringify({ claudeAiOauth: { accessToken: "token" } })),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

describe("ClaudeUsageReader", () => {
  it.effect("answers from cache while one refresh waits on the network", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      let requests = 0;
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.suspend(() => {
            requests += 1;
            return Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never));
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const reader = yield* ClaudeUsageReader;
        expect(yield* reader.read("/tmp/claude-a")).toBeUndefined();
        yield* Deferred.await(requested);
        expect(yield* reader.read("/tmp/claude-a")).toBeUndefined();
        expect(requests).toBe(1);
      }).pipe(
        Effect.provide(
          ClaudeUsageReaderLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                keychainLayer,
                httpLayer,
                Layer.succeed(HostProcess.Platform, "darwin"),
              ),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }),
  );
});
