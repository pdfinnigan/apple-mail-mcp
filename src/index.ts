#!/usr/bin/env node
/**
 * Apple Mail MCP Server
 *
 * A Model Context Protocol (MCP) server that provides AI assistants
 * with the ability to interact with Apple Mail on macOS.
 *
 * This server exposes tools for:
 * - Reading and searching emails
 * - Sending emails
 * - Managing mailboxes
 * - Managing multiple accounts (iCloud, Gmail, Exchange, etc.)
 *
 * Architecture:
 * - Tool definitions are declarative (schema + handler)
 * - The AppleMailManager class handles all AppleScript operations
 * - Error handling is consistent across all tools
 *
 * @module apple-mail-mcp
 * @see https://modelcontextprotocol.io
 */

import { createRequire } from "module";
import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { integerNumber, registerToolWithContracts } from "@/utils/toolRegistration.js";
import { AppleMailManager, LOCAL_STORE_LABEL } from "@/services/appleMailManager.js";
import {} from "fs";
import {} from "path";
import { isSmtpConfigured, composeRawMime, SMTP_ENV } from "@/services/smtpMailer.js";
import {} from "@/tools/compose.js";
import {} from "@/tools/serialEmail.js";
import { runThreadedDraft, threadingHeaders, type ThreadedDraftDeps } from "@/tools/threading.js";
import {
  isImapAccount,
  shouldUseImap,
  resolveImapConfigs,
  dropAllPools,
  imapSearchMessages,
  imapListMessages,
  imapUnreadCount,
  imapListMailboxes,
  imapMailStats,
  imapListAttachments,
  imapFetchAttachment,
  imapThread,
  omittedNote,
  stoppedNote,
  unscopedSearchOffsetError,
  type OmittedMessage,
  imapGetMessage,
  imapGetMessageHeaders,
  imapAppendDraft,
  resolveDraftImapAccount,
  FLAG_COLOR_NAMES,
} from "@/services/imapClient.js";
import {
  successResponse,
  errorResponse,
  partialCoverageBlock,
  withErrorHandling,
  currentCallTiming,
  messageSummary,
} from "@/tools/respond.js";
import { unlistableStoreError } from "@/tools/mailboxListing.js";
import { createCallStop, searchDeadlineMs, stoppedByDeadline } from "@/utils/callStop.js";
import {} from "@/tools/batchResults.js";
import {} from "@/tools/batchMutations.js";
import {
  fanOutImapMessages,
  mergeMessages,
  formatMergedRows,
  partitionAccountsForCounts,
  planCountSources,
  type MessageRow,
} from "@/services/imapMultiAccount.js";
import type { Account, SearchDiagnostics, SearchResult } from "@/types.js";
import { routeMessage } from "@/services/messageRouter.js";
import { runDoctor, formatDoctorReport } from "@/tools/doctor.js";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";
import {
  ATTACHMENTS_SCHEMA,
  DATE_FILTER_SCHEMA,
  IN_REPLY_TO_SCHEMA,
  MESSAGE_ID_SCHEMA,
  REFERENCES_SCHEMA,
} from "@/schemas.js";
import { normalizeSubject, subjectFromGetMessage } from "@/tools/thread.js";
import { extractRfcMessageIdFromSource } from "@/utils/mimeParse.js";
import { headersStructured, isoOrUndefined, parseHeaderBlock } from "@/utils/headers.js";
import { ImapIdleWatcher } from "@/services/imapIdle.js";
import { loadFileConfig } from "@/services/fileConfig.js";
import { isOrphaned } from "@/utils/orphan.js";
import { withJsonSchema2020_12 } from "@/utils/jsonSchemaDialect.js";
import {} from "@/services/auditLog.js";

// Load file-based config FIRST (2.1.1) — before anything reads APPLE_MAIL_MCP_*.
// Lets users configure the server when the host app strips the MCP env block.
loadFileConfig();

/** Apple Mail flag colors → the 0-6 palette index. `grey` is an alias for `gray`.
 *  Works on BOTH routes: AppleScript sets `flag index`, and the IMAP path writes
 *  the same index as the `$MailFlagBit0/1/2` keyword bitfield Mail.app uses on the
 *  wire. `\Flagged` alone is colorless, but the bits ride alongside it, so a smart
 *  mailbox keyed on flag color matches either way. */
// FLAG_COLOR_NAMES (imapClient.js) is the index<->name source of truth;
// FLAG_COLOR_INDEX is just its reverse (name -> index) plus the 'grey' alias.
const FLAG_COLOR_INDEX: Record<string, number> = Object.fromEntries(
  FLAG_COLOR_NAMES.map((name, index) => [name, index])
);
FLAG_COLOR_INDEX.grey = FLAG_COLOR_INDEX.gray;
const FLAG_COLOR_FILTER_SCHEMA = z
  .enum(["red", "orange", "yellow", "green", "blue", "purple", "gray", "grey"])
  .optional()
  .describe(
    "Filter to messages flagged with exactly this color (same palette as flag-message: red/orange/yellow/green/blue/purple/gray — 'grey' accepted). A message flagged with Mail's plain default (no explicit color) never matches. Implies isFlagged: true — pairing this with isFlagged: false is rejected as contradictory. Caveat on IMAP accounts only: 'red' is Mail's all-bits-clear encoding, wire-identical to a plain (colorless) flag, so red: true in results and flagColor: 'red' in this filter both also match a plain flag there — this is inherent to Apple's $MailFlagBit0/1/2 scheme, not specific to this server. AppleScript-only accounts distinguish red correctly (Mail's own `flag index` 0 vs -1)."
  );

// =============================================================================
// Shared Output Schemas (MCP outputSchema)
//
// Every tool below declares an MCP `outputSchema` so clients can know and
// validate the output shape. The SDK requires `structuredContent` on every
// success result once an outputSchema is present and validates it against the
// schema, so these schemas are intentionally PERMISSIVE — fields are optional
// unless they are provably always present on every success path, no `.strict()`
// is used (extra keys pass), and rows that vary across the AppleScript and IMAP
// backends use loose element types. Error responses are exempt from validation.
// =============================================================================

/** A message row in a list/search result. Loose: the AppleScript path emits a
 *  messageSummary while the IMAP path emits its own record, so allow any keys. */
const MESSAGE_ROW_SCHEMA = z.object({}).passthrough();

/** Shape returned by list/search style tools (messages + count + optional
 *  partial-coverage diagnostics from either backend). */
const LIST_OUTPUT_SCHEMA = {
  messages: z.array(MESSAGE_ROW_SCHEMA).optional(),
  count: z.number().optional(),
  partial: z.boolean().optional(),
  skippedLargeMailboxes: z.array(z.string()).optional(),
  notSearchedMailboxes: z.array(z.string()).optional(),
  timedOutAccounts: z.array(z.string()).optional(),
  failedMailboxes: z.array(z.string()).optional(),
  // Underlying error text per entry in `failedMailboxes`, same keys (#246
  // follow-up) — declared so a client can rely on it rather than parse text.
  failedMailboxReasons: z.record(z.string(), z.string()).optional(),
  // Messages that belong on the page but could not be read, each with its
  // imap: id and why (#256 follow-up). Non-empty implies `partial: true`.
  omittedMessages: z
    .array(z.object({ id: z.string(), mailbox: z.string(), uid: z.number(), reason: z.string() }))
    .optional(),
  // Mailboxes a cancelled or out-of-time search-messages never finished (#276),
  // and why. Non-empty implies `partial: true`.
  timedOutMailboxes: z.array(z.string()).optional(),
  stoppedBy: z.enum(["deadline", "cancelled"]).optional(),
};

/** A health/doctor check item — loose to accept both health-check
 *  ({name, passed, message}) and doctor ({name, status, detail}) items. */
const CHECK_ITEM_SCHEMA = z.object({}).passthrough();

// Read version from package.json to keep it in sync
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** An empty SearchDiagnostics (complete coverage). */
function emptyDiagnostics(): SearchDiagnostics {
  return {
    partial: false,
    timedOutAccounts: [],
    skippedLargeMailboxes: [],
    notSearchedMailboxes: [],
  };
}

/** Merge two diagnostics objects (union the lists, OR the partial flag). */
function mergeDiagnostics(a: SearchDiagnostics, b: SearchDiagnostics): SearchDiagnostics {
  return {
    partial: a.partial || b.partial,
    timedOutAccounts: [...a.timedOutAccounts, ...b.timedOutAccounts],
    skippedLargeMailboxes: [...a.skippedLargeMailboxes, ...b.skippedLargeMailboxes],
    notSearchedMailboxes: [...a.notSearchedMailboxes, ...b.notSearchedMailboxes],
  };
}

/** Result of the partitioned AppleScript scan: structured rows + merged diagnostics. */
interface AppleScan {
  rows: MessageRow[];
  diagnostics: SearchDiagnostics;
}

/**
 * Run a per-account AppleScript scan over ONLY the given accounts (the ones no
 * IMAP config covers), concatenating their rows and merging diagnostics. The IMAP
 * fan-out already covers the IMAP accounts, so this avoids scanning them on the
 * AppleScript side — which, for an all-IMAP user, means ZERO AppleScript work and
 * therefore no reliance on the fragile composite dedup. `scan` runs one account.
 */
function appleScanForAccounts(
  accounts: Account[],
  scan: (accountName: string) => SearchResult
): AppleScan {
  const rows: MessageRow[] = [];
  let diagnostics = emptyDiagnostics();
  for (const acct of accounts) {
    const res = scan(acct.name);
    rows.push(...res.messages.map(messageSummary));
    diagnostics = mergeDiagnostics(diagnostics, res.diagnostics);
  }
  return { rows, diagnostics };
}

/**
 * Build the success response for a no-account, prefer-IMAP MERGED message list
 * (search-messages / list-messages — v2.6.0). Concatenates the IMAP fan-out rows
 * with the (already partitioned) AppleScript rows, de-dups (IMAP copy wins — a
 * safety net for heuristic misses + IMAP-vs-IMAP dupes, no longer load-bearing
 * for matched accounts), sorts newest-first, applies `limit`, and preserves the
 * partial-coverage diagnostics (AppleScript scan + any failed IMAP fan-out).
 *
 * @param verb "matched" (search) or "listed" (list) — only affects empty-state text.
 */
