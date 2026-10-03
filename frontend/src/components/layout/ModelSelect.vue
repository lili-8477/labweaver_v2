<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { natsService } from '@/services/nats'

// Options come from the adapter's provider registry ("provider/model" refs).
interface ModelOption { ref: string; label: string; provider: string; available: boolean }

const models = ref<ModelOption[]>([])
const current = ref<string>('')
const saving = ref(false)
const error = ref<string>('')

async function loadCurrent() {
  try {
    const [list, cur] = await Promise.all([
      natsService.invoke('list_models') as Promise<{ success: boolean; models: ModelOption[] }>,
      natsService.invoke('get_model') as Promise<{ success: boolean; model: string }>,
    ])
    if (list?.success) models.value = list.models
    if (cur?.success) current.value = cur.model
  } catch (e) {
    console.warn('list_models/get_model failed:', e)
  }
}

async function onChange(e: Event) {
  const model = (e.target as HTMLSelectElement).value
  saving.value = true
  error.value = ''
  try {
    const res = await natsService.invoke('set_model', { model }) as { success: boolean; model: string }
    if (res?.success) current.value = res.model
  } catch (err) {
    error.value = (err as Error).message
    // Revert select UI to last-known good value
    ;(e.target as HTMLSelectElement).value = current.value
  } finally {
    saving.value = false
  }
}

onMounted(loadCurrent)
</script>

<template>
  <label class="model-select" :title="error || 'Model for new chat turns'">
    <span class="label">Model</span>
    <select :value="current" :disabled="saving" @change="onChange">
      <option
        v-for="m in models"
        :key="m.ref"
        :value="m.ref"
        :title="m.available ? m.ref : `${m.ref} — API key not configured`"
      >{{ m.label }}{{ m.available ? '' : ' (no key)' }}</option>
    </select>
  </label>
</template>

<style scoped>
.model-select {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 6px 2px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  font-size: var(--text-sm);
}
.label {
  font-size: var(--text-2xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
select {
  background: transparent;
  color: var(--text-primary);
  border: none;
  padding: 4px 4px 4px 2px;
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
}
select:disabled { opacity: 0.6; cursor: wait; }
select:focus { outline: none; }
</style>
