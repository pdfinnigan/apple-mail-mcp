/**
 * Regression: `list-messages unreadOnly=true` silently ignored the filter on
 * the AppleScript backend. `listMessagesWithDiagnostics` never accepted an
 * `unreadOnly` parameter at all, and both call sites in index.ts (the
 * no-IMAP-configured path and the AppleScript-only fallback inside the
 * multi-account merge) called it without one — so Mail.app returned every
 * message in scope, read and unread alike, and the caller had to filter the
 * results by hand. This covers the generated AppleScript `whose` clause for
 * each of the three list shapes (gmail-inbox, single-mailbox, all-mailboxes).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  router: {
    fn: (_script: string) => ({
      success: true,
      output: "",
      error: undefined as string | undefined,
    }),
  },
}));

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return {
    ...actual,
    executeAppleScript: (script: string) => {
      h.calls.push(script);
      return h.router.fn(script);
    },
  };
});

import { AppleMailManager } from "@/services/appleMailManager.js";

type ScriptResult = { success: boolean; output: string; error?: string };

function makeRouter(mailboxNames: string[]): (script: string) => ScriptResult {
  return (script: string): ScriptResult => {
    if (script.includes("set end of mbNames to mbPath")) {
      return { success: true, output: mailboxNames.join(", ") };
    }
    if (script.includes("set outputText to")) {
      return { success: true, output: "" };
    }
    return { success: true, output: "" };
  };
}

const MAILBOXES = ["INBOX", "Sent", "Drafts", "Trash"];

beforeEach(() => {
  h.calls = [];
  h.router.fn = makeRouter(MAILBOXES);
});

describe("listMessages unreadOnly", () => {
  it("adds `whose read status is false` for a single named mailbox", () => {
    const mgr = new AppleMailManager();
    mgr.listMessages("INBOX", "rob@superiortech.io", 50, undefined, 0, true);

    const listScript = h.calls.find((s) => s.includes("set outputText to"));
    expect(listScript).toContain("read status is false");
  });

  it("adds `whose read status is false` when scanning all mailboxes", () => {
    const mgr = new AppleMailManager();
    mgr.listMessages(undefined, "rob@superiortech.io", 50, undefined, 0, true);

    const listScript = h.calls.find((s) => s.includes("set outputText to"));
    expect(listScript).toContain("read status is false");
  });

  it("combines with `from` using `and`, same as search-messages", () => {
    const mgr = new AppleMailManager();
    mgr.listMessages("INBOX", "rob@superiortech.io", 50, "boss@acme.com", 0, true);

    const listScript = h.calls.find((s) => s.includes("set outputText to"));
    expect(listScript).toContain('sender contains "boss@acme.com" and read status is false');
  });

  it("omits the read-status filter when unreadOnly is not set (row still reports read status)", () => {
    const mgr = new AppleMailManager();
    mgr.listMessages("INBOX", "rob@superiortech.io", 50);

    const listScript = h.calls.find((s) => s.includes("set outputText to"));
    expect(listScript).not.toContain("read status is false");
    expect(listScript).not.toContain("read status is true");
  });

  // The Gmail virtual-INBOX fan-out (BUG A1) is a structurally separate
  // AppleScript template from the single-mailbox and all-mailboxes branches
  // above — "All Mail" in the mailbox list routes mailbox:"INBOX" through it
  // instead. It shares the same `fromFilter` variable, but that sharing is
  // exactly what the original bug broke (the variable wasn't built from
  // `unreadOnly` at all); covering it here means a future edit that gives
  // this branch its own filter construction can't silently drop the field
  // without a direct test failing.
  it("adds `whose read status is false` on the Gmail virtual-INBOX fan-out", () => {
    h.router.fn = makeRouter(["INBOX", "All Mail", "Important", "Sent", "Trash"]);
    const mgr = new AppleMailManager();
    mgr.listMessages("INBOX", "rob@gmail.com", 50, undefined, 0, true);

    const listScript = h.calls.find((s) => s.includes("set outputText to"));
    // Prove this actually took the Gmail fan-out branch (and not the
    // all-mailboxes branch falling back to the same assertion by accident) —
    // `_wantNames` only appears in that template.
    expect(listScript).toContain("_wantNames");
    expect(listScript).toContain("read status is false");
  });
});
