/**
 * The send queue's core: writes sent behind the member's back, so a tap never
 * waits on the network. Every write is a job; jobs are sent in order,
 * one at a time. A job that fails for want of a connection stays first in line
 * and is sent again after a growing pause (1 s, 2 s, 4 s … at most 30 s, or at
 * once on `kick()`, which the app calls when it is back online or hidden). A
 * job the server *refuses* leaves the line and is kept as a refusal, so the
 * screen can say why and lead her back; nothing is dropped without a word.
 *
 * Framework-free: the caller says how a job is sent (`run`), where the line is
 * kept (`storage`, localStorage in the app), and listens to `onChange`. The
 * line is written to storage after every change, so a closed or killed app
 * picks it up again where it was. A job must be safe to send twice (a message
 * carries its client id, a form write replaces what it touches).
 */

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type QueuedJob<P> = {
  id: string
  /** What the job writes; a newer job under the same key replaces one still waiting. */
  key: string
  payload: P
  /** Failed sends so far (connection, not refusals). */
  attempts: number
}

/**
 * How one send went. `retry`: try again later; otherwise a refusal with its
 * sentence. `giveUpAfter`: a failure that may not be the connection (the
 * server said something nobody explained) is tried that many times, then
 * handed back as a refusal rather than retried forever.
 */
export type JobOutcome =
  | { ok: true }
  | { ok: false; retry: true; error: string; giveUpAfter?: number }
  | { ok: false; retry: false; error: string; field: string | null }

/** How often a send that threw, or failed unexplained, is tried before it is handed back. */
export const UNEXPLAINED_ATTEMPTS = 5

export type Refusal<P> = { key: string; payload: P; error: string; field: string | null }

export type QueueStatus =
  /** Nothing to send. */
  | 'idle'
  /** A job is on its way. */
  | 'sending'
  /** The last send failed for want of a connection; the next try is scheduled. */
  | 'waiting'

export type QueueSnapshot<P> = {
  jobs: QueuedJob<P>[]
  /** Id of the job on its way, if one is. */
  inFlight: string | null
  status: QueueStatus
  /** Why the last send failed (the data layer's sentence), while `waiting`. */
  lastError: string | null
  /** When the next try is due (ms since epoch), while `waiting`. */
  retryAt: number | null
  refusals: Refusal<P>[]
}

/** What `drain()` came to: everything sent, or a send failed and is waiting to be tried again. */
export type DrainResult = 'empty' | 'waiting'

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type SaveQueueOptions<P> = {
  run: (payload: P, job: QueuedJob<P>) => Promise<JobOutcome>
  storage?: KeyValueStorage | null
  storageKey: string
  onChange?: (snapshot: QueueSnapshot<P>) => void
  /** A job went through. */
  onDone?: (job: QueuedJob<P>) => void
  /** A job was refused and left the line. */
  onRefused?: (refusal: Refusal<P>) => void
  /** The pause before try `attempt + 1`, after `attempt` failed sends. */
  backoff?: (attempt: number) => number
  timers?: Timers
  now?: () => number
}

export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 30_000

/** 1 s, 2 s, 4 s, 8 s, 16 s, then every 30 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS)
}

export type Stored<P> = { v: 1; jobs: QueuedJob<P>[]; refusals: Refusal<P>[] }

/** What a queue left in storage (nothing usable reads as an empty line). */
export function parseStoredQueue<P>(raw: string | null | undefined): Stored<P> {
  const empty: Stored<P> = { v: 1, jobs: [], refusals: [] }
  if (!raw) return empty
  try {
    const parsed = JSON.parse(raw) as Stored<P>
    if (parsed?.v !== 1 || !Array.isArray(parsed.jobs)) return empty
    return { v: 1, jobs: parsed.jobs, refusals: Array.isArray(parsed.refusals) ? parsed.refusals : [] }
  } catch {
    return empty
  }
}

function read<P>(storage: KeyValueStorage | null | undefined, key: string): Stored<P> {
  if (!storage) return parseStoredQueue<P>(null)
  try {
    return parseStoredQueue<P>(storage.getItem(key))
  } catch {
    return parseStoredQueue<P>(null)
  }
}

