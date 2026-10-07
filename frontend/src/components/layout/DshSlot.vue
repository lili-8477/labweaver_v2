<script lang="ts">
import { defineComponent, h, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** Mounts one React component in its own root, so a crash stays contained. */
const ReactMount = defineComponent({
  props: { component: { type: Function as unknown as PropType<React.ComponentType>, required: true } },
  setup(props) {
    const el = ref<HTMLElement | null>(null)
    let root: Root | null = null
    onMounted(() => {
      root = createRoot(el.value!)
      root.render(React.createElement(props.component))
    })
    onBeforeUnmount(() => root?.unmount())
    return () => h('div', { ref: el })
  },
})
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { slotEntries } from '@/services/dsh-client-host'

// A named place where dsh client plugins can draw (see dsh-client-host.ts).
const props = defineProps<{ name: string }>()
const entries = computed(() => slotEntries[props.name] ?? [])
</script>

<template>
  <div v-if="entries.length > 0" class="dsh-slot">
    <ReactMount v-for="e in entries" :key="`${e.plugin}/${e.id}`" :component="e.component" />
  </div>
</template>

<style scoped>
/* dsh's design tokens, mapped onto LabWeaver's so plugin UI matches the theme. */
.dsh-slot {
  --dsw-alias-bg-layer-1: var(--bg-primary);
  --dsw-alias-bg-layer-2: var(--bg-tertiary);
  --dsw-alias-border-l1: var(--border);
  --dsw-alias-label-primary: var(--text-primary);
  --dsw-alias-label-secondary: var(--text-secondary);
  --dsw-alias-brand-primary: var(--accent);
  --dsw-alias-state-success-primary: var(--success);
  --dsw-alias-state-warning-primary: var(--warning);
  --dsw-alias-state-danger-primary: var(--danger);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
