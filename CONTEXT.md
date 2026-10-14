# Talon domain language

This glossary defines the terms used to discuss Talon's image support.

## Language

**Attachment**:
An uploaded item delivered by a channel before Talon's image processing accepts
or rejects it. An Attachment is a delivery payload, not a durable Image.
_Avoid_: Image record, stored attachment

**Image**:
A durable record of image content submitted in a conversation thread, identified
by an Image ID and carrying state, metadata, and an expiry. An Image can remain
after its Normalized file becomes unavailable.
_Avoid_: Attachment record, image candidate, file

**Image ID**:
The stable identity of an Image within its owning conversation thread. A
re-upload creates a new Image ID.
_Avoid_: Attachment ID, filename

**Normalized file**:
The normalized visual content associated with an accepted Image. Its retention
period is independent of the lifetime of the Image's record and metadata.
_Avoid_: Image, original, attachment

**Inspection**:
A question submitted to the vision subagent about one or more Images in the
current conversation thread. A successful Inspection produces a Finding.
_Avoid_: Vision read, vision invocation, image read

**Finding**:
The recorded answer from a successful Inspection, including its question,
referenced Image IDs, extracted text, and uncertainty. A Finding remains
available after the referenced Images' Normalized files become unavailable.
_Avoid_: Vision result, image summary