export function createSaveQueue<P>(options: SaveQueueOptions<P>) {
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const now = options.now ?? (() => Date.now())
  const backoff = options.backoff ?? backoffDelay

  const restored = read<P>(options.storage, options.storageKey)
  let jobs: QueuedJob<P>[] = restored.jobs.map((job) => ({ ...job }))
  let refusals: Refusal<P>[] = restored.refusals
  let inFlight: string | null = null
  let status: QueueStatus = 'idle'
  let lastError: string | null = null
  let retryAt: number | null = null
  let timer: unknown = null
  let running = false
  let counter = 0
  let drains: Array<(result: DrainResult) => void> = []

  function snapshot(): QueueSnapshot<P> {
    return {
      jobs: jobs.map((job) => ({ ...job })),
      inFlight,
      status,
      lastError,
      retryAt,
      refusals: [...refusals],
    }
  }

  function persist() {
    if (!options.storage) return
    try {
      if (jobs.length === 0 && refusals.length === 0) options.storage.removeItem(options.storageKey)
      else {
        const stored: Stored<P> = { v: 1, jobs, refusals }
        options.storage.setItem(options.storageKey, JSON.stringify(stored))
      }
    } catch {
      // Storage full or unavailable: the line still lives in memory and is
      // sent from there; only a killed app would lose it.
    }
  }

  function changed() {
    persist()
    options.onChange?.(snapshot())
  }

  function settleDrains(result: DrainResult) {
    const waiting = drains
    drains = []
    for (const resolve of waiting) resolve(result)
  }

  /** Stops waiting for the next try and sends now. */
  function kick() {
    if (timer) {
      timers.clearTimeout(timer)
      timer = null
      retryAt = null
    }
    void pump()
  }

  async function pump(): Promise<void> {
    if (!running || inFlight || timer) return
    const job = jobs[0]
    if (!job) {
      status = 'idle'
      lastError = null
      retryAt = null
      options.onChange?.(snapshot())
      settleDrains('empty')
      return
    }
    inFlight = job.id
    status = 'sending'
    options.onChange?.(snapshot())

    let outcome: JobOutcome
    try {
      outcome = await options.run(job.payload, job)
    } catch (error) {
      outcome = {
        ok: false,
        retry: true,
        error: String((error as Error)?.message ?? error),
        giveUpAfter: UNEXPLAINED_ATTEMPTS,
      }
    }
    inFlight = null
    if (!running) return

    const current = jobs.find((other) => other.id === job.id)
    if (!outcome.ok && outcome.retry && current && outcome.giveUpAfter != null) {
      if (current.attempts + 1 >= outcome.giveUpAfter) {
        outcome = { ok: false, retry: false, error: outcome.error, field: null }
      }
    }

    if (outcome.ok) {
      jobs = jobs.filter((other) => other.id !== job.id)
      lastError = null
      retryAt = null
      changed()
      options.onDone?.(job)
    } else if (outcome.retry) {
      if (current) current.attempts += 1
      const delay = backoff(current?.attempts ?? 1)
      status = 'waiting'
      lastError = outcome.error
      retryAt = now() + delay
      timer = timers.setTimeout(() => {
        timer = null
        retryAt = null
        void pump()
      }, delay)
      changed()
      settleDrains('waiting')
      return
    } else {
      jobs = jobs.filter((other) => other.id !== job.id)
      const refusal: Refusal<P> = {
        key: job.key,
        payload: job.payload,
        error: outcome.error,
        field: outcome.field,
      }
      refusals = [...refusals.filter((other) => other.key !== job.key), refusal]
      changed()
      options.onRefused?.(refusal)
    }
    void pump()
  }

  return {
    snapshot,

    /**
     * Puts a write in line. A job under the same key that has not left yet is
     * replaced where it stands; one already on its way is followed by this one.
     * A refusal under the key is forgotten: she has answered it.
     */
    enqueue(key: string, payload: P): QueuedJob<P> {
      refusals = refusals.filter((other) => other.key !== key)
      const waiting = jobs.find((job) => job.key === key && job.id !== inFlight)
      let job: QueuedJob<P>
      if (waiting) {
        waiting.payload = payload
        waiting.attempts = 0
        job = waiting
      } else {
        const id = [now(), counter++, Math.floor(Math.random() * 1e6)].map((n) => n.toString(36))
        job = { id: id.join('-'), key, payload, attempts: 0 }
        jobs = [...jobs, job]
      }
      changed()
      void pump()
      return { ...job }
    },

    /**
     * Takes over the line of a queue whose owner is gone (a closed tab, see
     * `queueOwnership.ts`). Its jobs go ahead of everything still waiting here
     * (they were written first), behind the one on its way; a job whose key is
     * already in line, or refused, here is the same write and is not taken
     * twice. Its refusals stay refusals. Returns how many jobs came in.
     */
    adopt(adopted: readonly QueuedJob<P>[], adoptedRefusals: readonly Refusal<P>[] = []): number {
      const known = new Set(jobs.map((job) => job.key))
      const fresh = adopted
        .filter((job) => !known.has(job.key))
        .map((job) => ({ ...job, attempts: 0 }))
      const sentNow = jobs.filter((job) => job.id === inFlight)
      const rest = jobs.filter((job) => job.id !== inFlight)
      jobs = [...sentNow, ...fresh, ...rest]
      const refusedKeys = new Set(refusals.map((refusal) => refusal.key))
      const refused = adoptedRefusals.filter(
        (refusal) => !refusedKeys.has(refusal.key) && !jobs.some((job) => job.key === refusal.key),
      )
      refusals = [...refusals, ...refused]
      if (fresh.length || refused.length) changed()
      void pump()
      return fresh.length
    },

    /** Takes a job that has not left yet out of line (true if there was one). */
    remove(key: string): boolean {
      const before = jobs.length
      jobs = jobs.filter((job) => job.key !== key || job.id === inFlight)
      if (jobs.length === before) return false
      changed()
      void pump()
      return true
    },

    /** Stops waiting for the next try and sends now (back online, app hidden). */
    kick,

    /**
     * Resolves once every job has gone (`empty`; refusals are kept in the
     * snapshot), or as soon as a send fails for want of a connection
     * (`waiting`; the queue goes on trying on its own). Sends at once.
     */
    drain(): Promise<DrainResult> {
      const done = new Promise<DrainResult>((resolve) => drains.push(resolve))
      if (!running) settleDrains('waiting')
      else if (jobs.length === 0 && !inFlight) settleDrains('empty')
      else kick()
      return done
    },

    dismissRefusal(key: string) {
      const before = refusals.length
      refusals = refusals.filter((other) => other.key !== key)
      if (refusals.length !== before) changed()
    },

    /** Starts sending (what was restored, and whatever comes). */
    start() {
      if (running) return
      running = true
      void pump()
    },

    /** Stops sending; the line stays in storage for the next start. */
    stop() {
      running = false
      if (timer) timers.clearTimeout(timer)
      timer = null
      retryAt = null
      status = 'idle'
      settleDrains('waiting')
    },

    /** Forgets the line and its refusals, in memory and in storage. */
    clear() {
      jobs = jobs.filter((job) => job.id === inFlight)
      refusals = []
      changed()
      void pump()
    },
  }
}

