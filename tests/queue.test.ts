import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffDelay,
  createSaveQueue,
  type JobOutcome,
  type KeyValueStorage,
} from '../app/utils/queue'

/**
 * The send queue (`app/utils/queue.ts`): in order, one at a
 * time, again after a pause when there is no connection, kept across a
 * reload, and a refusal handed back instead of dropped. Pure logic: the
 * sends are stand-ins, the clock is Vitest's.
 */

type Job = { name: string }

/** localStorage as a Map, shared between two queues like two page loads. */
function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

const OK: JobOutcome = { ok: true }
const OFFLINE: JobOutcome = {
  ok: false,
  retry: true,
  error: 'No connection. Please try again when you are back online.',
}

/** A send that waits for the test to answer it, remembering what it was given. */
function controlledRun() {
  const sent: string[] = []
  const pending: Array<(outcome: JobOutcome) => void> = []
  let open = 0
  let mostOpen = 0
  const run = (payload: Job) => {
    sent.push(payload.name)
    open += 1
    mostOpen = Math.max(mostOpen, open)
    return new Promise<JobOutcome>((resolve) =>
      pending.push((outcome) => {
        open -= 1
        resolve(outcome)
      }),
    )
  }
  return {
    run,
    sent,
    mostOpen: () => mostOpen,
    /** Answers the oldest open send. */
    async answer(outcome: JobOutcome = OK) {
      pending.shift()!(outcome)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the save queue', () => {
  it('sends in the order she went, one at a time', async () => {
    const sends = controlledRun()
    const queue = createSaveQueue<Job>({ run: sends.run, storageKey: 'q' })
    queue.start()
    queue.enqueue('write:about', { name: 'about' })
    queue.enqueue('pass:about', { name: 'pass about' })
    queue.enqueue('write:top', { name: 'top' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sends.sent).toEqual(['about'])
    await sends.answer()
    await sends.answer()
    await sends.answer()
    expect(sends.sent).toEqual(['about', 'pass about', 'top'])
    expect(sends.mostOpen()).toBe(1)
    expect(queue.snapshot()).toMatchObject({ jobs: [], status: 'idle' })
  })

  it('replaces a waiting write of the same step where it stands, and follows one already sent', async () => {
    const sends = controlledRun()
    const queue = createSaveQueue<Job>({ run: sends.run, storageKey: 'q' })
    queue.start()
    queue.enqueue('write:about', { name: 'about 1' })
    queue.enqueue('write:top', { name: 'top 1' })
    queue.enqueue('write:bio', { name: 'bio 1' })
    // `about 1` is on its way; `top 1` still waits.
    queue.enqueue('write:top', { name: 'top 2' })
    queue.enqueue('write:about', { name: 'about 2' })
    expect(queue.snapshot().jobs.map((job) => job.payload.name)).toEqual([
      'about 1',
      'top 2',
      'bio 1',
      'about 2',
    ])
    for (let i = 0; i < 4; i++) await sends.answer()
    expect(sends.sent).toEqual(['about 1', 'top 2', 'bio 1', 'about 2'])
  })

  it('tries again after 1 s, 2 s, 4 s … at most 30 s, and at once when kicked', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(backoffDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])

    const sends = controlledRun()
    const changes: string[] = []
    const queue = createSaveQueue<Job>({
      run: sends.run,
      storageKey: 'q',
      onChange: (s) => changes.push(s.status),
    })
    queue.start()
    queue.enqueue('write:about', { name: 'about' })
    queue.enqueue('pass:about', { name: 'pass' })
    await vi.advanceTimersByTimeAsync(0)

    await sends.answer(OFFLINE)
    expect(queue.snapshot()).toMatchObject({
      status: 'waiting',
      lastError: OFFLINE.ok ? null : OFFLINE.error,
    })
    expect(queue.snapshot().jobs[0]).toMatchObject({ key: 'write:about', attempts: 1 })
    await vi.advanceTimersByTimeAsync(999)
    expect(sends.sent).toEqual(['about'])
    await vi.advanceTimersByTimeAsync(1)
    expect(sends.sent).toEqual(['about', 'about'])

    await sends.answer(OFFLINE)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sends.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sends.sent).toHaveLength(3)

    // Back online: no need to sit out the next 4 s.
    await sends.answer(OFFLINE)
    queue.kick()
    await vi.advanceTimersByTimeAsync(0)
    expect(sends.sent).toEqual(['about', 'about', 'about', 'about'])
    await sends.answer()
    await sends.answer()
    expect(sends.sent).toEqual(['about', 'about', 'about', 'about', 'pass'])
    expect(queue.snapshot()).toMatchObject({ jobs: [], status: 'idle', lastError: null })
    expect(changes).toContain('waiting')
  })

  it('keeps the line across a reload and sends it in order afterwards', async () => {
    const storage = memoryStorage()
    // First page load: offline the whole time, then the app is killed.
    const offline = createSaveQueue<Job>({
      run: async () => OFFLINE,
      storage,
      storageKey: 'app.saveQueue.ida',
    })
    offline.start()
    offline.enqueue('write:about', { name: 'about' })
    offline.enqueue('pass:about', { name: 'pass about' })
    offline.enqueue('write:weekends-genre', { name: 'weekends' })
    await vi.advanceTimersByTimeAsync(0)
    offline.stop()
    expect(storage.data.has('app.saveQueue.ida')).toBe(true)

    // Second page load, online.
    const sends = controlledRun()
    const reloaded = createSaveQueue<Job>({
      run: sends.run,
      storage,
      storageKey: 'app.saveQueue.ida',
    })
    expect(reloaded.snapshot().jobs.map((job) => job.key)).toEqual([
      'write:about',
      'pass:about',
      'write:weekends-genre',
    ])
    reloaded.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 3; i++) await sends.answer()
    expect(sends.sent).toEqual(['about', 'pass about', 'weekends'])
    // Everything sent: nothing left behind in storage.
    expect(storage.data.has('app.saveQueue.ida')).toBe(false)

    // Another member's line is another key.
    const other = createSaveQueue<Job>({ run: sends.run, storage, storageKey: 'app.saveQueue.lena' })
    expect(other.snapshot().jobs).toEqual([])
  })

  it('hands a refusal back with its sentence and field, goes on with the rest, and keeps it over a reload', async () => {
    const storage = memoryStorage()
    const refused: string[] = []
    const run = async (job: Job): Promise<JobOutcome> =>
      job.name === 'about'
        ? { ok: false, retry: false, error: 'Please choose a place.', field: 'city' }
        : OK
    const queue = createSaveQueue<Job>({
      run,
      storage,
      storageKey: 'q',
      onRefused: (r) => refused.push(r.key),
    })
    queue.start()
    queue.enqueue('write:about', { name: 'about' })
    queue.enqueue('pass:about', { name: 'pass about' })
    await vi.advanceTimersByTimeAsync(0)

    expect(refused).toEqual(['write:about'])
    expect(queue.snapshot()).toMatchObject({
      jobs: [],
      refusals: [
        {
          key: 'write:about',
          payload: { name: 'about' },
          error: 'Please choose a place.',
          field: 'city',
        },
      ],
    })
    // Not dropped: it is still there after a reload…
    const reloaded = createSaveQueue<Job>({ run, storage, storageKey: 'q' })
    expect(reloaded.snapshot().refusals).toHaveLength(1)
    // …until she sends that step again.
    reloaded.enqueue('write:about', { name: 'about, fixed' })
    expect(reloaded.snapshot().refusals).toEqual([])
  })

  it('drains: everything sent, or a send failing for want of a connection', async () => {
    let online = false
    const queue = createSaveQueue<Job>({
      run: async () => (online ? OK : OFFLINE),
      storageKey: 'q',
    })
    queue.start()
    expect(await queue.drain()).toBe('empty')

    queue.enqueue('write:bio', { name: 'bio' })
    queue.enqueue('pass:bio', { name: 'pass bio' })
    expect(await queue.drain()).toBe('waiting')
    expect(queue.snapshot().jobs).toHaveLength(2)

    online = true
    expect(await queue.drain()).toBe('empty')
    expect(queue.snapshot().jobs).toEqual([])
  })

  it('hands back what the server keeps failing without a reason, instead of trying forever', async () => {
    const unexplained: JobOutcome = {
      ok: false,
      retry: true,
      error: 'Something went wrong. Please try again.',
      giveUpAfter: 3,
    }
    let sends = 0
    const queue = createSaveQueue<Job>({
      run: async () => {
        sends += 1
        return unexplained
      },
      storageKey: 'q',
    })
    queue.start()
    queue.enqueue('write:bio', { name: 'bio' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(queue.snapshot().status).toBe('waiting')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sends).toBe(3)
    expect(queue.snapshot()).toMatchObject({
      jobs: [],
      status: 'idle',
      refusals: [{ key: 'write:bio', error: unexplained.error, field: null }],
    })
    // No connection is waited out however long it takes.
    let offline = 0
    const patient = createSaveQueue<Job>({
      run: async () => {
        offline += 1
        return OFFLINE
      },
      storageKey: 'q2',
    })
    patient.start()
    patient.enqueue('write:bio', { name: 'bio' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(offline).toBeGreaterThan(10)
    expect(patient.snapshot()).toMatchObject({ status: 'waiting', refusals: [] })
    patient.stop()
  })

  it('takes a send that throws for one that found no connection', async () => {
    let calls = 0
    const queue = createSaveQueue<Job>({
      run: async () => {
        calls += 1
        if (calls === 1) throw new TypeError('Load failed')
        return OK
      },
      storageKey: 'q',
    })
    queue.start()
    queue.enqueue('write:bio', { name: 'bio' })
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.snapshot()).toMatchObject({ status: 'waiting', lastError: 'Load failed' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(queue.snapshot()).toMatchObject({ status: 'idle', jobs: [] })
  })
})
