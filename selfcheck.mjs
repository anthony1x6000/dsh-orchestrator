import assert from 'node:assert/strict'
import { apply, Config } from './index.js'

/** Minimal Cordis context that records the registrations `apply` makes. */
function makeContext(config, options = {}) {
  const tools = new Map()
  const sections = new Map()
  const effects = []
  const listeners = new Map()
  const activations = []
  const ctx = {
    fiber: { entry: options.entry },
    logger: { warn: () => {} },
    get(name) {
      if (name === 'configEditor') return options.editor
      return undefined
    },
    inject: () => {},
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
    agents: { get: () => undefined },
    llm: {
      listProviders: () => [{ id: 'p1', name: 'Provider 1' }],
      listModels: async () => [{ id: 'm1', name: 'Model 1' }],
      resolveCallConfig: async () => {},
    },
    subagents: {
      getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
      resolveMaxDepth: () => 1,
      startActivation: async (spec) => {
        activations.push(spec)
        return { childId: 'child-1' }
      },
    },
    tools: {
      register(definition, options) {
        tools.set(definition.name, { definition, options })
        return () => {}
      },
    },
    systemPrompt: {
      getSectionOrder: () => 2800,
      section(section) {
        sections.set(section.name, section)
        return () => {}
      },
    },
  }
  apply(ctx, config)
  return { ctx, tools, sections, effects, listeners, activations }
}

const orchestratorAgent = {
  id: 's1',
  session: { header: { agentPreset: 'orchestrator' }, requestHeader: () => undefined },
  model: { current: () => undefined, select: () => {} },
}
const standardAgent = {
  id: 's2',
  session: { header: { agentPreset: 'standard' } },
}
const exec = { agent: orchestratorAgent, signal: new AbortController().signal }

const config = {
  childPreset: 'standard',
  mediaProvider: 'media-p',
  mediaModel: 'media-m',
  textProvider: 'text-p',
  textModel: 'text-m',
  mainProvider: 'main-p',
  mainModel: 'main-m',
}

{
  const { tools, sections, activations } = makeContext(config)
  await new Promise((resolve) => setImmediate(resolve))

  const media = tools.get('media_agent')
  assert.ok(media, 'media_agent registered')
  assert.equal(media.options.when({ agent: orchestratorAgent }), true, 'visible in orchestrator preset')
  assert.equal(media.options.when({ agent: standardAgent }), false, 'hidden outside orchestrator preset')

  const result = await media.definition.execute(
    { description: 'make art', task: 'Render a cube.' },
    exec,
  )
  assert.deepEqual(result, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(activations.length, 1, 'one child started')
  assert.equal(activations[0].provider, 'spawn')
  assert.equal(activations[0].delivery, 'parent')
  assert.equal(activations[0].request.agentOptions.provider, 'media-p')
  assert.equal(activations[0].request.agentOptions.model, 'media-m')
  assert.equal(activations[0].request.agentPreset, 'standard')
  assert.equal(activations[0].request.maxDepth, 1)
  assert.deepEqual(activations[0].request.prompt, [{ type: 'text', text: 'Render a cube.' }])

  const text = tools.get('text_agent')
  await text.definition.execute({ description: 'write code', task: 'Add a test.' }, exec)
  assert.equal(activations[1].request.agentOptions.model, 'text-m')

  const any = tools.get('subagent_model')
  await any.definition.execute({
    description: 'use hy4',
    task: 'Check the model.',
    provider: 'commandcode',
    model: 'hy4',
    reasoning_effort: 'max',
  }, exec)
  assert.equal(activations[2].request.agentOptions.provider, 'commandcode')
  assert.equal(activations[2].request.agentOptions.model, 'hy4')
  assert.equal(activations[2].request.agentOptions.reasoningEffort, 'max')

  const list = await tools.get('list_models').definition.execute({}, exec)
  assert.match(list.text, /p1\/m1 - Model 1/)

  const workerSection = sections.get('orchestrator:workers')
  assert.ok(workerSection, 'worker prompt section registered')
  assert.equal(workerSection.text({ scope: standardAgent }), '', 'section empty outside orchestrator')
  const textForOrchestrator = workerSection.text({ scope: orchestratorAgent })
  assert.match(textForOrchestrator, /media_agent -> media-p\/media-m/)
  assert.match(textForOrchestrator, /text_agent -> text-p\/text-m/)
  assert.match(textForOrchestrator, /p1\/m1 - Model 1/)

  assert.deepEqual(Object.keys(Config.dict).sort(), [
    'childPreset',
    'mainEffort',
    'mainModel',
    'mainProvider',
    'mediaModel',
    'mediaProvider',
    'textModel',
    'textProvider',
  ])
}

{
  const missing = makeContext({ childPreset: 'standard' })
  const media = missing.tools.get('media_agent')
  await assert.rejects(
    media.definition.execute({ description: 'x', task: 'y' }, exec),
    /media worker model is not set/,
  )
  const list = await missing.tools.get('list_models').definition.execute({}, exec)
  assert.match(list.text, /p1\/m1|No models are loaded yet/)
}

{
  const config = {
    childPreset: 'standard',
    mainProvider: 'old-p',
    mainModel: 'old-m',
  }
  let raw = { ...config }
  const editor = {
    edits: [],
    async edit(entry, change) {
      const next = change({ ...raw })
      raw = next
      for (const key of Object.keys(next)) config[key] = next[key]
      this.edits.push(next)
    },
  }
  const { listeners } = makeContext(config, { editor, entry: { id: 'orchestrator' } })

  listeners.get('session/event')[0](
    { header: { agentPreset: 'orchestrator' } },
    { type: 'model/selection', data: { provider: 'hy-p', model: 'hy4', reasoningEffort: 'max' } },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(config.mainProvider, 'hy-p', 'main provider saved')
  assert.equal(config.mainModel, 'hy4', 'main model saved')
  assert.equal(config.mainEffort, 'max', 'main effort saved')

  const selected = []
  const fresh = {
    session: { header: { agentPreset: 'orchestrator' }, requestHeader: () => undefined },
    model: { current: () => undefined, select: (selection) => selected.push(selection) },
  }
  await listeners.get('agent/created')[0]({ agent: fresh, source: 'startup' })
  assert.deepEqual(selected[0], { provider: 'hy-p', model: 'hy4', reasoningEffort: 'max' })

  const resumedSelected = []
  const resumed = {
    session: { header: { agentPreset: 'orchestrator' }, requestHeader: () => ({ config: {} }) },
    model: { current: () => undefined, select: (selection) => resumedSelected.push(selection) },
  }
  await listeners.get('agent/created')[0]({ agent: resumed, source: 'resume' })
  assert.equal(resumedSelected.length, 0, 'resumed session keeps its own model')

  const otherSelected = []
  const other = {
    session: { header: { agentPreset: 'standard' }, requestHeader: () => undefined },
    model: { current: () => undefined, select: (selection) => otherSelected.push(selection) },
  }
  await listeners.get('agent/created')[0]({ agent: other, source: 'startup' })
  assert.equal(otherSelected.length, 0, 'other presets do not take the orchestrator model')
}

console.log('orchestrator selfcheck ok')
