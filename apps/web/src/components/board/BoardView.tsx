// Roost's card wall, drawn after Trello: lists on a coloured board, cards with
// labels on top and badges below. Shared by the /board page and the Board tab
// of the right panel, which differ only in where the scope lives.
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  BOARD_REVIEWS_WANTED,
  type BoardApproval,
  type BoardColumn,
  type BoardCommentsSummary,
  type BoardStage,
  type BoardSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ArrowRightIcon,
  BotIcon,
  ChevronRightIcon,
  ClockIcon,
  KanbanSquareIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SparklesIcon,
  GitBranchIcon,
  MessageSquareIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SquareCheckIcon,
} from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import {
  type BoardCardView,
  type BoardFilter,
  type BoardScope,
  STALE_DAYS,
  type TurnStatus,
  activityAt,
  buildBoard,
  focusedCardId,
  ownerOf,
  idleCards,
  idleDays,
  missingReviews,
  passesFilter,
  summaryIsStale,
  turnStatus,
} from "./boardModel";
import { CardBack } from "./CardBack";
import { ColumnEditor } from "./ColumnEditor";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";
import { useBoard } from "./useBoard";

type Thread = ReturnType<typeof useBoard>["threads"][number];
type CardView = BoardCardView<Thread>;

/** Columns of archived threads grow without end; show the newest few. */
const ARCHIVE_SHOWN = 25;

/** Trello's label colours, one per project, the same every time. */
const LABEL_COLOURS = ["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink"];
const labelColour = (projectId: string) => {
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return LABEL_COLOURS[Math.abs(hash) % LABEL_COLOURS.length]!;
};

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

const TURN_LABEL: Record<TurnStatus, string> = {
  "needs-you": "Needs you",
  working: "Working",
  queued: "Queued",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  none: "No turns",
};

const FILTERS: ReadonlyArray<{ readonly id: BoardFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "needs-review", label: "Needs review" },
  { id: "stale", label: `Stale ${STALE_DAYS}d+` },
  { id: "unsummarized", label: "No summary" },
];

const columnTitle = (columns: ReadonlyArray<BoardColumn>, stage: BoardStage) =>
  columns.find((column) => column.id === stage)?.title ?? stage;

