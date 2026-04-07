import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { buildMemorySystemPrompt } from "./prompt.js"
import { recallRelevantMemories, formatRecalledMemories } from "./recall.js"
import {
  saveMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  readMemory,
  MEMORY_TYPES,
} from "./memory.js"
import { getMemoryDir } from "./paths.js"

const latestUserQueryBySession = new Map<string, string>()
const surfacedMemoriesBySession = new Map<string, Set<string>>()
const recentToolsBySession = new Map<string, string[]>()

const MAX_RECENT_TOOLS = 20

function shouldIgnoreMemoryContext(query: string | undefined): boolean {
  if (process.env.OPENCODE_MEMORY_IGNORE === "1") return true
  if (!query) return false

  const normalized = query.toLowerCase()
  return (
    /(ignore|don't use|do not use|without|skip)\s+(the\s+)?memory/.test(normalized) ||
    /memory\s+(should be|must be)?\s*ignored/.test(normalized)
  )
}

function extractUserQuery(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined

  if ("content" in message) {
    const content = (message as { content?: unknown }).content
    if (typeof content === "string") return content
    if (content !== undefined) return JSON.stringify(content)
  }

  if ("parts" in message) {
    const parts = (message as { parts?: unknown }).parts
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          return typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : ""
        })
        .filter(Boolean)
        .join("\n")
        .trim()
      if (text) return text
    }
  }

  return undefined
}

function getLastUserQuery(messages: Array<{ info?: { role?: unknown; sessionID?: unknown }; parts?: unknown }>): {
  query?: string
  sessionID?: string
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role !== "user") continue

    const query = extractUserQuery(message)
    const sessionID = typeof message.info?.sessionID === "string" ? message.info.sessionID : undefined
    return { query, sessionID }
  }

  return {}
}

function cacheLatestUserQuery(sessionID: string | undefined, message: unknown): void {
  if (!sessionID) return
  const query = extractUserQuery(message)
  if (query) {
    latestUserQueryBySession.set(sessionID, query)
  }
}

function isAutoMemoryPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  return typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.includes("# Auto Memory")
}

