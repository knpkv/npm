import { Bot, Sparkles } from "lucide-react"

interface ContextAgentProps {
  readonly context: string
  readonly onOpen: () => void
}

export function ContextAgent({ context, onOpen }: ContextAgentProps) {
  return (
    <button className="cc-context-agent" aria-label={`Ask the agent about ${context}`} onClick={onOpen}>
      <span>
        <Bot size={18} />
      </span>
      <span>
        <small>AGENT · THIS VIEW</small>
        <b>{context}</b>
      </span>
      <Sparkles size={16} />
    </button>
  )
}
