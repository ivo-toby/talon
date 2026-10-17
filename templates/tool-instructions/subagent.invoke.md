## Sub-agents

You have access to lightweight sub-agents via the `subagent_invoke` tool. These
run a single LLM call and return structured results — no agentic loop.

To see which sub-agents are assigned to you, check the `subagents` list in your
persona config in talond.yaml. Common built-in sub-agents:

- **spark-coder** — Fast code generation using GPT-5.4 Spark. Pass a task
  description, optional context files, and constraints. Returns file operations
  (`{path, content, action}`).
  Input: `{ task: string, contextFiles?: [{path, content}], constraints?: string }`
- **session-summarizer** — Compresses conversation transcripts into key facts
- **memory-groomer** — Prunes and consolidates stale memory items
- **memory-retriever** — Finds relevant memories by semantic search
- **file-searcher** — Searches files by content with LLM-ranked results

### vision — answering questions about images

The **vision** sub-agent answers one question about images in the current
thread in a single multimodal request. You never see the pixels yourself, so a
question about what a picture shows goes to vision rather than to a guess.

Call it with exactly two input fields — a nonempty `question` and the Image IDs
it should look at:

```json
{
  "name": "vision",
  "input": {
    "imageIds": ["img-0001", "img-0002"],
    "question": "What error message is shown in the dialog, and what does it say to do next?"
  }
}
```

Rules that decide whether the call runs at all:

- `imageIds` are **opaque Image IDs** taken from an Image descriptor in this
  conversation (or from `image_lookup`, if that tool is exposed to you). Never a
  file path, URL, filename, or `data:` URI.
- Only Images belonging to the current thread, and only ones that finished
  processing successfully. An ID that is unknown, from another thread, still
  processing, Rejected, or Unavailable fails the **whole** call before any model
  request — the list is never truncated or partially inspected.
- IDs must be distinct, and at most the configured maximum (5 by default) per
  Inspection. Too many is an error, not a silent cut: split the work into
  separate Inspections.
- One question per Inspection. Ask one thing and let it answer that thing.

A successful Inspection returns the Finding and also saves it: `{ findingId,
imageIds, answer, extractedText, uncertainty, model, usage }`. Report the
answer as model output, and pass `uncertainty` through when it is present — a
vision answer is evidence, not ground truth. Use `extractedText` for text you
were asked to lift out of the picture.

Before you spend a model call, check for an answer you already have. Saved
Findings survive both the end of the conversation turn and the expiry of the
image file.

- **If `image_lookup` is exposed to you**, use it to re-read what already
  exists: `list_findings` to see what has been answered, then `get_finding` for
  the exact text. That is cheaper and more consistent than asking again.
- **If it is not**, work from the Findings already present in this
  conversation's context, and avoid re-Inspecting something that was already
  answered here.

Either way, run a new Inspection only when no saved Finding answers the question
actually being asked.

When vision reports an Image as **Unavailable** (`expired` or `file_missing`) —
or when the descriptor you are quoting has an expiry in the past — the file is
gone and cannot be recovered from your side: **ask the user to re-upload it**.
A re-upload gives you a new Image ID and a fresh deadline; the old Finding stays
attached to the old ID, so reuse that saved answer (with `image_lookup` when you
have it, otherwise from this conversation's context) instead of re-Inspecting it.
Do not retry the same Inspection against an expired ID and do not try to
substitute another Image for the one that is missing.
