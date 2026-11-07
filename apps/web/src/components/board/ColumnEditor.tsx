// Edit the board's columns: titles, order, whether a column archives, and the
// description the summarizer reads when it places a card.
import { type BoardColumn, boardColumnsProblem, DEFAULT_BOARD_COLUMNS } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** A column id from its title: lowercase words joined by dashes, unique on the board. */
function columnIdFor(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "column";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function ColumnEditor({
  open,
  columns,
  projects,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  columns: ReadonlyArray<BoardColumn>;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  onOpenChange: (open: boolean) => void;
  onSave: (columns: ReadonlyArray<BoardColumn>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<ReadonlyArray<BoardColumn>>(columns);
  const [saving, setSaving] = useState(false);
  // Columns added in this edit take their id from their title when saved.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const keptIds = new Set(draft.filter((row) => !freshIds.has(row.id)).map((row) => row.id));
  const cleaned = draft.map((column) => {
    const title = column.title.trim();
    const id = freshIds.has(column.id) ? columnIdFor(title, keptIds) : column.id;
    if (freshIds.has(column.id)) keptIds.add(id);
    return { ...column, id, title, description: column.description.trim() };
  });
  const problem = cleaned.some((column) => column.title.length === 0)
    ? "Every column needs a title."
    : boardColumnsProblem(cleaned);

  const update = (index: number, patch: Partial<BoardColumn>) =>
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const swap = (index: number, other: number) =>
    setDraft((rows) => {
      if (other < 0 || other >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[other]] = [next[other]!, next[index]!];
      return next;
    });
  const add = () => {
    const id = columnIdFor("New column", new Set([...draft.map((row) => row.id), ...freshIds]));
    setFreshIds((ids) => new Set([...ids, id]));
    setDraft((rows) => {
      // A new open column goes before the archiving ones.
      const at = rows.findIndex((row) => row.archives);
      const column: BoardColumn = {
        id,
        title: "New column",
        description: "",
        archives: false,
      };
      return at === -1 ? [...rows, column] : [...rows.slice(0, at), column, ...rows.slice(at)];
    });
  };

  const save = async () => {
    if (problem !== null) return;
    setSaving(true);
    const saved = await onSave(cleaned);
    setSaving(false);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(columns);
          setFreshIds(new Set());
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-h-[85dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Board columns</DialogTitle>
          <DialogDescription>
            Each thread's agent reads these descriptions as the requirement for each column and
            moves its own card forward when it meets them, so say what work goes in each column and
            when it should move there. A column that needs approval stops the agent until you
            approve on the card. Cards in a removed column go to the first open column.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ol className="grid gap-3">
            {draft.map((column, index) => (
              <li key={column.id} className="grid gap-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Column title"
                    value={column.title}
                    onChange={(event) => update(index, { title: event.target.value })}
                    className="flex-1"
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => swap(index, index - 1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={index === draft.length - 1}
                    onClick={() => swap(index, index + 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${column.title}`}
                    onClick={() => setDraft((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                <Textarea
                  aria-label={`What belongs in ${column.title}`}
                  placeholder="What belongs here, and when a card should move here"
                  value={column.description}
                  onChange={(event) => update(index, { description: event.target.value })}
                  rows={2}
                />
                <ApprovalPicker
                  value={column.requireApprovalIn ?? []}
                  projects={projects}
                  onChange={(requireApprovalIn) => update(index, { requireApprovalIn })}
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={column.archives}
                    onCheckedChange={(checked) => update(index, { archives: checked === true })}
                  />
                  Archives the thread: dropping a card here archives it, and archived threads show
                  here
                </label>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={add}>
              <PlusIcon />
              Add column
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(DEFAULT_BOARD_COLUMNS);
                setFreshIds(new Set());
              }}
            >
              Reset to defaults
            </Button>
          </div>
        </DialogPanel>
        <DialogFooter>
          {problem !== null ? (
            <p className="mr-auto self-center text-xs text-destructive">{problem}</p>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={problem !== null || saving}>
            {saving ? "Saving…" : "Save columns"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Whose agents need the user's approval to move a card into the column. */
function ApprovalPicker({
  value,
  projects,
  onChange,
}: {
  value: ReadonlyArray<string>;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  onChange: (value: ReadonlyArray<string>) => void;
}) {
  const mode = value.includes("*") ? "all" : value.length > 0 ? "some" : "none";
  const [choosing, setChoosing] = useState(mode === "some");
  const shownMode = choosing && mode === "none" ? "some" : mode;
  return (
    <div className="grid gap-1.5 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        <span>Agents need your approval to move a card in:</span>
        <select
          className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground"
          value={shownMode}
          onChange={(event) => {
            const next = event.target.value;
            setChoosing(next === "some");
            onChange(next === "all" ? ["*"] : []);
          }}
        >
          <option value="none">Never</option>
          <option value="all">In every project</option>
          <option value="some">In some projects</option>
        </select>
      </label>
      {shownMode === "some" ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 pl-1">
          {projects
            .toSorted((a, b) => a.title.localeCompare(b.title))
            .map((project) => (
              <label key={project.id} className="flex items-center gap-1.5">
                <Checkbox
                  checked={value.includes(project.id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? [...value, project.id]
                        : value.filter((id) => id !== project.id),
                    )
                  }
                />
                {project.title}
              </label>
            ))}
        </div>
      ) : null}
    </div>
  );
}
