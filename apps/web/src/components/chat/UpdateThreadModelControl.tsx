import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { memo, useCallback, useMemo, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  collapseAccountGroups,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
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

/**
 * "Update thread model": one pick moves every thread used in the last few
 * days, new threads, and the projects that set a default, onto one model.
 * Accounts in one account group show as one entry, so picking Opus never
 * means picking a Max account; the server routes each turn to the account
 * that should be drained. The trigger shows no current value on purpose:
 * there is no single model all threads are on.
 */
export const UpdateThreadModelControl = memo(function UpdateThreadModelControl(props: {
  environmentId: EnvironmentId;
}) {
  const { environmentId } = props;
  const settings = useEnvironmentSettings(environmentId);
  const serverConfigs = useServerConfigs();
  const providers = serverConfigs.get(environmentId)?.providers ?? EMPTY_PROVIDERS;
  const threadShells = useThreadShells();
  const projects = useProjects();
  const [pending, setPending] = useState(false);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const { entries, leadByInstanceId } = useMemo(
    () =>
      collapseAccountGroups(
        sortProviderInstanceEntries(
          applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
        ),
        settings,
      ),
    [providers, settings],
  );
  const pickerEntries = useMemo(() => entries.filter(isProviderInstancePickerVisible), [entries]);
  const modelOptionsByInstance = useMemo(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque & { slug: string }>>();
    for (const entry of pickerEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry, null));
    }
    return out;
  }, [pickerEntries, settings]);

  const applyModel = useCallback(
    async (instanceId: ProviderInstanceId, model: string) => {
      const resolvedModel =
        resolveAppModelSelectionForInstance(instanceId, settings, providers, model) ?? model;
      const target: ModelSelection = { instanceId, model: resolvedModel };
      const option = modelOptionsByInstance
        .get(instanceId)
        ?.find((candidate) => candidate.slug === resolvedModel);
      const modelLabel = option ? getTriggerDisplayModelName(option) : resolvedModel;
      const sameAccountsAsTarget = new Set<string>([instanceId]);
      for (const [member, lead] of leadByInstanceId) {
        if (lead === instanceId) sameAccountsAsTarget.add(member);
      }

      const plan = planUpdateThreadModel({
        threads: threadShells.filter((thread) => thread.environmentId === environmentId),
        providers,
        target,
        nowMs: Date.now(),
        sameAccountsAsTarget,
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
      } finally {
        setPending(false);
      }
    },
    [
      environmentId,
      leadByInstanceId,
      modelOptionsByInstance,
      projects,
      providers,
      settings,
      threadShells,
      updateProject,
      updateThreadMetadata,
    ],
  );

  const firstEntry = pickerEntries[0];
  if (!firstEntry) return null;

  return (
    <ProviderModelPicker
      activeInstanceId={firstEntry.instanceId}
      model=""
      lockedProvider={null}
      instanceEntries={pickerEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      size="xs"
      triggerVariant="ghost"
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
