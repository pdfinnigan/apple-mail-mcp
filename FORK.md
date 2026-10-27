# Fork notes: read-only + drafts

This is a fork of [sweetrb/apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp)
(base commit `4f25910`), trimmed so an AI assistant can read mail and prepare
drafts but cannot send, delete, or reorganize anything.

## Tools kept (15)

`search-messages`, `get-message`, `get-message-headers`, `get-thread`,
`list-messages`, `list-attachments`, `fetch-attachment`, `list-mailboxes`,
`get-unread-count`, `list-accounts`, `get-mail-stats`, `get-sync-status`,
`health-check`, `doctor`, and `create-draft` (saved to Drafts, never sent).

## Tools removed (37)

- **Sending:** `send-email`, `send-serial-email`, `reply-to-message`, `forward-message`
- **Deleting / moving / flagging:** `delete-message`, `move-message`, `mark-as-*`,
  `flag-message`, `unflag-message`, and all `batch-*` tools
- **Mailbox management:** `create-mailbox`, `delete-mailbox`, `rename-mailbox`
- **Rules and smart mailboxes:** all `*-rule` and `*-smart-mailbox` tools,
  `create-newsletter-smart-mailboxes`
- **Other:** `save-attachment` (writes to disk), `get-message-rfc822`,
  `resolve-message-id`, `search-contacts`, and all template tools
- The standalone `apple-mail-send` CLI

## What this does and does not guarantee

- The removed tools are no longer registered, so an MCP client cannot call them.
- Their implementation code still exists inside `AppleMailManager` as methods
  that nothing in the MCP surface reaches. Deleting it is a follow-up.
- IMAP/SMTP support is still present but opt-in. Do not configure it, and the
  server stays on the AppleScript path through Mail.app.
- `create-draft` can attach local files by path. Review drafts before sending.
- README sections outside the Tool Reference still describe upstream features.

## Run it

```text
corepack enable && pnpm install --frozen-lockfile
pnpm build
node build/index.js
```

Pin Claude Desktop to this checkout's `build/index.js` instead of using `npx`.
