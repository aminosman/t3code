import { createFileRoute } from "@tanstack/react-router";

import { MeetingPage } from "~/components/meetings/MeetingPage";

function MeetingRoute() {
  const { meetingId } = Route.useParams();
  return <MeetingPage key={meetingId} meetingId={meetingId} />;
}

export const Route = createFileRoute("/_chat/meetings/$meetingId")({
  component: MeetingRoute,
});
