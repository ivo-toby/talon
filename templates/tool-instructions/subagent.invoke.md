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
