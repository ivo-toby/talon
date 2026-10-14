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
