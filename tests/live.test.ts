import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COLD_START_RESYNC_MS,
  createLiveConnection,
  subscribeTopic,
  type BroadcastMessage,
  type ChannelLike,
  type ChannelStatus,
  type LiveEnv,
  type RealtimeLike,
  type TopicChannel,
  type TopicHandlers,
} from '../app/utils/liveChannel'

/**
 * The chat layer's live channel (`app/utils/liveChannel.ts`) in plain Node: a fake realtime client, a
 * fake channel and a fake page.

 */

type Event = { type: 'ping'; n: number } | { type: 'pong' }

class FakeChannel implements ChannelLike {
  state: ((state: string, error?: { message?: string }) => void) | null = null
  broadcast: ((message: BroadcastMessage) => void) | null = null
  removed = 0
  constructor(readonly topic: string, readonly opts: { config: { private: boolean } }) {}
  on(_type: 'broadcast', _filter: { event: string }, callback: (message: BroadcastMessage) => void) {
    this.broadcast = callback
    return this
  }
  subscribe(callback: (state: string, error?: { message?: string }) => void) {
    this.state = callback
    return this
  }
  fire(state: string, error?: { message?: string }) {
    this.state?.(state, error)
  }
  send(event: string, payload: unknown) {
    this.broadcast?.({ event, payload })
  }
}

function fakeClient() {
  const channels: FakeChannel[] = []
  const order: string[] = []
  const client: RealtimeLike = {
    async setAuth() {
      order.push('setAuth')
    },
    channel(topic, opts) {
      order.push('channel')
      const channel = new FakeChannel(topic, opts)
      channels.push(channel)
      return channel
    },
    async removeChannel(channel) {
      ;(channel as FakeChannel).removed++
    },
  }
  return { client, channels, order, last: () => channels[channels.length - 1]! }
}

const parse = (event: string, payload: unknown): Event | null =>
  event === 'ping' ? { type: 'ping', n: (payload as { n: number }).n } : event === 'pong' ? { type: 'pong' } : null

