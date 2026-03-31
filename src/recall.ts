import { statSync } from "fs"
import { listMemories, type MemoryEntry } from "./memory.js"

const encoder = new TextEncoder()

export type RecalledMemory = {
  fileName: string
  name: string
  type: string
  description: string
  content: string
  ageInDays: number
}

const MAX_RECALLED_MEMORIES = 5
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 2))]
}

function getMemoryMtimeMs(entry: MemoryEntry): number {
  try {
    return statSync(entry.filePath).mtimeMs
  } catch {
    return 0
  }
}

function scoreMemory(entry: MemoryEntry, terms: string[]): number {
  if (terms.length === 0) return 0
  const haystack = `${entry.name}\n${entry.description}\n${entry.content}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (haystack.includes(term)) score += 1
  }
  return score
}

function truncateMemoryContent(content: string): string {
  const maxLines = content.split("\n").slice(0, MAX_MEMORY_LINES)
  const lineTruncated = maxLines.join("\n")
  if (encoder.encode(lineTruncated).length <= MAX_MEMORY_BYTES) {
    return lineTruncated
  }

  const lines = lineTruncated.split("\n")
  const kept: string[] = []
  let usedBytes = 0

  for (const line of lines) {
    const candidate = kept.length === 0 ? line : `\n${line}`
    const candidateBytes = encoder.encode(candidate).length
    if (usedBytes + candidateBytes > MAX_MEMORY_BYTES) break
    kept.push(line)
    usedBytes += candidateBytes
  }

  return kept.join("\n")
}

export function recallRelevantMemories(worktree: string, query?: string): RecalledMemory[] {
  const memories = listMemories(worktree)
  if (memories.length === 0) return []

  const now = Date.now()
  const memoriesWithMeta = memories.map((entry) => {
    const mtimeMs = getMemoryMtimeMs(entry)
    return {
      entry,
      mtimeMs,
    }
  })

  const terms = query ? tokenizeQuery(query) : []

  let selected = memoriesWithMeta

  if (terms.length > 0) {
    const withScores = memoriesWithMeta
      .map((item) => ({
        ...item,
        score: scoreMemory(item.entry, terms),
      }))
      .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)

    if (withScores.some((item) => item.score > 0)) {
      selected = withScores
    }
  }

  if (selected === memoriesWithMeta) {
    selected = [...memoriesWithMeta].sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  return selected.slice(0, MAX_RECALLED_MEMORIES).map(({ entry, mtimeMs }) => ({
    fileName: entry.fileName,
    name: entry.name,
    type: entry.type,
    description: entry.description,
    content: truncateMemoryContent(entry.content),
    ageInDays: Math.max(0, Math.floor((now - mtimeMs) / (1000 * 60 * 60 * 24))),
  }))
}

function formatAgeWarning(ageInDays: number): string {
  if (ageInDays <= 1) return ""
  return `\n> ⚠️ This memory is ${ageInDays} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n`
}

export function formatRecalledMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) return ""

  const sections = memories.map((memory) => {
    const ageWarning = formatAgeWarning(memory.ageInDays)
    return `### ${memory.name} (${memory.type})${ageWarning}\n${memory.content}`
  })
  return [
    "## Recalled Memories",
    "",
    "The following memories were automatically selected as relevant to this conversation. They may be outdated — verify against current state before relying on them.",
    "",
    sections.join("\n\n"),
  ].join("\n")
}
