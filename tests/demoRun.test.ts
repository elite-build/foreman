import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { driverFor } from '../src/main/agents/registry'
import type { TurnCallbacks, TurnRequest, TurnResult } from '../src/main/agents/types'
import { registerDemoAgents } from '../src/main/demoRun'
import { parseFindings } from '../src/shared/autoReview'
import type { ChatItem } from '../src/shared/types'
import { tempDir } from './helpers'

const TASK = 'Add a retry with backoff to the API client: retry a failed request up to 3 times, waiting 200 ms, then 400 ms, then 800 ms.'

/** One scripted turn, its waits run at once: the chat items it kept and how it ended. */
async function turn(cwd: string, prompt: string): Promise<{ items: ChatItem[]; result?: TurnResult }> {
  const items = new Map<string, ChatItem>()
  let result: TurnResult | undefined
  const callbacks = {
    item: (item: ChatItem, transient?: boolean) => {
      if (!transient) items.set(item.id, item)
    },
    usage: () => undefined,
    finished: (r: TurnResult) => {
      result = r
    }
  } as unknown as TurnCallbacks
  const request = { turnId: `t-${Math.random()}`, prompt, cwd } as TurnRequest
  const running = driverFor('claude').createTurn(request, callbacks).run()
  await vi.runAllTimersAsync()
  await running
  return { items: [...items.values()], result }
}

const answer = (items: ChatItem[]) => items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : [])).join('\n')

afterEach(() => {
  vi.useRealTimers()
})

describe('the demo agent', () => {
  it('plays a flow run: a bug the checks catch, its fix, two findings, then a clean review', async () => {
    vi.useFakeTimers()
    registerDemoAgents()
    const cwd = await tempDir('foreman-demo-run-')
    const retry = () => readFileSync(path.join(cwd, 'src', 'retry.ts'), 'utf8')

    const implement = await turn(cwd, TASK)
    expect(implement.result).toEqual({ ok: true })
    expect(retry()).toContain('attempt > MAX_RETRIES')
    expect(implement.items.some((i) => i.kind === 'tool' && i.name === 'Write' && i.status === 'done')).toBe(true)
    expect(implement.items.some((i) => i.kind === 'result' && i.ok)).toBe(true)

    await turn(cwd, 'The checks below failed. Fix them and run them again.')
    expect(retry()).not.toContain('attempt > MAX_RETRIES')

    const review = await turn(cwd, 'End your answer with one fenced block tagged `foreman-findings`')
    const findings = parseFindings(answer(review.items))
    expect(findings?.map((f) => f.title)).toEqual(['POST and PATCH requests are retried', 'A 4xx response is retried'])

    await turn(cwd, `An auto review found these.\n\n1. [Medium] src/retry.ts:7: ${findings![0].title}`)
    expect(retry()).toContain('isIdempotent')

    const again = await turn(cwd, 'End your answer with one fenced block tagged `foreman-findings`')
    expect(parseFindings(answer(again.items))).toEqual([])
  })

  it('answers any other message without touching the workspace', async () => {
    vi.useFakeTimers()
    registerDemoAgents()
    const cwd = await tempDir('foreman-demo-run-')
    const { items, result } = await turn(cwd, 'Can you fix the login redirect?')
    expect(result).toEqual({ ok: true })
    expect(items.filter((i) => i.kind === 'tool')).toEqual([])
    expect(answer(items)).toContain('this reply is a script')
  })
})