/** Lets the awaited `setAuth` and promise chains run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('subscribeTopic', () => {
  function join() {
    const fake = fakeClient()
    const events: Event[] = []
    const statuses: ChannelStatus[] = []
    const resyncs: string[] = []
    const channel = subscribeTopic(fake.client, 'room:1', parse, {
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      onResync: (r) => resyncs.push(r),
    })
    return { ...fake, channel, events, statuses, resyncs }
  }

  it('authorises before the first join, on a private topic', async () => {
    const t = join()
    expect(t.channel.status()).toBe('connecting')
    await flush()
    expect(t.order).toEqual(['setAuth', 'channel'])
    expect(t.last().topic).toBe('room:1')
    expect(t.last().opts).toEqual({ config: { private: true } })
  })

  it('goes live and reads once, exactly 3 s after the first join', async () => {
    const t = join()
    await flush()
    t.last().fire('SUBSCRIBED')
    expect(t.channel.status()).toBe('live')
    await expect(t.channel.ready).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS - 1)
    expect(t.resyncs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(t.resyncs).toEqual(['coldStart'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.resyncs).toEqual(['coldStart'])
  })

  it('reads no cold start when the channel is no longer live by then', async () => {
    const t = join()
    await flush()
    t.last().fire('SUBSCRIBED')
    t.last().fire('CLOSED')
    expect(t.channel.status()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS)
    expect(t.resyncs).toEqual([])
  })

  it('reads at once on a rejoin and sets no second cold-start timer', async () => {
    const t = join()
    await flush()
    t.last().fire('SUBSCRIBED')
    await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS)
    t.resyncs.length = 0
    for (const drop of ['CLOSED', 'CHANNEL_ERROR']) {
      t.last().fire(drop)
      expect(t.channel.status()).toBe('reconnecting')
      t.last().fire('SUBSCRIBED')
      expect(t.channel.status()).toBe('live')
      expect(t.resyncs.at(-1)).toBe('rejoin')
    }
    expect(t.resyncs).toEqual(['rejoin', 'rejoin'])
    await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS * 2)
    expect(t.resyncs).toEqual(['rejoin', 'rejoin'])
  })

  it('is refused on an unauthorized or permission error: channel removed, no retry', async () => {
    for (const message of ['Unauthorized: not allowed', 'unauthorised', 'No permissions for this topic']) {
      const t = join()
      await flush()
      t.last().fire('CHANNEL_ERROR', { message })
      expect(t.channel.status()).toBe('refused')
      await expect(t.channel.ready).resolves.toBe(false)
      expect(t.last().removed).toBe(1)
      expect(t.channels).toHaveLength(1)
      // Later calls of the old channel change nothing.
      t.last().fire('SUBSCRIBED')
      expect(t.channel.status()).toBe('refused')
      await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS)
      expect(t.resyncs).toEqual([])
      expect(t.statuses).toEqual(['refused'])
    }
  })

  it('is refused (ready false) when the authorisation itself fails', async () => {
    const client: RealtimeLike = {
      setAuth: () => Promise.reject(new Error('offline')),
      channel: () => {
        throw new Error('never joined')
      },
      removeChannel: async () => {},
    }
    const channel = subscribeTopic(client, 't', parse, { onEvent: () => {} })
    await expect(channel.ready).resolves.toBe(false)
    expect(channel.status()).toBe('refused')
  })

  it('says connecting on TIMED_OUT before it was ever live, reconnecting after', async () => {
    const t = join()
    await flush()
    t.last().fire('TIMED_OUT')
    expect(t.channel.status()).toBe('connecting')
    t.last().fire('CHANNEL_ERROR', { message: 'socket error' })
    expect(t.channel.status()).toBe('connecting')
    t.last().fire('SUBSCRIBED')
    t.last().fire('TIMED_OUT')
    expect(t.channel.status()).toBe('reconnecting')
    expect(t.statuses).toEqual(['live', 'reconnecting'])
  })

  it('drops an event that parse does not know, hands on the others', async () => {
    const t = join()
    await flush()
    t.last().send('ping', { n: 1 })
    t.last().send('unknown', {})
    t.last().send('pong', null)
    expect(t.events).toEqual([{ type: 'ping', n: 1 }, { type: 'pong' }])
  })

  it('unsubscribe clears the timer, removes the channel once and closes', async () => {
    const t = join()
    await flush()
    t.last().fire('SUBSCRIBED')
    await t.channel.unsubscribe()
    expect(t.channel.status()).toBe('closed')
    expect(t.last().removed).toBe(1)
    await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS * 2)
    expect(t.resyncs).toEqual([])
    await t.channel.unsubscribe()
    expect(t.last().removed).toBe(1)
  })

  it('does not join when unsubscribed while authorising', async () => {
    const t = join()
    await t.channel.unsubscribe()
    await flush()
    expect(t.channels).toHaveLength(0)
    await expect(t.channel.ready).resolves.toBe(false)
  })
})

describe('createLiveConnection', () => {
  type Handlers = Parameters<LiveEnv['listen']>[0]

  function connect() {
    const fake = fakeClient()
    let time = 1_000_000
    let onlineNow = true
    let page!: Handlers
    let listens = 0
    const opened: { id: string; channel: TopicChannel; handlers: TopicHandlers<Event> }[] = []
    const changes: string[] = []
    const connection = createLiveConnection<Event>({
      open: (id, handlers) => {
        const channel = subscribeTopic(fake.client, `room:${id}`, parse, handlers)
        opened.push({ id, channel, handlers })
        return channel
      },
      now: () => time,
      env: {
        isOnline: () => onlineNow,
        listen: (handlers) => {
          listens++
          page = handlers
        },
      },
      onChange: (s) => changes.push(`${s.memberId ?? '-'}:${s.status}:${s.online}`),
    })
    const seen: string[] = []
    const stopListening = [
      connection.on('ping', (e) => seen.push(`ping${e.n}`)),
      connection.on('resync', () => seen.push('resync')),
    ]
    return {
      ...fake,
      connection,
      opened,
      changes,
      seen,
      stopListening,
      page: () => page,
      listens: () => listens,
      advance: (ms: number) => {
        time += ms
        return vi.advanceTimersByTimeAsync(ms)
      },
      setOnline: (value: boolean) => {
        onlineNow = value
      },
    }
  }

  /** Starts for `id` and brings the channel live. */
  async function live(t: ReturnType<typeof connect>, id = 'a') {
    await t.connection.start(id)
    await flush()
    t.last().fire('SUBSCRIBED')
    await flush()
  }

  it('start joins once and says live; start again for the same id does nothing', async () => {
    const t = connect()
    await live(t)
    expect(t.connection.status).toBe('live')
    expect(t.connection.memberId).toBe('a')
    await t.connection.start('a')
    await flush()
    expect(t.channels).toHaveLength(1)
    expect(t.listens()).toBe(1)
  })

  it('hands the events on to the listeners of their type, and stops when told to', async () => {
    const t = connect()
    await live(t)
    t.last().send('ping', { n: 7 })
    t.stopListening[0]!()
    t.last().send('ping', { n: 8 })
    expect(t.seen).toEqual(['ping7'])
  })

  it('another id replaces the channel; the older channel\'s callbacks are ignored', async () => {
    const t = connect()
    await live(t, 'a')
    const old = t.last()
    await t.connection.start('b')
    await flush()
    expect(old.removed).toBe(1)
    expect(t.channels).toHaveLength(2)
    expect(t.connection.memberId).toBe('b')
    expect(t.connection.status).toBe('connecting')
    old.send('ping', { n: 1 })
    old.fire('SUBSCRIBED')
    expect(t.connection.status).toBe('connecting')
    expect(t.seen).toEqual([])
    t.last().fire('SUBSCRIBED')
    expect(t.connection.status).toBe('live')
    t.last().send('ping', { n: 2 })
    expect(t.seen).toEqual(['ping2'])
  })

  it('a start that was overtaken by another does not join', async () => {
    const t = connect()
    await live(t, 'a')
    const first = t.connection.start('b')
    const second = t.connection.start('c')
    await Promise.all([first, second])
    await flush()
    expect(t.opened.map((o) => o.id)).toEqual(['a', 'c'])
    expect(t.connection.memberId).toBe('c')
  })

  it('does not join when there is no client (open returns null) and keeps the generation', async () => {
    const t = connect()
    const idle = createLiveConnection<Event>({
      open: () => null,
      now: () => 0,
      env: { isOnline: () => true, listen: () => {} },
    })
    await idle.start('a')
    expect(idle.status).toBe('idle')
    expect(t.channels).toHaveLength(0)
  })

  it('online while the channel is not live replaces it once and says resync once it is live', async () => {
    const t = connect()
    await live(t)
    const old = t.last()
    old.fire('CLOSED')
    expect(t.connection.status).toBe('reconnecting')
    t.page().offline()
    expect(t.connection.online).toBe(false)
    t.page().online()
    expect(t.connection.online).toBe(true)
    await flush()
    expect(old.removed).toBe(1)
    expect(t.channels).toHaveLength(2)
    expect(t.seen).toEqual([])
    t.last().fire('SUBSCRIBED')
    await flush()
    expect(t.seen).toEqual(['resync'])
  })

  it('online and visible in the same tick make one revival', async () => {
    const t = connect()
    await live(t)
    t.last().fire('CLOSED')
    t.page().hidden()
    t.page().online()
    t.page().visible()
    await flush()
    expect(t.channels).toHaveLength(2)
    t.last().fire('SUBSCRIBED')
    await flush()
    expect(t.seen).toEqual(['resync'])
  })

  it('a revival that was overtaken by stop emits nothing', async () => {
    const t = connect()
    await live(t)
    t.last().fire('CLOSED')
    t.page().online()
    await t.connection.stop()
    await flush()
    t.last()?.fire('SUBSCRIBED')
    await flush()
    expect(t.seen).toEqual([])
  })

  it('visible after a glance away (2 s or less) while live does nothing, after more it reads again', async () => {
    const t = connect()
    await live(t)
    await t.advance(COLD_START_RESYNC_MS)
    t.seen.length = 0
    t.page().hidden()
    await t.advance(2_000)
    t.page().visible()
    await flush()
    expect(t.seen).toEqual([])
    t.page().hidden()
    await t.advance(2_001)
    t.page().visible()
    await flush()
    expect(t.seen).toEqual(['resync'])
    expect(t.channels).toHaveLength(1)
  })

  it('visible with a channel that is not live replaces it even after a glance', async () => {
    const t = connect()
    await live(t)
    t.last().fire('CHANNEL_ERROR', { message: 'socket' })
    t.page().hidden()
    t.page().visible()
    await flush()
    expect(t.channels).toHaveLength(2)
  })

  it('a revival followed by the new channel\'s cold start inside the skip window says resync only once', async () => {
    const t = connect()
    await live(t)
    await vi.advanceTimersByTimeAsync(COLD_START_RESYNC_MS)
    t.seen.length = 0
    t.last().fire('CLOSED')
    t.page().online()
    await flush()
    t.last().fire('SUBSCRIBED')
    await flush()
    expect(t.seen).toEqual(['resync'])
    await t.advance(COLD_START_RESYNC_MS + 1_000)
    expect(t.seen).toEqual(['resync'])
  })

  it('the cold start of a channel started long after a revival is read as usual', async () => {
    const t = connect()
    await live(t)
    t.last().fire('CLOSED')
    t.page().online()
    await flush()
    t.last().fire('SUBSCRIBED')
    await flush()
    await t.advance(COLD_START_RESYNC_MS + 2_000)
    t.seen.length = 0
    await t.connection.start('b')
    await flush()
    t.last().fire('SUBSCRIBED')
    await t.advance(COLD_START_RESYNC_MS)
    expect(t.seen).toEqual(['resync'])
  })

  it('stop says idle, closes the channel and ignores what comes after', async () => {
    const t = connect()
    await live(t)
    const channel = t.last()
    await t.connection.stop()
    expect(t.connection.status).toBe('idle')
    expect(t.connection.memberId).toBeNull()
    expect(channel.removed).toBe(1)
    channel.send('ping', { n: 1 })
    channel.fire('SUBSCRIBED')
    await t.advance(COLD_START_RESYNC_MS * 2)
    expect(t.seen).toEqual([])
    expect(t.connection.status).toBe('idle')
    // Back online with nobody signed in revives nothing.
    t.page().online()
    await flush()
    expect(t.channels).toHaveLength(1)
  })

  it('one listener that throws does not stop the others', async () => {
    const t = connect()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.connection.on('ping', () => {
      throw new Error('boom')
    })
    const later: number[] = []
    t.connection.on('ping', (e) => later.push(e.n))
    await live(t)
    t.last().send('ping', { n: 3 })
    expect(t.seen).toEqual(['ping3'])
    expect(later).toEqual([3])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('tells its owner what changed: member, status, online', async () => {
    const t = connect()
    await live(t)
    t.page().offline()
    expect(t.changes).toEqual(['a:idle:true', 'a:connecting:true', 'a:live:true', 'a:live:false'])
  })
})
