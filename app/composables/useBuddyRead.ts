import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { BuddyChapter, BuddyReadData, Id } from '../types/adapter'
import { whoIsAt } from '../utils/chapters'
import { chapterView, markerFor, offersMarker, type ChapterView } from '../utils/veil'

/** One row of the chapter list: the chapter, its view in the veil, and who is on it. */
export interface BuddyRow extends BuddyChapter, ChapterView {
  /** The members whose marker stands on this chapter. */
  here: Id[]
  /** She opened it anyway earlier. */
  peeked: boolean
}

/**
 * A buddy read's rules as reactive state (a thin layer over `utils/chapters.ts` and `utils/veil.ts`): her marker, the
 * rows of the chapter list with their veil, and what a thread ahead of her offers. `read` is what the app holds of the
 * buddy read; `peeked` says which chapters she opened anyway (the adapter's device-local set); `version` is any value that
 * changes when a peek is added, so the rows follow.
 */
export function useBuddyRead(
  read: MaybeRefOrGetter<BuddyReadData | null>,
  options: { peeked: (threadId: Id) => boolean; version?: MaybeRefOrGetter<unknown> },
) {
  /** How many chapters there are (the whole-book thread is not one). */
  const last = computed(() => toValue(read)?.chapters.filter((c) => c.kind === 'chapter').length ?? 0)
  const marker = computed(() => toValue(read)?.readThrough ?? 0)
  const rows = computed<BuddyRow[]>(() => {
    toValue(options.version)
    const data = toValue(read)
    if (!data) return []
    return data.chapters.map((chapter) => {
      const peeked = options.peeked(chapter.id)
      return { ...chapter, ...chapterView(chapter, marker.value, last.value, peeked), here: whoIsAt(chapter, data.marks, last.value), peeked }
    })
  })
  const rowOf = (threadId: Id) => rows.value.find((r) => r.id === threadId) ?? null
  const rowAt = (position: number) => rows.value.find((r) => r.position === position) ?? null
  /** New comments over her open chapters: what the pill and the group info show. */
  const unread = computed(() => rows.value.reduce((sum, row) => sum + (row.showUnread ? row.unread : 0), 0))
  return {
    last,
    marker,
    rows,
    rowOf,
    rowAt,
    unread,
    /** What a "read through chapter n" on this chapter would set. */
    markerFor: (chapter: BuddyChapter) => markerFor(chapter, last.value),
    offersMarker: (chapter: BuddyChapter) => offersMarker(chapter, marker.value, last.value),
  }
}
