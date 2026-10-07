// typedstream.mjs — the message text inside `message.attributedBody`.
//
// On current macOS, Messages often leaves `message.text` NULL and stores the text only in
// `attributedBody`: an NSAttributedString archived with Apple's legacy typedstream format
// (NSArchiver, not a keyed plist). A reader that trusts `text` alone silently misses a large
// share of messages, so every read path goes through `messageText()`.
//
// The archive is not parsed in full. The string payload follows the `NSString` class entry, a
// few bookkeeping bytes, and a `+` (0x2B) type tag, then a typedstream integer length and the
// UTF-8 bytes. A mutable string archives its class chain first (`NSMutableString`, then its
// superclass `NSString`), so the anchor is `NSString`, never the first class name:
//   length < 0x80        one byte
//   0x81  + int16 LE     two bytes
//   0x82  + int32 LE     four bytes
// Anything that does not fit that shape decodes to null rather than to a guess.

const MARKER = Buffer.from('NSString');
const PLUS = 0x2b;
const SEARCH_AFTER_MARKER = 16; // the '+' tag sits within a handful of bytes of the class name

/** Decode the plain text of an attributedBody blob; null when the blob has no string payload. */
export function decodeAttributedBody(blob) {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const at = buf.indexOf(MARKER);
  if (at === -1) return null;
  let p = at + MARKER.length;
  const stop = Math.min(buf.length, p + SEARCH_AFTER_MARKER);
  while (p < stop && buf[p] !== PLUS) p++;
  if (p >= stop) return null;
  p++; // past '+'
  if (p >= buf.length) return null;
  let len;
  const b = buf[p];
  if (b === 0x81) {
    if (p + 3 > buf.length) return null;
    len = buf.readUInt16LE(p + 1);
    p += 3;
  } else if (b === 0x82) {
    if (p + 5 > buf.length) return null;
    len = buf.readUInt32LE(p + 1);
    p += 5;
  } else if (b < 0x80) {
    len = b;
    p += 1;
  } else {
    return null;
  }
  if (p + len > buf.length) return null;
  return buf.toString('utf8', p, p + len);
}

/**
 * The text of a message row: `text` when present, else the decoded attributedBody. U+FFFC (the
 * object-replacement character marking where an attachment sits) is removed: attachments are
 * reported separately, and the placeholder is the only way `text` and the archive differ.
 */
export function messageText(row) {
  const raw = typeof row.text === 'string' && row.text.length ? row.text : decodeAttributedBody(row.attributedBody);
  if (raw === null || raw === undefined) return null;
  return raw.replace(/￼/g, '').trim();
}
