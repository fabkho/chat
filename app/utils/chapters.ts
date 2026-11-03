// How a buddy read is divided into chapters, in plain TypeScript (Vitest drives it in Node): the division by count, with
// grouping, or by pages, as ranges. The server has the same arithmetic (`set_buddy_chapters`); this is what the setup's
// preview draws before it is asked. No words: the app says "Chapter 1–2" (or its own words) over a range.

/** One chapter of a plan: the numbers it covers (`from` … `to`), and for a division by pages the pages. */
export interface ChapterRange {
  from: number
  to: number
  startPage?: number
  endPage?: number
}

/** The most chapters a buddy read has (the whole-book thread comes on top). */
export const MAX_CHAPTERS = 100
/** Above this many chapters the setup offers to group them. */
export const GROUPING_ABOVE = 30
/** The largest grouping the setup offers ("3 at a time"). */
export const MAX_GROUPING = 3
/** Pages in a part when nothing else is said. */
export const DEFAULT_PAGES_PER_PART = 50
export const MAX_PAGES = 10000

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)

/** The groupings on offer for a book of `count` chapters: only one chapter each up to 30, then 2 and 3 at a time as well. */
export function groupingsFor(count: number): readonly number[] {
  return whole(count) && count > GROUPING_ABOVE ? [1, 2, 3] : [1]
}

/** `count` chapters, `per` of them together: [1–2], [3–4] … (the last may be shorter). Empty for numbers out of range. */
export function planByCount(count: number, per = 1): ChapterRange[] {
  if (!whole(count) || !whole(per) || count < 1 || count > MAX_CHAPTERS || per < 1 || per > 5) return []
  const ranges: ChapterRange[] = []
  for (let from = 1; from <= count; from += per) ranges.push({ from, to: Math.min(from + per - 1, count) })
  return ranges
}

/** A book of `pageCount` pages in parts of `perPart` pages: chapter 1 is pages 1–50 … Empty for numbers out of range, or above 100 parts. */
export function planByPages(pageCount: number, perPart = DEFAULT_PAGES_PER_PART): ChapterRange[] {
  if (!whole(pageCount) || !whole(perPart) || pageCount < 1 || pageCount > MAX_PAGES || perPart < 1 || perPart > MAX_PAGES) return []
  const parts = Math.ceil(pageCount / perPart)
  if (parts > MAX_CHAPTERS) return []
  return Array.from({ length: parts }, (_, i) => ({
    from: i + 1,
    to: i + 1,
    startPage: i * perPart + 1,
    endPage: Math.min((i + 1) * perPart, pageCount),
  }))
}

/** What is wrong with the numbers typed, or null: `count` outside 1–100, `pages` empty or in more than 100 parts. */
export function planProblem(plan: { from: 'count' | 'pages'; count?: number | null; per?: number | null; pageCount?: number | null }): 'count' | 'pages' | null {
  if (plan.from === 'count') return planByCount(plan.count ?? NaN, plan.per ?? 1).length > 0 ? null : 'count'
  return planByPages(plan.pageCount ?? NaN, plan.per ?? DEFAULT_PAGES_PER_PART).length > 0 ? null : 'pages'
}

/** How many chapters a plan makes (without the whole-book thread). */
export const chaptersIn = (ranges: readonly ChapterRange[]): number => ranges.length

/**
 * Who is "here" on a chapter: the members whose marker stands on it (the chapter she has read through), never more.
 * The whole-book thread is where those stand who have read the last chapter. `last` is the number of chapters.
 */
export function whoIsAt<Member>(
  chapter: { position: number; kind: 'chapter' | 'end' },
  marks: readonly { memberId: Member; readThrough: number }[],
  last: number,
): Member[] {
  if (chapter.kind === 'end') return last >= 1 ? marks.filter((m) => m.readThrough >= last).map((m) => m.memberId) : []
  return marks.filter((m) => m.readThrough === chapter.position).map((m) => m.memberId)
}

/** The number a division writes into a chapter's title: `7`, or `1–2` when several chapters are grouped. */
const NUMBER = '(\\d{1,4}(?:–\\d{1,4})?)'

/**
 * The number a title carries, for the title format of the app's language: `format` is the division's title with `{n}` where the
 * number goes (`'Chapter {n}'`). `'7'` for `Chapter 7`, `'1–2'` for `Chapter 1–2`, null for any other title (`Prologue`, `Chapter 7:
 * The Storm`). An admin may insert a chapter anywhere, so a chapter's position is no longer its number: what a row says about
 * itself is its title, and a title that is not a division's own is a custom one.
 */
export function numberedTitle(title: string, format: string): string | null {
  const [before = '', after = ''] = format.split('{n}')
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escape(before)}${NUMBER}${escape(after)}$`).exec(title)?.[1] ?? null
}

/** The chapter (not the whole-book thread) at `position`, e.g. the one her marker stands on; null for 0 or none. */
export function chapterAt<C extends { position: number; kind: 'chapter' | 'end' }>(chapters: readonly C[], position: number): C | null {
  return chapters.find((c) => c.kind === 'chapter' && c.position === position) ?? null
}

/**
 * Where an inserted chapter goes, as `add_buddy_chapter`'s "in front of": `before` is in front of the chapter itself, `after` in
 * front of the one that follows it (the whole-book thread for the last chapter). Null when there is none to stand in front of (after
 * the whole-book thread, or a list that has no follower): then the call cannot be made.
 */
export function insertBefore<C extends { id: string; position: number }>(
  chapters: readonly C[],
  anchor: Pick<C, 'id' | 'position'>,
  placement: 'before' | 'after',
): string | null {
  if (placement === 'before') return anchor.id
  return chapters.find((c) => c.position === anchor.position + 1)?.id ?? null
}
