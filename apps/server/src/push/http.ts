/**
 * Device registration routes for environment-delivered push.
 *
 * A client posts the APNs token of the device it is running on to the
 * environment it is paired with. Authentication is the ordinary environment
 * auth every other route uses, which is what makes the relay unnecessary:
 * being paired to this environment is the whole authorization story.
 */
import {
  AuthOrchestrationOperateScope,
  PUSH_DEVICE_REGISTER_PATH,
  PUSH_DEVICE_UNREGISTER_PATH,
  PushDeviceRegistration,
  PushDeviceUnregistration,
  type PushRegistrationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";

const decodeRegistration = Schema.decodeUnknownEffect(PushDeviceRegistration);
const decodeUnregistration = Schema.decodeUnknownEffect(PushDeviceUnregistration);

/** Whether this environment can actually deliver, so clients can say so. */
const readDeliveryConfigured = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.catchTag("ServerSettingsError", (cause) =>
      Effect.logWarning("push: failed to read settings", { cause }).pipe(Effect.as(undefined)),
    ),
  );
  const push = settings?.push;
  return (
    push?.enabled === true &&
    push.authKey.length > 0 &&
    push.keyId.length > 0 &&
    push.teamId.length > 0 &&
    push.bundleId.length > 0
  );
});

const badRequest = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid-request", message }, { status: 400 });

const routeErrorHandlers = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

export const pushDeviceRegisterRouteLayer = HttpRouter.add(
  "POST",
  PUSH_DEVICE_REGISTER_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
    const request = yield* HttpServerRequest.HttpServerRequest;

    const body = yield* request.json.pipe(Effect.option);
    if (Option.isNone(body)) {
      return badRequest("Could not read the registration body.");
    }
    const registration = yield* decodeRegistration(body.value).pipe(Effect.option);
    if (Option.isNone(registration)) {
      return badRequest(
        "Expected a device token, platform, push environment, and installation id.",
      );
    }

    yield* registry.register(registration.value);
    const deliveryConfigured = yield* readDeliveryConfigured;
    yield* Effect.logInfo("push: device registered", {
      installationId: registration.value.installationId,
      pushEnvironment: registration.value.pushEnvironment,
      deliveryConfigured,
    });
    return HttpServerResponse.jsonUnsafe({
      registered: true,
      deliveryConfigured,
    } satisfies PushRegistrationResult);
  }).pipe(Effect.catchTags(routeErrorHandlers)),
);

export const pushDeviceUnregisterRouteLayer = HttpRouter.add(
  "POST",
  PUSH_DEVICE_UNREGISTER_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
    const request = yield* HttpServerRequest.HttpServerRequest;

    const body = yield* request.json.pipe(Effect.option);
    if (Option.isNone(body)) {
      return badRequest("Could not read the unregistration body.");
    }
    const unregistration = yield* decodeUnregistration(body.value).pipe(Effect.option);
    if (Option.isNone(unregistration)) {
      return badRequest("Expected an installation id.");
    }

    yield* registry.unregister(unregistration.value.installationId);
    return HttpServerResponse.jsonUnsafe({
      registered: false,
      deliveryConfigured: yield* readDeliveryConfigured,
    } satisfies PushRegistrationResult);
  }).pipe(Effect.catchTags(routeErrorHandlers)),
);
