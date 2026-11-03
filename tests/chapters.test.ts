import { describe, expect, it } from 'vitest'
import {
  chapterAt,
  DEFAULT_PAGES_PER_PART,
  groupingsFor,
  insertBefore,
  numberedTitle,
  planByCount,
  planByPages,
  planProblem,
  whoIsAt,
} from '../app/utils/chapters'
import { threadKey } from '../app/utils/thread'

/**
 * How a buddy read is divided (`app/utils/chapters.ts`) in
 * plain Node: the count with grouping, the pages, who is "here" on a chapter, and the key a chapter's thread lives under.
 */

describe('the division by count', () => {
  it('is one chapter each by default', () => {
    expect(planByCount(3)).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 2 },
      { from: 3, to: 3 },
    ])
  })

  it('groups two or three together, the last one may be shorter', () => {
    expect(planByCount(5, 2)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 5 },
    ])
    expect(planByCount(40, 3)).toHaveLength(14)
    expect(planByCount(40, 3).at(-1)).toEqual({ from: 40, to: 40 })
  })

  it('takes 1 to 100 chapters and nothing else', () => {
    expect(planByCount(100)).toHaveLength(100)
    expect(planByCount(0)).toEqual([])
    expect(planByCount(101)).toEqual([])
    expect(planByCount(2.5)).toEqual([])
    expect(planByCount(Number.NaN)).toEqual([])
    expect(planByCount(10, 6)).toEqual([])
  })

  it('offers grouping only above 30 chapters', () => {
    expect(groupingsFor(30)).toEqual([1])
    expect(groupingsFor(31)).toEqual([1, 2, 3])
    expect(groupingsFor(100)).toEqual([1, 2, 3])
  })
})

describe('the division by pages', () => {
  it('cuts the book into parts of 50 pages, with the pages of each', () => {
    const plan = planByPages(120)
    expect(DEFAULT_PAGES_PER_PART).toBe(50)
    expect(plan).toEqual([
      { from: 1, to: 1, startPage: 1, endPage: 50 },
      { from: 2, to: 2, startPage: 51, endPage: 100 },
      { from: 3, to: 3, startPage: 101, endPage: 120 },
    ])
  })

  it('takes the size of a part', () => {
    expect(planByPages(100, 25)).toHaveLength(4)
    expect(planByPages(100, 100)).toEqual([{ from: 1, to: 1, startPage: 1, endPage: 100 }])
  })

  it('refuses a book in more than 100 parts, and numbers out of range', () => {
    expect(planByPages(5001)).toEqual([])
    expect(planByPages(5000)).toHaveLength(100)
    expect(planByPages(0)).toEqual([])
    expect(planByPages(10001)).toEqual([])
    expect(planByPages(100, 0)).toEqual([])
  })

  it('says which number is wrong', () => {
    expect(planProblem({ from: 'count', count: 22 })).toBeNull()
    expect(planProblem({ from: 'count', count: 0 })).toBe('count')
    expect(planProblem({ from: 'count' })).toBe('count')
    expect(planProblem({ from: 'pages', pageCount: 300 })).toBeNull()
    expect(planProblem({ from: 'pages', pageCount: 9000 })).toBe('pages')
    expect(planProblem({ from: 'pages' })).toBe('pages')
  })
})

describe('who is here', () => {
  const marks = [
    { memberId: 'lena', readThrough: 2 },
    { memberId: 'sofia', readThrough: 2 },
    { memberId: 'mia', readThrough: 3 },
    { memberId: 'ida', readThrough: 0 },
  ]

  it('are the members whose marker stands on the chapter', () => {
    expect(whoIsAt({ position: 2, kind: 'chapter' }, marks, 3)).toEqual(['lena', 'sofia'])
    expect(whoIsAt({ position: 1, kind: 'chapter' }, marks, 3)).toEqual([])
  })

  it('are those through the last chapter on the whole book', () => {
    expect(whoIsAt({ position: 4, kind: 'end' }, marks, 3)).toEqual(['mia'])
    // No chapters, nobody is through.
    expect(whoIsAt({ position: 1, kind: 'end' }, [{ memberId: 'ida', readThrough: 0 }], 0)).toEqual([])
  })
})

