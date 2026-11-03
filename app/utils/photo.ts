/**
 * A photo from her gallery, made ready on her phone before it is uploaded (one pipeline for
 * every use an app has for a picked picture: a message, a post, a profile picture): at most 1600 px on the long edge, re-encoded as
 * JPEG (WebKit encodes no WebP) at the best quality that stays ≤ 2 MB. Drawing
 * it through a canvas and encoding it anew keeps only the pixels, so nothing of
 * the original's EXIF (location, camera, time) survives; but Safari's encoder
 * writes a small EXIF and Photoshop block of its own, so the encoded JPEG is
 * cleaned once more (`stripJpegMetadata`: every APP1, APP12, APP13 and comment
 * segment goes). Verified by `hasMetadata` in the tests and on the stored
 * object in an app's end-to-end test. A GIF from the gallery stays a GIF (it
 * may move; GIFs carry no EXIF) if it is small enough.
 *
 * Framework-free; `preparePhoto` needs a browser (createImageBitmap, canvas),
 * the size rules and the metadata check run anywhere.
 */

export const PHOTO_MAX_EDGE = 1600
/** A photo sent into a group chat: smaller, because up to 30 members download it. */
export const GROUP_PHOTO_MAX_EDGE = 1280
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024
/** What she may pick: stored as JPEG (photos) or GIF. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'
const ACCEPTED = PHOTO_ACCEPT.split(',')

export type PreparedPhoto = { blob: Blob; width: number; height: number; kind: 'image' | 'gif' }

/** Why a picked file cannot be sent; worded by the app (the layer returns the reason, never a sentence). */
export class PhotoError extends Error {
  constructor(readonly reason: 'type' | 'unreadable' | 'too_large') {
    super(reason)
  }
}

/** Her picture's size scaled down (never up) so its long edge is at most `max`. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * Whether the bytes carry EXIF or similar metadata: a JPEG APP1 "Exif"/XMP
 * segment, a PNG eXIf or tEXt chunk, a WebP EXIF or XMP chunk.
 */
export function hasMetadata(bytes: Uint8Array): boolean {
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.slice(at, at + n))
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 4 <= bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1]!
      if (marker === 0xda || marker === 0xd9) break
      const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
      if (marker === 0xe1) {
        const id = ascii(i + 4, 4)
        if (id === 'Exif' || id === 'http') return true
      }
      i += 2 + length
    }
    return false
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    for (let i = 8; i + 8 <= bytes.length; ) {
      const length = ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0
      const type = ascii(i + 4, 4)
      if (type === 'eXIf' || type === 'tEXt' || type === 'iTXt' || type === 'zTXt') return true
      i += 12 + length
    }
    return false
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    for (let i = 12; i + 8 <= bytes.length; ) {
      const type = ascii(i, 4)
      const length = (bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24)) >>> 0
      if (type === 'EXIF' || type === 'XMP ') return true
      i += 8 + length + (length % 2)
    }
  }
  return false
}

/**
 * A JPEG without its metadata segments: APP1 (EXIF, XMP), APP12, APP13
 * (Photoshop/IPTC) and comments are dropped; JFIF, the colour profile (APP2)
 * and Adobe's APP14 stay (the picture needs them to look the same). Anything
 * that is not a well-formed JPEG comes back unchanged.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes
  const keep: Uint8Array[] = [bytes.slice(0, 2)]
  let i = 2
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return bytes
    const marker = bytes[i + 1]!
    if (marker === 0xda) {
      keep.push(bytes.slice(i))
      const out = new Uint8Array(keep.reduce((n, part) => n + part.length, 0))
      let at = 0
      for (const part of keep) {
        out.set(part, at)
        at += part.length
      }
      return out
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    const drop = marker === 0xe1 || marker === 0xec || marker === 0xed || marker === 0xfe
    if (!drop) keep.push(bytes.slice(i, i + 2 + length))
    i += 2 + length
  }
  return bytes
}

/**
 * The picture's pixels and its size: `createImageBitmap` (which turns it the way it was taken) or,
 * where that is missing, an `Image` over an object URL; `close` releases whichever it used. Exported
 * because the face rendition of an avatar (`avatarFace.ts`) decodes the very same way.
 */
export async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    // Turned the way it was taken (EXIF orientation), before the EXIF goes.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await img.decode()
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
    } catch {
      URL.revokeObjectURL(url)
      throw new PhotoError('unreadable')
    }
  }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/** Her picked file as the chat sends it (`maxEdge`: the long edge's limit). Throws `PhotoError`. */
export async function preparePhoto(file: Blob, maxEdge = PHOTO_MAX_EDGE): Promise<PreparedPhoto> {
  if (!ACCEPTED.includes(file.type)) throw new PhotoError('type')
  if (file.type === 'image/gif') {
    if (file.size > PHOTO_MAX_BYTES) throw new PhotoError('too_large')
    const { width, height, close } = await decodeImage(file)
    close()
    return { blob: file, width, height, kind: 'gif' }
  }

  const image = await decodeImage(file)
  try {
    let size = fitWithin(image.width, image.height, maxEdge)
    for (let round = 0; round < 4; round++) {
      const canvas = document.createElement('canvas')
      canvas.width = size.width
      canvas.height = size.height
      const context = canvas.getContext('2d')
      if (!context) throw new PhotoError('unreadable')
      // A transparent PNG reads as on paper, not on black.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, size.width, size.height)
      context.drawImage(image.source, 0, 0, size.width, size.height)
      for (const quality of [0.86, 0.78, 0.68]) {
        const blob = await encode(canvas, quality)
        if (!blob) throw new PhotoError('unreadable')
        if (blob.size > PHOTO_MAX_BYTES) continue
        const clean = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()))
        return { blob: new Blob([clean], { type: 'image/jpeg' }), ...size, kind: 'image' }
      }
      size = fitWithin(size.width, size.height, Math.round(Math.max(size.width, size.height) * 0.8))
    }
    throw new PhotoError('too_large')
  } finally {
    image.close()
  }
}
