/**
 * File types by magic bytes, never by name or the client's Content-Type.
 * Only these three image formats are accepted anywhere. SVG (can carry
 * script), GIF, HTML, PDF and everything else are refused.
 */

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(buf: Uint8Array, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** The real type of an image, or null if it isn't one we accept. */
export function sniffImageType(buf: Uint8Array): AllowedImageType | null {
  if (startsWith(buf, PNG)) return "image/png";
  if (startsWith(buf, JPEG)) return "image/jpeg";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

export const EXTENSIONS: Readonly<Record<AllowedImageType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
