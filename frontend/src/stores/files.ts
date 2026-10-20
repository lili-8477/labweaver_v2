import { defineStore } from 'pinia'
import { ref } from 'vue'
import { natsService } from '@/services/nats'
import type { FileEntry } from '@/types'

export const useFileStore = defineStore('files', () => {
  const tree = ref<FileEntry[]>([])
  // FileTree view state, kept here so it survives the panel unmounting
  // (switching or closing the right panel).
  const expandedDirs = ref<Set<string>>(new Set())
  const dirChildren = ref<Map<string, FileEntry[]>>(new Map())
  const treeScrollTop = ref(0)
  const loading = ref(false)
  const openFile = ref<{
    path: string
    content: string
    language: string
    encoding: 'utf8' | 'base64'
    mimeType: string
    size?: number
  } | null>(null)

  // h5ad viewer uses its own state slot so it doesn't collide with the
  // text/binary FileViewer overlay. The viewer doesn't pre-load content
  // (those files are HDF5 and big) — backend reads on demand.
  const openH5ad = ref<{ path: string; size?: number } | null>(null)

  async function loadTree(subDir?: string) {
    loading.value = true
    try {
      const result = await natsService.callToolset('file_manager', 'list_files', { sub_dir: subDir || null })

      if (result?.success && Array.isArray(result.files)) {
        const entries: FileEntry[] = result.files
          .filter(f => f.name !== '.executor')
          .map(f => ({
            name: f.name,
            path: subDir ? `${subDir}/${f.name}` : f.name,
            type: f.type,
            size: f.size,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        if (!subDir) {
          tree.value = entries
        }
        return entries
      }
    } catch (e) {
      console.error('Failed to load file tree:', e)
    } finally {
      loading.value = false
    }
    return []
  }

  async function readFile(filePath: string) {
    try {
      const result = await natsService.callToolset('file_manager', 'read_file', { file_path: filePath })
      if (result?.success) {
        const ext = filePath.split('.').pop()?.toLowerCase() || ''
        const langMap: Record<string, string> = {
          py: 'python', js: 'javascript', ts: 'typescript',
          json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
          html: 'html', css: 'css', sh: 'shell', r: 'r',
          ipynb: 'json', csv: 'plaintext', txt: 'plaintext',
        }
        openFile.value = {
          path: filePath,
          content: result.content,
          language: langMap[ext] || 'plaintext',
          encoding: result.encoding,
          mimeType: result.mime_type,
          size: result.size,
        }
        return openFile.value
      }
    } catch (e) {
      console.error('Failed to read file:', e)
    }
    return null
  }

  async function writeFile(filePath: string, content: string) {
    return await natsService.callToolset('file_manager', 'write_file', { file_path: filePath, content })
  }

  async function createFile(filePath: string, content = '') {
    return await natsService.callToolset('file_manager', 'write_file', { file_path: filePath, content })
  }

  async function createDirectory(path: string) {
    return await natsService.callToolset('file_manager', 'manage_path', { operation: 'create_dir', path })
  }

  async function deletePath(path: string) {
    return await natsService.callToolset('file_manager', 'manage_path', { operation: 'delete', path, recursive: true })
  }

  async function movePath(from: string, to: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await natsService.callToolset('file_manager', 'manage_path', { operation: 'move', from, to })
      if (res?.success) return { ok: true }
      return { ok: false, error: 'move failed' }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      return { ok: false, error: msg }
    }
  }

  function closeFile() {
    openFile.value = null
  }

  function openH5adFile(path: string, size?: number) {
    openH5ad.value = { path, size }
  }

  function closeH5ad() {
    openH5ad.value = null
  }

  return {
    tree, loading, openFile, openH5ad,
    expandedDirs, dirChildren, treeScrollTop,
    loadTree, readFile, writeFile, createFile,
    createDirectory, deletePath, movePath,
    closeFile, openH5adFile, closeH5ad,
  }
})
