/**
 * The chat's live channel, the mechanics only: join one private Broadcast topic, track its status, read again
 * after a rejoin and once shortly after the first join, and replace a dead socket after the page was suspended
 * (a phone's installed web app) or the device was offline. Framework-free TypeScript: the app hands in its
 * realtime client as a small structural type (`RealtimeLike`) and decides what an event is (`parse`) and what a
 * `resync` reads. Written to be shared: the app only injects the client and adapts the events.
 */

// -------------------------------------------------------------------- types

/**
 * - `connecting`: joining for the first time.
 * - `live`: joined; events arrive.
 * - `reconnecting`: the connection dropped; the client rejoins by itself. When it is `live` again, `onResync`
 *   fires: read what was missed.
 * - `refused`: the database would not let it join (not signed in, or not its topic). Nothing is retried; subscribe
 *   again after signing in.
 * - `closed`: unsubscribed.
 */
export type ChannelStatus = 'connecting' | 'live' | 'reconnecting' | 'refused' | 'closed'

/** How long after the first join the cold-start catch-up fires. */
export const COLD_START_RESYNC_MS = 3_000

/** What a glance away from the page may last before coming back is worth reading again (ms). */
export const GLANCE_AWAY_MS = 2_000

/** One broadcast as the client hands it over. */
export type BroadcastMessage = { event: string; payload: unknown }

/** The part of a realtime channel this file uses. */
export interface ChannelLike {
  on(type: 'broadcast', filter: { event: string }, callback: (message: BroadcastMessage) => void): ChannelLike
  subscribe(callback: (state: string, error?: { message?: string }) => void): ChannelLike
}

/** The part of a realtime client this file uses (the app adapts its own client to it). */
export interface RealtimeLike {
  setAuth(): PromiseLike<unknown>
  channel(topic: string, opts: { config: { private: boolean } }): ChannelLike
  removeChannel(channel: ChannelLike): PromiseLike<unknown>
}

export type TopicHandlers<E> = {
  onEvent: (event: E) => void
  onStatus?: (status: ChannelStatus) => void
  /**
   * Read from the tables what may have been missed: fires when the channel is live again after a drop, and once
   * `COLD_START_RESYNC_MS` after the first join (a realtime server that was idle starts streaming the database's
   * broadcasts a moment after the join; what was written in that moment only the tables have). `reason` says
   * which: `rejoin` or `coldStart`.
   */
  onResync?: (reason: 'rejoin' | 'coldStart') => void
}

export type TopicChannel = {
  /** Resolves true once live, false if refused (never rejects). */
  ready: Promise<boolean>
  status: () => ChannelStatus
  unsubscribe: () => Promise<void>
}

// ---------------------------------------------------------------- subscribe

/**
 * Joins one private topic. `parse` turns a broadcast into the app's event (null: not one it knows, dropped).
 */
export function subscribeTopic<E>(
  client: RealtimeLike,
  topic: string,
  parse: (event: string, payload: unknown) => E | null,
  { onEvent, onStatus, onResync }: TopicHandlers<E>,
): TopicChannel {
  let status: ChannelStatus = 'connecting'
  let wasLive = false
  let channel: ChannelLike | null = null
  let coldStart: ReturnType<typeof setTimeout> | null = null
  let settle: (live: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve
  })

  const set = (next: ChannelStatus) => {
    if (next === status) return
    status = next
    onStatus?.(next)
  }

  const start = async () => {
    // Private channels are authorised with the member's access token; the client keeps it current on refresh,
    // this makes sure the first join has it.
    await client.setAuth()
    if (status === 'closed') return
    channel = client.channel(topic, { config: { private: true } })
    channel.on('broadcast', { event: '*' }, (message) => {
      const event = parse(message.event, message.payload)
      if (event) onEvent(event)
    })
    channel.subscribe((state, error) => {
      if (status === 'closed' || status === 'refused') return
      if (state === 'SUBSCRIBED') {
        set('live')
        if (wasLive) {
          onResync?.('rejoin')
        } else {
          coldStart = setTimeout(() => {
            coldStart = null
            if (status === 'live') onResync?.('coldStart')
          }, COLD_START_RESYNC_MS)
        }
        wasLive = true
        settle(true)
      } else if (state === 'CHANNEL_ERROR' && /unauthori[sz]ed|permission/i.test(error?.message ?? '')) {
        // The database said no: retrying will not change that.
        set('refused')
        settle(false)
        const refused = channel
        channel = null
        if (refused) void client.removeChannel(refused)
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
        set(wasLive ? 'reconnecting' : 'connecting')
      } else if (state === 'CLOSED') {
        // Closed by the server or the socket; the client rejoins.
        set(wasLive ? 'reconnecting' : 'connecting')
      }
    })
  }

  void start().catch(() => {
    set('refused')
    settle(false)
  })

  return {
    ready,
    status: () => status,
    async unsubscribe() {
      set('closed')
      settle(false)
      if (coldStart) clearTimeout(coldStart)
      coldStart = null
      const current = channel
      channel = null
      if (current) await client.removeChannel(current)
    },
  }
}

// ------------------------------------------------------------------ emitter

/** The pseudo-event that says: something may have been missed, read what is on screen again. */
export type ResyncEvent = { type: 'resync' }

/** A typed emitter: `on` returns the function that stops listening; one listener throwing does not stop the others. */
export function createEmitter<Ev extends { type: string }>() {
  const handlers = new Map<string, Set<(event: never) => void>>()

  function emit(event: Ev) {
    for (const handler of handlers.get(event.type) ?? []) {
      try {
        ;(handler as (event: Ev) => void)(event)
      } catch (error) {
        // One listener failing must not keep the event from the others.
        console.error(error)
      }
    }
  }

  function on<K extends Ev['type']>(type: K, handler: (event: Extract<Ev, { type: K }>) => void): () => void {
    let set = handlers.get(type)
    if (!set) handlers.set(type, (set = new Set()))
    set.add(handler as (event: never) => void)
    return () => set.delete(handler as (event: never) => void)
  }

  return { emit, on }
}