function mergedMessageResponse(
  fan: {
    rows: MessageRow[];
    accountsQueried: string[];
    accountsFailed: string[];
    failedMailboxes: string[];
    failedMailboxReasons: Record<string, string>;
    omittedMessages: OmittedMessage[];
    timedOutMailboxes?: string[];
  },
  apple: AppleScan,
  limit: number,
  verb: "matched" | "listed",
  stopSignal?: AbortSignal
) {
  const merged = mergeMessages(fan.rows, apple.rows, limit);
  const timedOutMailboxes = fan.timedOutMailboxes ?? [];
  // Surface IMAP fan-out failures alongside the AppleScript diagnostics so a
  // partial merge is never mistaken for a confirmed "no such mail".
  const diagnostics: SearchDiagnostics = {
    ...apple.diagnostics,
    partial:
      apple.diagnostics.partial ||
      fan.accountsFailed.length > 0 ||
      fan.failedMailboxes.length > 0 ||
      fan.omittedMessages.length > 0 ||
      timedOutMailboxes.length > 0,
    timedOutAccounts: [...apple.diagnostics.timedOutAccounts, ...fan.accountsFailed],
    notSearchedMailboxes: [...apple.diagnostics.notSearchedMailboxes, ...fan.failedMailboxes],
  };
  const structured = {
    messages: merged,
    count: merged.length,
    partial: diagnostics.partial,
    skippedLargeMailboxes: diagnostics.skippedLargeMailboxes,
    notSearchedMailboxes: diagnostics.notSearchedMailboxes,
    timedOutAccounts: diagnostics.timedOutAccounts,
    failedMailboxes: fan.failedMailboxes,
    failedMailboxReasons: fan.failedMailboxReasons,
    omittedMessages: fan.omittedMessages,
    ...(timedOutMailboxes.length > 0
      ? {
          timedOutMailboxes,
          stoppedBy: stoppedByDeadline(stopSignal) ? ("deadline" as const) : ("cancelled" as const),
        }
      : {}),
  };
  const coverageBlock =
    partialCoverageBlock(diagnostics) +
    omittedNote(fan.omittedMessages, true) +
    stoppedNote(timedOutMailboxes, stopSignal);
  if (merged.length === 0) {
    const base = diagnostics.partial
      ? `No messages found in the portions that were ${verb === "matched" ? "searched" : "listed"}.`
      : "No messages found";
    return successResponse(`${base}${coverageBlock}`, structured);
  }
  const parts: string[] = [];
  if (fan.accountsQueried.length > 0)
    parts.push(`IMAP account(s): ${fan.accountsQueried.join(", ")}`);
  if (apple.rows.length > 0) parts.push("AppleScript");
  const accountsNote = parts.length > 0 ? ` (merged across ${parts.join(" + ")})` : "";
  return successResponse(
    `Found ${merged.length} message(s)${accountsNote}:\n${formatMergedRows(merged)}${coverageBlock}`,
    structured
  );
}

// =============================================================================
// Server Initialization
// =============================================================================

/**
 * MCP server instance configured for Apple Mail operations.
 */
const server = new McpServer(
  {
    name: "apple-mail",
    version,
    description: "MCP server for managing Apple Mail - read, search, send, and organize emails",
  },
  // logging capability lets the IMAP IDLE watcher push new-mail notifications (B5).
  { capabilities: { logging: {} } }
);

function registerTool<
  OutputArgs extends z.ZodRawShape,
  InputArgs extends undefined | z.ZodRawShape = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool {
  // The v3 converter reused the described inReplyTo token for references.items.
  // Preserve that published annotation while keeping the original token parser.
  if (name === "send-email" || name === "create-draft") {
    const token = REFERENCES_SCHEMA.unwrap().element;
    z.globalRegistry.add(token, { ...token.meta(), description: IN_REPLY_TO_SCHEMA.description });
  }
  return registerToolWithContracts(server, name, config, cb);
}

/**
 * Singleton instance of the Apple Mail manager.
 * Handles all AppleScript execution and mail operations.
 */
const mailManager = new AppleMailManager();

// MCP resources (accounts/templates/mailboxes) and prompts (triage/reply/
// summary) — additive context + workflows alongside the tools (D2).
registerResourcesAndPrompts(server, mailManager);

// =============================================================================
// Message Tools
// =============================================================================

// --- search-messages ---

