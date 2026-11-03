import { describe, expect, it } from 'vitest'
import {
  claimQueue,
  createSaveQueue,
  parseStoredQueue,
  TAB_ID_STORAGE_KEY,
  type JobOutcome,
  type LockManagerLike,
  type QueuedJob,
  type ScanStorage,
} from '../app/utils/queue'

/**
 * Whose send queue is whose (`app/utils/queue.ts`): one localStorage key
 * per tab, held by a Web Lock while the page lives, and the line of a closed
 * tab taken over by one that is still open. Pure logic: the lock manager and
 * the storages are fakes, and "a page dies" is the tab letting its lock go,
 * which is what the browser does.
 */

/** `navigator.locks`, enough of it: exclusive locks that `ifAvailable` asks for. */
function fakeLocks(): LockManagerLike & { held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    async request(name, options, callback) {
      if (held.has(name)) {
        if (options.ifAvailable) return await callback(null)
        throw new Error('waiting for a lock is not needed here')
      }
      held.add(name)
      try {
        return await callback({ name })
      } finally {
        held.delete(name)
      }
    },
  }
}

/** localStorage as a Map that can list its keys. */
function memoryStorage(): ScanStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

/** sessionStorage: a Map per tab. */
const tabStorage = (id?: string) => {
  const data = new Map<string, string>(id ? [[TAB_ID_STORAGE_KEY, id]] : [])
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const PREFIX = 'app.chatQueue.ida'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The page goes away: the browser lets its lock go (a moment later, as it does). */
async function die(tab: { release(): void }) {
  tab.release()
  await flush()
}

function ids() {
  let n = 0
  return () => `t${++n}`
}

describe('claiming a queue key', () => {
  it('gives every tab a key of its own', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const newId = ids()
    const a = await claimQueue({ storage, locks, tabStorage: tabStorage(), prefix: PREFIX, newId })
    const b = await claimQueue({ storage, locks, tabStorage: tabStorage(), prefix: PREFIX, newId })
    expect(a.key).toBe(`${PREFIX}.t1`)
    expect(b.key).toBe(`${PREFIX}.t2`)
  })

  it('gives a reloaded tab its old key back', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const session = tabStorage()
    const before = await claimQueue({ storage, locks, tabStorage: session, prefix: PREFIX, newId: ids() })
    await die(before)
    const after = await claimQueue({ storage, locks, tabStorage: session, prefix: PREFIX, newId: ids() })
    expect(after.key).toBe(before.key)
  })

  it('does not share a key with a duplicated tab, whose sessionStorage was copied', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const original = tabStorage()
    const first = await claimQueue({ storage, locks, tabStorage: original, prefix: PREFIX, newId: ids() })
    const copy = tabStorage(original.getItem(TAB_ID_STORAGE_KEY)!)
    const second = await claimQueue({ storage, locks, tabStorage: copy, prefix: PREFIX, newId: () => 'fresh' })
    expect(first.key).toBe(`${PREFIX}.t1`)
    expect(second.key).toBe(`${PREFIX}.fresh`)
    expect(copy.getItem(TAB_ID_STORAGE_KEY)).toBe('fresh')
  })
})

