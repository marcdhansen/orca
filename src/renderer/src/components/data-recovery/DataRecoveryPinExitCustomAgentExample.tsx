import { AgentIcon } from '@/lib/agent-catalog'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent } from '../../../../shared/types'

export const PIN_EXIT_CUSTOM_AGENT_EXAMPLE_NAME = 'gpt-5.6-luna-low'
export const PIN_EXIT_CUSTOM_AGENT_EXAMPLE_COMMAND =
  'codex --model gpt-5.6-luna -c model_reasoning_effort="low"'

/** Static picker mock: shows a custom agent as a named row among built-ins. */
export function DataRecoveryPinExitCustomAgentExample() {
  return (
    <div aria-hidden className="overflow-hidden rounded-md border border-border bg-card text-left">
      <ExamplePickerRow agent="claude" label="Claude" />
      <ExamplePickerRow
        agent="codex"
        label={PIN_EXIT_CUSTOM_AGENT_EXAMPLE_NAME}
        command={PIN_EXIT_CUSTOM_AGENT_EXAMPLE_COMMAND}
        selected
      />
      <ExamplePickerRow agent="grok" label="Grok" />
    </div>
  )
}

function ExamplePickerRow({
  agent,
  label,
  command,
  selected = false
}: {
  agent: BuiltInTuiAgent
  label: string
  command?: string
  selected?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 px-3 py-2',
        selected &&
          'bg-[color-mix(in_srgb,var(--foreground)_10%,var(--background))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent)]',
        !selected && 'border-t border-border/60 first:border-t-0'
      )}
      data-current={selected ? 'true' : undefined}
    >
      <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
        <AgentIcon agent={agent} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          {selected ? (
            <Badge variant="outline" className="font-normal">
              {translate('auto.components.dataRecovery.pinExitExampleBadge', 'Custom')}
            </Badge>
          ) : null}
        </div>
        {command ? (
          <p className="mt-0.5 font-mono text-xs leading-relaxed text-muted-foreground">
            {command}
          </p>
        ) : null}
      </div>
    </div>
  )
}
