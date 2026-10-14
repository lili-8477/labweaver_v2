<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  x: number
  y: number
  type: 'file' | 'directory'
  shareable?: boolean
}>()

const emit = defineEmits<{
  (e: 'copy-path'): void
  (e: 'rename'): void
  (e: 'move-to'): void
  (e: 'new-file'): void
  (e: 'new-folder'): void
  (e: 'delete'): void
  (e: 'share'): void
  (e: 'close'): void
}>()

const root = ref<HTMLElement | null>(null)
// Opened at the click point, then pulled back inside the viewport when the
// menu would run past the right or bottom edge.
const pos = ref({ left: props.x, top: props.y })
const MARGIN = 8

function fitToViewport() {
  const el = root.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  pos.value = {
    left: Math.max(MARGIN, Math.min(props.x, window.innerWidth - width - MARGIN)),
    top: Math.max(MARGIN, Math.min(props.y, window.innerHeight - height - MARGIN)),
  }
}

function onClickOutside(ev: MouseEvent) {
  if (!root.value) return
  if (!root.value.contains(ev.target as Node)) emit('close')
}
function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') emit('close')
}

// Reopening on another row reuses this instance, so refit on every move.
watch(() => [props.x, props.y], () => {
  pos.value = { left: props.x, top: props.y }
  void nextTick(fitToViewport)
})

onMounted(() => {
  void nextTick(fitToViewport)
  document.addEventListener('mousedown', onClickOutside, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  document.removeEventListener('keydown', onKey)
})

function pick(action: 'copy-path' | 'rename' | 'move-to' | 'new-file' | 'new-folder' | 'delete' | 'share') {
  switch (action) {
    case 'copy-path': emit('copy-path'); break
    case 'rename': emit('rename'); break
    case 'move-to': emit('move-to'); break
    case 'new-file': emit('new-file'); break
    case 'new-folder': emit('new-folder'); break
    case 'delete': emit('delete'); break
    case 'share': emit('share'); break
  }
  emit('close')
}
</script>

<template>
  <Teleport to="body">
  <div
    ref="root"
    class="ctx-menu"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    role="menu"
  >
    <button
      v-if="shareable"
      class="ctx-item ctx-item-accent"
      role="menuitem"
      @click="pick('share')"
    >Share with org</button>
    <div v-if="shareable" class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('copy-path')">
      Copy {{ props.type === 'directory' ? 'directory' : 'file' }} path
    </button>
    <div class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('rename')">Rename</button>
    <button class="ctx-item" role="menuitem" @click="pick('move-to')">Move to…</button>
    <div class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('new-file')">
      New File{{ props.type === 'directory' ? ' in this folder' : '' }}
    </button>
    <button class="ctx-item" role="menuitem" @click="pick('new-folder')">
      New Folder{{ props.type === 'directory' ? ' in this folder' : '' }}
    </button>
    <div class="ctx-sep" />
    <button class="ctx-item ctx-danger" role="menuitem" @click="pick('delete')">Delete</button>
  </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 200px;
  background: var(--bg-elevated);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  font-size: 0.88em;
}
.ctx-item {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--text-primary);
  padding: 6px 12px;
  cursor: pointer;
}
.ctx-item:hover { background: var(--bg-tertiary); }
.ctx-danger { color: var(--danger); }
.ctx-item-accent { color: var(--accent); font-weight: var(--fw-semi); }
.ctx-item-accent:hover { background: var(--accent-soft); }
.ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