registerTool(
  "search-messages",
  {
    description:
      "Use when: finding messages by query/sender/subject/date/read/flag/flag-color filters and you need their ids for follow-up operations.\nReturns: matching messages with id, date, subject, sender, read state, and flagColor when flagged with an explicit color (plus partial-coverage diagnostics when some mailboxes were skipped). An IMAP search stops at its deadline (APPLE_MAIL_MCP_SEARCH_DEADLINE_MS, default 45s) or when the request is cancelled, returning the matches found so far with partial: true and timedOutMailboxes — narrow with mailbox/dateFrom rather than repeating it.\nDo not use when: you want a plain mailbox listing without filters (use list-messages), already have an id and want the body (use get-message), or want a whole conversation (use get-thread).\nPrefer this first to obtain the message ids that get-message/mark-as-read/delete-message/move-message and the batch tools require.\nTip: use flagColor to find messages you tagged earlier (e.g. all 'orange' across mailboxes) — colored flags work as cross-mailbox labels this way, via flag-message/batch-flag-messages to set them and this filter to find them again, without moving anything into a dedicated folder.",
    inputSchema: {
      query: z.string().optional().describe("Text to search for in subject or sender"),
      body: z
        .string()
        .optional()
        .describe(
          "Text to search for in the message body (server-side IMAP BODY search). Requires the IMAP backend for the account searched; AppleScript-only accounts cannot search bodies and are reported as not searched."
        ),
      from: z
        .string()
        .optional()
        .describe(
          "Filter by sender (substring match against the full sender string, i.e. display name + address — not an exact address match)"
        ),
      subject: z.string().optional().describe("Filter by subject line (substring match)"),
      mailbox: z
        .string()
        .optional()
        .describe("Mailbox to search in (e.g., 'INBOX'). Omit to search all mailboxes."),
      account: z.string().optional().describe("Account to search in (omit to search all accounts)"),
      isRead: z.boolean().optional().describe("Filter by read status"),
      isFlagged: z.boolean().optional().describe("Filter by flagged status"),
      flagColor: FLAG_COLOR_FILTER_SCHEMA,
      dateFrom: DATE_FILTER_SCHEMA.describe("Start date filter (e.g., 'January 1, 2026')"),
      dateTo: DATE_FILTER_SCHEMA.describe("End date filter (e.g., 'March 1, 2026')"),
      limit: integerNumber()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of results (default: 50, max: 500)"),
      offset: integerNumber()
        .min(0)
        .optional()
        .describe(
          "Number of newest matches to skip (for pagination; IMAP accounts only). Without a mailbox, offset + limit may not exceed 5,000 — name a mailbox to page deeper."
        ),
    },
    outputSchema: LIST_OUTPUT_SCHEMA,
  },
  withErrorHandling(
    async ({
      query,
      body,
      mailbox,
      account,
      limit = 50,
      offset = 0,
      dateFrom,
      dateTo,
      from,
      subject,
      isRead,
      isFlagged,
      flagColor,
    }) => {
      // IMAP backend: prefer direct IMAP whenever IMAP is configured (v2.6.0).
      //   - explicit IMAP account → single-account IMAP (fast path);
      //   - no account + IMAP configured → MERGE: IMAP fans out over every
      //     configured account; AppleScript scans ONLY the accounts no IMAP
      //     config covers (partitioned — so an all-IMAP user runs ZERO
      //     AppleScript and never relies on the composite dedup);
      //   - explicit non-IMAP account (or IMAP unconfigured) → AppleScript below.
      // `offset` used to be silently dropped here (the schema had no such
      // field). It is honoured on IMAP and refused, with the reason, wherever
      // it can't be: an all-mailbox merge past MAX_UNSCOPED_SEARCH_DEPTH, and
      // the AppleScript backend, whose search has no offset.
      if (offset > 0 && !mailbox) {
        const tooDeep = unscopedSearchOffsetError(offset, limit);
        if (tooDeep) return errorResponse(tooDeep);
      }
      // #286: flagColor implies isFlagged: true — an explicit isFlagged: false
      // alongside it can never match anything (a colored flag IS a flag), so
      // reject the contradiction rather than silently return zero results.
      if (flagColor && isFlagged === false) {
        return errorResponse(
          `flagColor ("${flagColor}") and isFlagged: false are contradictory — a message flagged with a color is always flagged. Drop isFlagged or set it to true.`
        );
      }
      const flagColorIndex = flagColor ? FLAG_COLOR_INDEX[flagColor] : undefined;
      if (shouldUseImap(account)) {
        // #276: one signal for "stop now" — the client's notifications/cancelled
        // or the per-call deadline (APPLE_MAIL_MCP_SEARCH_DEADLINE_MS, measured
        // from arrival so queue wait counts). The IMAP mailbox fan-out watches
        // it and returns what it found plus `timedOutMailboxes`, instead of
        // holding the serial gate for minutes (134-141s observed on iCloud).
        const stop = createCallStop(currentCallTiming(), searchDeadlineMs());
        try {
          return await searchViaImap(stop.signal);
        } finally {
          stop.dispose();
        }
      }
      return searchViaAppleScript();

      async function searchViaImap(signal: AbortSignal) {
        const imapArgs = {
          query,
          body,
          mailbox,
          limit,
          offset,
          dateFrom,
          dateTo,
          from,
          subject,
          isRead,
          isFlagged,
          flagColorIndex,
        };
        if (account !== undefined) {
          const r = await imapSearchMessages({ ...imapArgs, account }, { signal });
          return successResponse(r.text, {
            messages: r.messages,
            count: r.count,
            partial: r.partial,
            failedMailboxes: r.failedMailboxes,
            failedMailboxReasons: r.failedMailboxReasons,
            omittedMessages: r.omittedMessages,
            ...(r.timedOutMailboxes?.length
              ? { timedOutMailboxes: r.timedOutMailboxes, stoppedBy: r.stoppedBy }
              : {}),
          });
        }
        const { appleScriptOnly } = partitionAccountsForCounts(
          mailManager.listAccounts(),
          resolveImapConfigs()
        );
        if (offset > 0 && appleScriptOnly.length > 0 && !body) {
          return errorResponse(
            `offset is supported only on IMAP accounts, and ${appleScriptOnly
              .map((a) => `"${a.name}"`)
              .join(", ")} ${appleScriptOnly.length === 1 ? "is" : "are"} AppleScript-only. ` +
              `Pass an IMAP account to page, or omit offset.`
          );
        }
        const fan = await fanOutImapMessages(imapArgs, "search", { signal });
        // Body search is IMAP-only: AppleScript's `content contains` has to pull
        // every message body through the Apple Event bridge and times out on
        // real mailboxes. Rather than silently drop the body filter (and return
        // subject/sender matches as if they were body matches), AppleScript-only
        // accounts are skipped and reported as not searched.
        if (body) {
          const apple: AppleScan = {
            rows: [],
            diagnostics: {
              ...emptyDiagnostics(),
              partial: appleScriptOnly.length > 0,
              notSearchedMailboxes: appleScriptOnly.map(
                (a) => `${a.name} (body search requires the IMAP backend)`
              ),
            },
          };
          return mergedMessageResponse(fan, apple, limit, "matched", signal);
        }
        if (signal.aborted && appleScriptOnly.length > 0) {
          // Out of time (or cancelled) after the IMAP fan-out: don't start a
          // blocking AppleScript scan nobody will wait for — report it instead.
          const apple: AppleScan = {
            rows: [],
            diagnostics: {
              ...emptyDiagnostics(),
              partial: true,
              timedOutAccounts: appleScriptOnly.map((a) => a.name),
            },
          };
          return mergedMessageResponse(fan, apple, limit, "matched", signal);
        }
        const apple = appleScanForAccounts(appleScriptOnly, (acctName) =>
          mailManager.searchMessagesWithDiagnostics(
            query,
            mailbox,
            acctName,
            limit,
            dateFrom,
            dateTo,
            from,
            subject,
            isRead,
            isFlagged,
            flagColorIndex
          )
        );
        return mergedMessageResponse(fan, apple, limit, "matched", signal);
      }

      function searchViaAppleScript() {
        if (offset > 0) {
          return errorResponse(
            `offset is supported only on IMAP accounts; IMAP is not configured for ${
              account ? `account "${account}"` : "any account"
            }. Omit offset, or narrow the search with dateFrom/dateTo instead.`
          );
        }

        if (body) {
          return errorResponse(
            `Body search requires the IMAP backend, which is not configured for ${
              account ? `account "${account}"` : "any account"
            }. Configure IMAP (see the IMAP backend section of the README) or search by query/subject/from instead.`
          );
        }

        const { messages, diagnostics } = mailManager.searchMessagesWithDiagnostics(
          query,
          mailbox,
          account,
          limit,
          dateFrom,
          dateTo,
          from,
          subject,
          isRead,
          isFlagged,
          flagColorIndex
        );

        const coverageBlock = partialCoverageBlock(diagnostics);
        const structured = {
          messages: messages.map(messageSummary),
          count: messages.length,
          partial: diagnostics.partial,
          skippedLargeMailboxes: diagnostics.skippedLargeMailboxes,
          notSearchedMailboxes: diagnostics.notSearchedMailboxes,
          timedOutAccounts: diagnostics.timedOutAccounts,
        };

        if (messages.length === 0) {
          const base = diagnostics.partial
            ? "No messages found in the portions that were searched."
            : "No messages found matching criteria";
          return successResponse(`${base}${coverageBlock}`, structured);
        }

        const messageList = messages
          .map(
            (m) =>
              `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
          )
          .join("\n");

        return successResponse(
          `Found ${messages.length} message(s):\n${messageList}${coverageBlock}`,
          structured
        );
      }
    },
    "Error searching messages"
  )
);

// --- get-message ---

registerTool(
  "get-message",
  {
    description:
      "Use when: reading the full body of one message whose id you already have (numeric or imap:…); set preferHtml to get the HTML body instead of plain text.\nReturns: the message subject, body (plain text by default, HTML when preferHtml is true), its stable RFC Message-ID (rfcMessageId) for dedup/threading, and two dates: dateSent (the author's Date: header — survives a migration/re-import) and dateReceived (arrival in the mailbox; this is the one a migration resets).\nTip: pass the mailbox+account you got the id from (e.g. from search-messages) to fetch it directly — required for reliable reads of large folders like \"Sent Items\", which otherwise time out.\nDo not use when: you don't yet have an id (use search-messages or list-messages first), you want the whole conversation (use get-thread), or you need the raw headers / Received: trace (use get-message-headers).",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      preferHtml: z
        .boolean()
        .optional()
        .describe("Return the HTML body (extracted from the message source) instead of plain text"),
      mailbox: z
        .string()
        .optional()
        .describe(
          'Mailbox that holds the message (e.g. "Sent Items"). Numeric ids are unique per mailbox; supplying this (with account) opens that mailbox directly instead of scanning every mailbox, which is required to read large folders like Sent Items without timing out.'
        ),
      account: z
        .string()
        .optional()
        .describe(
          "Account that holds the message. Pair with `mailbox` for a direct, scan-free fetch."
        ),
    },
    outputSchema: {
      id: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      isHtml: z.boolean().optional(),
      rfcMessageId: z
        .string()
        .optional()
        .describe(
          "Stable RFC 5322 Message-ID (angle brackets stripped); empty when the message has none"
        ),
      dateSent: z
        .string()
        .optional()
        .describe(
          "ISO 8601 send time from the message's Date: header (Mail's `date sent`). Absent when the message carries no parseable Date: header, or when the value is more than 7 days later than dateReceived — a send time after arrival is not a real one."
        ),
      dateReceived: z
        .string()
        .optional()
        .describe(
          "ISO 8601 arrival time in the mailbox (IMAP INTERNALDATE / Mail's `date received`). A migration or re-import resets this; compare with dateSent."
        ),
    },
  },
  withErrorHandling(
    ({ id, preferHtml, mailbox, account }) =>
      routeMessage(id, {
        // IMAP id (imap:…) → fetch via IMAP (#43 Phase 3); else AppleScript.
        imap: () => imapGetMessage(id, preferHtml === true),
        // IMAP path: parse subject/body out of the returned source so the
        // structuredContent matches the AppleScript branch's shape.
        structuredFromResult: (r) => {
          if (!r.info) return undefined;
          const sep = r.info.indexOf("\n\n");
          return {
            id,
            subject: subjectFromGetMessage(r.info),
            body: sep >= 0 ? r.info.slice(sep + 2) : r.info,
            // What the IMAP read actually extracted (#234): with no text/plain
            // part it returns the HTML part, which must not claim to be text.
            isHtml: typeof r.meta?.isHtml === "boolean" ? r.meta.isHtml : preferHtml === true,
            // Prefer the envelope's Message-ID (#224 fix): `info` is subject +
            // body with no header block, so parsing it yielded "" for every
            // IMAP-sourced message from 2.2.0 through 2.18.1.
            rfcMessageId:
              (r.meta?.rfcMessageId as string | undefined) || extractRfcMessageIdFromSource(r.info),
            // #224: envelope Date: header and INTERNALDATE, already ISO strings.
            ...(r.meta?.dateSent ? { dateSent: r.meta.dateSent } : {}),
            ...(r.meta?.dateReceived ? { dateReceived: r.meta.dateReceived } : {}),
          };
        },
        apple: () => {
          // Only fetch/parse the raw source when HTML is actually requested (#32).
          // A mailbox+account hint (from the caller, else the id→location index)
          // scopes the fetch so large folders like Sent Items resolve instead of
          // timing out on a full-mailbox scan.
          const content = mailManager.getMessageContent(id, preferHtml === true, {
            account,
            mailbox,
          });
          if (!content) {
            const lookupError = mailManager.consumeLastMessageLookupError();
            return errorResponse(lookupError ?? `Message with ID "${id}" not found`);
          }
          const isHtml = preferHtml === true && !!content.htmlContent;
          const body = isHtml ? content.htmlContent! : content.plainText;
          const dateSent = isoOrUndefined(content.dateSent);
          const dateReceived = isoOrUndefined(content.dateReceived);
          return successResponse(`Subject: ${content.subject}\n\n${body}`, {
            id,
            subject: content.subject,
            body,
            isHtml,
            rfcMessageId: content.rfcMessageId ?? "",
            ...(dateSent ? { dateSent } : {}),
            ...(dateReceived ? { dateReceived } : {}),
          });
        },
        ok: "",
        fail: `Message with ID "${id}" not found`,
      }),
    "Error retrieving message"
  )
);

// --- get-message-headers ---

/** One zod shape for the header fields both backends return (#224). */
const HEADER_FIELD_SCHEMA = z.object({
  name: z.string().describe("Header name as written (case preserved)"),
  value: z.string().describe("Unfolded value; RFC 2047 encoded-words left as-is"),
});

registerTool(
  "get-message-headers",
  {
    description:
      "Use when: you need a message's raw RFC 5322 headers — the author's Date: header (not the mailbox arrival time), Message-ID, In-Reply-To/References, the Received: hop trace, or any custom X- header — for a message whose id you already have (numeric or imap:…). Cheap: never downloads the body or attachments.\nReturns: the raw header block (text), every header as ordered {name, value} pairs with folding undone, and the decoded key fields: date (ISO 8601, from the Date: header), dateHeader (verbatim), dateReceived (mailbox arrival time — the value a migration or re-import resets, so compare it with date), messageId, subject, from, to, cc, replyTo, inReplyTo, references[], received[], backend (imap or applescript), and warnings[] when a malformed block was repaired.\nTip: pass the mailbox+account you got the id from so a numeric id is fetched directly instead of scanning every mailbox.\nDo not use when: you want the body (use get-message), the conversation (use get-thread), or only the Message-ID (get-message already returns rfcMessageId).",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      mailbox: z
        .string()
        .optional()
        .describe(
          "Mailbox that holds the message (numeric ids are unique per mailbox). With `account`, opens that mailbox directly instead of scanning every mailbox."
        ),
      account: z
        .string()
        .optional()
        .describe("Account that holds the message. Pair with `mailbox` for a direct fetch."),
    },
    outputSchema: {
      id: z.string().optional(),
      backend: z
        .string()
        .optional()
        .describe(
          'Which backend read the headers: "imap" (the stored bytes over IMAP) or "applescript" (Mail\'s `all headers` property, which Mail renders itself and can alter)'
        ),
      warnings: z
        .array(z.string())
        .optional()
        .describe(
          "Repairs applied to a malformed header block, in plain words — e.g. a Date: value Mail.app dropped with the next header joined onto it. Absent when none fired; `raw` is never rewritten."
        ),
      raw: z.string().optional().describe("The raw header block, exactly as stored"),
      headers: z.array(HEADER_FIELD_SCHEMA).optional(),
      headerCount: z.number().optional(),
      date: z
        .string()
        .optional()
        .describe("ISO 8601 from the Date: header — the author's send time"),
      dateHeader: z.string().optional().describe("The Date: header verbatim"),
      dateReceived: z
        .string()
        .optional()
        .describe("ISO 8601 mailbox arrival time (INTERNALDATE / Mail's `date received`)"),
      messageId: z.string().optional().describe("Bare RFC 5322 Message-ID"),
      subject: z.string().optional().describe("RFC 2047-decoded Subject:"),
      from: z.string().optional(),
      to: z.string().optional(),
      cc: z.string().optional(),
      replyTo: z.string().optional(),
      inReplyTo: z.string().optional(),
      references: z.array(z.string()).optional(),
      received: z
        .array(z.string())
        .optional()
        .describe("Every Received: header, as written (first = last hop)"),
    },
    annotations: { readOnlyHint: true },
  },
  withErrorHandling(
    ({ id, mailbox, account }) =>
      routeMessage(id, {
        // imap: id → BODY.PEEK[HEADER] + INTERNALDATE, no body download.
        imap: () => imapGetMessageHeaders(id, { account }),
        structuredFromResult: (r) =>
          r.info
            ? headersStructured(
                id,
                parseHeaderBlock(r.info),
                r.meta?.dateReceived as string,
                "imap"
              )
            : undefined,
        apple: () => {
          const h = mailManager.getMessageHeaders(id, { account, mailbox });
          if (!h) {
            const lookupError = mailManager.consumeLastMessageLookupError();
            return errorResponse(lookupError ?? `Message with ID "${id}" not found`);
          }
          return successResponse(
            h.raw,
            headersStructured(id, parseHeaderBlock(h.raw), h.dateReceived, "applescript")
          );
        },
        ok: "",
        fail: `Message with ID "${id}" not found`,
      }),
    "Error retrieving message headers"
  )
);

// --- get-message-rfc822 ---

// --- get-thread ---

registerTool(
  "get-thread",
  {
    description:
      "Use when: you have one message id and want the whole conversation it belongs to, oldest-first. With an imap: id it threads by References/Message-ID; otherwise it groups by normalized subject.\nReturns: the thread's normalized subject and its messages (id, date, subject, sender, read state).\nDo not use when: you only need the single message (use get-message) or are searching by arbitrary criteria (use search-messages).",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA.describe("A message ID in the conversation (numeric or imap:…)"),
      account: z.string().optional().describe("Account to search (omit to search all)"),
      mailbox: z.string().optional().describe("Mailbox to search (omit to search all)"),
      limit: z.number().optional().describe("Max messages in the thread (default 50)"),
    },
    outputSchema: {
      subject: z.string().optional(),
      messages: z.array(MESSAGE_ROW_SCHEMA).optional(),
      count: z.number().optional(),
      partial: z.boolean().optional(),
      failedMailboxes: z.array(z.string()).optional(),
      failedMailboxReasons: LIST_OUTPUT_SCHEMA.failedMailboxReasons,
      omittedMessages: LIST_OUTPUT_SCHEMA.omittedMessages,
    },
  },
  withErrorHandling(async ({ id, account, mailbox, limit = 50 }) => {
    // True threading via References/Message-ID when we have an imap: id (I5);
    // falls through to subject grouping if the server lacks HEADER search or
    // nothing References-linked is found.
    if (id.startsWith("imap:")) {
      const t = await imapThread(id, { account }, limit);
      if (t && t.count > 1) return successResponse(t.text, { ...t.structured });
    }

    // Resolve the seed message's subject, then gather the conversation by
    // normalized subject (B1). Works across the AppleScript and IMAP backends.
    let seedSubject: string | null = null;
    if (id.startsWith("imap:")) {
      const r = await imapGetMessage(id, false, { account });
      if (!r.success || !r.info) return errorResponse(r.error || `Message "${id}" not found`);
      seedSubject = subjectFromGetMessage(r.info);
    } else {
      const msg = mailManager.getMessageById(id);
      if (!msg) {
        const lookupError = mailManager.consumeLastMessageLookupError();
        return errorResponse(lookupError ?? `Message with ID "${id}" not found`);
      }
      seedSubject = msg.subject;
    }
    if (!seedSubject) return errorResponse(`Could not determine the subject of message "${id}"`);
    const base = normalizeSubject(seedSubject);

    // IMAP backend: server-side subject search (prefer-IMAP, v2.6.0).
    //   - explicit IMAP account → single-account IMAP subject search;
    //   - no account + IMAP configured → MERGE: IMAP fan-out subject search over
    //     every configured account + AppleScript subject search over ONLY the
    //     accounts no IMAP config covers (partitioned), then re-order oldest-
    //     first for natural thread reading.
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        const r = await imapSearchMessages({ subject: base, mailbox, account, limit });
        return successResponse(`Thread "${base}":\n${r.text}`, {
          subject: base,
          messages: r.messages,
          count: r.count,
          partial: r.partial,
          failedMailboxes: r.failedMailboxes,
          failedMailboxReasons: r.failedMailboxReasons,
          omittedMessages: r.omittedMessages,
        });
      }
      const fan = await fanOutImapMessages({ subject: base, mailbox, limit }, "search");
      const { appleScriptOnly } = partitionAccountsForCounts(
        mailManager.listAccounts(),
        resolveImapConfigs()
      );
      const apple = appleScanForAccounts(appleScriptOnly, (acctName) =>
        mailManager.searchMessagesWithDiagnostics(
          undefined,
          mailbox,
          acctName,
          limit,
          undefined,
          undefined,
          undefined,
          base
        )
      );
      // Merge + de-dup (IMAP wins), then sort OLDEST-first for thread order.
      const mergedNewestFirst = mergeMessages(fan.rows, apple.rows, limit);
      const orderedRows = mergedNewestFirst
        .slice()
        .reverse() // mergeMessages returns newest-first; threads read oldest-first
        .sort(
          (a, b) =>
            (a.dateReceived ? new Date(a.dateReceived as string).getTime() : 0) -
            (b.dateReceived ? new Date(b.dateReceived as string).getTime() : 0)
        );
      const partial =
        apple.diagnostics.partial ||
        fan.accountsFailed.length > 0 ||
        fan.failedMailboxes.length > 0 ||
        fan.omittedMessages.length > 0;
      const coverage =
        partialCoverageBlock({
          ...apple.diagnostics,
          partial,
          timedOutAccounts: [...apple.diagnostics.timedOutAccounts, ...fan.accountsFailed],
          notSearchedMailboxes: [...apple.diagnostics.notSearchedMailboxes, ...fan.failedMailboxes],
        }) + omittedNote(fan.omittedMessages, true);
      const structured = {
        subject: base,
        messages: orderedRows,
        count: orderedRows.length,
        partial,
        failedMailboxes: fan.failedMailboxes,
        failedMailboxReasons: fan.failedMailboxReasons,
        omittedMessages: fan.omittedMessages,
      };
      if (orderedRows.length === 0) {
        return successResponse(`No messages found in thread "${base}".${coverage}`, structured);
      }
      return successResponse(
        `Thread "${base}" — ${orderedRows.length} message(s), oldest first:\n${formatMergedRows(orderedRows)}${coverage}`,
        structured
      );
    }

    const { messages, diagnostics } = mailManager.searchMessagesWithDiagnostics(
      undefined,
      mailbox,
      account,
      limit,
      undefined,
      undefined,
      undefined,
      base
    );
    // Oldest-first is the natural reading order for a conversation.
    const ordered = messages
      .slice()
      .sort((a, b) => a.dateReceived.getTime() - b.dateReceived.getTime());
    const coverageBlock = partialCoverageBlock(diagnostics);
    const structured = {
      subject: base,
      messages: ordered.map(messageSummary),
      count: ordered.length,
      partial: diagnostics.partial,
    };
    if (ordered.length === 0) {
      return successResponse(`No messages found in thread "${base}".${coverageBlock}`, structured);
    }
    const list = ordered
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender}) [${m.isRead ? "read" : "unread"}]`
      )
      .join("\n");
    return successResponse(
      `Thread "${base}" — ${ordered.length} message(s), oldest first:\n${list}${coverageBlock}`,
      structured
    );
  }, "Error retrieving thread")
);

// --- list-messages ---

registerTool(
  "list-messages",
  {
    description:
      "Use when: browsing a mailbox's recent messages (optionally filtered by sender or unread-only) with pagination via limit/offset, and you need their ids.\nReturns: messages with id, date, subject, sender, and flagColor when flagged with an explicit color (plus partial-coverage diagnostics when some mailboxes were skipped).\nDo not use when: you have specific search criteria like subject/date/flags/flag color (use search-messages, which also supports filtering by flagColor) or already have an id and want the body (use get-message).\nLike search-messages, use this to obtain the ids that read/mark/delete/move and batch tools require.",
    inputSchema: {
      mailbox: z
        .string()
        .optional()
        .describe("Mailbox to list messages from. Omit to list from all mailboxes."),
      account: z.string().optional().describe("Account to list messages from"),
      limit: integerNumber()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of messages (default: 50, max: 500)"),
      offset: integerNumber()
        .min(0)
        .optional()
        .describe("Number of messages to skip (for pagination)"),
      from: z.string().optional().describe("Filter by sender email address or name"),
      unreadOnly: z.boolean().optional().describe("Only show unread messages"),
    },
    outputSchema: LIST_OUTPUT_SCHEMA,
  },
  withErrorHandling(async ({ mailbox, account, limit = 50, offset = 0, from, unreadOnly }) => {
    // IMAP backend: prefer direct IMAP whenever IMAP is configured (v2.6.0).
    //   - explicit IMAP account → single-account IMAP listing (fast path);
    //   - no account + IMAP configured → MERGE: IMAP fans out over every
    //     configured account; AppleScript lists ONLY the accounts no IMAP config
    //     covers (partitioned — all-IMAP user runs ZERO AppleScript). NOTE:
    //     pagination via `offset` is applied PER-BACKEND before the merge, so
    //     deep offsets in a merged multi-account list are approximate — recommend
    //     scoping with an `account` for exact pagination.
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        const r = await imapListMessages({ mailbox, account, limit, offset, from, unreadOnly });
        return successResponse(r.text, {
          messages: r.messages,
          count: r.count,
          partial: r.partial,
          failedMailboxes: r.failedMailboxes,
          failedMailboxReasons: r.failedMailboxReasons,
          omittedMessages: r.omittedMessages,
        });
      }
      const fan = await fanOutImapMessages({ mailbox, limit, offset, from, unreadOnly }, "list");
      const { appleScriptOnly } = partitionAccountsForCounts(
        mailManager.listAccounts(),
        resolveImapConfigs()
      );
      const apple = appleScanForAccounts(appleScriptOnly, (acctName) =>
        mailManager.listMessagesWithDiagnostics(mailbox, acctName, limit, from, offset)
      );
      return mergedMessageResponse(fan, apple, limit, "listed");
    }

    const { messages, diagnostics } = mailManager.listMessagesWithDiagnostics(
      mailbox,
      account,
      limit,
      from,
      offset
    );

    const coverageBlock = partialCoverageBlock(diagnostics);
    const structured = {
      messages: messages.map(messageSummary),
      count: messages.length,
      partial: diagnostics.partial,
      skippedLargeMailboxes: diagnostics.skippedLargeMailboxes,
      notSearchedMailboxes: diagnostics.notSearchedMailboxes,
      timedOutAccounts: diagnostics.timedOutAccounts,
    };

    if (messages.length === 0) {
      const base = diagnostics.partial
        ? "No messages found in the portions that were listed."
        : "No messages found";
      return successResponse(`${base}${coverageBlock}`, structured);
    }

    const messageList = messages
      .map(
        (m) =>
          `  - ID: ${m.id} | ${m.dateReceived.toLocaleDateString()} | ${m.subject} (from: ${m.sender})`
      )
      .join("\n");

    return successResponse(
      `Found ${messages.length} message(s):\n${messageList}${coverageBlock}`,
      structured
    );
  }, "Error listing messages")
);

