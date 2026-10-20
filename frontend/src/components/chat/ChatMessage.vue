<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import type { ChatItem } from '@/types'

const props = defineProps<{
  item: Extract<ChatItem, { kind: 'user' | 'text' }>
}>()

const isUser = computed(() => props.item.kind === 'user')

const renderedContent = computed(() => {
  if (isUser.value || !props.item.text) return ''  // user text rendered as plain text in template
  try {
    return renderMarkdown(props.item.text)
  } catch {
    return props.item.text
  }
})
</script>

<template>
  <div class="chat-message" :class="{ user: isUser, assistant: !isUser }">
    <div v-if="isUser" class="avatar"><span>U</span></div>
    <div class="bubble">
      <div v-if="isUser" class="content user-text">{{ item.text }}</div>
      <div v-else class="content markdown-body" v-html="renderedContent"></div>
    </div>
  </div>
</template>

<style scoped>
.chat-message {
  display: flex; gap: 10px; margin-bottom: 16px; max-width: 85%;
}
.chat-message.user { margin-left: auto; flex-direction: row-reverse; }
/* Agent answers read as plain text across the panel (no bubble), like DSH. */
.chat-message.assistant { max-width: 100%; margin-bottom: 6px; }

.avatar {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.8em; font-weight: 600;
}
.user .avatar { background: var(--accent); color: var(--on-accent); }

.bubble {
  padding: 10px 14px; border-radius: var(--radius-lg);
  line-height: 1.5; min-width: 0;
}
.user .bubble {
  background: var(--accent); color: var(--on-accent);
  border-bottom-right-radius: 4px;
}
.assistant .bubble { padding: 0; border-radius: 0; line-height: 1.6; }
.assistant .markdown-body > :deep(:first-child) { margin-top: 0; }
.assistant .markdown-body > :deep(:last-child) { margin-bottom: 0; }

.user-text { white-space: pre-wrap; word-break: break-word; }
</style>