describe('a chapter thread', () => {
  it('lives under the conversation and the chapter, the chat under the conversation alone', () => {
    expect(threadKey('c1')).toBe('c1')
    expect(threadKey('c1', null)).toBe('c1')
    expect(threadKey('c1', 'k1')).toBe('c1#k1')
    expect(threadKey('c1', 'k1')).not.toBe(threadKey('c1', 'k2'))
  })
})

describe('custom chapters (D26): a position is no number, the title is the name', () => {
  const list = [
    { id: 'p', position: 1, kind: 'chapter' as const, title: 'Prologue' },
    { id: 'k1', position: 2, kind: 'chapter' as const, title: 'Chapter 1' },
    { id: 'z', position: 3, kind: 'chapter' as const, title: 'Interlude' },
    { id: 'k2', position: 4, kind: 'chapter' as const, title: 'Chapter 2' },
    { id: 'end', position: 5, kind: 'end' as const, title: 'The whole book' },
  ]

  it('knows the number a division wrote, and none in any other title', () => {
    const fmt = 'Chapter {n}'
    expect(numberedTitle('Chapter 7', fmt)).toBe('7')
    expect(numberedTitle('Chapter 1–2', fmt)).toBe('1–2')
    expect(numberedTitle('Prologue', fmt)).toBeNull()
    expect(numberedTitle('Chapter 7: The Storm', fmt)).toBeNull()
    expect(numberedTitle('Chapter', fmt)).toBeNull()
    // No number to count on: five digits and more are a title like any other.
    expect(numberedTitle('Chapter 99999999999', fmt)).toBeNull()
    expect(numberedTitle('Chapter 9999', fmt)).toBe('9999')
  })

  it('knows it for any app\'s format (English, a number first, a format with regex characters)', () => {
    expect(numberedTitle('Chapter 7', 'Chapter {n}')).toBe('7')
    expect(numberedTitle('Chapter 1–2', 'Chapter {n}')).toBe('1–2')
    expect(numberedTitle('Prologue', 'Chapter {n}')).toBeNull()
    expect(numberedTitle('Chapter 7: The Storm', 'Chapter {n}')).toBeNull()
    // A title in another format is a custom one here.
    expect(numberedTitle('Part 7', 'Chapter {n}')).toBeNull()
    expect(numberedTitle('3rd part', '{n}rd part')).toBe('3')
    expect(numberedTitle('Part (3).', 'Part ({n}).')).toBe('3')
    expect(numberedTitle('Part x3y.', 'Part ({n}).')).toBeNull()
    expect(numberedTitle('Chapter 99999', 'Chapter {n}')).toBeNull()
  })

  it('finds the chapter a marker stands on by position, never "The whole book"', () => {
    expect(chapterAt(list, 3)?.title).toBe('Interlude')
    expect(chapterAt(list, 0)).toBeNull()
    expect(chapterAt(list, 5)).toBeNull()
  })

  it('puts "before" in front of the chapter and "after" in front of the one that follows (the whole book for the last)', () => {
    expect(insertBefore(list, list[1]!, 'before')).toBe('k1')
    expect(insertBefore(list, list[1]!, 'after')).toBe('z')
    expect(insertBefore(list, list[3]!, 'after')).toBe('end')
    expect(insertBefore(list, list[4]!, 'after')).toBeNull()
  })

  it('keeps who is "here" on the chapter she read through, whatever its position', () => {
    // Berit's marker was Chapter 1 (position 1); after a Prologue in front of it the database has moved it to 2.
    expect(whoIsAt(list[1]!, [{ memberId: 'berit', readThrough: 2 }], 4)).toEqual(['berit'])
    expect(whoIsAt(list[0]!, [{ memberId: 'berit', readThrough: 2 }], 4)).toEqual([])
  })
})
