<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import { formatDate } from '@/utils/format'
import type { ChatInfo } from '@/types'

const chat = useChatStore()

/** Clean raw XML/tags from chat names that weren't renamed yet */
function cleanName(name: string | undefined): string {
  if (!name) return 'Untitled'
  // Strip XML-like tags: <USER_REQUEST>, <ACTION>, etc.
  let clean = name.replace(/<[^>]+>/g, '').trim()
  // Truncate long names
  if (clean.length > 50) clean = clean.slice(0, 50) + '...'
  return clean || 'Untitled'
}
const editingId = ref<string | null>(null)
const editName = ref('')
const newProjectName = ref<string | null>(null)
const dropTarget = ref<string | null>(null)

// Folded project groups ("p:<dir>") and chats with sub-sessions (chat id),
// remembered per browser.
const FOLD_KEY = 'labweaver.sidebar.folded'
const folded = ref(new Set<string>(readFolded()))
function readFolded(): string[] {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '[]') } catch { return [] }
}
watch(folded, f => {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...f])) } catch { /* private mode */ }
})

/** Group key for chats bound to no project. */
const NONE = ''
const groupKey = (dir: string) => `p:${dir}`

interface Row { chat: ChatInfo; depth: number; childCount: number }
interface Group { dir: string; name: string; latest: string; count: number; rows: Row[] }

/** Sessions grouped by project, as in the DeepSeek Harness. Inside a project,
 *  sub-sessions nest under their parent; projects and branches sort by their
 *  most recent activity. Unbound chats go last, under "No project". */
const groups = computed<Group[]>(() => {
  const byDir = new Map<string, ChatInfo[]>()
  for (const p of chat.projects) byDir.set(p.dir, [])
  for (const c of chat.chats) {
    const dir = c.project_dir || NONE
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir)!.push(c)
  }
  const modified = new Map(chat.projects.map(p => [p.dir, p.modified_at]))
  const out: Group[] = []
  for (const [dir, chats] of byDir) {
    if (dir === NONE && chats.length === 0) continue
    const { rows, latest } = tree(chats, dir)
    out.push({
      dir,
      name: dir === NONE ? 'No project' : dir.split('/').pop()!,
      latest: [latest, modified.get(dir) ?? ''].reduce((a, b) => (a > b ? a : b)),
      count: chats.length,
      rows,
    })
  }
  return out.sort((a, b) =>
    a.dir === NONE ? 1 : b.dir === NONE ? -1 : b.latest.localeCompare(a.latest))
})

function tree(chats: ChatInfo[], dir: string): { rows: Row[]; latest: string } {
  // A parent counts only within the same project; otherwise the chat is a root.
  const ids = new Set(chats.map(c => c.id))
  const children = new Map<string | null, ChatInfo[]>()
  for (const c of chats) {
    const parent = c.parent_chat_id && ids.has(c.parent_chat_id) ? c.parent_chat_id : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(c)
  }
  const latest = new Map<string, string>()
  const latestOf = (c: ChatInfo): string => {
    if (!latest.has(c.id)) {
      const own = c.last_activity_date || ''
      const kids = (children.get(c.id) ?? []).map(latestOf)
      latest.set(c.id, [own, ...kids].reduce((a, b) => (a > b ? a : b)))
    }
    return latest.get(c.id)!
  }
  const rows: Row[] = []
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(children.get(parent) ?? [])].sort((a, b) => latestOf(b).localeCompare(latestOf(a)))
    for (const c of kids) {
      const childCount = children.get(c.id)?.length ?? 0
      rows.push({ chat: c, depth, childCount })
      if (childCount && !folded.value.has(c.id)) walk(c.id, depth + 1)
    }
  }
  walk(null, 0)
  const roots = children.get(null) ?? []
  const groupLatest = roots.map(latestOf).reduce((a, b) => (a > b ? a : b), '')
  return { rows: folded.value.has(groupKey(dir)) ? [] : rows, latest: groupLatest }
}

// Unfold the active chat's project and ancestors when the selection changes,
// so it is visible; the user can still fold them afterwards.
watch(() => chat.activeChat && [chat.activeChat.id, chat.activeChat.project_dir], () => {
  const active = chat.activeChat
  if (!active) return
  const next = new Set(folded.value)
  next.delete(groupKey(active.project_dir || NONE))
  for (let id = active.parent_chat_id; id; id = chat.chats.find(c => c.id === id)?.parent_chat_id ?? null) {
    next.delete(id)
  }
  if (next.size !== folded.value.size) folded.value = next
})

