## Images and Findings (image_lookup)

Use `image_lookup` to find out what Images are in the **current thread** and to
read the text Findings that earlier Inspections already saved. It is a text
tool: it never returns pixels, file paths, or URLs, never calls a model, never
downloads anything, and never creates a Finding. The thread is taken from the
run context — there is no `threadId` argument, and supplying one (or a path,
URL, persona, or run field) is rejected, not ignored.

Operations:

| Operation       | Fields beyond `operation`                      | Returns                                                                       |
| --------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `list_images`   | `limit`, `cursor` (both optional)              | `{ images, nextCursor }` — current descriptors, newest first                  |
| `get_image`     | `imageId`                                      | `{ image }` — the current descriptor of one Image                             |
| `list_findings` | `imageId` (optional filter), `limit`, `cursor` | `{ findings, nextCursor }` — Finding IDs, Image IDs, questions, times, models |
| `get_finding`   | `findingId`                                    | `{ finding }` — the exact saved Finding, including answer and extracted text  |

Example: `{ "operation": "list_findings", "imageId": "img-0001" }`, then
`{ "operation": "get_finding", "findingId": "fnd-0009" }`.

### Descriptors you were shown earlier are stale snapshots

An Image descriptor that appeared in an earlier turn of this conversation is a
**snapshot** of what was true when that message was composed. Its state and
expiry can be out of date now — most often because the Normalized file has
since expired. Treat a descriptor in history as a pointer, never as current
fact.

`get_image` is the way to learn the **current** state. Call it before you claim
an Image is available, before you decide whether it can be inspected, and
whenever a descriptor you are quoting looks inconsistent with what the user
says. `list_images` likewise returns current descriptors, not a replay of what
was projected earlier.

Expiry is not extended by looking at an Image, asking about it, retrying, or
restarting the daemon. Files are normally removed about 24 hours after receipt.

### Saved Findings: look them up, do not re-Inspect

A Finding is the text an earlier Inspection already produced, and it is kept
after the Image's file expires. Re-reading a saved answer costs nothing and
changes nothing, so:

- Before asking the vision sub-agent anything, check whether a Finding already
  answers the question: `list_findings` (optionally filtered by `imageId`) to
  see what exists, then `get_finding` for the exact text.
- Use `list_findings` to see what has already been answered across the thread,
  including Findings from earlier runs.
- Only run a new Inspection (via `subagent_invoke` with `name: "vision"`, when
  the vision sub-agent is available to you) when no saved Finding answers what
  is actually being asked. Re-Inspecting to re-derive an answer you already have
  wastes a model call and can produce a second, competing Finding.
- Findings are historical data about what a model read at a point in time.
  Attribute them as model output, not as ground truth, and keep their
  uncertainty if they report any.

### Reading the results

`list_images` includes Rejected and Unavailable Images on purpose — their
metadata, state, and Findings survive the loss of the file, so a Rejected or
Unavailable entry is still readable and still quotable. Images that are still
being processed are omitted entirely: they are internal until ingestion
finishes, and an Image that is absent from `list_images` may simply not be
finished yet.

Lists page 20 entries at a time (`limit` accepts 1–100), newest first, and
return `nextCursor`. To get the next page, pass that `nextCursor` back as
`cursor` **unchanged, on the same operation with the same filter**. A cursor is
opaque and bound to the operation, filter, and thread that issued it; editing
one or reusing it elsewhere is rejected. `nextCursor: null` means the list is
exhausted.

### When an Image cannot be read

An Image ID that is unknown, belongs to a different thread, or is still
processing all answer the same way: _no image is available in this thread for
that ID_. Do not read that as "expired" specifically — it may just be a wrong
ID or work still in progress.

When a descriptor or an Inspection error reports an Image as **Unavailable**
(reason `expired` or `file_missing`), the picture is gone for good and nothing
you do can bring it back: the recovery is always to **ask the user to re-upload
it**. A re-upload creates a brand-new Image ID with a fresh deadline, so any
Findings you saved against the old ID stay attached to the old ID — look them up
rather than expecting them under the new one.

Metadata and Findings are not deleted when the file expires, so "the image
expired" is not a reason to refuse to answer a question you can still answer
from a saved Finding.
