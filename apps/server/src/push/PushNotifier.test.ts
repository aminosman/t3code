import { assert, describe, it } from "@effect/vitest";

import { shouldNotifyPhaseTransition } from "./PushNotifier.ts";

// A spurious "Done" at thread birth is the failure mode that makes people turn
// notifications off, so the transition rules are pinned here rather than only
// observed against a live projector.
describe("shouldNotifyPhaseTransition", () => {
  it("stays silent on a thread's first observed phase", () => {
    assert.isFalse(shouldNotifyPhaseTransition({ previous: undefined, next: "completed" }));
  });

  it("notifies when work finishes after running", () => {
    assert.isTrue(shouldNotifyPhaseTransition({ previous: "running", next: "completed" }));
  });

  it("notifies when the agent starts needing the user", () => {
    assert.isTrue(
      shouldNotifyPhaseTransition({ previous: "running", next: "waiting_for_approval" }),
    );
    assert.isTrue(shouldNotifyPhaseTransition({ previous: "running", next: "waiting_for_input" }));
    assert.isTrue(shouldNotifyPhaseTransition({ previous: "running", next: "failed" }));
  });

  it("ignores progress phases nobody needs to be interrupted for", () => {
    assert.isFalse(shouldNotifyPhaseTransition({ previous: "starting", next: "running" }));
    assert.isFalse(shouldNotifyPhaseTransition({ previous: null, next: "starting" }));
  });

  it("does not repeat itself while the thread sits in the same phase", () => {
    assert.isFalse(shouldNotifyPhaseTransition({ previous: "completed", next: "completed" }));
  });

  it("stays silent when the thread projects to nothing", () => {
    assert.isFalse(shouldNotifyPhaseTransition({ previous: "running", next: null }));
  });

  it("notifies again when a finished thread is picked back up and finishes", () => {
    assert.isFalse(shouldNotifyPhaseTransition({ previous: "completed", next: "running" }));
    assert.isTrue(shouldNotifyPhaseTransition({ previous: "running", next: "completed" }));
  });
});
