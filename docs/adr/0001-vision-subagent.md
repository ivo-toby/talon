---
status: accepted
date: 2026-10-14
---

# Inspect Images through a dedicated vision subagent

Talon's personas can use text-only models and provider sessions that retain prior
inputs. Talon's image feature will send pixel inputs exclusively to a separately
configured vision subagent, while the main agent receives Image metadata and
textual Findings. This gives every persona the same Inspection interface and
keeps image-token history out of the main agent's session.

Compared with native multimodal input to the foreground model, this adds a model
call and requires the main agent to ask explicit visual questions. Each
Inspection starts fresh; exact Findings are stored separately, while bounded
conversation replay can summarize them. Pixel access ends when the Normalized
file expires, even though Image metadata and Findings remain available.

This decision governs Talon's image ingestion and Inspection interfaces. It
does not add operating-system isolation to existing provider-native filesystem
tools. Adding native multimodal delivery through Talon's foreground provider
would require revisiting this decision and the context-retention contract.
