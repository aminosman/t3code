/**
 * Embedder — turns a passage into a vector, so search can match by meaning.
 *
 * Word search finds "billing" when asked for "billing". It does not find it
 * when asked for "invoice", and no amount of stemming or spelling tolerance
 * will. An embedding model does: it puts passages that mean the same thing
 * near each other whatever words they use.
 *
 * The model runs on this Mac, through Ollama. Threads and meetings are the
 * most private text the user has; they are not sent to a hosted embedding API
 * to be made searchable. The cost of that choice is that meaning search is
 * optional: no Ollama, or no embedding model in it, and search is by words
 * alone, and says so. When Ollama is there without the model, the model is
 * pulled once, in the background (about 600 MB).
 *
 * `embeddinggemma` is the default because it was measured here against
 * `nomic-embed-text` on paraphrases of real threads ("the assistant texted
 * someone without permission" against the iMessage incident): it separated
 * the right passage from the wrong ones by 2-5x where nomic's margins were a
 * few hundredths, at 37 passages a second on an M-series Mac.
 *
 * @module historySearch/Embedder
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/**
 * Kept dimensions: all of embeddinggemma's. The model is trained so that a
 * prefix of its vector still works, and 256 was tried first; on the live index
 * it blurred near-misses into hits (a right answer ranked 4th at 768 sat past
 * 40th at 256). At a byte a dimension the whole history is still under 20 MB.
 */
export const DIMENSIONS = 768;

export interface EmbedderStatus {
  readonly available: boolean;
  readonly model: string;
  /** Why not, when not. */
  readonly reason: string | null;
}

export interface EmbedderShape {
  readonly status: Effect.Effect<EmbedderStatus>;
  /** Null when the embedder cannot answer; the caller falls back to words. */
  readonly embedDocuments: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Float32Array> | null>;
  readonly embedQuery: (text: string) => Effect.Effect<Float32Array | null>;
}

export class Embedder extends Context.Service<Embedder, EmbedderShape>()(
  "t3/historySearch/Embedder",
) {}

/** Unit length over the kept dimensions, so a dot product is a cosine. */
export const normalize = (vector: ReadonlyArray<number>): Float32Array => {
  const kept = Float32Array.from(vector.slice(0, DIMENSIONS));
  let norm = 0;
  for (const value of kept) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < kept.length; index++) kept[index] = kept[index]! / norm;
  return kept;
};

/**
 * One signed byte per dimension, scaled to the vector's own largest value.
 * Cosine does not care about a vector's length, so the scale need not be
 * kept; a quarter of the space for a ranking that does not change.
 */
export const quantize = (vector: Float32Array): Uint8Array => {
  let max = 0;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const scale = max === 0 ? 0 : 127 / max;
  const bytes = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index++) {
    bytes[index] = Math.round(vector[index]! * scale);
  }
  return new Uint8Array(bytes.buffer);
};

/** No model: search is by words alone. Also what tests of word search use. */
export const layerNone = Layer.succeed(
  Embedder,
  Embedder.of({
    status: Effect.succeed({ available: false, model: "none", reason: "no embedder configured" }),
    embedDocuments: () => Effect.succeed(null),
    embedQuery: () => Effect.succeed(null),
  }),
);

const EmbedResponse = Schema.Struct({ embeddings: Schema.Array(Schema.Array(Schema.Number)) });
const TagsResponse = Schema.Struct({
  models: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const DEFAULT_MODEL = "embeddinggemma";
const RECHECK_MS = 60_000;
const EMBED_TIMEOUT = "60 seconds";
const QUERY_TIMEOUT = "4 seconds";
const PULL_TIMEOUT = "30 minutes";

// embeddinggemma's own prompts for retrieval; other models take the text bare.
const asDocument = (model: string, text: string) =>
  model.startsWith("embeddinggemma") ? `title: none | text: ${text}` : text;
const asQuery = (model: string, text: string) =>
  model.startsWith("embeddinggemma") ? `task: search result | query: ${text}` : text;

export const layerOllama = Layer.effect(
  Embedder,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const host = (process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434").replace(/\/+$/u, "");
    const base = /^https?:\/\//u.test(host) ? host : `http://${host}`;
    const model = process.env.ROOST_EMBED_MODEL?.trim() || DEFAULT_MODEL;
    const checked = yield* Ref.make<{
      readonly at: number;
      readonly status: EmbedderStatus;
    } | null>(null);
    const pulling = yield* Ref.make(false);

    const post = (path: string, body: unknown) =>
      HttpClientRequest.post(`${base}${path}`).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((request) => http.execute(request)),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      );

    const pull = Effect.gen(function* () {
      if (yield* Ref.getAndSet(pulling, true)) return;
      yield* Effect.logInfo("history search: pulling the embedding model").pipe(
        Effect.annotateLogs({ model }),
      );
      yield* post("/api/pull", { model, stream: false }).pipe(
        Effect.timeout(PULL_TIMEOUT),
        Effect.tap(() => Ref.set(checked, null)),
        Effect.catchCause((cause) =>
          Effect.logWarning("history search: could not pull the embedding model").pipe(
            Effect.annotateLogs({ model, cause: String(cause) }),
          ),
        ),
        Effect.ensuring(Ref.set(pulling, false)),
      );
    });

    const probe = Effect.gen(function* () {
      const tags = yield* http.get(`${base}/api/tags`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TagsResponse)),
        Effect.timeout(QUERY_TIMEOUT),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (tags === null) {
        return { available: false, model, reason: `Ollama is not answering at ${base}` };
      }
      const has = tags.models.some((m) => m.name === model || m.name.startsWith(`${model}:`));
      if (!has) {
        yield* Effect.forkDetach(pull);
        return { available: false, model, reason: `Ollama has no ${model} yet; pulling it` };
      }
      return { available: true, model, reason: null };
    });

    const status: EmbedderShape["status"] = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(checked);
      if (last !== null && now - last.at < RECHECK_MS) return last.status;
      const next = yield* probe;
      yield* Ref.set(checked, { at: now, status: next });
      return next;
    });

    const embed = (
      inputs: ReadonlyArray<string>,
      timeout: typeof EMBED_TIMEOUT | typeof QUERY_TIMEOUT,
    ) =>
      Effect.gen(function* () {
        if (!(yield* status).available) return null;
        return yield* post("/api/embed", { model, input: inputs }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbedResponse)),
          Effect.timeout(timeout),
          Effect.map((response) =>
            response.embeddings.length === inputs.length
              ? response.embeddings.map(normalize)
              : null,
          ),
          // Stopped, restarted, out of memory: ask again after the next probe.
          Effect.catchCause(() => Ref.set(checked, null).pipe(Effect.as(null))),
        );
      });

    return Embedder.of({
      status,
      embedDocuments: (texts) =>
        embed(
          texts.map((text) => asDocument(model, text)),
          EMBED_TIMEOUT,
        ),
      embedQuery: (text) =>
        embed([asQuery(model, text)], QUERY_TIMEOUT).pipe(
          Effect.map((vectors) => vectors?.[0] ?? null),
        ),
    });
  }),
);