// --- send-email ---

const COMPOSITION_SCHEMA = z
  .literal("native-editor")
  .optional()
  .describe(
    "Opt in to Mail's visible native editor: inserts only new prose, preserving its signature, " +
      "HTML quotation and reply ancestry without the AppleScript content setter. Requires an unlocked " +
      "desktop and existing Accessibility and Automation permissions. Uses Mail.app even when SMTP " +
      "is configured; cannot be combined with transport=smtp or caller-built threading headers. " +
      "New messages require an explicit account. Do not interact with Mail or the clipboard while it runs. " +
      "Failure never falls back to another composition method or sends an unverified message."
  );

// --- send-serial-email ---

// --- create-draft ---

registerTool(
  "create-draft",
  {
    description:
      "Use when: composing an email the user should review in Mail.app before sending — the safe default for any new message (to/cc/bcc are arrays, optional attachments). With inReplyTo/references the draft is threaded: it is composed by this server and filed over IMAP into the account's Drafts mailbox (Mail.app's AppleScript cannot set those headers), so an IMAP account is required.\nReturns: a confirmation that the draft was created, with recipients and attachment count; for a threaded draft also its Drafts mailbox, account and Message-ID (transport: imap).\nDo not use when: the user has already confirmed they want it sent now (use send-email), or is replying to an existing message (use reply-to-message with send=false — it derives recipients, threading and the quote and takes attachments).\nSafety: low risk — creates a draft only and sends nothing; the user must open Mail.app and send it themselves.",
    inputSchema: {
      to: z.array(z.string()).min(1, "At least one recipient is required"),
      subject: z.string().min(1, "Subject is required"),
      body: z.string().min(1, "Body is required"),
      composition: COMPOSITION_SCHEMA,
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
      account: z
        .string()
        .optional()
        .describe(
          "Account to create draft in: a Mail account name or an exact sender address, resolved " +
            "and verified before the draft is saved (no match or a different sender → error, " +
            "no draft). With inReplyTo/references this must name a configured IMAP account " +
            "(label or login); when omitted, the IMAP account matching the SMTP identity, else " +
            "the only IMAP account, is used."
        ),
      attachments: ATTACHMENTS_SCHEMA,
      inReplyTo: IN_REPLY_TO_SCHEMA,
      references: REFERENCES_SCHEMA,
    },
    outputSchema: {
      ok: z.boolean().optional(),
      recipients: z.array(z.string()).optional(),
      attachmentCount: z.number().optional(),
      transport: z.enum(["applescript", "imap"]).optional(),
      from: z.string().optional().describe("AppleScript draft: the sender Mail.app used"),
      account: z.string().optional().describe("Threaded draft only: IMAP account it was filed in"),
      mailbox: z.string().optional().describe("Threaded draft only: Drafts mailbox path"),
      messageId: z.string().optional().describe("Threaded draft only: the draft's Message-ID"),
      inReplyTo: z.string().optional(),
      references: z.array(z.string()).optional(),
    },
  },
  withErrorHandling(
    async ({
      to,
      subject,
      body,
      cc,
      bcc,
      account,
      attachments,
      inReplyTo,
      references,
      composition,
    }) => {
      if (threadingHeaders({ inReplyTo, references })) {
        if (composition)
          return errorResponse(
            "Native-editor drafts cannot use caller-built threading headers. Use reply-to-message with send=false for a native reply."
          );
        return runThreadedDraft(threadedDraftDeps, {
          to,
          subject,
          body,
          cc,
          bcc,
          account,
          attachments,
          inReplyTo,
          references,
        });
      }
      const drafted = composition
        ? mailManager.createDraft(to, subject, body, cc, bcc, account, attachments, true)
        : mailManager.createDraft(to, subject, body, cc, bcc, account, attachments);

      if (!drafted.success) {
        return errorResponse(
          drafted.error ?? "Failed to create draft. Check Mail.app configuration."
        );
      }

      const attachmentCount = attachments?.length ?? 0;
      const attachInfo = attachmentCount ? ` with ${attachmentCount} attachment(s)` : "";
      return successResponse(
        `Draft created for ${to.join(", ")}${attachInfo}${drafted.from ? ` from ${drafted.from}` : ""}`,
        {
          ok: true,
          recipients: to,
          attachmentCount,
          transport: "applescript",
          from: drafted.from,
        }
      );
    },
    "Error creating draft"
  )
);

