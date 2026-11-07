// Roost's card wall, drawn after Trello: lists on a coloured board, cards with
// labels on top and badges below. Every thread is a card; a card with
// sub-threads opens a board of its own.
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
import type { BoardStage, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronRightIcon,
  ClockIcon,
  KanbanSquareIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SquareCheckIcon,
} from "lucide-react";
import { useState } from "react";

import { resolveThreadStatusPill } from "~/components/Sidebar.logic";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { SidebarTrigger } from "~/components/ui/sidebar";

import {
  BOARD_COLUMNS,
  type BoardCardView,
  type BoardColumnSpec,
  type BoardScope,
  activityAt,
  buildBoard,
  idleCards,
  idleDays,
} from "./boardModel";
import { useBoard } from "./useBoard";

type Thread = ReturnType<typeof useBoard>["threads"][number];
type CardView = BoardCardView<Thread>;

/** Columns of archived threads grow without end; show the newest few. */
const ARCHIVE_SHOWN = 25;
const IDLE_CLEANUP_DAYS = 14;

/** Trello's label colours, one per project, the same every time. */
const LABEL_COLOURS = ["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink"];
const labelColour = (projectId: string) => {
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return LABEL_COLOURS[Math.abs(hash) % LABEL_COLOURS.length]!;
};

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