export type SaveQueue<P> = ReturnType<typeof createSaveQueue<P>>

// ---------------------------------------------------------------- tab ownership

/**
 * Which tab owns which send queue (the chat's: a message written offline is
 * kept in localStorage and goes out when the connection is back, even after a
 * reload or a killed PWA).
 *
 * The problem: every tab of one member used to read and write the same
 * localStorage key. Each tab keeps its line in memory and writes the *whole*
 * line on every change, so two tabs overwrote each other and a message queued
 * offline in one could vanish with the next write of the other.
 *
 * The design: **one key per tab**, `<prefix>.<tab id>`. A tab only ever writes
 * its own key, so nothing is overwritten. What a tab queued must still outlive
 * the tab (a reload, a closed tab, an iOS app kill), so a key is not tied to
 * the tab's lifetime but to a **Web Lock** with the key's name, held for as
 * long as the page lives (`navigator.locks`, released by the browser when the
 * page goes, however it goes):
 *
 * - **Claim.** The tab id is kept in `sessionStorage`, which survives a reload
 *   of the tab, so a reloaded tab asks for its own old key and finds its line
 *   again. If the lock is not free (a duplicated tab copies `sessionStorage`,
 *   or the old page is still unloading) it takes a fresh id instead.
 * - **Orphans.** A key nobody holds the lock of belongs to a page that is
 *   gone: its owner was closed or killed with messages still waiting. Any tab
 *   of the same member can take it over: it requests the key's lock with
 *   `ifAvailable` (so only one tab wins, and a live owner is never touched),
 *   hands the stored line to its own queue (`adopt`), deletes the key, and lets
 *   the lock go. The queue's own key is written (inside `adopt`) before the
 *   orphan's is removed, so a crash in between sends a message twice at worst;
 *   every message carries a client id, and the server stores one row per client
 *   id, so twice is harmless.
 * - **The old single key** (`<prefix>` itself, from before this change) is
 *   nobody's, so it is adopted the same way.
 * - **No Web Locks** (an old browser, a page that is not a secure context):
 *   `claimQueue` is not used and the caller falls back to the single shared
 *   key, as before. Nothing is lost that was not lost before.
 *
 * Framework-free: the lock manager, the storage and the id source are passed
 * in, so `tests/queue-ownership.test.ts` drives it with fakes.
 */

