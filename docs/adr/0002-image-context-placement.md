---
status: accepted
date: 2026-10-14
---

# Deliver current Image descriptors with their live message

Codex appends resumed-turn input to its session log, so repeating the full Image
inventory and Finding projection on every query would accumulate mostly duplicate
text. Deliver current-message descriptors in live content for every provider;
reserve the full projections for fresh-session history and context rotation.
Resumed sessions use image_lookup for older Images/Findings and current availability.

This trades automatic refresh of all historical Image state for bounded additions
to provider sessions. Current-message descriptors are refreshed before delivery,
Inspection always checks current availability, and canonical Images/Findings
remain in SQLite. Descriptor budgets are shared across live/fresh-history sections
to avoid duplication. Queue/provider retries retain existing message-delivery
semantics; this decision does not promise exactly-once writes to provider logs.
