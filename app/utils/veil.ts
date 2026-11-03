// The spoiler veil of a buddy read, drawn by the app and not enforced by the database (a spoiler among readers is a
// courtesy, not a secret): one rule in one place, in plain TypeScript. Her marker "read through chapter n" opens
// chapters 1…n, and the whole-book thread once she has read the last one; every other chapter is veiled until she opens it
// anyway (a "peek", remembered on her device, her marker does not move). Nothing here has words.

import type { Id } from '../types/adapter'

/** What the rules need of a chapter. */
export interface VeilChapter {
  id: Id
  position: number
  kind: 'chapter' | 'end'
}

/**
 * Whether the chapter's thread is open to her: up to her marker, the whole-book thread once she is through the last
 * chapter (`last`: how many chapters there are; none, no end thread), or opened anyway (`peeked`).
 */
export function chapterOpen(chapter: VeilChapter, marker: number, last: number, peeked: boolean): boolean {
  if (peeked) return true
  if (chapter.kind === 'end') return last >= 1 && marker >= last
  return chapter.position <= marker
}

/** A row of the chapter list: what it may show. */
export interface ChapterView {
  open: boolean
  /** Not opened, not reached: the row shows its number, count and faces only, as a thread she must confirm first. */
  veiled: boolean
  /** The title is drawn (and spoken) only on an open row: a renamed title can spoil (a chapter named after what happens in it). */
  showTitle: boolean
  /** The "new" dot: only on an open row (a veiled row's news is a spoiler as well). */
  showUnread: boolean
}

/** The row's view of a chapter; `peeked` is whether she opened it anyway before. */
export function chapterView(chapter: VeilChapter, marker: number, last: number, peeked: boolean): ChapterView {
  const open = chapterOpen(chapter, marker, last, peeked)
  return { open, veiled: !open, showTitle: open, showUnread: open }
}

/** What a thread's message may be in the veil. */
export interface VeilMessage {
  spoiler: boolean
  media: { kind: string } | null
}

/** A comment is veiled for her: it carries the spoiler mark and she has not tapped it. */
export function messageVeiled(message: Pick<VeilMessage, 'spoiler'>, revealed: boolean): boolean {
  return message.spoiler && !revealed
}

/**
 * Whether a picture of a message may be signed and loaded: **never** while the chapter is veiled (no thumbnail, no
 * egress until she opens it), and a picture with the spoiler mark only after she tapped it (`revealed`). A message
 * without a picture has nothing to load.
 */
export function mayLoadMedia(message: Pick<VeilMessage, 'spoiler'>, open: boolean, revealed: boolean): boolean {
  if (!open) return false
  return !messageVeiled(message, revealed)
}

/** The marker a "read through chapter n" at the foot of a thread sets: the chapter's own number, the last one for the whole book. */
export function markerFor(chapter: VeilChapter, last: number): number {
  return chapter.kind === 'end' ? last : chapter.position
}

/**
 * Whether the thread ends with "read through chapter n": only when she opened it ahead of her marker (it would move forward;
 * a thread she has reached ends without it).
 */
export function offersMarker(chapter: VeilChapter, marker: number, last: number): boolean {
  return markerFor(chapter, last) > marker
}

/** What a device keeps: a key → value store (`localStorage`). */
export interface PeekStorage {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** The chapters she opened anyway, kept on her device under `key`; a broken or foreign value reads as none. */
export function createPeeks(storage: PeekStorage, key: string) {
  function read(): Set<Id> {
    try {
      const parsed: unknown = JSON.parse(storage.get(key) ?? '[]')
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
    } catch {
      return new Set()
    }
  }
  return {
    has: (threadId: Id) => read().has(threadId),
    add(threadId: Id) {
      const all = read()
      if (all.has(threadId)) return
      all.add(threadId)
      try {
        storage.set(key, JSON.stringify([...all]))
      } catch {
        // A full or blocked storage: the peek lasts until she leaves the page.
      }
    },
  }
}
