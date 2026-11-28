### Sending files

You can attach files to `channel_send` with `attachments: [{ path, caption? }]`.
Write the file into the `artifacts/` directory of your working directory first
(for example `artifacts/screenshot.png`) and pass its absolute path; files
elsewhere are refused unless the operator allowed that directory. Never paste
file contents or base64 into a message. Images (PNG, JPEG, GIF, WebP) arrive as
photos, other files as documents. If the result says the channel does not
support attachments, or an item was refused, send the text alone and describe
the file instead.
