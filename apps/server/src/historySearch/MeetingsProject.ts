// Create the Meetings project on first use, rooted at tui’s recordings folder,
// so questions run among the recordings without creating an unused startup project.
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Meetings from "./Meetings.ts";

export class MeetingsProjectError extends Schema.TaggedError<MeetingsProjectError>()(
  "MeetingsProjectError",
  { message: Schema.String },
) {}

/** What an agent in the Meetings project is told about where it is. */
const AGENT_INSTRUCTIONS = `# Your meetings

This folder holds the user's recorded meetings, one folder each, named
yyyy.MM.dd-HHmm. tui records, transcribes and writes the notes; you answer
questions about them.

In a meeting folder:
- summary.md: the notes: a summary, key points, decisions, action items.
- transcript.md: everything said, timestamped, by speaker ("me" is the user).
- notes.md: what the user typed during the meeting, when there is one.
- slides.md: text read off screens shared in it; meta.json: when and how long.

Search before you read. t3_history_search with sources ["meetings"] finds
meetings by words and by meaning; add meetingParts ["action"] for action items
and to-dos, ["decision"] for what was decided. t3_meeting_list lists them by
date; t3_meeting_read reads one's notes, or the transcript around a moment a
search hit names. Open the files yourself when you need more.

Name every meeting you draw on by its folder, like [[2026.09.30-1335]], right
after the point it supports, so the user can open it. Be concise: lists with
who and when; for to-dos, the owner, the task and the meeting. If the meetings
do not say, say so. Never change or delete a meeting's files.
`;

/** The folder, when it is there to be a project root. */
export const meetingsRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* Meetings.configuredDir;
  const info = yield* fs.stat(dir).pipe(Effect.option);
  return info._tag === "Some" && info.value.type === "Directory" ? dir : null;
});

export const ensureMeetingsProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const workspaceRoot = yield* meetingsRoot;
  if (workspaceRoot === null) {
    return yield* new MeetingsProjectError({
      message: "No meetings folder yet. tui creates it with the first recording.",
    });
  }
  // The agents' instructions, written once; a user's own edit is kept.
  for (const [file, text] of [
    ["AGENTS.md", AGENT_INSTRUCTIONS],
    ["CLAUDE.md", "@AGENTS.md\n"],
  ] as const) {
    const target = path.join(workspaceRoot, file);
    if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))) {
      yield* fs.writeFileString(target, text).pipe(Effect.ignore);
    }
  }
  const id = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => new MeetingsProjectError({ message: String(cause) })));
  const bootstrapped = yield* projects
    .bootstrap({
      commandId: CommandId.make(`meetings-project:${id}`),
      projectId: ProjectId.make(id),
      title: "Meetings",
      workspaceRoot,
    })
    .pipe(
      Effect.catchTags({
        ProjectConflictError: (conflict) =>
          Effect.succeed({ project: { id: conflict.conflictingProjectId }, created: false }),
      }),
      Effect.mapError((cause) => new MeetingsProjectError({ message: cause.message })),
    );
  if (bootstrapped.created) {
    yield* projects
      .update({
        commandId: CommandId.make(`meetings-project-icon:${id}`),
        projectId: bootstrapped.project.id,
        projectIcon: { kind: "lucide", name: "notebook-pen", color: "lime" },
      })
      .pipe(Effect.ignore);
  }
  return { projectId: bootstrapped.project.id, workspaceRoot };
});

// Per-meeting questions continue the thread in chat.json unless fresh is set.
// All-meeting questions create a thread; threadId continues an existing one.
export const askMeetings = Effect.fn("MeetingsProject.askMeetings")(function* (input: {
  readonly question: string;
  readonly meetingId?: string | undefined;
  readonly fresh?: boolean | undefined;
  readonly threadId?: string | undefined;
}) {
  const { projectId, workspaceRoot } = yield* ensureMeetingsProject;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => new MeetingsProjectError({ message: String(cause) })));
  const question = input.question.trim();
  const meetingId =
    input.meetingId !== undefined && Meetings.isMeetingId(input.meetingId) ? input.meetingId : null;

  const chatThreadId =
    input.fresh === true
      ? null
      : meetingId !== null
        ? yield* Meetings.readChatThreadId(workspaceRoot, meetingId)
        : (input.threadId ?? null);
  if (chatThreadId !== null) {
    // Behind an answer still being written, never steering it; a chat
    // whose thread was archived or deleted is started again below.
    const sent = yield* (yield* ThreadManagement.ThreadManagementService)
      .sendToThread({
        projectId,
        commandId: CommandId.make(`meetings-ask:${yield* uuid}`),
        threadId: ThreadId.make(chatThreadId),
        messageId: MessageId.make(yield* uuid),
        text: question,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (sent) return { projectId, threadId: chatThreadId };
  }

  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError((cause) => new MeetingsProjectError({ message: String(cause) })),
  );
  const resolved = resolveProjectSettings(settings, projectId).settings;
  const text = meetingId === null ? question : `About the meeting [[${meetingId}]]: ${question}`;
  const launched = yield* (yield* ThreadLaunch.ThreadLaunchService)
    .launch({
      commandId: CommandId.make(`meetings-ask:${yield* uuid}`),
      projectId,
      title: question.length > 60 ? `${question.slice(0, 57)}…` : question,
      generateTitle: true,
      modelSelection: resolved.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      },
      runtimeMode: resolved.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workspaceStrategy: { type: "root" },
      initialMessage: { text, attachments: [] },
      createdBy: "user",
      creationSource: "web",
    })
    .pipe(Effect.mapError((error) => new MeetingsProjectError({ message: error.message })));
  if (meetingId !== null) {
    yield* Meetings.writeChatThreadId(workspaceRoot, meetingId, launched.threadId).pipe(
      Effect.mapError(
        () => new MeetingsProjectError({ message: "Could not keep the chat with the meeting." }),
      ),
    );
  }
  return { projectId, threadId: launched.threadId };
});
