// "+ Add a card" at the foot of a list, as Trello has it: a title and a
// description become a new thread whose agent starts in this column.
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { resolveProjectDefaultProviderModelSelection } from "~/providerInstances";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";

/** The model a new thread in this project starts on, as the composer would pick it. */
function defaultModelFor(
  environmentId: EnvironmentId,
  project: EnvironmentProject,
): ModelSelection | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = config?.providers ?? [];
  return (
    resolveProjectSettings(settings, project.id as ProjectId, project).settings
      .defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(providers, settings, project.id as ProjectId) ??
    settings.fallbackModelSelection ??
    null
  );
}

export function AddCard({
  environmentId,
  projects,
  defaultProjectId,
  columnTitle,
  onAdd,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<EnvironmentProject>;
  /** The project a board scoped to one project adds to; else the user picks. */
  defaultProjectId: string | null;
  columnTitle: string;
  onAdd: (input: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly modelSelection: ModelSelection;
  }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [adding, setAdding] = useState(false);
  const project = projects.find((entry) => entry.id === (defaultProjectId ?? projectId));
  const model = project === undefined ? null : defaultModelFor(environmentId, project);

  if (!open) {
    return (
      <button type="button" className="board-add-card" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        Add a card
      </button>
    );
  }
  const reset = () => {
    setOpen(false);
    setTitle("");
    setDescription("");
  };
  const submit = async () => {
    if (project === undefined || model === null || title.trim().length === 0) return;
    setAdding(true);
    const added = await onAdd({
      projectId: project.id,
      title: title.trim(),
      description,
      modelSelection: model,
    });
    setAdding(false);
    if (added) reset();
  };
  return (
    <form
      className="board-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        className="board-add-title"
        placeholder="Title of this card"
        aria-label="Card title"
        value={title}
        rows={2}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") reset();
        }}
      />
      <textarea
        className="board-add-description"
        placeholder="What needs doing, and how you will know it is done"
        aria-label="Card description"
        value={description}
        rows={3}
        onChange={(event) => setDescription(event.target.value)}
      />
      {defaultProjectId === null ? (
        <select
          className="board-add-project"
          aria-label="Project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">Choose a project</option>
          {projects
            .toSorted((a, b) => a.title.localeCompare(b.title))
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
        </select>
      ) : null}
      <p className="board-add-hint">
        {project === undefined
          ? "Pick a project for its agent."
          : model === null
            ? "This project has no model to start on; set one in its settings."
            : `Starts in ${columnTitle} on ${model.model}.`}
      </p>
      <div className="board-add-actions">
        <button
          type="submit"
          className="board-add-submit"
          disabled={adding || title.trim().length === 0 || project === undefined || model === null}
        >
          {adding ? "Adding…" : "Add card"}
        </button>
        <button type="button" className="board-icon-button" aria-label="Cancel" onClick={reset}>
          <XIcon className="size-4" />
        </button>
      </div>
    </form>
  );
}
