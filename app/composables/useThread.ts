import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { Id } from '../types/adapter'
import { readPoint, runsOf, sameRun, unreadAfter, type ThreadMessage } from '../utils/thread'

/**
 * The thread's rules as reactive state (a thin layer over `utils/thread.ts`, Vue reactivity only): what a screen
 * needs of a conversation's messages, whatever the app keeps them in. `messages` is oldest first; `me` the signed-in
 * member; `cursor` the `createdAt` she has read up to (a group's per-member cursor; null: nothing).
 *
 * - `runs`: the thread cut into one person's runs (names go over the first message of a run, a face beside the last).
 * - `sameRun`: what `UiChatThread`'s `sameRun` prop takes.
 * - `unread`: how many messages after the cursor are somebody else's (`cap` stops the count).
 * - `readPoint(marked)`: where the cursor should move to, or null when there is nothing new to tell the server.
 */
export function useThread<M extends ThreadMessage>(
  messages: MaybeRefOrGetter<readonly M[]>,
  options: { me: MaybeRefOrGetter<Id | null>; cursor?: MaybeRefOrGetter<string | null>; cap?: number },
) {
  const runs = computed(() => runsOf(toValue(messages)))
  const unread = computed(() => unreadAfter(toValue(messages), toValue(options.cursor) ?? null, toValue(options.me), options.cap))
  const point = (marked: string | null) => readPoint(toValue(messages), marked, toValue(options.me))
  return { runs, sameRun, unread, readPoint: point }
}
