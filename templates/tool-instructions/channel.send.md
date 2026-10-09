## Cross-Channel Messaging

Use `channel_send` to send messages to channels other than the current thread's
channel. The available channels are listed in your context. Always use the
channel name exactly as shown.


To send a file, pass an `attachments` array to `channel_send`. Each item must
contain an HTTP(S) `url`; `filename` and `mimeType` are optional. Prefer
short-lived download URLs returned by trusted file tools (for example a file-export tool) instead of copying file bytes through the model context.


File attachments currently work **only with Telegram**. Other channel types reject
attachment requests before downloading. An attachment requires explicit
`channel.attachment:send` permission and the URL origin must be configured
in `attachments.allowedOrigins` in talond.yaml; internal/private origins additionally
require `attachments.privateOrigins`. Never guess a URL or circumvent the
allowlist. Files are limited to 50 MiB per file and 50 MiB per complete batch.
If an attachment send partially succeeds, check `deliveredAttachments` and
`deliveryUncertain`; do **not** repeat the entire batch, since earlier items
may already have arrived. Telegram uploads have a 90-second timeout.
