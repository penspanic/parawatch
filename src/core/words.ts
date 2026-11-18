/**
 * Short words for GitHub news, shared by `status`, the panel and the desktop app's notifications,
 * so all three say the same thing.
 */
import type { InboxThread, NewsItem } from "./types.js";

/** Why a notification from another person is in the inbox, in a few words. */
export function inboxReason(t: Pick<InboxThread, "reason" | "by">): string {
  const who = t.by ?? "someone";
  switch (t.reason) {
    case "mention":
      return t.by ? `${t.by} mentioned you` : "mentioned you";
    case "team_mention":
      return t.by ? `${t.by} mentioned your team` : "mentioned your team";
    case "review_requested":
      return "asks for your review";
    case "approval_requested":
      return "asks for your approval";
    case "assign":
      return "assigned to you";
    case "invitation":
      return "invited you";
    case "security_alert":
      return "security alert";
    default:
      return `${who} wrote`;
  }
}

const NEWS_WORDS: Record<string, string> = {
  review: "reviewed",
  approved: "approved",
  changes_requested: "changes requested",
  commented: "comment",
  ci_failed: "CI failed",
  ci_passed: "CI passed",
  queued: "queued",
  queue_removed: "left the merge queue",
  conflict: "conflict",
  merged: "merged",
  closed: "closed",
  note: "note",
  assigned: "assigned to you",
};

/** What happened, in a few words: "merged", "CI failed", "changes requested by kim". */
export function newsWords(n: Pick<NewsItem, "change" | "by">): string {
  const w = NEWS_WORDS[n.change] ?? n.change;
  return n.by && n.change !== "merged" && n.change !== "closed" && !n.change.startsWith("ci_") ? `${w} · ${n.by}` : w;
}
