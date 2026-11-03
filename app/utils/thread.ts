import { compareCreated } from '@fabkho/ui/pure/timeline'
import type { Id } from '../types/adapter'

// The thread's pure rules, in plain TypeScript (Vitest drives them in Node): where a message goes in a thread, how
// a stored row and its optimistic bubble become one, which messages are one person's run, and what is unread after
// a cursor. No Vue, no store, no words: the app's store holds the state and calls these, and a conversation of any
// kind (1:1, a group, later a chapter's comments) is a thread under its `threadKey`.

/** What the rules need of a message: the app's own type has more. */
export interface ThreadMessage {
  id: Id
  conversationId: Id
  /** The id the sending device made up; matches an optimistic bubble to its row. */
  clientId: Id | null
  /** Null for a system line and for a member who has gone. */
  senderId: Id | null
  kind: string
  createdAt: string
}

/** A thread is one conversation, or one chapter of a buddy read inside a conversation. */
export function threadKey(conversationId: Id, threadId: Id | null = null): string {
  return threadId ? `${conversationId}#${threadId}` : conversationId
}

/** The server's time order: oldest first, microseconds kept (a `Date` drops them). */
export const byCreated = compareCreated

/** Two messages are the same one: the same row, or the same send of the same member (a client id). */
export function sameMessage(a: ThreadMessage, b: ThreadMessage): boolean {
  return a.id === b.id || (b.clientId !== null && a.clientId === b.clientId && a.senderId === b.senderId)
}

/**
 * Puts `message` into `messages` (oldest first), in place: a row that is there already (by id, or by client id and
 * sender: the stored row replacing her optimistic bubble) is merged over the old one, anything else is inserted
 * where its time says (almost always the end; a catch-up may bring one from between). `fill` takes what a merge
 * must keep of the old row (a read mark that was set meanwhile). Resolves whether it was new.
 */
export function insertMessage<M extends ThreadMessage>(messages: M[], message: M, fill?: (old: M, next: M) => Partial<M>): boolean {
  const at = messages.findIndex((m) => sameMessage(m, message))
  if (at >= 0) {
    const old = messages[at]!
    messages[at] = { ...old, ...message, ...(fill ? fill(old, message) : {}) }
    return false
  }
  let index = messages.length
  while (index > 0 && byCreated(messages[index - 1]!, message) > 0) index--
  messages.splice(index, 0, message)
  return true
}

/**
 * Whether two neighbours are one person's run: the same sender, and neither is a system line. A member who has gone
 * (`senderId` null, not a system line) is one sender, which is right because her lines all read the same way.
 */
export function sameRun(before: Pick<ThreadMessage, 'kind' | 'senderId'>, item: Pick<ThreadMessage, 'kind' | 'senderId'>): boolean {
  if (before.kind === 'system' || item.kind === 'system') return false
  return before.senderId === item.senderId
}

/** One run: the indices of its first and last message, and who wrote it. */
export interface Run {
  from: number
  to: number
  senderId: Id | null
}

/** The thread cut into runs (system lines are runs of their own, one each). */
export function runsOf(messages: readonly Pick<ThreadMessage, 'kind' | 'senderId'>[]): Run[] {
  const runs: Run[] = []
  for (let i = 0; i < messages.length; i++) {
    const last = runs.at(-1)
    if (last && sameRun(messages[last.to]!, messages[i]!)) last.to = i
    else runs.push({ from: i, to: i, senderId: messages[i]!.senderId })
  }
  return runs
}

/** A message another member wrote and that counts for "unread": not hers, not a system line. */
export function countsAsUnread(message: Pick<ThreadMessage, 'kind' | 'senderId'>, me: Id | null): boolean {
  return message.kind !== 'system' && message.senderId !== me
}

/**
 * How many messages are after her cursor (`readUpTo`, the `createdAt` of the newest she has read; null: nothing
 * read) and count as unread. Capped: a number past `cap` says only "that many or more".
 */
export function unreadAfter(
  messages: readonly Pick<ThreadMessage, 'kind' | 'senderId' | 'createdAt'>[],
  readUpTo: string | null,
  me: Id | null,
  cap = Infinity,
): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0 && count < cap; i--) {
    const m = messages[i]!
    if (readUpTo !== null && compareCreated(m, { createdAt: readUpTo }) <= 0) break
    if (countsAsUnread(m, me)) count++
  }
  return count
}

/**
 * Where her cursor should move to: the newest message of somebody else's that is newer than `markedUpTo` (what she
 * has told the server so far), or null when there is nothing to tell. A group has no per-message read mark, only
 * this cursor, so the store asks this before every `markRead`.
 */
export function readPoint(
  messages: readonly Pick<ThreadMessage, 'kind' | 'senderId' | 'createdAt'>[],
  markedUpTo: string | null,
  me: Id | null,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!countsAsUnread(m, me)) continue
    return markedUpTo !== null && compareCreated(m, { createdAt: markedUpTo }) <= 0 ? null : m.createdAt
  }
  return null
}

/** The later of two cursors (either may be null). */
export function laterCursor(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return compareCreated({ createdAt: a }, { createdAt: b }) >= 0 ? a : b
}
