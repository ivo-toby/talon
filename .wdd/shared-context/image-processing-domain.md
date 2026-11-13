# Image domain and accepted decisions

Frozen planning handover for the current Image epic. Canonical sources remain the repository files below; these copies enter the immutable task snapshot. Refresh copies and re-approve the plan if their authoritative content changes.

## Source: CONTEXT.md

SHA-256: c18288d530dc510fa96f75cb791e5b3abfec5bb04b6a99ba95bb0ddeafc1435a

# Talon domain language

This glossary defines the terms used to discuss Talon's image support.

## Language

**Attachment**:
An uploaded item delivered by a channel before Talon's image processing accepts
or rejects it. An Attachment is a delivery payload, not a durable Image.
_Avoid_: Image record, stored attachment

**Ingestion**:
Taking a message's Attachments through selection and processing to final Image
outcomes. Excluded Attachments do not create Images.
_Avoid_: download, normalization

**Admission**:
The durable acceptance of an inbound message and creation of its Images; the
first step of Ingestion. Admission is the receipt that starts an Image's expiry.
_Avoid_: Ingestion, enqueue, delivery

**Image**:
A durable record of an image Attachment that Talon accepted or rejected,
carrying state, metadata, and an expiry. An Image can exist without downloaded
content and remains after its Normalized file becomes unavailable.
_Avoid_: Attachment record, image candidate, file

**Image ID**:
A globally unique identifier for one Image, owned by exactly one conversation
thread. A re-upload creates a new Image ID.
_Avoid_: Attachment ID, filename

**Image descriptor**:
The textual representation of an Image's identity, origin, availability, expiry,
and selected metadata. It contains no image pixels.
_Avoid_: Attachment description, image payload

**Image descriptor inventory**:
A bounded list of the current thread's Image descriptors supplied as conversation
context. It includes Images that have never produced a Finding.
_Avoid_: Image ID reference inventory, attachment inventory

**Normalized file**:
The size-bounded, metadata-free JPEG derived from an accepted Image. Its
retention period is independent of the lifetime of the Image record and metadata.
_Avoid_: Image, original, attachment

**Rejection reason**:
The reason an Image was rejected: exactly one of unsupported_mime, count_limit,
size_limit, animated, download_failed, conversion_failed, processing_interrupted,
or processing_failed. A Rejected Image cannot be used for an Inspection.
_Avoid_: Error code, unavailability reason

**Unavailability reason**:
The reason an Image's visual content is unavailable: exactly expired or
file_missing. Both require re-upload for a new Inspection and preserve access
to existing metadata and Findings.
_Avoid_: Rejection reason, expired state

**Inspection**:
A question submitted to the vision subagent about one or more Images in the
current conversation thread. A successful Inspection produces a Finding.
_Avoid_: Vision read, vision invocation, image read

**Finding**:
The recorded answer from a successful Inspection, including its question,
referenced Image IDs, extracted text, and uncertainty. A Finding remains
available after the referenced Images' Normalized files become unavailable.
_Avoid_: Vision result, image summary

## Source: docs/adr/0001-vision-subagent.md

SHA-256: e832f82406f2e01f645cb19fbec8f0beba4e5842199c28b544df13f45293dc62

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

## Source: docs/adr/0002-image-context-placement.md

SHA-256: 84d2e6ebe8ef44077288059a181bbe3c7689630f04b4ee8cd4635f097b9df920

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