const threadedDraftDeps: ThreadedDraftDeps = {
  resolveAccount: (account, smtpUser) => resolveDraftImapAccount(account, smtpUser),
  smtpIdentity: () => {
    if (!isSmtpConfigured()) return {};
    const user = process.env[SMTP_ENV.user]?.trim();
    return { user, from: process.env[SMTP_ENV.from]?.trim() || user };
  },
  compose: composeRawMime,
  append: (account, raw) => imapAppendDraft(account, raw),
};

// --- batch-delete-messages ---

// --- batch-move-messages ---

// --- batch-mark-as-read ---

// --- batch-mark-as-unread ---

// --- batch-flag-messages ---

// --- batch-unflag-messages ---

// --- resolve-message-id ---

// --- list-attachments ---

registerTool(
  "list-attachments",
  {
    description:
      "Use when: enumerating a message's attachments (by id) to discover their names, MIME types, and sizes — typically before saving or fetching one.\nReturns: each attachment's name, MIME type, and decoded size in bytes (what fetch-attachment returns), plus a count; sizeApproximate: true marks the rare IMAP size that is an estimate.\nDo not use when: you want the bytes (use fetch-attachment for inline base64, or save-attachment to write to disk). Get the message id from search-messages or list-messages first.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
    },
    outputSchema: {
      attachments: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
    },
  },
  withErrorHandling(async ({ id }) => {
    // IMAP (I1): BODYSTRUCTURE enumerates parts (incl. MIME attachments
    // AppleScript can't see) without downloading the message.
    const attachments = id.startsWith("imap:")
      ? await (async () => {
          const r = await imapListAttachments(id);
          if (!r.success) throw new Error(r.error || "Failed to list attachments via IMAP");
          return r.attachments ?? [];
        })()
      : mailManager.listAttachments(id);
    const structured = { attachments, count: attachments.length };

    if (attachments.length === 0) {
      return successResponse("No attachments found", structured);
    }

    const attachmentList = attachments
      .map((a) => {
        // Decoded bytes (#270). Small files in bytes — "0 KB" told nothing.
        const approx = "sizeApproximate" in a && a.sizeApproximate ? "~" : "";
        const size = a.size < 1024 ? `${a.size} bytes` : `${Math.round(a.size / 1024)} KB`;
        return `  - ${a.name} (${a.mimeType}, ${approx}${size})`;
      })
      .join("\n");

    return successResponse(
      `Found ${attachments.length} attachment(s):\n${attachmentList}`,
      structured
    );
  }, "Error listing attachments")
);

// --- save-attachment ---

// --- fetch-attachment ---

registerTool(
  "fetch-attachment",
  {
    description:
      "Use when: retrieving an attachment's raw bytes inline as base64 (by message id and attachmentName), e.g. to process its contents without keeping a file.\nReturns: the attachment's bytes base64-encoded, with its size and (for IMAP) MIME type.\nDo not use when: you don't know the attachment name (use list-attachments first) or you just want it saved to disk (use save-attachment).\nSafety: leaves no file behind, but the AppleScript path is not disk-free — Mail writes the attachment into a private temp directory, which is read back and then deleted. Needs no Full Disk Access either way: Mail performs that write under the Automation grant, and this server never reads the mail store itself.",
    inputSchema: {
      id: MESSAGE_ID_SCHEMA,
      attachmentName: z.string().min(1, "Attachment name is required"),
    },
    outputSchema: {
      attachmentName: z.string().optional(),
      bytes: z.number().optional(),
      mimeType: z.string().optional(),
      contentBase64: z.string().optional(),
    },
  },
  withErrorHandling(async ({ id, attachmentName }) => {
    // Returns the attachment bytes as base64 (B4) — the read counterpart to
    // sending inline base64 content. IMAP (I1) fetches the part directly; numeric
    // ids fall back to the AppleScript/MIME path.
    if (id.startsWith("imap:")) {
      const r = await imapFetchAttachment(id, attachmentName);
      if (!r.success || !r.base64) {
        return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
      }
      return successResponse(
        `Fetched "${attachmentName}" (${r.bytes} bytes, base64-encoded below).\n\n${r.base64}`,
        { attachmentName, bytes: r.bytes, mimeType: r.mimeType, contentBase64: r.base64 }
      );
    }
    const r = mailManager.getAttachmentBase64(id, attachmentName);
    if (!r.success) {
      return errorResponse(r.error || `Failed to fetch attachment "${attachmentName}"`);
    }
    return successResponse(
      `Fetched "${attachmentName}" (${r.bytes} bytes, base64-encoded below).\n\n${r.base64}`,
      { attachmentName, bytes: r.bytes, contentBase64: r.base64 }
    );
  }, "Error fetching attachment")
);

// =============================================================================
// Mailbox Tools
// =============================================================================

// --- list-mailboxes ---

/**
 * Append Mail's LOCAL ("On My Mac") mailboxes to an unscoped listing. (#183)
 *
 * They are not children of any account, so every `accounts` → `mailboxes of
 * acct` loop is structurally blind to them; this is the only way they appear
 * without being asked for by name. A failure is NAMED in `failedAccounts`
 * rather than dropped, for the same reason an unreadable account is: a short
 * list that looks complete is the bug this tool just stopped shipping.
 *
 * Called LAST so a slow local store cannot delay the account results.
 */
function appendLocalStoreRows(
  rows: { name: string; account: string; unreadCount: number; messageCount: number }[],
  failedAccounts: string[]
): void {
  const checked = mailManager.listMailboxesChecked(LOCAL_STORE_LABEL);
  if (checked.failed) {
    console.error(`list-mailboxes failed for "${LOCAL_STORE_LABEL}": ${checked.error}`);
    failedAccounts.push(LOCAL_STORE_LABEL);
    return;
  }
  for (const mb of checked.mailboxes) {
    rows.push({
      name: `${LOCAL_STORE_LABEL}/${mb.name}`,
      account: LOCAL_STORE_LABEL,
      unreadCount: mb.unreadCount,
      messageCount: mb.messageCount,
    });
  }
}

