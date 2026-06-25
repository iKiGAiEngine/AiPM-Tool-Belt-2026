/**
 * Centralized upload size limits.
 *
 * The production deployment runs on Replit Autoscale, whose ingress proxy
 * rejects request bodies larger than ~32 MiB with HTTP 413 — regardless of
 * what multer or Express bodyParser allow. Anything above this cap fails
 * BEFORE the request reaches the application.
 *
 * To process spec PDFs of ANY size, large uploads are sent in chunks: the
 * client splits the file into <= UPLOAD_CHUNK_BYTES pieces (each well under the
 * proxy cap) and the server reassembles them on disk before extraction. Files
 * at or below UPLOAD_CHUNK_BYTES still use the single-shot upload endpoint.
 *
 * MAX_UPLOAD_* below is retained as a sanity ceiling (e.g. to reject obviously
 * wrong files), not as the hard cap it used to be.
 */

// Per-chunk size for the chunked upload flow. Kept comfortably under the
// ~32 MiB Autoscale proxy limit to leave room for multipart overhead.
export const UPLOAD_CHUNK_MB = 8;
export const UPLOAD_CHUNK_BYTES = UPLOAD_CHUNK_MB * 1024 * 1024;

// Generous sanity ceiling for a single PDF. Not enforced by the proxy any more
// (chunking bypasses it); this only guards against accidental huge uploads.
export const MAX_UPLOAD_MB = 1024;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_MB} MB`;
