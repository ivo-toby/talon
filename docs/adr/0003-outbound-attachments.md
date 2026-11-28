---
status: accepted
date: 2026-11-28
---

# Outbound attachments are host files the host validates, gated by channel.attach

Agents produce artifacts a human wants to see (screenshots, charts, logs,
reports). An agent names a file by **absolute host path** in `channel_send`
`attachments`; the host resolves, validates and reads it, and connectors only
ever receive bytes plus sanitized metadata. The agent never passes bytes or
base64, and Talon never fetches a URL for an attachment. Fetching would bypass
`net.http` egress rules (the reason the URL-based approach in PR #289 was not
adopted).

## Decisions

- **Capability.** `channel.attach` is a *modifier* capability: it exposes no
  tool on its own, and `channel_send` re-checks it in-handler (fail-closed, like
  `image.read:thread`). A persona that may talk may not necessarily upload.
- **Allowed roots.** By default the only root is the run's **own thread
  artifacts directory** (`<dataDir>/threads/<threadId>/artifacts/`, created for
  every run in its working directory). Operators add roots with
  `attachments.outbound.allowedRoots`; `threadArtifacts: false` plus no roots
  turns the feature off. A run can never send another thread's artifacts. The
  per-persona opt-in is the capability; roots and limits are global
  (per-persona roots can come later without a migration).
- **Path safety.** Absolute paths only. The lexical path must be inside a
  root before the filesystem is touched (so a refusal reveals nothing about
  existence), and its `realpath` must be inside a root's `realpath` (symlink
  escapes are refused separately). Built-in denylist: `/proc`, `/sys`, `/dev`,
  `/etc`, `/boot`, `/run`, credential directories (`.ssh`, `.aws`, `.git`, …)
  and key or secret files (`.env*`, `id_*`, `*.pem`, `*.key`, …). Talon's data
  directory, database and config file are always denied, except the run's own
  artifacts root, where only the built-in list applies. Regular, non-empty
  files only. The file is opened `O_NOFOLLOW|O_NONBLOCK` and re-checked by
  device, inode and size, so a swap between check and read is refused.
- **Limits and type.** Global `maxBytes` (20 MiB) and `maxPerMessage` (5), each
  narrowed by the connector's declared `outboundAttachments` limits. The MIME
  type is sniffed from the bytes; the extension or declared type only selects
  a text subtype for content that is valid UTF-8. `allowedMimeTypes` defaults
  to common images, PDF, plain text, CSV, Markdown and JSON.
- **All or nothing before sending.** Any refused item fails the whole call with
  a closed error code (`capability_denied`, `attachments_disabled`,
  `channel_unsupported`, `too_many_files`, `invalid_request`,
  `path_not_absolute`, `outside_allowed_roots`, `symlink_escape`,
  `denied_path`, `not_found`, `is_directory`, `special_file`, `empty_file`,
  `too_large`, `mime_not_allowed`, `read_failed`). Nothing is sent, not even
  the text.
- **Connector negotiation.** `ChannelConnector.outboundAttachments` declares
  support and limits; absent means unsupported (terminal, browser voice).
- **Delivery.** Text first, carrying the native reply. Then one message per
  attachment, in the same chat or topic. With no text, the first attachment
  carries the reply. A failed text fails the send before any upload. A failed
  attachment is reported per item in `SendReceipt.attachments`; the human gets
  a short notice naming the files that did not arrive, and the tool result
  tells the agent which items failed.
- **Ledger and persistence.** Every delivered attachment message is a
  `message_refs` row (excerpt `[Attachment: <name>] <caption>`), so replies
  and reactions to it work. The outbound `messages` row stores the text plus one
  `[Attached: name (type, size)]` line, so later context shows what was sent,
  plus metadata `{filename, mimeType, size, sha256}`. It never stores bytes or
  paths. Logs carry index, type, size and a hash prefix only.
- **Filenames** are sanitized (basename, no control characters or leading
  dots, ≤ 128 chars), not replaced; an empty result becomes `attachment-<n>`.
- **Voice runs** never send attachments.

## Not yet decided / follow-ups

- A run's final reply (`RunDelivery`) carrying attachments without a tool call.
- WhatsApp Baileys and Business, and email; each declares
  `outboundAttachments` when implemented.

## Connector notes

- **Telegram:** `sendPhoto` for images up to 10 MB, otherwise (or when the
  photo is rejected) `sendDocument`; 50 MB, 10 files.
- **Slack:** `files.getUploadURLExternal` → presigned upload →
  `files.completeUploadExternal` with `channel_id`, `thread_ts` and the caption
  as `initial_comment` (the legacy `files.upload` is retired). Needs
  `files:write`. The bot token is never sent to the upload URL, which must be
  `https://` on a `slack.com` host. Slack shares files asynchronously, so the
  file message's `ts` is often not reported and then has no ledger row; Talon
  has no Slack replies or reactions that would need it.
- **Discord:** one multipart Create Message per file (`payload_json` +
  `files[0]`) with the caption as content, reusing the 429 retry. 20 MB per
  file (the non-boosted default); a larger server limit is not assumed.
- Reading an agent's own outbound artifacts back (an `artifacts` table).