registerTool(
  "list-mailboxes",
  {
    description:
      'Use when: discovering the mailbox/folder paths (and unread/message counts) available in an account, e.g. before moving messages or searching a specific mailbox.\nReturns: each mailbox\'s canonical account-relative path in `name`, unread/message counts, and a total count. Use the full path for nested mailboxes (for example `Archive/Inbox`); a top-level `Inbox` remains `Inbox`. A source that could not be read is NAMED — the result carries `partial: true` + `failedAccounts` and the list is a floor, not the complete set — and a listing Mail refused outright (e.g. an account that does not exist) returns an ERROR naming the accounts that do exist, never an empty list.\nDo not use when: you want the messages inside a mailbox (use list-messages or search-messages) or the list of accounts (use list-accounts).\nNote: Mail\'s local "On My Mac" mailboxes are not part of any account, so they are reported under the synthetic account label "On My Mac" — an unscoped call includes them, and `account: "On My Mac"` lists only them. They will not appear in list-accounts, which reports real accounts only.',
    inputSchema: {
      account: z.string().optional().describe("Account to list mailboxes from"),
    },
    outputSchema: {
      mailboxes: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      // Declared explicitly: the SDK stamps additionalProperties:false on a bare
      // zod shape, so an undeclared key makes the CLIENT reject the result.
      partial: z.boolean().optional(),
      failedAccounts: z.array(z.string()).optional(),
    },
  },
  withErrorHandling(async ({ account }) => {
    // IMAP (I6): LIST + per-mailbox STATUS — sees the true server hierarchy and
    // authoritative counts. Prefer-IMAP (v2.6.0):
    //   - explicit IMAP account → that account's IMAP mailboxes;
    //   - no account + IMAP configured → concatenate every configured IMAP
    //     account's mailboxes (each name prefixed with its account label to
    //     disambiguate identical mailbox names across accounts) PLUS the
    //     AppleScript mailboxes of every account NOT covered by IMAP.
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        const boxes = await imapListMailboxes({ account });
        const structured = {
          mailboxes: boxes.map((b) => ({
            name: b.path,
            unreadCount: b.unseen,
            messageCount: b.messages,
          })),
          count: boxes.length,
        };
        if (boxes.length === 0) return successResponse("No mailboxes found", structured);
        const list = boxes.map((b) => `  - ${b.path} (${b.unseen} unread)`).join("\n");
        return successResponse(`Found ${boxes.length} mailbox(es):\n${list}`, structured);
      }
      const configs = resolveImapConfigs();
      const rows: { name: string; account: string; unreadCount: number; messageCount: number }[] =
        [];
      // #183: a source that could not be read is NAMED. Dropping it left the
      // caller with a short list that looked complete — the same absent-vs-empty
      // confusion, one level up. Matches get-mail-stats' partial/failedAccounts.
      const failedAccounts: string[] = [];
      for (const config of configs) {
        try {
          const boxes = await imapListMailboxes({ config });
          for (const b of boxes) {
            // Prefix with the account label so "INBOX" from two accounts is
            // distinguishable; keep the raw path available via the structured row.
            rows.push({
              name: `${config.accountLabel}/${b.path}`,
              account: config.accountLabel,
              unreadCount: b.unseen,
              messageCount: b.messages,
            });
          }
        } catch (e) {
          console.error(`IMAP list-mailboxes failed for "${config.accountLabel}": ${String(e)}`);
          failedAccounts.push(config.accountLabel);
        }
      }
      // AppleScript for the accounts IMAP doesn't cover (no double-listing).
      const { appleScriptOnly } = partitionAccountsForCounts(mailManager.listAccounts(), configs);
      for (const acct of appleScriptOnly) {
        const checked = mailManager.listMailboxesChecked(acct.name);
        if (checked.failed) {
          console.error(`list-mailboxes failed for "${acct.name}": ${checked.error}`);
          failedAccounts.push(acct.name);
          continue;
        }
        for (const mb of checked.mailboxes) {
          rows.push({
            name: `${acct.name}/${mb.name}`,
            account: acct.name,
            unreadCount: mb.unreadCount,
            messageCount: mb.messageCount,
          });
        }
      }
      // #183: Mail's LOCAL store is not an account, so the loops above can
      // never reach it. Append it under its synthetic label. Ordered LAST so a
      // slow local store never delays the account results a caller is more
      // likely to want.
      appendLocalStoreRows(rows, failedAccounts);
      const partial = failedAccounts.length > 0;
      const structured = {
        mailboxes: rows,
        count: rows.length,
        ...(partial ? { partial, failedAccounts } : {}),
      };
      // A partial list is a FLOOR, not an answer — say so rather than letting a
      // short list read as the complete set.
      const caveat = partial
        ? `\n\nPARTIAL — could not read: ${failedAccounts.join(", ")}. This list is incomplete.`
        : "";
      if (rows.length === 0) {
        return partial
          ? errorResponse(
              `Could not list mailboxes from any source. Failed: ${failedAccounts.join(", ")}.`
            )
          : successResponse("No mailboxes found", structured);
      }
      const list = rows.map((b) => `  - ${b.name} (${b.unreadCount} unread)`).join("\n");
      return successResponse(`Found ${rows.length} mailbox(es):\n${list}${caveat}`, structured);
    }

    // #183: read through the CHECKED variant. `listMailboxes` returns `[]` both
    // when an account genuinely has no mailboxes and when Mail REFUSED the
    // request — an account that does not exist raises `Can't get account "X"`
    // — so reporting the empty list as a success made "this store is not
    // addressable" indistinguishable from "you have no mail". That is the
    // absent-vs-empty confusion this codebase refuses to make everywhere else
    // (the collateral diff withholds rather than reports an empty array).
    const { mailboxes, failed, error } = mailManager.listMailboxesChecked(account);
    if (failed) {
      return errorResponse(
        unlistableStoreError(
          account,
          error,
          mailManager.listAccounts().map((a) => a.name)
        )
      );
    }
    // #183: an UNSCOPED call resolves to one default account, which can never
    // include the local store. Append it so "list my mailboxes" sees On My Mac
    // on the pure-AppleScript path too, not only when IMAP is configured.
    const localFailures: string[] = [];
    if (account === undefined) appendLocalStoreRows(mailboxes, localFailures);
    const structured = {
      mailboxes,
      count: mailboxes.length,
      ...(localFailures.length ? { partial: true, failedAccounts: localFailures } : {}),
    };

    if (mailboxes.length === 0) {
      return successResponse("No mailboxes found", structured);
    }

    const mailboxList = mailboxes.map((m) => `  - ${m.name} (${m.unreadCount} unread)`).join("\n");

    return successResponse(`Found ${mailboxes.length} mailbox(es):\n${mailboxList}`, structured);
  }, "Error listing mailboxes")
);

// --- get-unread-count ---

registerTool(
  "get-unread-count",
  {
    description:
      "Use when: you only need the number of unread messages — INBOX by default, or scoped to one mailbox and/or account — without listing the messages themselves.\nReturns: the unread count for the requested scope (INBOX when no mailbox is given). If a source cannot be read the result carries `partial: true` + `failedAccounts`, and a total AppleScript failure returns an ERROR — a plain count is never a disguised transport failure.\nDo not use when: you need the actual unread messages and their ids (use list-messages with unreadOnly, or search-messages with isRead=false) or broader totals across every mailbox (use get-mail-stats).",
    inputSchema: {
      mailbox: z.string().optional().describe("Mailbox to check (default: INBOX)"),
      account: z.string().optional().describe("Account to check"),
    },
    outputSchema: {
      unread: z.number().optional(),
      mailbox: z.string().optional(),
      account: z.string().optional(),
      partial: z.boolean().optional(),
      failedAccounts: z.array(z.string()).optional(),
    },
  },
  withErrorHandling(async ({ mailbox, account }) => {
    // IMAP (I4): STATUS (UNSEEN) is authoritative and fast even on huge
    // mailboxes. Prefer-IMAP (v2.6.0). No mailbox → each account's INBOX (the
    // meaningful "unread" figure; summing every mailbox was slow and, on Gmail,
    // counted one unread message once per label + All Mail). Counts are
    // ACCOUNT-CENTRIC so each account is counted exactly once even if the
    // coverage heuristic mis-matches:
    //   - explicit IMAP account → IMAP UNSEEN for that account;
    //   - no account + IMAP configured → planCountSources assigns each account
    //     ONE source (its matching IMAP config, else AppleScript) and counts any
    //     config that matched no account once via IMAP — no double-counting;
    //   - explicit non-IMAP account (or IMAP unconfigured) → AppleScript.
    let count: number;
    // Accounts whose count could not be read. A failed source must never be
    // folded in as a silent 0 — that turns a wedged transport into "inbox
    // zero", which reads as a real answer. (#130)
    const failedAccounts: string[] = [];
    if (shouldUseImap(account)) {
      if (account !== undefined) {
        count = await imapUnreadCount(mailbox, { account });
      } else {
        const sources = planCountSources(mailManager.listAccounts(), resolveImapConfigs());
        let total = 0;
        for (const src of sources) {
          if (src.kind === "imap") {
            try {
              total += await imapUnreadCount(mailbox, { config: src.config });
            } catch (e) {
              console.error(`IMAP unread-count failed for "${src.label}": ${String(e)}`);
              failedAccounts.push(src.label);
            }
          } else {
            const r = mailManager.getUnreadCountChecked(mailbox, src.account.name);
            if (r.failed) failedAccounts.push(src.account.name);
            else total += r.count ?? 0;
          }
        }
        count = total;
      }
    } else {
      const r = mailManager.getUnreadCountChecked(mailbox, account);
      if (r.failed) {
        return errorResponse(
          `Could not read the unread count — the AppleScript transport failed: ${r.error}. ` +
            `This is NOT the same as zero unread. Mail may be busy, wedged, or missing an ` +
            `Automation grant; run the "doctor" tool to check.`
        );
      }
      count = r.count ?? 0;
    }
    const location = mailbox ? ` in "${mailbox}"` : "";

    if (failedAccounts.length > 0) {
      return successResponse(
        `${count} unread message(s)${location} — PARTIAL: ${failedAccounts.length} account(s) ` +
          `could not be read (${failedAccounts.join(", ")}), so the real total is higher. ` +
          `Run the "doctor" tool to check.`,
        { unread: count, mailbox, account, partial: true, failedAccounts }
      );
    }

    return successResponse(`${count} unread message(s)${location}`, {
      unread: count,
      mailbox,
      account,
    });
  }, "Error getting unread count")
);

// --- create-mailbox ---

// --- delete-mailbox ---

// --- rename-mailbox ---

// --- list-smart-mailboxes (intelligente Postfächer) ---

// --- create-smart-mailbox ---

// --- delete-smart-mailbox ---

// --- create-newsletter-smart-mailboxes (the main use-case: from Inbox) ---

// =============================================================================
// Account Tools
// =============================================================================

// --- list-accounts ---

registerTool(
  "list-accounts",
  {
    description:
      "Use when: discovering the configured Mail accounts (e.g. iCloud, Gmail) so you can pass an exact account name to other tools.\nReturns: the account names and a count. If the AppleScript transport fails (timeout / wedged Mail / missing Automation grant) this returns an ERROR rather than an empty list — an empty list always means Mail really has no accounts.\nDo not use when: you want the folders within an account (use list-mailboxes) or messages (use list-messages / search-messages).",
    inputSchema: {},
    outputSchema: {
      accounts: z.array(z.object({}).passthrough()).optional(),
      count: z.number().optional(),
      partial: z.boolean().optional(),
      error: z.string().optional(),
    },
  },
  withErrorHandling(() => {
    const { accounts, failed, error } = mailManager.listAccountsChecked();
    const structured = failed
      ? { accounts, count: accounts.length, partial: true, error }
      : { accounts, count: accounts.length };

    // A wedged/timed-out AppleScript transport must never render as a confident
    // "No Mail accounts found" — that reads as a real answer. (#130)
    if (failed) {
      return errorResponse(
        `Could not read the Mail account list — the AppleScript transport failed: ${error}. ` +
          `This is NOT the same as having no accounts. Mail may be busy, wedged, or missing an ` +
          `Automation grant; run the "doctor" tool to check.`
      );
    }

    if (accounts.length === 0) {
      return successResponse("No Mail accounts found", structured);
    }

    const accountList = accounts.map((a) => `  - ${a.name}`).join("\n");
    return successResponse(`Found ${accounts.length} account(s):\n${accountList}`, structured);
  }, "Error listing accounts")
);

// =============================================================================
// Mail Rules Tools
// =============================================================================

// --- list-rules ---

// --- enable-rule ---

// --- disable-rule ---

// --- create-rule ---

// --- delete-rule ---

// =============================================================================
// Contacts Tools
// =============================================================================

// --- search-contacts ---

// =============================================================================
// Email Template Tools
// =============================================================================

// --- save-template ---

// --- list-templates ---

// --- get-template ---

// --- delete-template ---

// --- use-template ---

