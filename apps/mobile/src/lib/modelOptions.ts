import type { MenuAction } from "@react-native-menu/menu";
import type {
  ModelCapabilities,
  ModelSelection,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly providerIconUrl?: string | undefined;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isUnavailable?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  if (provider.driver === "pi") return "Pi";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  if (!selection.options?.length) {
    return { instanceId: selection.instanceId, model: selection.model };
  }
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
    selection.options,
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/** Whether a known Antigravity selection needs setup or a different model. */
export function isModelSelectionUnavailable(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  if (!config || !selection) {
    return false;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  return (
    driver === "antigravity" &&
    (!provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !provider.models.some((model) => model.slug === selection.model))
  );
}

/**
 * Keep Antigravity selections when setup or catalog changes make them
 * unavailable. Other providers fall through to the server default when they
 * are disabled, missing, or signed out. Without config, keep stored selections.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  if (driver === "antigravity") {
    return selection;
  }
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Reject legacy models for implicit defaults, except Antigravity selections,
 * which must not silently change after a catalog update. Explicit picks in
 * the settings sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return provider?.driver !== "antigravity" && model?.isLegacy === true ? null : usable;
}

export function resolveNewTaskModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly projectDefaultSelection: ModelSelection | null;
  readonly stickySelection: ModelSelection | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
}): ModelSelection | null {
  return (
    input.draftSelection ??
    input.projectDefaultSelection ??
    input.stickySelection ??
    input.modelOptions.find((option) => option.isDefault && !option.isUnavailable)?.selection ??
    input.modelOptions.find((option) => !option.isUnavailable)?.selection ??
    null
  );
}

type ConfigProvider = T3ServerConfig["providers"][number];
type InstanceId = ModelSelection["instanceId"];

function isPickableProvider(provider: ConfigProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    !(provider.driver === "antigravity" && provider.availability === "unavailable")
  );
}

function accountGroupOf(config: T3ServerConfig, instanceId: InstanceId): string {
  const instanceConfig = config.settings?.providerInstances[instanceId]?.config;
  if (typeof instanceConfig !== "object" || instanceConfig === null) return "";
  const group = (instanceConfig as { readonly accountGroup?: unknown }).accountGroup;
  return typeof group === "string" ? group.trim() : "";
}

/**
 * Accounts that share an `accountGroup` are one choice: the server picks which
 * of them serves each turn (`ClaudeAccountRouter`), so the picker shows the
 * group once, under the driver's own name, as the web picker does (Amin, Oct
 * 24 2026: "I see two separate ... Claude setup. I should just see one").
 * Maps each hidden member to the member that stands for its group.
 */
export function accountGroupLeads(
  config: T3ServerConfig | null | undefined,
): ReadonlyMap<InstanceId, InstanceId> {
  const leads = new Map<InstanceId, InstanceId>();
  if (!config) return leads;
  const membersByGroup = new Map<string, InstanceId[]>();
  for (const provider of config.providers) {
    if (!isPickableProvider(provider)) continue;
    const group = accountGroupOf(config, provider.instanceId);
    if (group.length === 0) continue;
    const key = `${provider.driver}\u0000${group}`;
    const members = membersByGroup.get(key);
    if (members) members.push(provider.instanceId);
    else membersByGroup.set(key, [provider.instanceId]);
  }
  for (const [lead, ...rest] of membersByGroup.values()) {
    for (const member of rest) leads.set(member, lead!);
  }
  return leads;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
  providerInstanceId?: ModelSelection["instanceId"],
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();
  const leads = accountGroupLeads(config);
  const groupLeads = new Set(leads.values());
  const asLead = (instanceId: InstanceId) => leads.get(instanceId) ?? instanceId;
  const lockedTo = providerInstanceId === undefined ? undefined : asLead(providerInstanceId);

  for (const provider of config?.providers ?? []) {
    if (
      (lockedTo !== undefined && provider.instanceId !== lockedTo) ||
      leads.has(provider.instanceId) ||
      !isPickableProvider(provider)
    ) {
      continue;
    }

    const providerLabel = groupLeads.has(provider.instanceId)
      ? providerDisplayLabel({ driver: provider.driver, instanceId: provider.instanceId })
      : providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: model.subProvider ?? "",
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        ...(provider.supportedRuntimeModes === undefined
          ? {}
          : { supportedRuntimeModes: provider.supportedRuntimeModes }),
        ...(provider.iconUrl ? { providerIconUrl: provider.iconUrl } : {}),
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (
    fallbackModelSelection &&
    (providerInstanceId === undefined || fallbackModelSelection.instanceId === providerInstanceId)
  ) {
    // A thread on a hidden group member reads as the group's entry, keeping
    // its own account in the selection so picking it changes nothing.
    const fallbackInstanceId = asLead(fallbackModelSelection.instanceId);
    const key = `${fallbackInstanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection:
          existing.providerDriver === "antigravity"
            ? fallbackModelSelection
            : normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = config?.providers.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      const instanceConfig = config?.settings?.providerInstances[fallbackModelSelection.instanceId];
      const model = provider?.models.find(
        (candidate) => candidate.slug === fallbackModelSelection.model,
      );
      const providerDriver =
        provider?.driver ?? instanceConfig?.driver ?? fallbackModelSelection.instanceId;
      const grouped = fallbackInstanceId !== fallbackModelSelection.instanceId;
      const providerLabel = providerDisplayLabel({
        driver: providerDriver,
        displayName: grouped ? undefined : (provider?.displayName ?? instanceConfig?.displayName),
        instanceId: fallbackModelSelection.instanceId,
      });
      options.set(key, {
        key,
        label: model?.name ?? fallbackModelSelection.model,
        subtitle: model?.subProvider ?? "",
        providerKey: fallbackInstanceId,
        providerLabel,
        providerDriver,
        isDefault: false,
        isLegacy: model?.isLegacy === true,
        ...(isModelSelectionUnavailable(config, fallbackModelSelection)
          ? { isUnavailable: true }
          : {}),
        capabilities: model?.capabilities ?? null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

function modelMenuAction(option: ModelOption, selectedModel: ModelSelection | null): MenuAction {
  return {
    id: `model:${option.key}`,
    title: option.label,
    state:
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model
        ? "on"
        : undefined,
  };
}

export function buildModelMenuActions(
  groups: ReadonlyArray<ProviderGroup>,
  selectedModel: ModelSelection | null,
): MenuAction[] {
  return groups.flatMap((group) => {
    const currentModels = group.models.filter((model) => !model.isLegacy);
    const legacyModels = group.models.filter((model) => model.isLegacy);
    const selected = group.models.find(
      (model) =>
        model.selection.instanceId === selectedModel?.instanceId &&
        model.selection.model === selectedModel.model,
    );

    return [
      ...(currentModels.length > 0
        ? [
            {
              id: `provider:${group.providerKey}`,
              title: group.providerLabel,
              subtitle: selected && !selected.isLegacy ? selected.label : undefined,
              subactions: currentModels.map((option) => modelMenuAction(option, selectedModel)),
            },
          ]
        : []),
      ...(legacyModels.length > 0
        ? [
            {
              id: `legacy-models:${group.providerKey}`,
              title: `${group.providerLabel} legacy models`,
              subtitle: selected?.isLegacy ? selected.label : undefined,
              subactions: legacyModels.map((option) => modelMenuAction(option, selectedModel)),
            },
          ]
        : []),
    ];
  });
}
