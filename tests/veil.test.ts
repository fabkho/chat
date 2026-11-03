import { describe, expect, it } from 'vitest'
import { chapterOpen, chapterView, createPeeks, markerFor, mayLoadMedia, messageVeiled, offersMarker } from '../app/utils/veil'

/**
 * The spoiler veil (`app/utils/veil.ts`) in plain Node: which chapters are open
 * for a marker, the whole-book thread, a peek, what a row may show, and when a picture may be signed.
 */

const chapter = (position: number) => ({ id: `k${position}`, position, kind: 'chapter' as const })
const end = (position: number) => ({ id: `k${position}`, position, kind: 'end' as const })

describe('which chapters are open', () => {
  it('are those up to her marker', () => {
    expect([1, 2, 3, 4].map((n) => chapterOpen(chapter(n), 2, 4, false))).toEqual([true, true, false, false])
  })

  it('are none while she has not started', () => {
    expect([1, 2].map((n) => chapterOpen(chapter(n), 0, 2, false))).toEqual([false, false])
  })

  it('open the whole book only once she is through the last chapter', () => {
    expect(chapterOpen(end(4), 2, 3, false)).toBe(false)
    expect(chapterOpen(end(4), 3, 3, false)).toBe(true)
  })

  it('never open the whole book of a read without chapters', () => {
    expect(chapterOpen(end(1), 0, 0, false)).toBe(false)
  })

  it('open a veiled one she opened anyway, the marker stays where it is', () => {
    expect(chapterOpen(chapter(9), 6, 12, true)).toBe(true)
    expect(chapterOpen(end(13), 6, 12, true)).toBe(true)
  })
})

describe('a row', () => {
  it('shows its title and its news only when open', () => {
    expect(chapterView(chapter(1), 3, 5, false)).toEqual({ open: true, veiled: false, showTitle: true, showUnread: true })
    expect(chapterView(chapter(4), 3, 5, false)).toEqual({ open: false, veiled: true, showTitle: false, showUnread: false })
  })

  it('is open, with its title, after a peek', () => {
    expect(chapterView(chapter(4), 3, 5, true)).toMatchObject({ veiled: false, showTitle: true })
  })
})

describe('her marker', () => {
  it('is the chapter\'s own number, the last for the whole book', () => {
    expect(markerFor(chapter(7), 22)).toBe(7)
    expect(markerFor(end(23), 22)).toBe(22)
  })

  it('is offered at the foot of a thread opened ahead of her, not of one she has reached', () => {
    expect(offersMarker(chapter(7), 6, 22)).toBe(true)
    expect(offersMarker(chapter(6), 6, 22)).toBe(false)
    expect(offersMarker(chapter(3), 6, 22)).toBe(false)
    expect(offersMarker(end(23), 6, 22)).toBe(true)
    expect(offersMarker(end(23), 22, 22)).toBe(false)
  })
})

describe('a comment', () => {
  it('with the spoiler mark is veiled until she taps it', () => {
    expect(messageVeiled({ spoiler: true }, false)).toBe(true)
    expect(messageVeiled({ spoiler: true }, true)).toBe(false)
    expect(messageVeiled({ spoiler: false }, false)).toBe(false)
  })
})

describe('a photo', () => {
  it('in a veiled chapter is never signed, tapped or not', () => {
    expect(mayLoadMedia({ spoiler: false }, false, false)).toBe(false)
    expect(mayLoadMedia({ spoiler: false }, false, true)).toBe(false)
    expect(mayLoadMedia({ spoiler: true }, false, true)).toBe(false)
  })

  it('in an open chapter is signed', () => {
    expect(mayLoadMedia({ spoiler: false }, true, false)).toBe(true)
  })

  it('with the spoiler mark is signed only when she taps it', () => {
    expect(mayLoadMedia({ spoiler: true }, true, false)).toBe(false)
    expect(mayLoadMedia({ spoiler: true }, true, true)).toBe(true)
  })
})

describe('peeks', () => {
  function memory() {
    const data = new Map<string, string>()
    return { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v), data }
  }

  it('are remembered on the device, per chapter', () => {
    const storage = memory()
    const peeks = createPeeks(storage, 'peeks.ida')
    expect(peeks.has('k9')).toBe(false)
    peeks.add('k9')
    expect(peeks.has('k9')).toBe(true)
    expect(peeks.has('k10')).toBe(false)
    // A new page load reads the same.
    expect(createPeeks(storage, 'peeks.ida').has('k9')).toBe(true)
    // Another member of the same device has her own.
    expect(createPeeks(storage, 'peeks.berit').has('k9')).toBe(false)
  })

  it('are kept once', () => {
    const storage = memory()
    const peeks = createPeeks(storage, 'p')
    peeks.add('k1')
    peeks.add('k1')
    expect(JSON.parse(storage.data.get('p')!)).toEqual(['k1'])
  })

  it('read a broken value as none and survive a storage that refuses', () => {
    const broken = { get: () => '{nope', set: () => {} }
    expect(createPeeks(broken, 'p').has('k1')).toBe(false)
    const full = { get: () => null, set: () => { throw new Error('quota') } }
    expect(() => createPeeks(full, 'p').add('k1')).not.toThrow()
    const foreign = { get: () => '{"a":1}', set: () => {} }
    expect(createPeeks(foreign, 'p').has('a')).toBe(false)
  })
})
