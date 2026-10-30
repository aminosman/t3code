import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { memo, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "~/modelSelection";
import { isProviderInstancePickerVisible, providerInstanceEntriesFor } from "~/providerInstances";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";
import {
  describeUpdateThreadModelResult,
  planUpdateThreadModel,
  UPDATE_THREAD_MODEL_RECENT_DAYS,
} from "./UpdateThreadModel.logic";

const EMPTY_PROVIDERS: never[] = [];

// The trigger has no current model because threads can use different models.
export const UpdateThreadModelControl = memo(function UpdateThreadModelControl(props: {
  environmentId: EnvironmentId;
}) {
  const { environmentId } = props;
  const settings = useEnvironmentSettings(environmentId);
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_PROVIDERS;
  const threadShells = useThreadShells();
  const projects = useProjects();
  const [pending, setPending] = useState(false);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const pickerEntries = providerInstanceEntriesFor(providers, settings, null).filter(
    isProviderInstancePickerVisible,
  );
  const modelOptionsByInstance = new Map<
    ProviderInstanceId,
    ReadonlyArray<ModelEsque & { slug: string }>
  >();
  for (const entry of pickerEntries) {
    modelOptionsByInstance.set(
      entry.instanceId,
      getAppModelOptionsForInstance(settings, entry, null),
    );
  }

  const applyModel = async (instanceId: ProviderInstanceId, model: string) => {
    const resolvedModel =
      resolveAppModelSelectionForInstance(instanceId, settings, providers, model) ?? model;
    const target: ModelSelection = { instanceId, model: resolvedModel };
    const option = modelOptionsByInstance
      .get(instanceId)
      ?.find((candidate) => candidate.slug === resolvedModel);
    const modelLabel = option
      ? getTriggerDisplayModelName(
          option,
          providers.find((provider) => provider.instanceId === instanceId)?.driver,
        )
      : resolvedModel;
    const plan = planUpdateThreadModel({
      threads: threadShells.filter((thread) => thread.environmentId === environmentId),
      providers,
      target,
      nowMs: Date.now(),
    });

    setPending(true);
    const draftStore = useComposerDraftStore.getState();
    draftStore.setStickyModelSelection(target);
    let failed = 0;
    try {
      for (const thread of plan.update) {
        // The composer reads the draft before the thread record, so both move.
        draftStore.setModelSelection(scopeThreadRef(environmentId, thread.id), target, {
          explicit: true,
        });
        const result = await updateThreadMetadata({
          environmentId,
          input: { threadId: thread.id, modelSelection: target },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) failed += 1;
      }
      let projectDefaults = 0;
      for (const project of projects) {
        if (project.environmentId !== environmentId) continue;
        const current = project.defaultModelSelection;
        if (current === null) continue;
        if (current.instanceId === instanceId && current.model === resolvedModel) continue;
        const result = await updateProject({
          environmentId,
          input: { projectId: project.id, defaultModelSelection: target },
        });
        if (result._tag === "Success") projectDefaults += 1;
        else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          console.warn("update thread model: project default failed", project.id, error);
        }
      }
      const summary = describeUpdateThreadModelResult({
        modelLabel,
        updated: plan.update.length - failed,
        unchanged: plan.unchanged.length,
        failed,
        skipped: plan.skipped,
        projectDefaults,
      });
      toastManager.add({
        type: failed > 0 ? "warning" : "success",
        title: summary.title,
        description: summary.description,
      });
    } catch (error) {
      toastManager.add({
        type: "warning",
        title: "Could not update thread models",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
    setPending(false);
  };

  const firstEntry = pickerEntries[0];
  if (!firstEntry) return null;

  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={firstEntry.instanceId}
      model=""
      lockedProvider={null}
      instanceEntries={pickerEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      size="xs"
      triggerLabel={pending ? "Updating…" : "Update thread model"}
      triggerAriaLabel={`Update the model of every thread used in the last ${UPDATE_THREAD_MODEL_RECENT_DAYS} days and of new threads`}
      triggerClassName="text-muted-foreground hover:text-foreground"
      disabled={pending}
      onInstanceModelChange={(instanceId, model) => {
        void applyModel(instanceId, model);
      }}
    />
  );
});