export const MemoryPlugin: Plugin = async ({ worktree }) => {
  getMemoryDir(worktree)

  return {
    "chat.message": async (input, output) => {
      cacheLatestUserQuery(input.sessionID, { parts: output.parts })
    },

    "tool.execute.after": async (input) => {
      const { tool: toolName, sessionID } = input
      if (!sessionID || !toolName) return
      if (!recentToolsBySession.has(sessionID)) {
        recentToolsBySession.set(sessionID, [])
      }
      const tools = recentToolsBySession.get(sessionID)!
      if (!tools.includes(toolName)) {
        tools.push(toolName)
        if (tools.length > MAX_RECENT_TOOLS) {
          tools.shift()
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const { query, sessionID } = getLastUserQuery(output.messages)
      if (query && sessionID) latestUserQueryBySession.set(sessionID, query)

      if (shouldIgnoreMemoryContext(query)) {
        output.messages = output.messages
          .map((message) => {
            const role = String(message.info.role)
            if (role !== "system") return message

            const parts = message.parts.filter((part) => !isAutoMemoryPart(part))
            return { ...message, parts }
          })
          .filter((message) => message.parts.length > 0)
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      let query: string | undefined
      let sessionID: string | undefined
      if (_input && typeof _input === "object") {
        sessionID = (typeof (_input as { sessionID?: unknown }).sessionID === "string"
          ? (_input as { sessionID?: string }).sessionID
          : undefined)
        if (sessionID) {
          query = latestUserQueryBySession.get(sessionID)
        }

        const messages = (_input as { messages?: unknown }).messages
        if (!query && Array.isArray(messages)) {
          const lastUserMsg = [...messages]
            .reverse()
            .find((message) =>
              message && typeof message === "object" && "role" in message && (message as { role?: unknown }).role === "user",
            )

          query = extractUserQuery(lastUserMsg)
        }
      }

      const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query)
      const alreadySurfaced = sessionID ? (surfacedMemoriesBySession.get(sessionID) ?? new Set()) : new Set<string>()
      const recentTools = sessionID ? (recentToolsBySession.get(sessionID) ?? []) : []
      const recalled = ignoreMemoryContext ? [] : recallRelevantMemories(worktree, query, alreadySurfaced, recentTools)

      if (sessionID && recalled.length > 0) {
        if (!surfacedMemoriesBySession.has(sessionID)) {
          surfacedMemoriesBySession.set(sessionID, new Set())
        }
        const surfaced = surfacedMemoriesBySession.get(sessionID)!
        for (const mem of recalled) {
          surfaced.add(mem.filePath)
        }
      }

      const recalledSection = formatRecalledMemories(recalled)
      const memoryPrompt = buildMemorySystemPrompt(worktree, recalledSection, {
        includeIndex: !ignoreMemoryContext,
      })
      output.system.push(memoryPrompt)
    },

    tool: {
      memory_save: tool({
        description:
          "Save or update a memory for future conversations. " +
          "Each memory is stored as a markdown file with frontmatter. " +
          "Use this when the user explicitly asks you to remember something, " +
          "or when you observe important information worth preserving across sessions " +
          "(user preferences, feedback, project context, external references). " +
          "Check existing memories first with memory_list or memory_search to avoid duplicates.",
        args: {
          file_name: tool.schema
            .string()
            .describe(
              'File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"',
            ),
          name: tool.schema.string().describe("Human-readable name for this memory"),
          description: tool.schema
            .string()
            .describe("One-line description — used to decide relevance in future conversations, so be specific"),
          type: tool.schema
            .enum(MEMORY_TYPES)
            .describe(
              "Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)",
            ),
          content: tool.schema
            .string()
            .describe(
              "Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines",
            ),
        },
        async execute(args) {
          const filePath = saveMemory(worktree, args.file_name, args.name, args.description, args.type, args.content)
          return `Memory saved to ${filePath}`
        },
      }),

      memory_delete: tool({
        description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
        args: {
          file_name: tool.schema.string().describe("File name of the memory to delete (with or without .md extension)"),
        },
        async execute(args) {
          const deleted = deleteMemory(worktree, args.file_name)
          return deleted ? `Memory "${args.file_name}" deleted.` : `Memory "${args.file_name}" not found.`
        },
      }),

      memory_list: tool({
        description:
          "List all saved memories with their names, types, and descriptions. " +
          "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
          "or when you need to recall what's been stored.",
        args: {},
        async execute() {
          const entries = listMemories(worktree)
          if (entries.length === 0) {
            return "No memories saved yet."
          }
          const lines = entries.map(
            (e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}`,
          )
          return `${entries.length} memories found:\n${lines.join("\n")}`
        },
      }),

      memory_search: tool({
        description:
          "Search memories by keyword. Searches across names, descriptions, and content. " +
          "Use this to find relevant memories before answering questions or when the user references past conversations.",
        args: {
          query: tool.schema.string().describe("Search query — searches across name, description, and content"),
        },
        async execute(args) {
          const results = searchMemories(worktree, args.query)
          if (results.length === 0) {
            return `No memories matching "${args.query}".`
          }
          const lines = results.map(
            (e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}\n  Content: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`,
          )
          return `${results.length} matches for "${args.query}":\n${lines.join("\n")}`
        },
      }),

      memory_read: tool({
        description: "Read the full content of a specific memory file.",
        args: {
          file_name: tool.schema.string().describe("File name of the memory to read (with or without .md extension)"),
        },
        async execute(args) {
          const entry = readMemory(worktree, args.file_name)
          if (!entry) {
            return `Memory "${args.file_name}" not found.`
          }
          return `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.content}`
        },
      }),
    },
  }
}