/** How long ago, Trello-short: "now", "40m", "5h", "3d". */
function age(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (Number.isNaN(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

export interface BoardSearch {
  /** One project's board. */
  readonly project?: string;
  /** One thread's board: its sub-threads. */
  readonly thread?: string;
}

export interface BoardViewProps {
  readonly search: BoardSearch;
  readonly onScopeChange: (next: BoardSearch) => void;
  readonly onOpenCard: (card: { readonly environmentId: string; readonly id: string }) => void;
  /** The thread beside the board: its card, or its nearest owner's, is shown and marked. */
  readonly focusThreadId?: string | null;
  readonly variant: "page" | "panel";
  /** The panel's "follow the chat's project" choice, offered in the project picker. */
  readonly follow?: { readonly active: boolean; readonly onFollow: () => void };
  /** Extra controls at the right of the bar. */
  readonly controls?: ReactNode;
}

/** What every card and list needs from the page. */
interface BoardContext {
  readonly columns: ReadonlyArray<BoardColumn>;
  readonly showProject: boolean;
  readonly projectsById: ReadonlyMap<string, EnvironmentProject>;
  readonly summaries: ReadonlyMap<string, BoardSummary>;
  readonly summarizing: ReadonlySet<string>;
  readonly now: number;
  readonly focusedId: string | null;
  readonly open: (card: CardView) => void;
  readonly openBoard: (card: CardView) => void;
  readonly move: (card: CardView, stage: BoardStage) => void;
  readonly summarize: (cards: ReadonlyArray<CardView>) => void;
  /** Archives them into `into`, or the last archiving column. */
  readonly archive: (cards: ReadonlyArray<CardView>, into?: BoardStage) => void;
  readonly pendingApprovals: ReadonlyMap<string, BoardApproval>;
  readonly decide: (card: CardView, approve: boolean) => void;
  readonly nudge: (cards: ReadonlyArray<CardView>) => void;
  readonly commentSummaries: ReadonlyMap<string, BoardCommentsSummary>;
  readonly openCard: (card: CardView) => void;
}

export function BoardView(props: BoardViewProps) {
  const { search, variant } = props;
  const board = useBoard(search.thread ?? null);
  const listsRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [quick, setQuick] = useState<BoardFilter>("all");
  // Ages are counted from when the board opened; a minute's drift is fine.
  const [now] = useState(() => Date.now());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [showAllIn, setShowAllIn] = useState<ReadonlySet<BoardStage>>(new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const scope: BoardScope =
    search.thread !== undefined
      ? { kind: "thread", threadId: search.thread }
      : search.project !== undefined
        ? { kind: "project", projectId: search.project }
        : { kind: "all" };
  const view = buildBoard(board.threads, board.cards, scope, board.columns, board.subCounts);
  const [editingColumns, setEditingColumns] = useState(false);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const projectsById = new Map(board.projects.map((project) => [project.id as string, project]));
  const ownerProject =
    view.owner === null ? undefined : projectsById.get(view.owner.thread.projectId);
  const scopeProject = scope.kind === "project" ? projectsById.get(scope.projectId) : ownerProject;
  const needle = text.trim().toLowerCase();
  const matchesText = (card: CardView) =>
    needle.length === 0 ||
    card.thread.title.toLowerCase().includes(needle) ||
    (board.summaries.get(card.thread.id)?.summary.toLowerCase().includes(needle) ?? false) ||
    (projectsById.get(card.thread.projectId)?.title.toLowerCase().includes(needle) ?? false);
  const passes = (card: CardView, filter: BoardFilter) =>
    (filter === "needs-you" &&
      card.thread.archivedAt === null &&
      (board.pendingApprovals.has(card.thread.id) || card.card?.assignee === "user")) ||
    passesFilter(card, filter, now, board.summaries.get(card.thread.id));

  const allCards = [...view.columns.values()].flat();
  const dragging = allCards.find((card) => card.thread.id === draggingId) ?? null;
  const openCard =
    (openCardId === null ? null : allCards.find((card) => card.thread.id === openCardId)) ??
    (openCardId !== null && view.owner?.thread.id === openCardId ? view.owner : null);
  const openCards = allCards.filter((card) => card.thread.archivedAt === null);

  const goTo = props.onScopeChange;
  const focusedId = focusedCardId(
    board.threads,
    new Set(allCards.map((card) => card.thread.id as string)),
    props.focusThreadId ?? null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM to the focused card when the chat beside the board changes
  useEffect(() => {
    if (focusedId === null) return;
    const node = listsRef.current?.querySelector(`[data-card-id="${CSS.escape(focusedId)}"]`);
    node?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [focusedId, listsRef]);
  const context: BoardContext = {
    columns: board.columns,
    showProject: scope.kind === "all",
    projectsById,
    summaries: board.summaries,
    summarizing: board.summarizing,
    now,
    focusedId,
    open: (card) => props.onOpenCard(card.thread),
    openBoard: (card) => goTo({ thread: card.thread.id }),
    move: (card, stage) => void board.move(card.thread.id as ThreadId, stage),
    summarize: (cards) => void board.summarize(cards.map((card) => card.thread.id as ThreadId)),
    pendingApprovals: board.pendingApprovals,
    decide: (card, approve) => {
      const request = board.pendingApprovals.get(card.thread.id);
      if (request === undefined) return;
      const note = approve ? "" : (window.prompt("Why not? The agent reads this.") ?? "");
      void board.decide(card.thread.id as ThreadId, request.stage, approve, note);
    },
    nudge: (cards) => void board.nudge(cards.map((card) => card.thread.id as ThreadId)),
    commentSummaries: board.commentSummaries,
    openCard: (card) => setOpenCardId(card.thread.id),
    archive: (cards, into) =>
      void board.archiveMany(
        cards.map((card) => card.thread.id as ThreadId),
        into,
      ),
  };

  const onDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const to = event.over?.id as BoardStage | undefined;
    const card = allCards.find((candidate) => candidate.thread.id === event.active.id);
    if (to === undefined || card === undefined || card.column === to) return;
    context.move(card, to);
  };

  return (
    <div className="board-surface flex h-full min-w-0 flex-1 flex-col" data-variant={variant}>
      <header
        className={cn(
          "board-bar",
          // The full page is the top of the desktop window: it drags the window and
          // clears the traffic lights when the sidebar is collapsed. In the right
          // panel, the panel's tab strip owns the title bar.
          variant === "page" &&
            isElectron &&
            "drag-region wco:pr-(--workspace-native-controls-inset)",
          variant === "page" && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        {variant === "page" ? <SidebarTrigger className="md:hidden" /> : null}
        <nav className="board-crumbs" aria-label="Board">
          <KanbanSquareIcon className="size-4 shrink-0" />
          <button type="button" onClick={() => goTo({})} className="board-crumb">
            {variant === "panel" ? "All" : "All projects"}
          </button>
          {scopeProject !== undefined ? (
            <>
              <ChevronRightIcon className="size-3.5 shrink-0 opacity-60" />
              <button
                type="button"
                onClick={() => goTo({ project: scopeProject.id })}
                className="board-crumb max-w-[14rem] truncate"
              >
                {scopeProject.title}
              </button>
            </>
          ) : null}
          {view.owner !== null ? (
            <OwnerCrumbs owner={view.owner} threads={board.threads} onOpen={goTo} />
          ) : null}
        </nav>
        <ProjectPicker
          projects={board.projects}
          current={scope.kind === "project" ? scope.projectId : null}
          follow={props.follow}
          onPick={(projectId) => goTo(projectId === null ? {} : { project: projectId })}
        />
        <label className="board-search">
          <SearchIcon className="size-3.5 shrink-0 opacity-70" />
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Filter cards"
          />
        </label>
        <span className="board-bar-note">
          {board.loading ? "Loading…" : `${openCards.length} open`}
          {board.summarizing.size > 0 ? ` · summarizing ${board.summarizing.size}` : ""}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="board-icon-button board-bar-button"
                aria-label="Edit columns"
                onClick={() => setEditingColumns(true)}
              />
            }
          >
            <SlidersHorizontalIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Edit columns</TooltipPopup>
        </Tooltip>
        {props.controls}
      </header>
      {openCard !== null && board.environmentId !== null ? (
        <CardBack
          environmentId={board.environmentId}
          thread={openCard.thread}
          projectTitle={projectsById.get(openCard.thread.projectId)?.title ?? null}
          card={openCard.card}
          column={board.columns.find((column) => column.id === openCard.column)}
          summary={board.summaries.get(openCard.thread.id)}
          approval={board.pendingApprovals.get(openCard.thread.id)}
          approvalColumnTitle={
            board.columns.find(
              (column) => column.id === board.pendingApprovals.get(openCard.thread.id)?.stage,
            )?.title
          }
          pullRequests={openCard.thread.pullRequests}
          onClose={() => setOpenCardId(null)}
          onOpenThread={() => {
            setOpenCardId(null);
            context.open(openCard);
          }}
          onViewDiff={() => {
            setOpenCardId(null);
            // The chat, with its Diff tab beside it: the branch against its base.
            useRightPanelStore
              .getState()
              .open(
                scopeThreadRef(
                  openCard.thread.environmentId as EnvironmentId,
                  openCard.thread.id as ThreadId,
                ),
                "diff",
              );
            context.open(openCard);
          }}
          onDecide={(approve) => context.decide(openCard, approve)}
          onUpdate={(change) => board.updateCard(openCard.thread.id as ThreadId, change)}
        />
      ) : null}
      {editingColumns ? (
        <ColumnEditor
          open
          columns={board.columns}
          projects={board.projects}
          onOpenChange={setEditingColumns}
          onSave={board.saveColumns}
        />
      ) : null}

      <div className="board-filters" role="toolbar" aria-label="Quick filters">
        {FILTERS.map((filter) => {
          const count =
            filter.id === "all"
              ? openCards.length
              : allCards.filter((card) => passes(card, filter.id)).length;
          return (
            <button
              key={filter.id}
              type="button"
              className="board-filter"
              data-on={quick === filter.id ? "" : undefined}
              data-tone={
                (filter.id === "needs-you" || filter.id === "needs-review") && count > 0
                  ? "alert"
                  : undefined
              }
              onClick={() => setQuick(filter.id)}
            >
              {filter.label}
              <span className="board-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {view.owner !== null ? (
        <OwnerStrip
          columns={board.columns}
          owner={view.owner}
          summary={board.summaries.get(view.owner.thread.id)}
          onOpen={() => context.open(view.owner!)}
          onMove={(stage) => context.move(view.owner!, stage)}
        />
      ) : null}

      {board.error ? <p className="board-error">{board.error}</p> : null}

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDraggingId(null)}
      >
        <div className="board-lists" ref={listsRef}>
          {board.columns.map((column, index) => {
            const cards = (view.columns.get(column.id) ?? []).filter(
              (card) => matchesText(card) && passes(card, quick),
            );
            const showAll = showAllIn.has(column.id) || !column.archives;
            const putAway = board.columns.findLast((entry) => entry.archives)?.id === column.id;
            return (
              <BoardList
                key={column.id}
                column={column}
                tint={putAway ? "put-away" : String(index % 5)}
                cards={showAll ? cards : cards.slice(0, ARCHIVE_SHOWN)}
                allCards={cards}
                hidden={showAll ? 0 : Math.max(0, cards.length - ARCHIVE_SHOWN)}
                context={context}
                draggingId={draggingId}
                onShowAll={() => setShowAllIn((current) => new Set([...current, column.id]))}
              />
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging !== null ? <CardFace card={dragging} context={context} lifted /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function OwnerCrumbs({
  owner,
  threads,
  onOpen,
}: {
  owner: CardView;
  threads: ReadonlyArray<Thread>;
  onOpen: (next: BoardSearch) => void;
}) {
  // The owners above this one, outermost first, each a board of its own.
  const chain: Thread[] = [];
  const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
  for (
    let parent = ownerOf(owner.thread);
    parent !== null && chain.length < 6;
    parent = ownerOf(byId.get(parent))
  ) {
    const thread = byId.get(parent);
    if (thread === undefined) break;
    chain.unshift(thread);
  }
  return (
    <>
      {[...chain, owner.thread].map((thread) => (
        <span key={thread.id} className="contents">
          <ChevronRightIcon className="size-3.5 shrink-0 opacity-60" />
          <button
            type="button"
            className="board-crumb max-w-[18rem] truncate"
            onClick={() => onOpen({ thread: thread.id })}
          >
            {thread.title}
          </button>
        </span>
      ))}
    </>
  );
}

const FOLLOW_VALUE = "\u0000follow";

function ProjectPicker({
  projects,
  current,
  follow,
  onPick,
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  current: string | null;
  follow: BoardViewProps["follow"];
  onPick: (projectId: string | null) => void;
}) {
  const sorted = projects.toSorted((a, b) => a.title.localeCompare(b.title));
  return (
    <select
      className="board-picker"
      value={follow?.active ? FOLLOW_VALUE : (current ?? "")}
      onChange={(event) => {
        const value = event.target.value;
        if (value === FOLLOW_VALUE) follow?.onFollow();
        else onPick(value === "" ? null : value);
      }}
      aria-label="Project board"
    >
      {follow !== undefined ? <option value={FOLLOW_VALUE}>This chat's project</option> : null}
      <option value="">All projects</option>
      {sorted.map((project) => (
        <option key={project.id} value={project.id}>
          {project.title}
        </option>
      ))}
    </select>
  );
}

/** A thread's own board shows the thread itself above its sub-cards. */
function OwnerStrip({
  columns,
  owner,
  summary,
  onOpen,
  onMove,
}: {
  columns: ReadonlyArray<BoardColumn>;
  owner: CardView;
  summary: BoardSummary | undefined;
  onOpen: () => void;
  onMove: (stage: BoardStage) => void;
}) {
  return (
    <div className="board-owner">
      <div className="min-w-0 flex-1">
        <span className="board-owner-title">{owner.thread.title}</span>
        {summary !== undefined ? <p className="board-owner-summary">{summary.summary}</p> : null}
      </div>
      <StagePicker columns={columns} current={owner.column} onPick={onMove} />
      <button type="button" className="board-button" onClick={onOpen}>
        Open thread
      </button>
      <span className="board-bar-note">
        {owner.subCards === 0
          ? "No sub-threads yet"
          : `${owner.subCardsDone}/${owner.subCards} sub-threads done`}
      </span>
    </div>
  );
}

function StagePicker({
  columns,
  current,
  onPick,
}: {
  columns: ReadonlyArray<BoardColumn>;
  current: BoardStage;
  onPick: (stage: BoardStage) => void;
}) {
  return (
    <select
      className="board-picker"
      value={current}
      onChange={(event) => onPick(event.target.value as BoardStage)}
      aria-label="Stage"
    >
      {columns.map((column) => (
        <option key={column.id} value={column.id}>
          {column.title}
        </option>
      ))}
    </select>
  );
}

function BoardList({
  column,
  tint,
  cards,
  allCards,
  hidden,
  context,
  draggingId,
  onShowAll,
}: {
  column: BoardColumn;
  /** The list's pastel: an index, or the grey of the last archiving column. */
  tint: string;
  cards: ReadonlyArray<CardView>;
  /** Every card the filters leave in this list, shown or not. */
  allCards: ReadonlyArray<CardView>;
  hidden: number;
  context: BoardContext;
  draggingId: string | null;
  onShowAll: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const open = allCards.filter((card) => card.thread.archivedAt === null);
  const idle = column.archives ? [] : idleCards(allCards, context.now, STALE_DAYS);
  const outdated = open.filter((card) =>
    summaryIsStale(card.thread, context.summaries.get(card.thread.id)?.summarizedAt),
  );
  const archivable = column.archives ? open : [];
  // Stopped, open cards in a working column: worth asking to move forward.
  const nudgeable = column.archives
    ? []
    : open.filter((card) => {
        const turn = turnStatus(card.thread);
        return (
          turn !== "working" && turn !== "queued" && !context.pendingApprovals.has(card.thread.id)
        );
      });
  const confirmArchive = (list: ReadonlyArray<CardView>, what: string, into?: BoardStage) => {
    if (window.confirm(`Archive ${list.length} thread${list.length === 1 ? "" : "s"} ${what}?`)) {
      context.archive(list, into);
    }
  };
  const hasActions =
    idle.length > 0 || outdated.length > 0 || archivable.length > 0 || nudgeable.length > 0;
  return (
    <section
      ref={setNodeRef}
      className="board-list"
      data-stage={column.id}
      data-tint={tint}
      data-over={isOver ? "" : undefined}
      aria-label={column.title}
    >
      <header className="board-list-header">
        <h2>{column.title}</h2>
        <span className="board-count">{allCards.length}</span>
        {hasActions ? (
          <Menu>
            <MenuTrigger
              render={
                <button type="button" className="board-icon-button" aria-label="List actions" />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {nudgeable.length > 0 ? (
                <MenuItem
                  onClick={() => {
                    if (
                      window.confirm(
                        `Ask ${nudgeable.length} thread${nudgeable.length === 1 ? "" : "s"} in ${column.title} to move their work forward? Each starts a turn.`,
                      )
                    ) {
                      context.nudge(nudgeable);
                    }
                  }}
                >
                  Nudge {nudgeable.length} forward
                </MenuItem>
              ) : null}
              {outdated.length > 0 ? (
                <MenuItem onClick={() => context.summarize(outdated)}>
                  Summarize {outdated.length} out of date
                </MenuItem>
              ) : null}
              {archivable.length > 0 ? (
                <MenuItem
                  onClick={() =>
                    confirmArchive(archivable, `still open in ${column.title}`, column.id)
                  }
                >
                  Archive {archivable.length} still open
                </MenuItem>
              ) : null}
              {idle.length > 0 ? (
                <MenuItem
                  onClick={() =>
                    confirmArchive(idle, `in ${column.title} untouched for ${STALE_DAYS}+ days`)
                  }
                >
                  Archive {idle.length} idle {STALE_DAYS}+ days
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </header>
      {column.description ? <p className="board-list-hint">{column.description}</p> : null}
      <ol className="board-cards">
        {cards.map((card) => (
          <li key={card.thread.id}>
            <DraggableCard
              card={card}
              context={context}
              hiddenWhileDragging={draggingId === card.thread.id}
            />
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <button type="button" className="board-list-more" onClick={onShowAll}>
          Show {hidden} more
        </button>
      ) : null}
    </section>
  );
}

function DraggableCard({
  card,
  context,
  hiddenWhileDragging,
}: {
  card: CardView;
  context: BoardContext;
  hiddenWhileDragging: boolean;
}) {
  const { setNodeRef, attributes, listeners } = useDraggable({ id: card.thread.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="board-card-slot"
      data-card-id={card.thread.id}
      data-focused={context.focusedId === card.thread.id ? "" : undefined}
      data-placeholder={hiddenWhileDragging ? "" : undefined}
      onClick={() => context.open(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter") context.open(card);
      }}
    >
      <CardFace card={card} context={context} />
    </div>
  );
}

function CardFace({
  card,
  context,
  lifted = false,
}: {
  card: CardView;
  context: BoardContext;
  lifted?: boolean;
}) {
  const { thread } = card;
  const project = context.projectsById.get(thread.projectId);
  const summary = context.summaries.get(thread.id);
  const summarizing = context.summarizing.has(thread.id);
  const request = context.pendingApprovals.get(thread.id);
  const assignedToYou = card.card?.assignee === "user" && thread.archivedAt === null;
  const commentInfo = context.commentSummaries.get(thread.id);
  // The work's branch, when it is not the default one.
  const named = card.card?.branch ?? thread.branch ?? null;
  const branch = named !== null && !DEFAULT_BRANCHES.has(named) ? named : null;
  const liveTurn = turnStatus(thread);
  const turn =
    (request !== undefined || assignedToYou) && liveTurn !== "working" ? "needs-you" : liveTurn;
  const days = idleDays(thread, context.now);
  const archived = thread.archivedAt !== null;
  const suggestion =
    summary !== undefined && !archived && summary.suggestedStage !== card.column
      ? summary.suggestedStage
      : null;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <article
      className="board-card"
      data-lifted={lifted ? "" : undefined}
      data-turn={archived ? undefined : turn}
    >
      {context.showProject && project !== undefined ? (
        <div className="board-labels">
          <span className="board-label" data-colour={labelColour(project.id)}>
            {project.title}
          </span>
        </div>
      ) : null}
      <h3 className="board-card-title">{thread.title}</h3>
      {branch !== null ? (
        <p className="board-card-branch">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </p>
      ) : null}
      {summary !== undefined ? (
        <p
          className="board-card-summary"
          data-stale={summaryIsStale(thread, summary.summarizedAt) ? "" : undefined}
        >
          {summary.summary}
        </p>
      ) : null}
      {summary !== undefined && summary.next.length > 0 && !archived ? (
        <p className="board-card-next">
          <ArrowRightIcon className="size-3 shrink-0" />
          <span>{summary.next}</span>
        </p>
      ) : null}
      {request !== undefined && !archived ? (
        <div className="board-approval" onPointerDown={stop} onClick={stop}>
          <p className="board-approval-ask">
            Asks to move to <strong>{columnTitle(context.columns, request.stage)}</strong>
          </p>
          {request.note ? <p className="board-approval-note">{request.note}</p> : null}
          {!lifted ? (
            <div className="board-approval-actions">
              <button
                type="button"
                className="board-approval-button"
                data-tone="approve"
                onClick={() => context.decide(card, true)}
              >
                Approve
              </button>
              <button
                type="button"
                className="board-approval-button"
                onClick={() => context.decide(card, false)}
              >
                Decline
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="board-badges">
        {!archived ? (
          <span className="board-turn" data-turn={turn}>
            <span className="board-turn-dot" />
            {TURN_LABEL[turn]}
          </span>
        ) : null}
        <span
          className="board-badge"
          data-tone={!archived && days >= STALE_DAYS ? "stale" : undefined}
        >
          <ClockIcon className="size-3" />
          {age(thread.archivedAt ?? activityAt(thread), context.now)}
        </span>
        {card.subCards > 0 ? (
          <button
            type="button"
            className="board-badge board-badge-button"
            data-tone={card.subCardsDone === card.subCards ? "done" : undefined}
            aria-label="Open this card's board"
            onPointerDown={stop}
            onClick={(event) => {
              event.stopPropagation();
              context.openBoard(card);
            }}
          >
            <SquareCheckIcon className="size-3" />
            {card.subCardsDone}/{card.subCards}
          </button>
        ) : null}
        {card.card?.movedBy === "agent" || card.card?.movedBy === "auto" ? (
          <Tooltip>
            <TooltipTrigger render={<span className="board-badge" />}>
              {card.card.movedBy === "agent" ? (
                <BotIcon className="size-3" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {card.card.movedBy === "agent"
                ? "Moved here by its agent"
                : `Moved here from its summary${summary ? `: ${summary.reason}` : ""}`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {summary?.reviewedBy != null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="board-badge"
                  data-tone={missingReviews(summary) ? "stale" : "done"}
                />
              }
            >
              <ShieldCheckIcon className="size-3" />
              {summary.reviewedBy.length}/{BOARD_REVIEWS_WANTED}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {summary.reviewedBy.length === 0
                ? "Code changed; nobody has reviewed it yet"
                : `Reviewed by ${summary.reviewedBy.join(", ")}`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {commentInfo !== undefined ? (
          <button
            type="button"
            className="board-badge board-badge-button"
            aria-label={`${commentInfo.count} comment${commentInfo.count === 1 ? "" : "s"}; open the card`}
            onPointerDown={stop}
            onClick={(event) => {
              event.stopPropagation();
              context.openCard(card);
            }}
          >
            <MessageSquareIcon className="size-3" />
            {commentInfo.count}
          </button>
        ) : null}
        {summarizing ? <span className="board-badge board-badge-busy">Summarizing…</span> : null}
        {suggestion !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="board-badge board-badge-button board-suggest"
                  onPointerDown={stop}
                  onClick={(event) => {
                    event.stopPropagation();
                    context.move(card, suggestion);
                  }}
                />
              }
            >
              → {columnTitle(context.columns, suggestion)}?
            </TooltipTrigger>
            <TooltipPopup side="top">{summary?.reason}</TooltipPopup>
          </Tooltip>
        ) : null}
        {assignedToYou ? (
          <Tooltip>
            <TooltipTrigger render={<span className="board-assignee" />}>You</TooltipTrigger>
            <TooltipPopup side="top">
              Assigned to you
              {commentInfo?.last.author === "agent" ? `: ${commentInfo.last.body}` : ""}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {!lifted ? (
          <span
            className={assignedToYou ? undefined : "ml-auto"}
            onPointerDown={stop}
            onClick={stop}
          >
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="board-icon-button board-card-menu"
                    aria-label="Card actions"
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => context.openCard(card)}>Open card</MenuItem>
                <MenuItem onClick={() => context.openBoard(card)}>Open its board</MenuItem>
                {!archived ? (
                  <MenuItem onClick={() => context.nudge([card])}>Nudge forward</MenuItem>
                ) : null}
                <MenuItem onClick={() => context.summarize([card])}>
                  {summary === undefined ? "Summarize" : "Refresh summary"}
                </MenuItem>
                <MenuSeparator />
                {context.columns
                  .filter((column) => column.id !== card.column)
                  .map((column) => (
                    <MenuItem key={column.id} onClick={() => context.move(card, column.id)}>
                      Move to {column.title}
                    </MenuItem>
                  ))}
              </MenuPopup>
            </Menu>
          </span>
        ) : null}
      </div>
    </article>
  );
}
