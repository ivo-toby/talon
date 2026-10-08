## Cross-Channel Messaging

Use `channel_send` to send messages to channels other than the current thread's
channel. The available channels are listed in your context. Always use the
channel name exactly as shown.


To send a file, pass an `attachments` array to `channel_send`. Each item must
contain an HTTP(S) `url`; `filename` and `mimeType` are optional. Prefer
short-lived download URLs returned by trusted file tools (for example a file-export tool) instead of copying file bytes through the model context.
