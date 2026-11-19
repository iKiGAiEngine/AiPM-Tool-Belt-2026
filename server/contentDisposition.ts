/**
 * Builds a safe `Content-Disposition` header value for file downloads.
 *
 * HTTP headers only allow plain ASCII characters. Project names often contain
 * characters like the en dash (–) or accented letters, which make Node throw
 * `ERR_INVALID_CHAR` and turn the download into a 500 error.
 *
 * This returns two versions of the filename:
 *  - `filename="..."`   an ASCII-only fallback for old browsers
 *  - `filename*=UTF-8''...`  the real name, percent-encoded, for modern browsers
 */
export function attachmentHeader(filename: string): string {
  const asciiFallback = filename
    .replace(/[–—]/g, "-") // en/em dash -> regular hyphen
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accent marks
    .replace(/[^\x20-\x7E]/g, "_") // anything else non-ASCII -> underscore
    .replace(/["\\]/g, "_"); // quotes/backslashes would break the header

  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
