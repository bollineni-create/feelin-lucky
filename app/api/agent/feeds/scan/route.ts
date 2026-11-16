import { agentRoute } from "@/lib/agent-auth";
import { feedScanLine, scanFeeds } from "@/lib/feeds";

export const dynamic = "force-dynamic";

/** Reads every watchlist company's Greenhouse, Lever, Ashby, SmartRecruiters or Workday board and records the matches. */
export const POST = agentRoute(async () => {
  const summary = await scanFeeds();
  return { ok: true, line: feedScanLine(summary), summary };
});
