import { describe, expect, it } from 'vitest'
import {
  insertMessage,
  laterCursor,
  readPoint,
  runsOf,
  sameMessage,
  sameRun,
  threadKey,
  unreadAfter,
  type ThreadMessage,
} from '../app/utils/thread'

/**
 * The thread's pure rules (`app/utils/thread.ts`) in plain Node: where a message goes, how a stored row
 * replaces its optimistic bubble, runs by sender, unread after a cursor.
 */

let n = 0
function message(over: Partial<ThreadMessage> & { body?: string } = {}): ThreadMessage & { body: string } {
  n++
  return {
    id: `m${n}`,
    conversationId: 'c1',
    clientId: null,
    senderId: 'ida',
    kind: 'text',
    createdAt: `2027-05-03T10:00:${String(n).padStart(2, '0')}.000000+00:00`,
    body: '',
    ...over,
  }
}

describe('threadKey', () => {
  it('is the conversation, or the conversation and its chapter', () => {
    expect(threadKey('c1')).toBe('c1')
    expect(threadKey('c1', null)).toBe('c1')
    expect(threadKey('c1', 'ch2')).toBe('c1#ch2')
  })
})

describe('insertMessage', () => {
  it('appends a newer message and says it is new', () => {
    const list = [message(), message()]
    const next = message()
    expect(insertMessage(list, next)).toBe(true)
    expect(list.at(-1)).toBe(next)
  })

  it('puts one from between where its time says (a catch-up)', () => {
    const a = message()
    const c = message()
    const b = { ...message(), createdAt: '2027-05-03T10:00:00.500000+00:00' }
    const list = [a, c]
    expect(insertMessage(list, { ...b, createdAt: a.createdAt.replace(/\.\d+/, '.500000') })).toBe(true)
    expect(list.map((m) => m.id)).toEqual([a.id, b.id, c.id])
  })

  it('orders by the microseconds the database sends when the milliseconds are equal', () => {
    const early = message({ createdAt: '2027-05-03T10:00:00.123456+00:00' })
    const late = message({ createdAt: '2027-05-03T10:00:00.123789+00:00' })
    const list = [late]
    insertMessage(list, early)
    expect(list.map((m) => m.id)).toEqual([early.id, late.id])
  })

  it('merges the stored row over her optimistic one by client id, once', () => {
    const optimistic = message({ id: 'local', clientId: 'cid-1' })
    const list = [optimistic]
    const row = { ...optimistic, id: 'server-1' }
    expect(insertMessage(list, row)).toBe(false)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('server-1')
    // The same row again (the live copy after the send's answer) changes nothing and is not new.
    expect(insertMessage(list, row)).toBe(false)
    expect(list).toHaveLength(1)
  })

  it('does not take another member\'s message with the same client id for hers', () => {
    const mine = message({ clientId: 'same', senderId: 'ida' })
    const theirs = message({ clientId: 'same', senderId: 'berit' })
    expect(sameMessage(mine, theirs)).toBe(false)
    const list = [mine]
    expect(insertMessage(list, theirs)).toBe(true)
    expect(list).toHaveLength(2)
  })

  it('lets `fill` keep what the old row had', () => {
    const a = { ...message({ id: 'x' }), readAt: '2027-05-03T11:00:00Z' as string | null }
    const list = [a]
    insertMessage(list, { ...a, readAt: null }, (old, next) => ({ readAt: next.readAt ?? old.readAt }))
    expect(list[0]!.readAt).toBe('2027-05-03T11:00:00Z')
  })
})

describe('runs by sender', () => {
  const ida = () => message({ senderId: 'ida' })
  const berit = () => message({ senderId: 'berit' })
  const system = () => message({ senderId: null, kind: 'system' })

  it('is one run per person in a row', () => {
    const list = [ida(), ida(), berit(), ida()]
    expect(runsOf(list).map((r) => [r.from, r.to, r.senderId])).toEqual([
      [0, 1, 'ida'],
      [2, 2, 'berit'],
      [3, 3, 'ida'],
    ])
  })

  it('breaks a run at a system line, and a system line is a run of its own', () => {
    const list = [ida(), system(), system(), ida()]
    expect(runsOf(list).map((r) => [r.from, r.to])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]])
    expect(sameRun(list[0]!, list[1]!)).toBe(false)
    expect(sameRun(list[1]!, list[2]!)).toBe(false)
  })

  it('takes members who have gone (no sender, not a system line) as one sender', () => {
    const gone = () => message({ senderId: null })
    expect(sameRun(gone(), gone())).toBe(true)
    expect(sameRun(gone(), ida())).toBe(false)
  })

  it('is empty for no messages', () => {
    expect(runsOf([])).toEqual([])
  })
})

describe('unread after a cursor', () => {
  const list = [
    message({ senderId: 'berit' }),
    message({ senderId: 'ida' }),
    message({ senderId: 'berit' }),
    message({ senderId: null, kind: 'system' }),
    message({ senderId: 'clara' }),
  ]

  it('counts everybody else\'s messages, never hers or a system line', () => {
    expect(unreadAfter(list, null, 'ida')).toBe(3)
  })

  it('starts after the cursor', () => {
    expect(unreadAfter(list, list[1]!.createdAt, 'ida')).toBe(2)
    expect(unreadAfter(list, list[4]!.createdAt, 'ida')).toBe(0)
  })

  it('stops at the cap', () => {
    expect(unreadAfter(list, null, 'ida', 2)).toBe(2)
  })

  it('counts a member who has gone', () => {
    expect(unreadAfter([message({ senderId: null })], null, 'ida')).toBe(1)
  })
})

describe('readPoint', () => {
  const list = [message({ senderId: 'berit' }), message({ senderId: 'ida' }), message({ senderId: null, kind: 'system' })]

  it('is the newest message of somebody else\'s', () => {
    expect(readPoint(list, null, 'ida')).toBe(list[0]!.createdAt)
  })

  it('is null once told, or when there is nothing of anybody else\'s', () => {
    expect(readPoint(list, list[0]!.createdAt, 'ida')).toBeNull()
    expect(readPoint([list[1]!, list[2]!], null, 'ida')).toBeNull()
    expect(readPoint([], null, 'ida')).toBeNull()
  })

  it('moves on for a newer one', () => {
    const newer = message({ senderId: 'clara' })
    expect(readPoint([...list, newer], list[0]!.createdAt, 'ida')).toBe(newer.createdAt)
  })
})

describe('laterCursor', () => {
  it('takes the later, and the one that is there', () => {
    expect(laterCursor(null, null)).toBeNull()
    expect(laterCursor('2027-05-03T10:00:01Z', null)).toBe('2027-05-03T10:00:01Z')
    expect(laterCursor(null, '2027-05-03T10:00:01Z')).toBe('2027-05-03T10:00:01Z')
    expect(laterCursor('2027-05-03T10:00:01Z', '2027-05-03T10:00:09Z')).toBe('2027-05-03T10:00:09Z')
  })
})
