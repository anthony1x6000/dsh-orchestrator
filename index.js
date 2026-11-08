/**
 * Orchestrator Host half.
 *
 * Owns four things and nothing else:
 *  1. Two worker routes (media_agent, text_agent) whose models come from the
 *     composer pickers, plus a free-form subagent_model tool for any model.
 *  2. A live prompt section that shows the worker routes and the full model
 *     list only inside the Orchestrator preset.
 *  3. The orchestrator-mode main-model memory: save the last model selected in
 *     an orchestrator Session and restore it when the next orchestrator Session
 *     is created before its first request.
 *  4. The settings namespace (`orchestrator`) that the composer pickers write
 *     through the standard settings Remote.
 *
 * Worker model choices live in the plugin Config on purpose: the config editor
 * is the supported durable store, and volatile fields update in place.
 *
 * @module dsh-orchestrator
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'orchestrator'

/** Services this plugin contributes to or reads. */
export const inject = ['agents', 'tools', 'systemPrompt', 'llm', 'subagents']

/** Agent preset id this plugin serves. */
const PRESET_ID = 'orchestrator'

/** Settings namespace (also the Loader row id) the composer pickers write. */
const SETTINGS_NS = 'orchestrator'

/**
 * Config schema. Every field is volatile: a picker save applies without
 * remounting the Host plugin, and the runtime reads the live value each time.
 */
export const Config = z.object({
  childPreset: z.string().default('standard').volatile(),
  mediaProvider: z.string().volatile(),
  mediaModel: z.string().volatile(),
  textProvider: z.string().volatile(),
  textModel: z.string().volatile(),
  mainProvider: z.string().volatile(),
  mainModel: z.string().volatile(),
  mainEffort: z.string().volatile(),
})

/** Read a volatile config field, a plain value, or nothing. */
function fieldValue(field) {
  if (field === undefined || field === null) return undefined
  if (typeof field.get === 'function') return field.get()
  return field
}