onMounted(() => chat.loadProjects())

function toggle(key: string) {
  const next = new Set(folded.value)
  if (!next.delete(key)) next.add(key)
  folded.value = next
}

async function newChatIn(dir: string) {
  const chatId = await chat.createChat(undefined, { projectDir: dir || undefined })
  if (chatId) chat.selectChat(chatId)
}

async function newSubSession(parentId: string) {
  const chatId = await chat.createChat(undefined, { parentChatId: parentId })
  if (chatId) chat.selectChat(chatId)
}

async function saveNewProject() {
  const name = newProjectName.value?.trim()
  newProjectName.value = null
  if (!name) return
  const dir = await chat.createProject(name)
  if (dir) await newChatIn(dir)
}

// ---- Drag a chat (with its sub-sessions) onto a project to move it ----

function onDragStart(e: DragEvent, chatId: string) {
  e.dataTransfer?.setData('application/x-labweaver-chat', chatId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, dir: string) {
  if (!e.dataTransfer?.types.includes('application/x-labweaver-chat')) return
  e.preventDefault()
  dropTarget.value = dir
}

async function onDrop(e: DragEvent, dir: string) {
  dropTarget.value = null
  const chatId = e.dataTransfer?.getData('application/x-labweaver-chat')
  const moved = chat.chats.find(c => c.id === chatId)
  if (!moved || (moved.project_dir || NONE) === dir) return
  const from = moved.project_dir || NONE
  const subtree = [moved.id]
  for (let i = 0; i < subtree.length; i++) {
    for (const c of chat.chats) {
      if (c.parent_chat_id === subtree[i] && (c.project_dir || NONE) === from) subtree.push(c.id)
    }
  }
  await Promise.all(subtree.map(id => chat.setChatProjectDir(id, dir)))
}

function startRename(chatId: string, name: string) {
  editingId.value = chatId
  editName.value = name
}

async function saveRename(chatId: string) {
  if (editName.value.trim()) {
    await chat.updateChatName(chatId, editName.value.trim())
  }
  editingId.value = null
}

async function handleDelete(chatId: string, childCount: number) {
  const msg = childCount
    ? `Delete this chat? Its ${childCount} sub-session(s) will move up a level.`
    : 'Delete this chat?'
  if (confirm(msg)) {
    await chat.deleteChat(chatId)
  }
}
</script>

<template>
  <div class="chat-sidebar">
    <div class="sidebar-header">
      <span class="title">Projects</span>
      <button class="btn-new" @click="newProjectName = ''" title="New project">+</button>
    </div>

    <div class="chat-list">
      <input
        v-if="newProjectName !== null"
        v-model="newProjectName"
        class="rename-input new-project-input"
        placeholder="Project name, then Enter"
        @keyup.enter="saveNewProject"
        @keyup.escape="newProjectName = null"
        @blur="saveNewProject"
        autofocus
      />

      <div v-for="g in groups" :key="g.dir" class="project">
        <div
          class="project-header"
          :class="{ 'drop-target': dropTarget === g.dir }"
          :title="g.dir || 'Chats not bound to a project'"
          @click="toggle(groupKey(g.dir))"
          @dragover="onDragOver($event, g.dir)"
          @dragleave="dropTarget = null"
          @drop="onDrop($event, g.dir)"
        >
          <span class="twisty" :class="{ open: !folded.has(groupKey(g.dir)) }">&#9656;</span>
          <span class="project-name" :class="{ none: !g.dir }">{{ g.name }}</span>
          <span class="project-count">{{ g.count }}</span>
          <button
            class="action-btn project-new"
            :title="g.dir ? `New chat in ${g.name}` : 'New chat without a project'"
            @click.stop="newChatIn(g.dir)"
          >+</button>
        </div>

        <div
          v-for="{ chat: c, depth, childCount } in g.rows"
          :key="c.id"
          class="chat-item"
          :class="{ active: c.id === chat.activeChatId, sub: depth > 0 }"
          :style="{ paddingLeft: `${16 + depth * 16}px` }"
          draggable="true"
          @dragstart="onDragStart($event, c.id)"
          @click="chat.selectChat(c.id)"
        >
          <button
            v-if="childCount"
            class="twisty"
            :class="{ open: !folded.has(c.id) }"
            :title="folded.has(c.id) ? `Show ${childCount} sub-session(s)` : 'Hide sub-sessions'"
            @click.stop="toggle(c.id)"
          >&#9656;</button>
          <span v-else class="twisty-spacer"></span>
          <div class="chat-item-content">
            <template v-if="editingId === c.id">
              <input
                v-model="editName"
                class="rename-input"
                @keyup.enter="saveRename(c.id)"
                @keyup.escape="editingId = null"
                @blur="saveRename(c.id)"
                @click.stop
                autofocus
              />
            </template>
            <template v-else>
              <div class="chat-name">{{ cleanName(c.name) }}</div>
              <div class="chat-meta">
                <span v-if="c.running" class="running-dot"></span>
                {{ formatDate(c.last_activity_date) }}
                <span v-if="childCount" class="sub-count">· {{ childCount }} sub</span>
              </div>
            </template>
          </div>
          <div class="chat-actions" @click.stop>
            <button class="action-btn" @click="newSubSession(c.id)" title="New sub-session (continues from this chat)">
              &#8627;
            </button>
            <button class="action-btn" @click="startRename(c.id, c.name || '')" title="Rename">
              &#9998;
            </button>
            <button class="action-btn danger" @click="handleDelete(c.id, childCount)" title="Delete">
              &times;
            </button>
          </div>
        </div>

        <div v-if="g.count === 0 && !folded.has(groupKey(g.dir))" class="project-empty">
          No chats yet
        </div>
      </div>

      <div v-if="groups.length === 0" class="empty">
        No projects yet. Click + to start one.
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-sidebar { display: flex; flex-direction: column; height: 100%; }
.sidebar-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.title { font-weight: 600; font-size: 0.9em; }
.btn-new {
  width: 28px; height: 28px; background: var(--accent); color: var(--on-accent);
  border: none; border-radius: var(--radius); font-size: 1.2em;
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.btn-new:hover { background: var(--accent-hover); }

.chat-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
.new-project-input { margin: 4px 0 6px; padding: 6px 8px; }

.project { margin-bottom: 4px; }
.project-header {
  display: flex; align-items: center; gap: 4px; padding: 6px 8px;
  border-radius: var(--radius); cursor: pointer; user-select: none;
  border: 1px dashed transparent;
}
.project-header:hover { background: var(--bg-tertiary); }
.project-header.drop-target { border-color: var(--accent); background: var(--bg-tertiary); }
.project-name {
  flex: 1; min-width: 0; font-size: 0.85em; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.project-name.none { font-weight: 500; color: var(--text-muted); }
.project-count { font-size: 0.75em; color: var(--text-muted); }
.project-new { opacity: 0; transition: opacity 0.1s; }
.project-header:hover .project-new { opacity: 1; }
.project-empty { padding: 2px 0 6px 36px; font-size: 0.75em; color: var(--text-muted); }

.chat-item {
  display: flex; align-items: center; padding: 8px 12px;
  border-radius: var(--radius); cursor: pointer;
  margin-bottom: 2px; transition: background 0.1s;
}
.chat-item:hover { background: var(--bg-tertiary); }
.chat-item.active { background: var(--bg-tertiary); border-left: 2px solid var(--accent); }
.chat-item-content { flex: 1; min-width: 0; }
.chat-item.sub .chat-name { font-size: 0.85em; color: var(--text-secondary); }
.twisty, .twisty-spacer { flex: none; width: 20px; margin-right: 4px; }
.twisty {
  height: 20px; padding: 0; background: transparent; border: none;
  border-radius: 4px; cursor: pointer;
  color: var(--text-secondary); font-size: 15px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  transition: transform 0.1s;
}
.twisty.open { transform: rotate(90deg); }
.twisty:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.sub-count { opacity: 0.8; }
.chat-name {
  font-size: 0.9em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}
.chat-meta {
  font-size: 0.75em; color: var(--text-muted);
  display: flex; align-items: center; gap: 4px;
}
.running-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--success);
  display: inline-block; animation: pulse 1.5s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.chat-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; }
.chat-item:hover .chat-actions { opacity: 1; }
.action-btn {
  width: 24px; height: 24px; background: transparent; border: none;
  color: var(--text-muted); border-radius: 4px; font-size: 0.9em;
  display: flex; align-items: center; justify-content: center;
}
.action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.action-btn.danger:hover { color: var(--danger); }

.rename-input {
  width: 100%; padding: 2px 4px; background: var(--bg-primary);
  border: 1px solid var(--accent); border-radius: 3px;
  color: var(--text-primary); font-size: 0.9em;
}

.empty {
  padding: 20px 16px; text-align: center;
  color: var(--text-muted); font-size: 0.85em;
}
</style>