export function BoardPage() {
  const search = useSearch({ from: "/_chat/board" });
  const navigate = useNavigate();
  const board = useBoard(search.thread ?? null);
  const [filter, setFilter] = useState("");
  // Idle days are counted from when the board opened; a day's drift is fine.
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
  const view = buildBoard(board.threads, board.cards, scope, board.subCounts);
  const projectsById = new Map(board.projects.map((project) => [project.id as string, project]));
  const ownerProject =
    view.owner === null ? undefined : projectsById.get(view.owner.thread.projectId);
  const scopeProject = scope.kind === "project" ? projectsById.get(scope.projectId) : ownerProject;
  const needle = filter.trim().toLowerCase();
  const matches = (card: CardView) =>
    needle.length === 0 ||
    card.thread.title.toLowerCase().includes(needle) ||
    (projectsById.get(card.thread.projectId)?.title.toLowerCase().includes(needle) ?? false);

  const allCards = [...view.columns.values()].flat();
  const dragging = allCards.find((card) => card.thread.id === draggingId) ?? null;
  const openCount = allCards.filter((card) => card.thread.archivedAt === null).length;

  const goTo = (next: BoardSearch) => void navigate({ to: "/board", search: next });
  const openThread = (card: CardView) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: card.thread.environmentId, threadId: card.thread.id },
    });

  const onDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const to = event.over?.id as BoardStage | undefined;
    const card = allCards.find((candidate) => candidate.thread.id === event.active.id);
    if (to === undefined || card === undefined || card.column === to) return;
    void board.move(card.thread.id as ThreadId, to);
  };

  return (
    <div className="board-surface flex h-full min-w-0 flex-1 flex-col">
      <header className="board-bar">
        <SidebarTrigger className="md:hidden" />
        <nav className="board-crumbs" aria-label="Board">
          <KanbanSquareIcon className="size-4 shrink-0" />
          <Link to="/board" search={{}} className="board-crumb">
            All projects
          </Link>
          {scopeProject !== undefined ? (
            <>
              <ChevronRightIcon className="size-3.5 shrink-0 opacity-60" />
              <Link to="/board" search={{ project: scopeProject.id }} className="board-crumb">
                {scopeProject.title}
              </Link>
            </>
          ) : null}
          {view.owner !== null ? (
            <OwnerCrumbs owner={view.owner} threads={board.threads} onOpen={goTo} />
          ) : null}
        </nav>
        <ProjectPicker
          projects={board.projects}
          current={scope.kind === "project" ? scope.projectId : null}
          onPick={(projectId) => goTo(projectId === null ? {} : { project: projectId })}
        />
        <label className="board-search">
          <SearchIcon className="size-3.5 shrink-0 opacity-70" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter cards"
          />
        </label>
        <span className="board-bar-note">{board.loading ? "Loading…" : `${openCount} open`}</span>
      </header>

      {view.owner !== null ? (
        <OwnerStrip
          owner={view.owner}
          onOpen={() => openThread(view.owner!)}
          onMove={(stage) => void board.move(view.owner!.thread.id as ThreadId, stage)}
        />
      ) : null}

      {board.error ? <p className="board-error">{board.error}</p> : null}

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDraggingId(null)}
      >
        <div className="board-lists">
          {BOARD_COLUMNS.map((column) => {
            const cards = (view.columns.get(column.stage) ?? []).filter(matches);
            const showAll = showAllIn.has(column.stage) || !column.archives;
            return (
              <BoardList
                key={column.stage}
                column={column}
                cards={showAll ? cards : cards.slice(0, ARCHIVE_SHOWN)}
                hidden={showAll ? 0 : Math.max(0, cards.length - ARCHIVE_SHOWN)}
                total={cards.length}
                idle={column.archives ? [] : idleCards(cards, now, IDLE_CLEANUP_DAYS)}
                showProject={scope.kind === "all"}
                projectsById={projectsById}
                now={now}
                draggingId={draggingId}
                onShowAll={() => setShowAllIn((current) => new Set([...current, column.stage]))}
                onOpen={openThread}
                onOpenBoard={(card) => goTo({ thread: card.thread.id })}
                onMove={(card, stage) => void board.move(card.thread.id as ThreadId, stage)}
                onArchiveIdle={(cards) =>
                  void board.archiveMany(cards.map((card) => card.thread.id as ThreadId))
                }
              />
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging !== null ? (
            <CardFace
              card={dragging}
              project={projectsById.get(dragging.thread.projectId)}
              showProject={scope.kind === "all"}
              now={now}
              lifted
            />
          ) : null}
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
    let parent = parentOf(owner.thread);
    parent !== null && chain.length < 6;
    parent = parentOf(byId.get(parent)!)
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

function parentOf(thread: Thread | undefined): string | null {
  if (thread === undefined) return null;
  if (thread.lineage.relationshipToParent === "subagent") return thread.lineage.parentThreadId;
  if (thread.lineage.relationshipToParent === null && thread.delegatedFrom != null) {
    return thread.delegatedFrom.threadId;
  }
  return null;
}

function ProjectPicker({
  projects,
  current,
  onPick,
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  current: string | null;
  onPick: (projectId: string | null) => void;
}) {
  const sorted = projects.toSorted((a, b) => a.title.localeCompare(b.title));
  return (
    <select
      className="board-picker"
      value={current ?? ""}
      onChange={(event) => onPick(event.target.value === "" ? null : event.target.value)}
      aria-label="Project board"
    >
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
  owner,
  onOpen,
  onMove,
}: {
  owner: CardView;
  onOpen: () => void;
  onMove: (stage: BoardStage) => void;
}) {
  return (
    <div className="board-owner">
      <span className="board-owner-title">{owner.thread.title}</span>
      <StagePicker current={owner.column} onPick={onMove} />
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
  current,
  onPick,
}: {
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
      {BOARD_COLUMNS.map((column) => (
        <option key={column.stage} value={column.stage}>
          {column.title}
        </option>
      ))}
    </select>
  );
}

function BoardList({
  column,
  cards,
  hidden,
  total,
  idle,
  showProject,
  projectsById,
  now,
  draggingId,
  onShowAll,
  onOpen,
  onOpenBoard,
  onMove,
  onArchiveIdle,
}: {
  column: BoardColumnSpec;
  cards: ReadonlyArray<CardView>;
  hidden: number;
  total: number;
  idle: ReadonlyArray<CardView>;
  showProject: boolean;
  projectsById: ReadonlyMap<string, EnvironmentProject>;
  now: number;
  draggingId: string | null;
  onShowAll: () => void;
  onOpen: (card: CardView) => void;
  onOpenBoard: (card: CardView) => void;
  onMove: (card: CardView, stage: BoardStage) => void;
  onArchiveIdle: (cards: ReadonlyArray<CardView>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage });
  return (
    <section
      ref={setNodeRef}
      className="board-list"
      data-stage={column.stage}
      data-over={isOver ? "" : undefined}
      aria-label={column.title}
    >
      <header className="board-list-header">
        <h2>{column.title}</h2>
        <span className="board-count">{total}</span>
        {idle.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <button type="button" className="board-icon-button" aria-label="List actions" />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() => {
                  if (
                    window.confirm(
                      `Archive ${idle.length} thread${idle.length === 1 ? "" : "s"} in ${column.title} untouched for ${IDLE_CLEANUP_DAYS}+ days?`,
                    )
                  ) {
                    onArchiveIdle(idle);
                  }
                }}
              >
                Archive {idle.length} idle {IDLE_CLEANUP_DAYS}+ days
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </header>
      <p className="board-list-hint">{column.hint}</p>
      <ol className="board-cards">
        {cards.map((card) => (
          <li key={card.thread.id}>
            <DraggableCard
              card={card}
              project={projectsById.get(card.thread.projectId)}
              showProject={showProject}
              now={now}
              hiddenWhileDragging={draggingId === card.thread.id}
              onOpen={() => onOpen(card)}
              onOpenBoard={() => onOpenBoard(card)}
              onMove={(stage) => onMove(card, stage)}
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
  project,
  showProject,
  now,
  hiddenWhileDragging,
  onOpen,
  onOpenBoard,
  onMove,
}: {
  card: CardView;
  project: EnvironmentProject | undefined;
  showProject: boolean;
  now: number;
  hiddenWhileDragging: boolean;
  onOpen: () => void;
  onOpenBoard: () => void;
  onMove: (stage: BoardStage) => void;
}) {
  const { setNodeRef, attributes, listeners } = useDraggable({ id: card.thread.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="board-card-slot"
      data-placeholder={hiddenWhileDragging ? "" : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <CardFace
        card={card}
        project={project}
        showProject={showProject}
        now={now}
        onOpenBoard={onOpenBoard}
        onMove={onMove}
      />
    </div>
  );
}

function CardFace({
  card,
  project,
  showProject,
  now,
  lifted = false,
  onOpenBoard,
  onMove,
}: {
  card: CardView;
  project: EnvironmentProject | undefined;
  showProject: boolean;
  now: number;
  lifted?: boolean;
  onOpenBoard?: () => void;
  onMove?: (stage: BoardStage) => void;
}) {
  const { thread } = card;
  const status = thread.archivedAt === null ? resolveThreadStatusPill({ thread }) : null;
  const days = idleDays(thread, now);
  const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <article className="board-card" data-lifted={lifted ? "" : undefined}>
      {showProject && project !== undefined ? (
        <div className="board-labels">
          <span className="board-label" data-colour={labelColour(project.id)}>
            {project.title}
          </span>
        </div>
      ) : null}
      <h3 className="board-card-title">{thread.title}</h3>
      <div className="board-badges">
        {status !== null ? (
          <span className={`board-badge ${status.colorClass}`}>
            <span
              className={`size-1.5 rounded-full ${status.dotClass} ${status.pulse ? "animate-pulse" : ""}`}
            />
            {status.label}
          </span>
        ) : null}
        {status === null ? (
          <span
            className="board-badge"
            data-tone={
              thread.archivedAt === null && days >= IDLE_CLEANUP_DAYS ? "stale" : undefined
            }
          >
            <ClockIcon className="size-3" />
            {age(thread.archivedAt ?? activityAt(thread), now)}
          </span>
        ) : null}
        {card.subCards > 0 ? (
          <button
            type="button"
            className="board-badge board-badge-button"
            data-tone={card.subCardsDone === card.subCards ? "done" : undefined}
            aria-label="Open this card's board"
            onPointerDown={stopPropagation}
            onClick={(event) => {
              event.stopPropagation();
              onOpenBoard?.();
            }}
          >
            <SquareCheckIcon className="size-3" />
            {card.subCardsDone}/{card.subCards}
          </button>
        ) : null}
        {card.card?.movedBy === "agent" ? (
          <span className="board-badge" aria-label="Moved here by its agent">
            <BotIcon className="size-3" />
          </span>
        ) : null}
        {onMove !== undefined ? (
          <span className="ml-auto" onPointerDown={stopPropagation} onClick={stopPropagation}>
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
                {onOpenBoard !== undefined ? (
                  <>
                    <MenuItem onClick={onOpenBoard}>Open its board</MenuItem>
                    <MenuSeparator />
                  </>
                ) : null}
                {BOARD_COLUMNS.filter((column) => column.stage !== card.column).map((column) => (
                  <MenuItem key={column.stage} onClick={() => onMove(column.stage)}>
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