/** The part of `navigator.locks` this needs. */
export type LockManagerLike = {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>
}

/** `localStorage`, with the ability to list its keys. */
export type ScanStorage = KeyValueStorage & {
  readonly length: number
  key(index: number): string | null
}

export type ClaimOptions = {
  storage: ScanStorage
  locks: LockManagerLike
  /** Per tab, survives its reloads: `sessionStorage`. Without it every page load is a new tab. */
  tabStorage?: KeyValueStorage | null
  /** An app's own storage key for the queue of one member (`app.queue.<member id>`); the tab's key is `<prefix>.<tab id>`. */
  prefix: string
  /** Where the tab's id is remembered in `tabStorage`. Default: `TAB_ID_STORAGE_KEY`. */
  tabIdKey?: string
  newId?: () => string
}

export type TabQueue = {
  /** The localStorage key this tab (and only this tab) writes its line to. */
  key: string
  /**
   * Takes over the line of every queue of this member whose page is gone.
   * `adopt` gets the stored text; it must have made it its own (persisted)
   * before it returns, as the orphan's key is removed right after.
   * Resolves to how many queues were taken over.
   */
  adoptOrphans(adopt: (raw: string, orphanKey: string) => void | Promise<void>): Promise<number>
  /** Lets the lock go (signing out); the key, if it holds a line, becomes an orphan. */
  release(): void
}

/** Where a tab remembers its id in `tabStorage` (the app may name its own: `ClaimOptions.tabIdKey`). */
export const TAB_ID_STORAGE_KEY = 'chat.queue.tabId'

const randomId = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 6).toString(36)}`

/**
 * Tries to take the lock called `name` without waiting. Resolves to the
 * function that gives it back, or null if somebody else holds it. The lock is
 * held by a callback that does not return until `release()` is called.
 */
export function tryHold(locks: LockManagerLike, name: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    locks
      .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null)
          return undefined
        }
        return new Promise<void>((release) => resolve(() => release()))
      })
      .catch(() => resolve(null))
  })
}

/** Gives this tab a key of its own and the lock that says "this page is alive". */
export async function claimQueue(options: ClaimOptions): Promise<TabQueue> {
  const { storage, locks, prefix } = options
  const newId = options.newId ?? randomId

  let key = ''
  let release: (() => void) | null = null
  const tabIdKey = options.tabIdKey ?? TAB_ID_STORAGE_KEY
  const remembered = options.tabStorage?.getItem(tabIdKey) ?? null
  for (let attempt = 0; attempt < 5 && !release; attempt++) {
    const id = attempt === 0 && remembered ? remembered : newId()
    key = `${prefix}.${id}`
    release = await tryHold(locks, key)
    if (release) options.tabStorage?.setItem(tabIdKey, id)
  }
  if (!release) throw new Error('No send queue of its own could be claimed')
  let held: (() => void) | null = release

  let sweeping: Promise<number> | null = null

  function orphanCandidates(): string[] {
    const found: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const other = storage.key(index)
      if (other === null || other === key) continue
      if (other === prefix || other.startsWith(`${prefix}.`)) found.push(other)
    }
    return found
  }

  async function sweep(adopt: (raw: string, orphanKey: string) => void | Promise<void>) {
    let taken = 0
    for (const orphan of orphanCandidates()) {
      const giveBack = await tryHold(locks, orphan)
      if (!giveBack) continue // its page is alive, or another tab is taking it over right now
      try {
        const raw = storage.getItem(orphan)
        if (raw !== null) {
          await adopt(raw, orphan)
          storage.removeItem(orphan)
          taken++
        }
      } finally {
        giveBack()
      }
    }
    return taken
  }

  return {
    key,
    adoptOrphans(adopt) {
      // One sweep at a time per tab; a second call joins the one under way.
      sweeping ??= sweep(adopt).finally(() => (sweeping = null))
      return sweeping
    },
    release() {
      held?.()
      held = null
    },
  }
}