describe('taking over the queue of a tab that is gone', () => {
  async function twoTabs() {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const newId = ids()
    const a = await claimQueue({ storage, locks, tabStorage: tabStorage(), prefix: PREFIX, newId })
    const b = await claimQueue({ storage, locks, tabStorage: tabStorage(), prefix: PREFIX, newId })
    return { storage, locks, a, b }
  }

  it('leaves the queue of a tab that is still open alone', async () => {
    const { storage, a, b } = await twoTabs()
    storage.setItem(a.key, '{"v":1,"jobs":[],"refusals":[]}')
    const taken: string[] = []
    expect(await b.adoptOrphans((raw) => void taken.push(raw))).toBe(0)
    expect(taken).toEqual([])
    expect(storage.getItem(a.key)).not.toBeNull()
  })

  it('hands a closed tab’s line to the open one and removes the key', async () => {
    const { storage, a, b } = await twoTabs()
    storage.setItem(a.key, 'A’s line')
    storage.setItem(b.key, 'B’s line')
    await die(a)
    const taken: Array<[string, string]> = []
    expect(await b.adoptOrphans((raw, key) => void taken.push([raw, key]))).toBe(1)
    expect(taken).toEqual([['A’s line', a.key]])
    expect(storage.getItem(a.key)).toBeNull()
    expect(storage.getItem(b.key)).toBe('B’s line') // never touches its own
    expect(await b.adoptOrphans(() => void taken.push(['again', '']))).toBe(0)
  })

  it('lets exactly one of two open tabs take it', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const newId = ids()
    const [a, b, c] = await Promise.all(
      [0, 1, 2].map(() => claimQueue({ storage, locks, tabStorage: tabStorage(), prefix: PREFIX, newId })),
    )
    storage.setItem(a!.key, 'line')
    await die(a!)
    const takenBy: string[] = []
    const results = await Promise.all([
      b!.adoptOrphans(async () => {
        await Promise.resolve()
        takenBy.push('b')
      }),
      c!.adoptOrphans(async () => {
        await Promise.resolve()
        takenBy.push('c')
      }),
    ])
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(takenBy).toHaveLength(1)
    expect(storage.getItem(a!.key)).toBeNull()
  })

  it('keeps the key when taking it over fails, for the next try', async () => {
    const { storage, a, b } = await twoTabs()
    storage.setItem(a.key, 'line')
    await die(a)
    await expect(
      b.adoptOrphans(() => {
        throw new Error('storage full')
      }),
    ).rejects.toThrow('storage full')
    expect(storage.getItem(a.key)).toBe('line')
    expect(await b.adoptOrphans(() => undefined)).toBe(1)
    expect(storage.getItem(a.key)).toBeNull()
  })

  it('takes over the single key from before, and only this member’s keys', async () => {
    const { storage, b } = await twoTabs()
    storage.setItem(PREFIX, 'old single key')
    storage.setItem('app.chatQueue.ida2.x', 'a member whose id starts the same')
    storage.setItem('app.chatQueue.lena.x', 'another member')
    storage.setItem('app.saveQueue.ida', 'a different queue\u2019s')
    const taken: string[] = []
    expect(await b.adoptOrphans((raw) => void taken.push(raw))).toBe(1)
    expect(taken).toEqual(['old single key'])
    expect(storage.getItem('app.chatQueue.ida2.x')).not.toBeNull()
    expect(storage.getItem('app.chatQueue.lena.x')).not.toBeNull()
    expect(storage.getItem('app.saveQueue.ida')).not.toBeNull()
  })

  it('leaves a released claim’s line to the others (signing out)', async () => {
    const { storage, a, b } = await twoTabs()
    storage.setItem(b.key, 'line')
    await die(b)
    expect(await a.adoptOrphans(() => undefined)).toBe(1)
  })
})

// ------------------------------------------------- the queues that sit on top

type Msg = { text: string }
const OFFLINE: JobOutcome = { ok: false, retry: true, error: 'No connection.' }

/** A tab: a claimed key, a send queue on it, and what that queue sent. */
async function tab(storage: ScanStorage, locks: LockManagerLike, newId: () => string, online = false) {
  const sent: string[] = []
  let connected = online
  const claim = await claimQueue({ storage, locks, tabStorage: tabStorage(), prefix: PREFIX, newId })
  const queue = createSaveQueue<Msg>({
    storage,
    storageKey: claim.key,
    run: async (payload) => {
      if (!connected) return OFFLINE
      sent.push(payload.text)
      return { ok: true }
    },
    backoff: () => 60_000,
  })
  queue.start()
  return {
    claim,
    queue,
    sent,
    connect() {
      connected = true
      queue.kick()
    },
    async sweep() {
      return await claim.adoptOrphans((raw) => {
        const stored = parseStoredQueue<Msg>(raw)
        queue.adopt(stored.jobs, stored.refusals)
      })
    },
  }
}

