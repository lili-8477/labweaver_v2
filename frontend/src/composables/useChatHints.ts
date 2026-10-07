import { computed, type ComputedRef, type Ref } from 'vue'
import type { ChatMessage, HarnessProgress } from '@/types'
import type { ChatAttachment } from '@/services/chat-attachments'
import type { CreatedProject } from '@/services/project-from-drop'

export interface Hint {
  id:   string
  text: string
}

export interface HintInputs {
  messages:       Ref<ChatMessage[]>
  attachments:    Ref<ChatAttachment[]>
  pendingProject: Ref<CreatedProject | null>
}

// Must match TOOL in adapter/dsh-plugins/next-step.js.
const NEXT_STEP_TOOL = 'suggest_next_steps'
const MAX_NEXT_STEPS = 4  // MAX_OPTIONS there

// Rule-based "what to do next" chips. First matching rule wins.
//   - empty chat (no messages, no pending project) -> two starter hints
//   - pending project queued                       -> send-to-analyze hint
//   - uploads in flight                            -> none (chips already show)
//   - last turn called suggest_next_steps          -> the agent's options
//   - otherwise                                    -> none
export function useChatHints(inputs: HintInputs): ComputedRef<Hint[]> {
  return computed<Hint[]>(() => {
    const anyUploading = inputs.attachments.value.some(a => a.state === 'uploading')
    if (anyUploading) return []

    if (inputs.pendingProject.value) {
      return [{
        id: 'send-pending-project',
        text: `Send to start analyzing ${inputs.pendingProject.value.projectName}`,
      }]
    }

    if (inputs.messages.value.length === 0) {
      return [
        { id: 'describe',  text: 'Describe what you want to do' },
        { id: 'drop-file', text: 'Drop a file to start a project' },
      ]
    }

    return nextSteps(inputs.messages.value).map((text, i) => ({ id: `next-step-${i}`, text }))
  })
}

/** Options from the last suggest_next_steps call since the latest user message. */
function nextSteps(messages: ChatMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as unknown as Record<string, unknown>
    if (msg.role === 'user') return []
    const calls = (msg.tool_calls ?? []) as Array<{ function?: { name?: string; arguments?: string } }>
    for (const tc of calls) {
      if (tc.function?.name !== NEXT_STEP_TOOL) continue
      try {
        const options = JSON.parse(tc.function.arguments ?? '{}').options
        if (Array.isArray(options)) {
          return options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map(o => o.trim()).slice(0, MAX_NEXT_STEPS)
        }
      } catch { /* malformed arguments: no hints */ }
    }
  }
  return []
}

export interface PlaceholderState {
  sending:        boolean
  messageCount:   number
  attachments:    number
  pendingProject: string | null
  hintCount:      number
  harnessActive:  boolean
  progress:       HarnessProgress | null
}

// The input's placeholder, following what the user can usefully do next.
// First matching rule wins; kept short so it fits on one line.
export function inputPlaceholder(s: PlaceholderState): string {
  if (s.sending) {
    return s.harnessActive
      ? 'Auto mode is working. Draft your next message, or ■ to stop'
      : 'Working… draft your next message, or ■ to stop'
  }
  if (s.pendingProject) return `Add context for ${s.pendingProject}, or just send`
  if (s.attachments > 0) return 'Say what to do with the attached files'
  if (s.harnessActive) {
    const p = s.progress
    if (!p || p.steps.length === 0) return 'Describe the analysis. Auto mode will plan, run and review it'
    if (p.complete) return 'Project complete. Ask about the results, or start a new analysis'
    if (p.pendingFeedback > 0) return `${p.pendingFeedback} review item(s) open. Send to let auto mode fix them`
    const next = p.nextStepIndex != null ? p.steps[p.nextStepIndex] : null
    if (next) return `Next step: ${next.name}. Send to continue, or add instructions`
  }
  if (s.messageCount === 0) return 'Ask anything, drop a file to start a project, or type / for commands'
  if (s.hintCount > 0) return 'Pick a suggestion above, or type your own'
  return 'Ask a follow-up · Shift+Enter for a new line'
}