/** True when two selections name the same provider, model, and effort. */
function sameSelection(left, right) {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/** Render a selection for a prompt line. */
function formatSelection(selection) {
  if (selection === undefined) return 'NOT SET'
  return `${selection.provider}/${selection.model}`
}

/** Render the full model catalog as plain prompt lines. */
function modelLines(groups) {
  return groups
    .flatMap((group) => group.models.map((model) => `- ${group.id}/${model.id} - ${model.name}`))
    .join('\n')
}

/**
 * Register the Host half.
 * @param ctx - Host plugin context.
 * @param config - live plugin config (volatile fields read through `fieldValue`).
 */
export function apply(ctx, config) {
  // ---------------------------------------------------------------- settings
  ctx.inject(['settings'], (scope) => {
    scope.effect(
      () => scope.settings.configure({ auto: false }, ctx.fiber),
      'orchestrator: settings policy',
    )
  })

  // ------------------------------------------------------------ model catalog
  const catalog = { groups: [], lines: '', ready: false }
  let catalogGeneration = 0

  async function refreshCatalog() {
    const generation = ++catalogGeneration
    try {
      const providers = ctx.llm.listProviders()
      const groups = []
      for (const provider of providers) {
        try {
          const models = await ctx.llm.listModels(provider.id)
          if (generation !== catalogGeneration) return
          groups.push({
            id: provider.id,
            name: provider.name ?? provider.id,
            models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
          })
        } catch (error) {
          ctx.logger.warn(`orchestrator: cannot list models for "${provider.id}": ${String(error)}`)
        }
      }
      if (generation !== catalogGeneration) return
      catalog.groups = groups
      catalog.lines = modelLines(groups)
      catalog.ready = true
    } catch (error) {
      ctx.logger.warn(`orchestrator: model catalog refresh failed: ${String(error)}`)
    }
  }

  ctx.effect(() => {
    void refreshCatalog()
    const offAdapters = ctx.on('llm/adapters-updated', () => { void refreshCatalog() })
    const offModels = ctx.on('llm/models-updated', () => { void refreshCatalog() })
    return () => {
      offAdapters()
      offModels()
    }
  }, 'orchestrator: model catalog')

  // ------------------------------------------------------------ worker routes
  /** Stored picker selection for one role, or undefined when not picked yet. */
  function storedSelection(role) {
    const provider = fieldValue(config[`${role}Provider`])
    const model = fieldValue(config[`${role}Model`])
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof model !== 'string' || model.length === 0) return undefined
    return { provider, model }
  }

  /** Stored orchestrator-mode main selection. */
  function storedMain() {
    const provider = fieldValue(config.mainProvider)
    const model = fieldValue(config.mainModel)
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof model !== 'string' || model.length === 0) return undefined
    const effort = fieldValue(config.mainEffort)
    return {
      provider,
      model,
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
    }
  }

  /** Live preset of a Session: the registry wins, the durable header is the fallback. */
  function presetOf(session) {
    try {
      const presets = ctx.get('agentPresets')
      const live = presets?.presetForSession?.(session)
      if (typeof live === 'string') return live
    } catch {
      // The preset service is optional at the tool layer; the header still answers.
    }
    return session?.header?.agentPreset
  }

  function isOrchestratorSession(session) {
    return session !== undefined && presetOf(session) === PRESET_ID
  }

  function isOrchestratorAgent(agent) {
    try {
      return agent !== undefined && agent !== null && isOrchestratorSession(agent.session)
    } catch {
      return false
    }
  }

  /** The prompt block the Orchestrator preset sees before every step. */
  function workerSectionText() {
    const models = catalog.ready && catalog.lines.length > 0
      ? catalog.lines
      : '(model list is loading or empty; call list_models)'
    return [
      'ORCHESTRATOR WORKER ROUTES (live):',
      `media_agent -> ${formatSelection(storedSelection('media'))}`,
      `text_agent -> ${formatSelection(storedSelection('text'))}`,
      'subagent_model -> any model below',
      '',
      'If a route says NOT SET, ask the user to pick that model in the composer bar. Do not guess.',
      '',
      'ALL MODELS:',
      models,
    ].join('\n')
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'orchestrator:workers',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
    text: (context) => (isOrchestratorAgent(context.scope) ? workerSectionText() : ''),
  }), 'orchestrator: worker prompt section')

  // -------------------------------------------------------------- delegation
  /** Start one managed child on an exact route. */
  async function startWorker(exec, selection, task, description, roleLabel) {
    if (exec.agent === undefined) throw new Error('delegation requires a calling agent')
    if (typeof task !== 'string' || task.trim().length === 0) throw new Error('task must be a non-empty string')
    await ctx.llm.resolveCallConfig({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }, exec.signal)
    const provider = ctx.subagents.getProvider('spawn')
    if (provider === undefined) throw new Error('the spawn subagent provider is not loaded')
    const childPreset = fieldValue(config.childPreset)
    const maxDepth = ctx.subagents.resolveMaxDepth()
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: typeof description === 'string' && description.length > 0 ? description : roleLabel,
      request: {
        prompt: [{ type: 'text', text: task }],
        parent: exec.agent,
        agentPreset: typeof childPreset === 'string' && childPreset.length > 0 ? childPreset : 'standard',
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
        ...(maxDepth === undefined ? {} : { maxDepth }),
      },
      signal: exec.signal,
      delivery: 'parent',
    })
    return { kind: 'activation', subagentId: activation.childId }
  }

  /** Shared input schema for a worker tool. */
  const workerParameters = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'task'],
    properties: {
      description: {
        type: 'string',
        description: 'Short task name. 3 to 6 words.',
      },
      task: {
        type: 'string',
        description: 'Complete task. The worker cannot see this chat. Include: goal, files or paths, exact commands, expected output, and the test that proves it is done.',
      },
    },
  }

  /** Shared output schema for a worker tool. */
  const workerOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'subagentId'],
      properties: {
        kind: { type: 'string', const: 'activation' },
        subagentId: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: `started ${value.subagentId}` }],
  }

  /** Register one role-locked worker tool. */
  function registerRoleTool(role, toolName, description) {
    const definition = {
      name: toolName,
      description,
      parameters: workerParameters,
      output: workerOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args === null || typeof args !== 'object') throw new Error('arguments must be an object')
        if (typeof args.task !== 'string' || args.task.trim().length === 0) {
          throw new Error('task must be a non-empty string')
        }
        const selection = storedSelection(role)
        if (selection === undefined) {
          throw new Error(`the ${role} worker model is not set. Ask the user to pick the ${role} model in the composer bar.`)
        }
        return startWorker(exec, selection, args.task, args.description, `${role} worker`)
      },
    }
    ctx.effect(
      () => ctx.tools.register(definition, { when: ({ agent }) => isOrchestratorAgent(agent) }),
      `orchestrator: ${toolName} tool`,
    )
  }

  registerRoleTool(
    'media',
    'media_agent',
    'Delegate creative work to the MEDIA worker. Use for Blender, images, computer use, UI looks, video, and audio. The worker cannot see this chat, so give a complete task.',
  )
  registerRoleTool(
    'text',
    'text_agent',
    'Delegate code work to the TEXT worker. Use for Node, Java, tests, refactors, docs, and files. The worker cannot see this chat, so give a complete task.',
  )

  // Free-form route for any catalog model the user names.
  ctx.effect(() => ctx.tools.register({
    name: 'subagent_model',
    description: 'Delegate to a worker on ANY model. Use only when the user names a model, or when media and text cannot do the job. Pass provider and model exactly as listed in ALL MODELS.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'task', 'provider', 'model'],
      properties: {
        description: {
          type: 'string',
          description: 'Short task name. 3 to 6 words.',
        },
        task: {
          type: 'string',
          description: 'Complete task. The worker cannot see this chat. Include: goal, files or paths, exact commands, expected output, and the test that proves it is done.',
        },
        provider: {
          type: 'string',
          description: 'Exact provider id from ALL MODELS.',
        },
        model: {
          type: 'string',
          description: 'Exact model id from ALL MODELS.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Optional reasoning effort id. Omit to use the model default.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subagentId'],
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args === null || typeof args !== 'object') throw new Error('arguments must be an object')
      if (typeof args.provider !== 'string' || args.provider.length === 0) throw new Error('provider must be a non-empty string')
      if (typeof args.model !== 'string' || args.model.length === 0) throw new Error('model must be a non-empty string')
      return startWorker(exec, {
        provider: args.provider,
        model: args.model,
        ...(typeof args.reasoning_effort === 'string' && args.reasoning_effort.length > 0
          ? { reasoningEffort: args.reasoning_effort }
          : {}),
      }, args.task, args.description, 'model worker')
    },
  }, { when: ({ agent }) => isOrchestratorAgent(agent) }), 'orchestrator: subagent_model tool')

  // Cheap recovery path when the prompt list is stale.
  ctx.effect(() => ctx.tools.register({
    name: 'list_models',
    description: 'List every model subagent_model can use. No arguments. Use this only when ALL MODELS in the prompt is empty or stale.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { text: catalog.ready && catalog.lines.length > 0 ? catalog.lines : 'No models are loaded yet.' }
    },
  }, { when: ({ agent }) => isOrchestratorAgent(agent) }), 'orchestrator: list_models tool')

  // ----------------------------------------------------- main-model memory
  let mainSave = Promise.resolve()

  /** Persist the last main model selected inside an orchestrator Session. */
  function saveMain(selection) {
    if (sameSelection(storedMain(), selection)) return mainSave
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) return mainSave
    mainSave = mainSave.then(async () => {
      await editor.edit(entry, (raw) => {
        const next = { ...raw }
        delete next.mainProvider
        delete next.mainModel
        delete next.mainEffort
        next.mainProvider = selection.provider
        next.mainModel = selection.model
        if (selection.reasoningEffort !== undefined) next.mainEffort = String(selection.reasoningEffort)
        return next
      })
    }).catch((error) => {
      ctx.logger.warn(`orchestrator: could not save the orchestrator main model: ${String(error)}`)
    })
    return mainSave
  }

  /** Restore the remembered main model on a fresh orchestrator Session. */
  async function applyStoredMain(agent) {
    try {
      if (!isOrchestratorAgent(agent)) return
      const session = agent.session
      if (typeof session.requestHeader === 'function' && session.requestHeader() !== undefined) return
      const main = storedMain()
      if (main === undefined) return
      await ctx.llm.resolveCallConfig(main)
      if (sameSelection(agent.model.current(), main)) return
      agent.model.select(main)
    } catch (error) {
      ctx.logger.warn(`orchestrator: could not restore the remembered main model: ${String(error)}`)
    }
  }

  ctx.effect(
    () => ctx.on('agent/created', ({ agent }) => applyStoredMain(agent)),
    'orchestrator: restore main model on create',
  )
  ctx.effect(
    () => ctx.on('agent-preset/selected', (sessionId, presetId) => {
      if (presetId !== PRESET_ID) return
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) return
      void applyStoredMain(agent)
    }),
    'orchestrator: restore main model on preset switch',
  )
  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      if (event?.type !== 'model/selection') return
      if (!isOrchestratorSession(session)) return
      const data = event.data
      if (typeof data?.provider !== 'string' || typeof data?.model !== 'string') return
      void saveMain({
        provider: data.provider,
        model: data.model,
        ...(typeof data.reasoningEffort === 'string' && data.reasoningEffort.length > 0
          ? { reasoningEffort: data.reasoningEffort }
          : {}),
      })
    }),
    'orchestrator: remember main model',
  )

  // Exported for a future selfcheck; the runtime never reads it.
  return {
    settingsNamespace: SETTINGS_NS,
    workerSectionText,
    storedSelection,
    storedMain,
  }
}