// =============================================================================
// Diagnostics Tools
// =============================================================================

// --- health-check ---

registerTool(
  "health-check",
  {
    description:
      "Use when: doing a quick check that Mail.app is reachable and the server's basic checks pass.\nReturns: an overall healthy/unhealthy status with a pass/fail line per check.\nDo not use when: you need detailed permission/account/IMAP/SMTP diagnostics with remediation steps (use doctor).",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(CHECK_ITEM_SCHEMA).optional(),
    },
  },
  withErrorHandling(() => {
    const result = mailManager.healthCheck();

    const statusIcon = result.healthy ? "✓" : "✗";
    const statusText = result.healthy ? "All checks passed" : "Issues detected";

    const checkLines = result.checks
      .map((c) => {
        const icon = c.passed ? "✓" : "✗";
        return `  ${icon} ${c.name}: ${c.message}`;
      })
      .join("\n");

    return successResponse(`${statusIcon} ${statusText}\n\n${checkLines}`, { ...result });
  }, "Error running health check")
);

// --- doctor ---

registerTool(
  "doctor",
  {
    description:
      "Use when: troubleshooting setup problems — diagnoses Mail.app automation permissions, account state, and the IMAP/SMTP backends with actionable remediation messages.\nReturns: a detailed diagnostic report (formatted text plus structured checks).\nDo not use when: you just want a quick up/down status (use health-check) or message counts (use get-mail-stats).",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z.array(CHECK_ITEM_SCHEMA).optional(),
    },
  },
  withErrorHandling(async () => {
    // Diagnoses Mail.app permission, account state, and the IMAP/SMTP backends
    // with actionable messages (C3). structuredContent carries the raw checks.
    const report = await runDoctor(mailManager);
    return successResponse(formatDoctorReport(report), { ...report });
  }, "Error running doctor")
);

// --- get-mail-stats ---

