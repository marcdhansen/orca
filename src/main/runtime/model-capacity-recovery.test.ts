import { describe, expect, it, vi } from 'vitest'
import type { ModelCapacityRecoveryLedger } from '../../shared/model-capacity-recovery'
import {
  AgentPromptSubmissionRuntime,
  MODEL_CAPACITY_ERROR_V1,
  capacityRecoveryMessageDigest,
  classifyModelCapacityRollout
} from './agent-prompt-submission-runtime'

const TURN = 'turn-1'
const PROMPT = 'Fix the race exactly.\n'

function rollout(prompt = PROMPT, error = MODEL_CAPACITY_ERROR_V1, turn = TURN): unknown[] {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { type: 'turn_context', turn_id: turn, model: 'gpt-5' },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, error } }
  ]
}

function memoryStore(seed: ModelCapacityRecoveryLedger = {}) {
  let ledger = structuredClone(seed)
  return {
    getModelCapacityRecoveryLedger: () => structuredClone(ledger),
    replaceModelCapacityRecoveryLedgerAndFlush: (next: ModelCapacityRecoveryLedger) => {
      ledger = structuredClone(next)
    },
    snapshot: () => structuredClone(ledger)
  }
}

describe('model capacity rollout grammar', () => {
  it('accepts the canonical real-rollout shape', () => {
    expect(classifyModelCapacityRollout(rollout())).toEqual({
      providerTurnId: TURN,
      normalizedMessage: PROMPT,
      messageDigest: capacityRecoveryMessageDigest(PROMPT)
    })
  })

  it.each([
    ['wrong error', rollout(PROMPT, `${MODEL_CAPACITY_ERROR_V1} `)],
    [
      'progress',
      [
        ...rollout().slice(0, 3),
        { type: 'event_msg', payload: { type: 'agent_message' } },
        rollout()[3]
      ]
    ],
    [
      'assistant',
      [
        ...rollout().slice(0, 3),
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x' } },
        rollout()[3]
      ]
    ],
    ['trailing', [...rollout(), { type: 'event_msg', payload: { type: 'turn_aborted' } }]],
    [
      'turn mismatch',
      [rollout()[0], { type: 'turn_context', turn_id: 'other' }, ...rollout().slice(2)]
    ]
  ])('rejects %s records', (_name, records) => {
    expect(classifyModelCapacityRollout(records)).toBeNull()
  })
})

describe('capacity recovery authority', () => {
  it('replays exact owned input after the first bounded delay', async () => {
    const store = memoryStore()
    const delay = vi.fn(async () => undefined)
    const runtime = new AgentPromptSubmissionRuntime(
      () => store,
      () => 1_000,
      delay
    )
    await runtime.submitOwnedPrompt('pty', PROMPT, 'identity', async () => undefined)
    const deliver = vi.fn(async () => undefined)

    await expect(
      runtime.recover('pty', { records: rollout(), identity: 'identity' }, deliver)
    ).resolves.toBe('replayed')

    expect(delay).toHaveBeenCalledWith(5_000)
    expect(deliver).toHaveBeenCalledWith(PROMPT)
    expect(JSON.stringify(store.snapshot())).not.toContain(PROMPT)
  })

  it('fails closed on exact envelope mismatch', async () => {
    const store = memoryStore()
    const runtime = new AgentPromptSubmissionRuntime(
      () => store,
      () => 1_000,
      async () => {}
    )
    await runtime.submitOwnedPrompt('pty', PROMPT, 'identity', async () => undefined)
    const deliver = vi.fn(async () => undefined)

    expect(
      await runtime.recover('pty', { records: rollout('other'), identity: 'identity' }, deliver)
    ).toBe('attention')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('lets human or partial input invalidate a pending replay before bytes', async () => {
    const store = memoryStore()
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = new AgentPromptSubmissionRuntime(
      () => store,
      () => 1_000,
      () => wait
    )
    await runtime.submitOwnedPrompt('pty', PROMPT, 'identity', async () => undefined)
    const deliver = vi.fn(async () => undefined)
    const recovery = runtime.recover('pty', { records: rollout(), identity: 'identity' }, deliver)
    await Promise.resolve()
    const input = runtime.serializeInput('pty', async () => undefined)
    release()
    await recovery
    await input
    expect(deliver).not.toHaveBeenCalled()
  })

  it('serializes concurrent observers to one send', async () => {
    const store = memoryStore()
    const runtime = new AgentPromptSubmissionRuntime(
      () => store,
      () => 1_000,
      async () => {}
    )
    await runtime.submitOwnedPrompt('pty', PROMPT, 'identity', async () => undefined)
    const deliver = vi.fn(async () => undefined)
    const observation = { records: rollout(), identity: 'identity' }
    await Promise.all([
      runtime.recover('pty', observation, deliver),
      runtime.recover('pty', observation, deliver)
    ])
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each(['SUBMITTING', 'RETRYING'] as const)(
    'marks restart from %s ambiguous with no send',
    (phase) => {
      const store = memoryStore({
        pty: {
          version: 1,
          ptyId: 'pty',
          envelopeId: 'e',
          messageDigest: 'd',
          providerTurnId: TURN,
          identity: 'identity',
          phase,
          generation: 1,
          attempts: 1,
          createdAt: 1,
          updatedAt: 1
        }
      })
      new AgentPromptSubmissionRuntime(
        () => store,
        () => 2
      ).hydrate()
      expect(store.snapshot().pty).toMatchObject({
        phase: 'AMBIGUOUS',
        attentionReason: 'restart_during_delivery'
      })
    }
  )

  it('stops after three attempts', async () => {
    const store = memoryStore()
    let now = 0
    const runtime = new AgentPromptSubmissionRuntime(
      () => store,
      () => now,
      async (ms) => {
        now += ms
      }
    )
    await runtime.submitOwnedPrompt('pty', PROMPT, 'identity', async () => undefined)
    const deliver = vi.fn(async () => undefined)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await runtime.recover(
          'pty',
          {
            records: rollout(PROMPT, MODEL_CAPACITY_ERROR_V1, `turn-${attempt}`),
            identity: 'identity'
          },
          deliver
        )
      ).toBe('replayed')
    }
    expect(
      await runtime.recover(
        'pty',
        {
          records: rollout(PROMPT, MODEL_CAPACITY_ERROR_V1, 'turn-exhausted'),
          identity: 'identity'
        },
        deliver
      )
    ).toBe('attention')
    expect(deliver).toHaveBeenCalledTimes(3)
  })

  it('rejects identity drift and never replays after progress', async () => {
    const store = memoryStore()
    const runtime = new AgentPromptSubmissionRuntime(
      () => store,
      () => 1_000,
      async () => {}
    )
    await runtime.submitOwnedPrompt('pty', PROMPT, 'identity', async () => undefined)
    const deliver = vi.fn(async () => undefined)
    expect(await runtime.recover('pty', { records: rollout(), identity: 'other' }, deliver)).toBe(
      'attention'
    )
    expect(
      await runtime.recover(
        'pty',
        {
          records: [
            ...rollout().slice(0, 3),
            { type: 'event_msg', payload: { type: 'agent_message' } },
            rollout()[3]
          ],
          identity: 'identity'
        },
        deliver
      )
    ).toBe('ignored')
    expect(deliver).not.toHaveBeenCalled()
  })
})