// --------------------------------------------------------------- connection

/** `idle`: nobody signed in (or not started yet); otherwise the channel's own status. */
export type LiveStatus = 'idle' | ChannelStatus

export type LiveState = { status: LiveStatus; memberId: string | null; online: boolean }

/** What the page offers: the device's network word and its lifecycle events. */
export interface LiveEnv {
  isOnline(): boolean
  /** Registers the page's events once; the connection never unregisters them. */
  listen(handlers: { online(): void; offline(): void; hidden(): void; visible(): void }): void
}

export type LiveConnectionOptions<E extends { type: string }> = {
  /** Joins the topic of `id` with these handlers; null when nothing can be joined (no client). */
  open: (id: string, handlers: TopicHandlers<E>) => TopicChannel | null
  now: () => number
  env: LiveEnv
  /** Called whenever `status`, `memberId` or `online` changes (an app mirrors them into its own state). */
  onChange?: (state: LiveState) => void
}

/**
 * One live channel per signed-in device, and its upkeep: a `generation` guard so an older channel's callbacks are
 * ignored, one leave before the next join, and the revival on coming back online or back from the background.
 * The usual realtime client hands back the same channel for the same topic while the old one is still there, so a
 * new join waits for the leave.
 *
 * Back online, or back from the background: a channel that is not live is replaced, and once it is live everybody
 * reads what they may have missed (`resync`). A suspended phone's page may sit on a dead socket that still says
 * `live`: so a return after more than `GLANCE_AWAY_MS` reads again either way.
 */
export function createLiveConnection<E extends { type: string }>(options: LiveConnectionOptions<E>) {
  const { env, now } = options
  const emitter = createEmitter<E | ResyncEvent>()

  const state: LiveState = { status: 'idle', memberId: null, online: env.isOnline() }
  const patch = (next: Partial<LiveState>) => {
    const changed = (Object.keys(next) as (keyof LiveState)[]).some((key) => state[key] !== next[key])
    if (!changed) return
    Object.assign(state, next)
    options.onChange?.({ ...state })
  }

  let channel: TopicChannel | null = null
  /** A newer start or stop makes an older channel's callbacks stale. */
  let generation = 0

  function open(id: string) {
    const mine = ++generation
    const next = options.open(id, {
      onEvent: (event) => {
        if (mine === generation) emitter.emit(event)
      },
      onStatus: (status) => {
        if (mine === generation) patch({ status })
      },
      onResync: (reason) => {
        if (mine !== generation) return
        // A channel replaced on a return to the foreground was read for right away (`revive`); its cold start
        // would read everything a second time three seconds later (the database's load).
        if (reason === 'coldStart' && revivedAt !== null && now() - revivedAt < COLD_START_RESYNC_MS + 2_000) return
        emitter.emit({ type: 'resync' })
      },
    })
    if (!next) {
      generation = mine - 1
      return null
    }
    channel = next
    patch({ memberId: id, status: 'connecting' })
    return next
  }

  /**
   * Leaves the current channel and resolves once it is gone: the client hands back the same channel for the same
   * topic while the old one is still there, so a new join waits for the leave.
   */
  function close() {
    generation++
    const current = channel
    channel = null
    return current ? current.unsubscribe().catch(() => {}) : Promise.resolve()
  }

  /** Joins `id`'s channel (harmless when it is already hers and alive). */
  async function start(id: string) {
    listen()
    if (state.memberId === id && channel && state.status !== 'refused' && state.status !== 'closed') return
    patch({ memberId: id })
    const mine = generation + 1
    await close()
    // Signed out or somebody else in the meantime.
    if (generation !== mine || state.memberId !== id) return
    open(id)
  }

  /** Leaves the channel: sign-out, or somebody else signing in. */
  async function stop() {
    patch({ memberId: null, status: 'idle' })
    await close()
  }

  let reviving = false
  /** When `revive` last read for a fresh channel: that channel's cold-start resync is then not needed. */
  let revivedAt: number | null = null
  /** `online` and the page becoming visible often come together: one revival at a time. */
  async function revive() {
    const id = state.memberId
    if (!id || reviving) return
    if (state.status === 'live') {
      emitter.emit({ type: 'resync' })
      return
    }
    reviving = true
    try {
      const mine = generation + 1
      await close()
      if (generation !== mine || state.memberId !== id) return
      const fresh = open(id)
      if (fresh && (await fresh.ready) && channel === fresh) {
        revivedAt = now()
        emitter.emit({ type: 'resync' })
      }
    } finally {
      reviving = false
    }
  }

  let listening = false
  let hiddenAt: number | null = null
  function listen() {
    if (listening) return
    listening = true
    env.listen({
      online: () => {
        patch({ online: true })
        void revive()
      },
      offline: () => patch({ online: false }),
      hidden: () => {
        hiddenAt = now()
      },
      visible: () => {
        // A glance away (a notification pulled down) changes nothing worth a reload.
        const away = hiddenAt === null ? 0 : now() - hiddenAt
        hiddenAt = null
        if (away > GLANCE_AWAY_MS || state.status !== 'live') void revive()
      },
    })
  }

  return {
    on: emitter.on,
    start,
    stop,
    /** Whose channel this is. */
    get memberId() {
      return state.memberId
    },
    get status() {
      return state.status
    },
    get online() {
      return state.online
    },
  }
}

export type LiveConnection<E extends { type: string }> = ReturnType<typeof createLiveConnection<E>>