describe('two tabs of one member queueing offline', () => {
  it('each keeps its own messages: neither overwrites the other', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const newId = ids()
    const a = await tab(storage, locks, newId)
    const b = await tab(storage, locks, newId)
    a.queue.enqueue('m1', { text: 'from A, first' })
    b.queue.enqueue('m2', { text: 'from B' })
    a.queue.enqueue('m3', { text: 'from A, second' })
    await flush()

    const stored = (key: string) => parseStoredQueue<Msg>(storage.getItem(key)).jobs.map((j) => j.payload.text)
    expect(stored(a.claim.key)).toEqual(['from A, first', 'from A, second'])
    expect(stored(b.claim.key)).toEqual(['from B'])

    a.connect()
    b.connect()
    await flush()
    expect([...a.sent, ...b.sent].sort()).toEqual(['from A, first', 'from A, second', 'from B'])
    expect(storage.data.size).toBe(0)
  })

  it('a message queued in a tab that was then closed is sent by the one still open', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const newId = ids()
    const a = await tab(storage, locks, newId)
    const b = await tab(storage, locks, newId)
    a.queue.enqueue('m1', { text: 'queued in A, which is closed now' })
    b.queue.enqueue('m2', { text: 'queued in B' })
    await flush()

    a.queue.stop()
    await die(a.claim) // A's page is gone
    expect(await b.sweep()).toBe(1)
    expect(b.queue.snapshot().jobs.map((j) => j.payload.text)).toEqual([
      'queued in A, which is closed now',
      'queued in B',
    ])

    b.connect()
    await flush()
    expect(b.sent).toEqual(['queued in A, which is closed now', 'queued in B'])
    expect(storage.data.size).toBe(0)
  })

  it('a reload picks up its own line again', async () => {
    const storage = memoryStorage()
    const locks = fakeLocks()
    const session = tabStorage()
    const before = await claimQueue({ storage, locks, tabStorage: session, prefix: PREFIX, newId: ids() })
    const first = createSaveQueue<Msg>({
      storage,
      storageKey: before.key,
      run: async () => OFFLINE,
      backoff: () => 60_000,
    })
    first.start()
    first.enqueue('m1', { text: 'before the reload' })
    first.stop()
    await die(before)

    const after = await claimQueue({ storage, locks, tabStorage: session, prefix: PREFIX, newId: ids() })
    const sent: string[] = []
    const second = createSaveQueue<Msg>({
      storage,
      storageKey: after.key,
      run: async (payload) => (sent.push(payload.text), { ok: true }),
    })
    second.start()
    await flush()
    expect(after.key).toBe(before.key)
    expect(sent).toEqual(['before the reload'])
  })
})

describe('adopting a line (SaveQueue.adopt)', () => {
  const job = (key: string, text: string): QueuedJob<Msg> => ({
    id: `id-${key}`,
    key,
    payload: { text },
    attempts: 3,
  })

  it('puts the adopted jobs ahead of the waiting ones, fresh, and never twice', async () => {
    const storage = memoryStorage()
    const queue = createSaveQueue<Msg>({
      storage,
      storageKey: 'k',
      run: async () => OFFLINE,
      backoff: () => 60_000,
    })
    queue.enqueue('own', { text: 'own' })
    expect(queue.adopt([job('a', 'a'), job('own', 'own, again'), job('b', 'b')])).toBe(2)
    const jobs = queue.snapshot().jobs
    expect(jobs.map((j) => j.key)).toEqual(['a', 'b', 'own'])
    expect(jobs.find((j) => j.key === 'a')?.attempts).toBe(0)
    expect(jobs.find((j) => j.key === 'own')?.payload.text).toBe('own')
    // Persisted with the adoption, before the orphan's key goes.
    expect(parseStoredQueue<Msg>(storage.getItem('k')).jobs).toHaveLength(3)
  })

  it('keeps the adopted refusals, so the bubble still says why', () => {
    const queue = createSaveQueue<Msg>({ run: async () => ({ ok: true }) })
    queue.adopt([], [{ key: 'r', payload: { text: 'refused' }, error: 'No.', field: null }])
    expect(queue.snapshot().refusals.map((r) => r.key)).toEqual(['r'])
  })
})

describe('the tab key', () => {
  it('has its own default, for an app that names none', async () => {
    const tab = tabStorage()
    const claimed = await claimQueue({ storage: memoryStorage(), locks: fakeLocks(), tabStorage: tab, prefix: 'app.queue.m1', newId: () => 'tab9' })
    expect(tab.data.get(TAB_ID_STORAGE_KEY)).toBe('tab9')
    claimed.release()
  })
})
