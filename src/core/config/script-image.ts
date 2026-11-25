/**
 * Digest-pinned worker image of the script runtime: `<name>@sha256:<64 lowercase hex>`.
 *
 * In its own module so that the script runtime can use it without loading the
 * full configuration schema.
 */
export const SCRIPT_IMAGE_DIGEST_RE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