registerTool(
  "get-mail-stats",
  {
    description:
      "Use when: you want aggregate mailbox statistics — total and unread message counts, recently-received counts (last 24h/7d/30d), and (for the all-accounts path) a per-account breakdown.\nReturns: totals, unread counts, recent-activity counts, and per-account figures.\nDo not use when: you only need a single unread number (use get-unread-count) or want to list the messages themselves (use list-messages / search-messages).",
    inputSchema: {
      account: z
        .string()
        .optional()
        .describe("Limit to one account; uses fast IMAP STATUS if that account is IMAP-configured"),
    },
    outputSchema: {
      account: z.string().optional(),
      totalMessages: z.number().optional(),
      totalUnread: z.number().optional(),
      accounts: z.array(z.object({}).passthrough()).optional(),
      recentlyReceived: z.object({}).passthrough().optional(),
      recent: z.object({}).passthrough().optional(),
      // The scoped IMAP path spreads an ImapStats, which carries per-mailbox
      // STATUS rows. Declared so the shape is documented rather than merely
      // tolerated by the permissive advertisement (#135).
      perMailbox: z.array(z.object({}).passthrough()).optional(),
      partial: z.boolean().optional(),
      failedAccounts: z.array(z.string()).optional(),
      // Present only when this call waited behind other tool calls. Without it,
      // queue wait is invisible from the outside and a caller timing the call
      // sees a duration no per-account budget explains (#135).
      queueWaitMs: z.number().optional(),
    },
  },
  withErrorHandling(async ({ account }) => {
    // IMAP (I3): for a named IMAP account, STATUS gives authoritative counts and
    // SEARCH SINCE gives recent activity — fast even on huge mailboxes.
    //   - explicit IMAP account → IMAP STATUS for that account (today's path);
    //   - explicit non-IMAP account → AppleScript all-accounts stats below;
    //   - no account + IMAP configured → MERGE: sum IMAP STATUS over every
    //     configured account + AppleScript per-account stats for the accounts
    //     IMAP does NOT cover (partitioned so no account is double-counted).
    // #135: gathering stats is one STATUS per mailbox, and Gmail lists every
    // label — so a slow or large account can outlast the client's request
    // timeout and die as a bare -32001 with nothing to act on. Every IMAP read
    // below is bounded; what happens on expiry differs by path (see each).
    const budgetMs = Math.max(1000, Number(process.env.APPLE_MAIL_MCP_STATS_BUDGET_MS ?? 25_000));
    // #135 (follow-up): bounding each step separately still lets the call die.
    // The per-account IMAP budget above never covered the AppleScript account
    // enumeration that precedes the fan-out, and that read is its own blocking
    // 30s. Worst case was therefore their SUM — 30s enumerate + 25s fan-out —
    // which already exceeds a typical 60s client request timeout, so the call
    // came back as a bare -32001 with no partial and no failedAccounts to act
    // on: exactly the symptom the fix was supposed to remove. Every step now
    // draws from ONE wall-clock deadline, so the whole tool is bounded rather
    // than each of its parts.
    const deadlineMs = Math.max(
      2000,
      Number(process.env.APPLE_MAIL_MCP_STATS_DEADLINE_MS ?? 50_000)
    );
    // #135 (second follow-up): the deadline has to run from when the REQUEST
    // arrived, not from this handler's first line. Every tool call is serialized
    // through the AppleScript gate (#11), so a call can sit queued for as long as
    // all the calls ahead of it take — and a handler-anchored clock cannot see any
    // of that. Measured on 3 accounts: three concurrent calls returned at
    // 5.5s/10.3s/15.6s and the last one reported `partial: false` with the
    // deadline set to 6s, having spent ~10s queued. The client's request timeout
    // does not care where the time went, so neither can the deadline.
    const timing = currentCallTiming();
    const queueWaitMs = timing?.queueWaitMs ?? 0;
    const startedAt = timing?.arrivedAt ?? Date.now();
    const remainingMs = () => Math.max(0, deadlineMs - (Date.now() - startedAt));
    // Nothing useful is achievable in the last sliver, and spending it anyway is
    // strictly worse than saying so: the caller has already waited the whole
    // deadline, so more work only pushes the answer past the request timeout that
    // is about to fire. Fail fast, and name the queue — the one cause a caller
    // cannot see from the outside, and cannot fix by raising a budget.
    if (queueWaitMs > 0 && remainingMs() < 1000) {
      return errorResponse(
        `Could not read mail statistics: the ${deadlineMs}ms overall deadline was spent ` +
          `waiting ${queueWaitMs}ms in the tool-call queue before this call could start. ` +
          `Tool calls are serialized so they cannot race into Mail.app, so concurrent ` +
          `get-mail-stats calls each wait for the ones ahead of them — and it is the most ` +
          `expensive read tool (one IMAP STATUS per mailbox, and Gmail lists every label). ` +
          `Issue one at a time, prefer "get-unread-count" when a single number will do, or ` +
          `raise APPLE_MAIL_MCP_STATS_DEADLINE_MS.`
      );
    }
    const withBudget = async <T>(work: Promise<T>, label: string): Promise<T> => {
      // Never outlive the overall deadline, however generous the per-account budget.
      const ms = Math.min(budgetMs, remainingMs());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    if (account !== undefined && isImapAccount(account)) {
      // Scoped: the caller named ONE account, so a partial result would be no
      // result. Fail loudly with the remedy instead of stalling until -32001.
      let s;
      try {
        s = await withBudget(imapMailStats({ account }), `IMAP mail-stats for "${account}"`);
      } catch (e) {
        return errorResponse(
          `Could not read mail statistics for "${account}": ${String(e)}. Gathering stats ` +
            `costs one IMAP STATUS per mailbox, so a very large account can exceed the ` +
            `${budgetMs}ms budget — raise APPLE_MAIL_MCP_STATS_BUDGET_MS, or run the ` +
            `"doctor" tool if the connection itself is the problem.` +
            // Don't send someone tuning a budget when the queue is what ran the
            // clock down: the remaining deadline caps the budget (#135).
            (queueWaitMs >= 1000
              ? ` Note: this call waited ${queueWaitMs}ms behind other tool calls before ` +
                `starting, which counts against the ${deadlineMs}ms overall deadline and so ` +
                `caps the effective budget — issue get-mail-stats calls one at a time.`
              : ``)
        );
      }
      const lines = [
        `📊 Mail Statistics — ${account} (IMAP)`,
        `══════════════════`,
        `Total messages: ${s.totalMessages}`,
        `Unread messages: ${s.totalUnread}`,
        ``,
        `📥 Recently Received (INBOX):`,
        `  Last 24 hours: ${s.recent.last24h}`,
        `  Last 7 days: ${s.recent.last7d}`,
        `  Last 30 days: ${s.recent.last30d}`,
      ];
      if (queueWaitMs >= 1000) {
        lines.push(
          ``,
          `⏳ Waited ${(queueWaitMs / 1000).toFixed(1)}s in the tool-call queue before this ` +
            `call started (calls are serialized so they cannot race into Mail.app), so the ` +
            `time you measured is queue wait plus work.`
        );
      }
      return successResponse(lines.join("\n"), {
        account,
        ...s,
        ...(queueWaitMs >= 1000 ? { queueWaitMs } : {}),
      });
    }

    if (account === undefined && shouldUseImap(account)) {
      let totalMessages = 0;
      let totalUnread = 0;
      const recent = { last24h: 0, last7d: 0, last30d: 0 };
      const perAccount: {
        name: string;
        totalMessages: number;
        unreadMessages: number;
        backend: string;
      }[] = [];
      // ACCOUNT-CENTRIC: each account counted via exactly ONE source so a
      // heuristic mis-match can't double-count. IMAP sources use STATUS; the
      // AppleScript sources are built from listMailboxes (same source
      // getMailStats uses) — never getMailStats(), which is all-accounts and
      // would re-count the IMAP-covered ones. Recently-received from AppleScript
      // is INBOX-wide (not per-account), so it's omitted for AppleScript sources;
      // IMAP's per-account recent IS included.
      // Accounts whose stats could not be read. A failed or too-slow source must
      // never be folded in as a silent 0 — that understates the totals and reads
      // as a real answer (#130, same class as get-unread-count).
      const failedAccounts: string[] = [];

      // Enumerating Mail.app's accounts is a blocking AppleScript read, and on a
      // cold cache it was the single largest unbounded cost on this path (#135
      // follow-up). It gets a slice of the deadline, not the blanket 30s, and
      // failing it degrades rather than kills: every IMAP account is known from
      // config alone, so we can still answer for those and say what is missing.
      // The slice is capped so a wedged Mail.app cannot eat the whole deadline
      // and leave nothing for the IMAP fan-out that does the actual work.
      const imapConfigs = resolveImapConfigs();
      const enumerateMs = Math.max(1000, Math.min(10_000, Math.floor(remainingMs() * 0.3)));
      const enumerated = mailManager.listAccountsChecked({ timeoutMs: enumerateMs });
      const sources = enumerated.failed
        ? imapConfigs.map((config) => ({
            kind: "imap" as const,
            config,
            label: config.accountLabel,
          }))
        : planCountSources(enumerated.accounts, imapConfigs);
      if (enumerated.failed) {
        console.error(
          `Mail.app account enumeration failed for get-mail-stats: ${enumerated.error}`
        );
        failedAccounts.push("Mail.app accounts (AppleScript enumeration)");
      }

      // #135: run SEQUENTIALLY this was the sum of every account's cost, which
      // overran the client's request timeout on a four-account all-IMAP setup
      // and killed the whole call with -32001, returning nothing at all. The
      // pool is per-account, so accounts don't contend: fan them out
      // CONCURRENTLY (wall clock becomes the slowest account, not the sum) and
      // let a wedged account degrade to a partial result rather than taking the
      // other three down with it.
      const settled = await Promise.all(
        sources
          .filter((s) => s.kind === "imap")
          .map(async (src) => {
            try {
              const stats = await withBudget(
                imapMailStats({ config: src.config }),
                `IMAP mail-stats for "${src.label}"`
              );
              return { label: src.label, stats };
            } catch (e) {
              console.error(`IMAP mail-stats failed for "${src.label}": ${String(e)}`);
              return { label: src.label, stats: undefined };
            }
          })
      );
      for (const r of settled) {
        if (!r.stats) {
          failedAccounts.push(r.label);
          continue;
        }
        const s = r.stats;
        totalMessages += s.totalMessages;
        totalUnread += s.totalUnread;
        recent.last24h += s.recent.last24h;
        recent.last7d += s.recent.last7d;
        recent.last30d += s.recent.last30d;
        perAccount.push({
          name: r.label,
          totalMessages: s.totalMessages,
          unreadMessages: s.totalUnread,
          backend: "imap",
        });
      }

      // AppleScript sources are synchronous (they block the event loop), so they
      // run after the IMAP fan-out has settled rather than racing it. Each one
      // is charged against what is left of the deadline: the default here is 60s
      // per account, so on a multi-account setup this loop alone used to be able
      // to overrun any client's request timeout (#135 follow-up). Out of time,
      // or a failed read, means the account is named in failedAccounts — never
      // folded in as a silent 0.
      for (const src of sources) {
        if (src.kind === "imap") continue;
        const left = remainingMs();
        if (left < 1000) {
          failedAccounts.push(src.label);
          continue;
        }
        const read = mailManager.listMailboxesChecked(src.account.name, { timeoutMs: left });
        if (read.failed) {
          console.error(`AppleScript mail-stats failed for "${src.label}": ${read.error}`);
          failedAccounts.push(src.label);
          continue;
        }
        let m = 0;
        let u = 0;
        for (const mb of read.mailboxes) {
          m += mb.messageCount;
          u += mb.unreadCount;
        }
        totalMessages += m;
        totalUnread += u;
        perAccount.push({
          name: src.label,
          totalMessages: m,
          unreadMessages: u,
          backend: "applescript",
        });
      }
      const lines = [
        `📊 Mail Statistics (merged: IMAP + AppleScript)`,
        `══════════════════`,
        `Total messages: ${totalMessages}`,
        `Unread messages: ${totalUnread}`,
        ``,
        `📥 Recently Received (IMAP INBOXes):`,
        `  Last 24 hours: ${recent.last24h}`,
        `  Last 7 days: ${recent.last7d}`,
        `  Last 30 days: ${recent.last30d}`,
        ``,
        `📁 By Account:`,
        ...perAccount.map(
          (a) =>
            `  ${a.name}: ${a.totalMessages} messages (${a.unreadMessages} unread) [${a.backend}]`
        ),
      ];
      if (failedAccounts.length > 0) {
        lines.push(
          ``,
          `⚠️  PARTIAL: ${failedAccounts.length} account(s) could not be read ` +
            `(${failedAccounts.join(", ")}), so the real totals are higher. They either ` +
            `failed, exceeded the ${budgetMs}ms per-account budget, or ran out of the ` +
            `${deadlineMs}ms overall deadline — raise APPLE_MAIL_MCP_STATS_BUDGET_MS and/or ` +
            `APPLE_MAIL_MCP_STATS_DEADLINE_MS if an account is simply large, or run the ` +
            `"doctor" tool to check the connection.` +
            // Attribute the shortfall to the queue when the queue is what ate the
            // deadline, instead of leaving it to look like a slow account (#135).
            (queueWaitMs >= 1000
              ? ` Note: ${queueWaitMs}ms of that deadline was spent queued behind other ` +
                `tool calls, not reading mail — issuing get-mail-stats calls one at a time ` +
                `will recover it.`
              : ``)
        );
      }
      if (queueWaitMs >= 1000) {
        lines.push(
          ``,
          `⏳ Waited ${(queueWaitMs / 1000).toFixed(1)}s in the tool-call queue before this ` +
            `call started (calls are serialized so they cannot race into Mail.app), so the ` +
            `time you measured is queue wait plus work.`
        );
      }
      return successResponse(lines.join("\n"), {
        totalMessages,
        totalUnread,
        accounts: perAccount,
        recent,
        ...(failedAccounts.length > 0 ? { partial: true, failedAccounts } : {}),
        ...(queueWaitMs >= 1000 ? { queueWaitMs } : {}),
      });
    }

    const stats = mailManager.getMailStats();

    const lines: string[] = [];
    lines.push(`📊 Mail Statistics`);
    lines.push(`══════════════════`);
    lines.push(`Total messages: ${stats.totalMessages}`);
    lines.push(`Unread messages: ${stats.totalUnread}`);
    lines.push(``);

    if (stats.recentlyReceived) {
      lines.push(`📥 Recently Received:`);
      lines.push(`  Last 24 hours: ${stats.recentlyReceived.last24h}`);
      lines.push(`  Last 7 days: ${stats.recentlyReceived.last7d}`);
      lines.push(`  Last 30 days: ${stats.recentlyReceived.last30d}`);
      lines.push(``);
    }

    if (stats.accounts.length > 0) {
      lines.push(`📁 By Account:`);
      for (const account of stats.accounts) {
        lines.push(
          `  ${account.name}: ${account.totalMessages} messages (${account.unreadMessages} unread)`
        );
      }
    }

    return successResponse(lines.join("\n"), { ...stats });
  }, "Error getting mail statistics")
);

// --- get-sync-status ---

registerTool(
  "get-sync-status",
  {
    description:
      "Use when: checking whether Mail.app is running and actively syncing, e.g. to explain why new mail hasn't appeared yet.\nReturns: whether Mail.app is running and whether sync activity was detected.\nDo not use when: you need message counts (use get-mail-stats) or a full setup diagnosis (use doctor).",
    inputSchema: {},
    outputSchema: {
      syncDetected: z.boolean().optional(),
      pendingUpload: z.number().optional(),
      recentActivity: z.boolean().optional(),
      secondsSinceLastChange: z.number().optional(),
      error: z.string().optional(),
    },
  },
  withErrorHandling(() => {
    const status = mailManager.getSyncStatus();

    const lines: string[] = [];
    lines.push(`🔄 Mail Sync Status`);
    lines.push(`═══════════════════`);

    if (status.error) {
      lines.push(`Status: ⚠️ ${status.error}`);
    } else {
      lines.push(`Mail.app: ${status.recentActivity ? "Running" : "Not running"}`);
      lines.push(`Sync active: ${status.syncDetected ? "Yes" : "No"}`);
    }

    return successResponse(lines.join("\n"), { ...status });
  }, "Error getting sync status")
);

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Initialize and start the MCP server.
 */
// Defense-in-depth: a stray EventEmitter "error" (e.g. an idle IMAP/SMTP socket
// drop) or an unhandled rejection must never take down this long-lived MCP
// server. EPIPE on stdout means the MCP client went away — exit cleanly.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EPIPE") process.exit(0);
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

// The SDK stamps every emitted inputSchema/outputSchema with the draft-07
// dialect, which current MCP clients reject outright ("The default validator
// supports JSON Schema 2020-12 only" — #147). Wrapping the transport rewrites
// the tools/list payload on the way out; see @/utils/jsonSchemaDialect.
const transport = withJsonSchema2020_12(new StdioServerTransport());
await server.connect(transport);

// IMAP IDLE push notifications (B5) — opt-in. When enabled, watch every
// configured IMAP account's INBOX and notify the client on new mail via a
// logging message + a resource-updated signal for the account's mailbox.
let idleWatcher: ImapIdleWatcher | undefined;
if (/^(1|true|yes|on)$/i.test(process.env.APPLE_MAIL_MCP_IMAP_IDLE?.trim() ?? "")) {
  try {
    const configs = resolveImapConfigs();
    if (configs.length > 0) {
      idleWatcher = new ImapIdleWatcher({
        configs,
        onNewMail: (e) => {
          const newCount = e.count - e.prevCount;
          void server.server
            .sendLoggingMessage({
              level: "info",
              logger: "apple-mail-mcp",
              data: `New mail in "${e.account}": ${newCount} new message(s) (INBOX now ${e.count}).`,
            })
            .catch(() => undefined);
          void server.server
            .sendResourceUpdated({ uri: `mail://mailboxes/${encodeURIComponent(e.account)}` })
            .catch(() => undefined);
        },
      });
      await idleWatcher.start();
    }
  } catch (e) {
    console.error(`IMAP IDLE watcher failed to start: ${String(e)}`);
  }
}

// Clean shutdown: close BOTH the IDLE watcher's connections AND the request
// pool's pooled sockets, so we never leave IMAP connections occupying slots
// against the server's per-account limit. Triggered on SIGINT/SIGTERM (parent
// kills us) AND on stdin EOF (the MCP client/parent went away) — the latter
// prevents this process lingering as an orphan that keeps holding IMAP
// connections after its Claude session is gone, which is how connections piled
// up past Gmail's per-account limit.
let _shuttingDown = false;
const shutdown = (): void => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  // Stop the parent-death watchdog (defined just below) so it can't re-enter.
  clearInterval(orphanWatchdog);
  const force = setTimeout(() => process.exit(0), 2000);
  force.unref?.();
  // Closing the IDLE watcher logs out its dedicated per-account connections
  // (one persistent socket per account when APPLE_MAIL_MCP_IMAP_IDLE=1) and
  // dropAllPools() closes the request pool — together this releases EVERY IMAP
  // socket this instance holds, which is the whole point of the orphan check.
  void Promise.allSettled([idleWatcher?.stop() ?? Promise.resolve(), dropAllPools()]).finally(() =>
    process.exit(0)
  );
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

// Parent-death watchdog (connection-footprint hardening, v2.6.1). The exit
// paths above all rely on a signal or stdin-EOF, but a host (claude-code) that
// is force-quit or crashes delivers neither — leaving this process orphaned and
// still holding its IMAP sockets (the IDLE watcher's per-account connections
// and/or pooled request connections) against Gmail's ~15-per-account cap, which
// can starve Apple Mail of connection slots. On macOS an orphan is reparented to
// launchd (ppid 1), so poll for that and self-shutdown. At normal startup ppid
// is the real parent, so this never misfires; it's unref'd (never keeps the
// event loop alive) and is cleared in shutdown(). `shutdown` only reads this
// binding at runtime (long after it's initialized), so the forward reference is
// safe.
const orphanWatchdog: NodeJS.Timeout = setInterval(() => {
  if (isOrphaned()) shutdown();
}, 30_000);
orphanWatchdog.unref?.();
