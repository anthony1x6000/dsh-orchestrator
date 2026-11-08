/**
 * Orchestrator Client half: two compact model pickers beside the composer's
 * main model seat. "Media" and "Text" each open a searchable list of every
 * routable model, and each choice is saved to the Host plugin's settings
 * namespace so it survives every future chat.
 *
 * The Host owns the worker routes and the orchestrator prompt; this file only
 * reads the shared model catalog and writes the two selections.
 */
window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Settings namespace / Loader row id shared with the Host half. */
    const SETTINGS_NS = 'orchestrator'
    /** Composer slot that renders immediately before the main model seat. */
    const SLOT = 'conversation.input.right'

    const CSS = `
      .orch-seats {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .orch-seat {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        max-width: 190px;
        padding: 0 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }
      .orch-seat:hover {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .orch-seat[data-empty="true"] {
        border-style: dashed;
      }
      .orch-seat-role {
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
      }
      .orch-seat-model {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .orch-panel {
        position: fixed;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        width: 340px;
        max-height: 420px;
        overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px;
        background: var(--dsw-alias-bg-overlay);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
      }
      .orch-title {
        padding: 10px 12px 0;
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
      }
      .orch-search {
        height: 30px;
        margin: 8px 10px;
        padding: 0 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        outline: none;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
      }
      .orch-search:focus {
        border-color: var(--dsw-alias-brand-primary);
      }
      .orch-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 2px 6px 8px;
      }
      .orch-group {
        padding: 8px 8px 4px;
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
      }
      .orch-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .orch-option:hover {
        background: var(--dsw-alias-bg-layer-2);
      }
      .orch-check {
        width: 14px;
        color: var(--dsw-alias-brand-primary);
        text-align: center;
      }
      .orch-empty, .orch-error {
        padding: 10px 12px;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
      }
      .orch-error {
        color: var(--dsw-alias-state-error-primary);
        font-size: 11px;
      }
    `

    /** Stable key for one provider/model pair. */
    function modelKey(provider, model) {
      return `${provider}\u0000${model}`
    }

    /** Read one role's saved selection from a settings namespace view. */
    function selectionOf(view, role) {
      const value = view && view.value && typeof view.value === 'object' ? view.value : {}
      const provider = value[`${role}Provider`]
      const model = value[`${role}Model`]
      if (typeof provider !== 'string' || provider.length === 0) return undefined
      if (typeof model !== 'string' || model.length === 0) return undefined
      return { provider, model }
    }

    /** Find a catalog row for a saved selection. */
    function findModel(catalog, selection) {
      if (selection === undefined) return undefined
      for (const group of catalog?.groups ?? []) {
        if (group.id !== selection.provider) continue
        for (const model of group.models) {
          if (model.id === selection.model) return { group, model }
        }
      }
      return undefined
    }

    /** Display name for a saved selection. */
    function displayName(catalog, selection) {
      if (selection === undefined) return 'Pick model'
      const found = findModel(catalog, selection)
      return found === undefined ? `${selection.provider}/${selection.model}` : found.model.name
    }

    /** One compact picker with a portal popup. */
    function SeatButton(props) {
      const { role, title, catalog, catalogError, view, open, onOpen, onClose, onChoose } = props
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [query, setQuery] = React.useState('')
      const [anchor, setAnchor] = React.useState(null)
      const [maxHeight, setMaxHeight] = React.useState(420)

      const selection = selectionOf(view, role)

      React.useEffect(() => {
        if (!open) return undefined
        const trigger = triggerRef.current
        if (trigger === null) return undefined
        const rect = trigger.getBoundingClientRect()
        setAnchor({
          right: Math.max(12, window.innerWidth - rect.right),
          bottom: Math.max(12, window.innerHeight - rect.top + 8),
        })
        setMaxHeight(Math.max(180, Math.min(420, rect.top - 24)))
        setQuery('')

        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current && panelRef.current.contains(target)) return
          if (triggerRef.current && triggerRef.current.contains(target)) return
          onClose()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        const onScroll = (event) => {
          if (panelRef.current && panelRef.current.contains(event.target)) return
          onClose()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open, onClose])

      const needle = query.trim().toLowerCase()
      const groups = (catalog?.groups ?? [])
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => {
            if (needle.length === 0) return true
            const groupName = String(group.name ?? group.id)
            return model.name.toLowerCase().includes(needle)
              || model.id.toLowerCase().includes(needle)
              || groupName.toLowerCase().includes(needle)
              || group.id.toLowerCase().includes(needle)
          }),
        }))
        .filter((group) => group.models.length > 0)

      const panel = open && anchor !== null
        ? ReactDOM.createPortal(
          h('div', {
            ref: panelRef,
            className: 'orch-panel',
            style: { right: anchor.right, bottom: anchor.bottom, maxHeight },
            role: 'dialog',
            'aria-label': `${title} worker model`,
          },
            h('div', { className: 'orch-title' }, `${title} worker model`),
            h('input', {
              className: 'orch-search',
              autoFocus: true,
              placeholder: 'Search models',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              'aria-label': `Search ${title} worker models`,
            }),
            h('div', { className: 'orch-list' },
              groups.length === 0
                ? h('div', { className: 'orch-empty' }, catalogError || (catalog === null ? 'Loading models...' : 'No models match.'))
                : groups.map((group) => h('div', { key: group.id },
                  h('div', { className: 'orch-group' }, group.name ?? group.id),
                  group.models.map((model) => {
                    const selected = selection !== undefined
                      && selection.provider === group.id
                      && selection.model === model.id
                    return h('button', {
                      key: modelKey(group.id, model.id),
                      type: 'button',
                      className: 'orch-option',
                      onClick: () => onChoose(role, group, model),
                    },
                      h('span', null, model.name),
                      h('span', { className: 'orch-check' }, selected ? '✓' : ''),
                    )
                  }),
                )),
            ),
          ),
          document.body,
        )
        : null

      return h(React.Fragment, null,
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'orch-seat',
          'data-empty': selection === undefined ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: `${title} worker model: ${displayName(catalog, selection)}`,
          onClick: open ? onClose : onOpen,
        },
          h('span', { className: 'orch-seat-role' }, title),
          h('span', { className: 'orch-seat-model' }, displayName(catalog, selection)),
        ),
        panel,
      )
    }

    /** Both pickers, sharing one catalog and one settings view. */
    function OrchestratorSeats({ ctx }) {
      const [catalog, setCatalog] = React.useState(null)
      const [catalogError, setCatalogError] = React.useState('')
      const [view, setView] = React.useState(null)
      const [openRole, setOpenRole] = React.useState(null)
      const [error, setError] = React.useState('')

      const loadCatalog = React.useCallback(async () => {
        try {
          const response = await ctx.remote.session.modelCatalog()
          if (!response.ok) throw new Error(response.error.message)
          setCatalog(response.value)
          setCatalogError('')
        } catch (failure) {
          setCatalog({ groups: [], failures: [] })
          setCatalogError(`Could not load models: ${String(failure?.message ?? failure)}`)
        }
      }, [ctx])

      const loadSettings = React.useCallback(async () => {
        try {
          const response = await ctx.remote.settings.describe()
          if (!response.ok) throw new Error(response.error.message)
          const found = (response.value?.namespaces ?? []).find((namespace) => namespace.ns === SETTINGS_NS)
          setView(found ?? null)
          if (response.value && response.value.writable === false) setError('Settings are read-only in this deployment.')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [ctx])

      React.useEffect(() => {
        void loadCatalog()
        void loadSettings()
        const disposers = []
        try {
          disposers.push(ctx.remote.$on('settings/document-updated', (ns) => {
            if (ns === SETTINGS_NS) void loadSettings()
          }))
          disposers.push(ctx.remote.$on('llm/adapters-updated', () => { void loadCatalog() }))
          disposers.push(ctx.remote.$on('llm/models-updated', () => { void loadCatalog() }))
        } catch {
          // Event forwarding is an optimization; the pickers still load once.
        }
        try {
          disposers.push(ctx.on('connection/reset', () => {
            void loadCatalog()
            void loadSettings()
          }))
        } catch {
          // No client connection service; the one-shot loads already ran.
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // Disposal must not break teardown.
            }
          }
        }
      }, [ctx, loadCatalog, loadSettings])

      const choose = React.useCallback(async (role, group, model) => {
        setError('')
        const operations = [
          { op: 'set', path: [`${role}Provider`], value: group.id },
          { op: 'set', path: [`${role}Model`], value: model.id },
        ]
        try {
          const response = await ctx.remote.settings.mutate(SETTINGS_NS, operations, view ? view.revision : undefined)
          if (!response.ok) throw new Error(response.error.message)
          setView(response.value ?? null)
          setOpenRole(null)
        } catch (firstFailure) {
          try {
            const described = await ctx.remote.settings.describe()
            if (!described.ok) throw new Error(described.error.message)
            const found = (described.value?.namespaces ?? []).find((namespace) => namespace.ns === SETTINGS_NS)
            const retry = await ctx.remote.settings.mutate(SETTINGS_NS, operations, found ? found.revision : undefined)
            if (!retry.ok) throw new Error(retry.error.message)
            setView(retry.value ?? null)
            setOpenRole(null)
          } catch (secondFailure) {
            setError(String(secondFailure?.message ?? firstFailure?.message ?? secondFailure))
          }
        }
      }, [ctx, view])

      const close = React.useCallback(() => setOpenRole(null), [])
      const openMedia = React.useCallback(() => { setError(''); setOpenRole('media') }, [])
      const openText = React.useCallback(() => { setError(''); setOpenRole('text') }, [])

      return h('div', { className: 'orch-seats' },
        h(SeatButton, {
          role: 'media',
          title: 'Media',
          catalog,
          catalogError,
          view,
          open: openRole === 'media',
          onOpen: openMedia,
          onClose: close,
          onChoose: choose,
        }),
        h(SeatButton, {
          role: 'text',
          title: 'Text',
          catalog,
          catalogError,
          view,
          open: openRole === 'text',
          onOpen: openText,
          onClose: close,
          onChoose: choose,
        }),
        error.length > 0
          ? h('span', { className: 'orch-error', title: error }, 'model save failed')
          : null,
      )
    }

    /** Client plugin body. */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-orchestrator'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'orchestrator: styles')

      ctx.slots.inject(SLOT, () => ctx.slots.register(
        {
          name: SLOT,
          id: 'orchestrator-models',
          order: 5,
          label: 'Orchestrator worker models',
        },
        (props) => h(OrchestratorSeats, { ...props, ctx }),
      ))
    }

    return {
      inject: ['slots', 'remote', 'remote.session', 'remote.settings'],
      apply,
    }
  },
})
