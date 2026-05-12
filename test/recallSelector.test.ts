import { describe, expect, test } from "bun:test"
import { join } from "path"
import { SELECT_MEMORIES_SYSTEM_PROMPT, selectRelevantMemoryFilenames } from "../src/recallSelector.js"
import type { MemoryHeader } from "../src/memoryScan.js"

function header(filename: string, description: string): MemoryHeader {
  return {
    filename,
    filePath: join("/tmp/memory", filename),
    mtimeMs: new Date("2026-05-01T00:00:00Z").getTime(),
    name: filename.replace(/\.md$/, ""),
    description,
    type: "project",
  }
}

describe("selectRelevantMemoryFilenames", () => {
  test("throws a clear error when the session client does not support v2 structured output", async () => {
    const calls: string[] = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(_options: unknown) {
          calls.push("create")
          return { data: { id: "selector-session" } }
        },
        async prompt(_options: unknown) {
          calls.push("prompt")
          return { data: { parts: [] } }
        },
        async delete(_options: unknown) {
          calls.push("delete")
          return { data: true }
        },
      },
    }

    let error: unknown
    try {
      await selectRelevantMemoryFilenames({
        client,
        directory: "/repo",
        parentSessionID: "parent-session",
        query: "Anything relevant?",
        memories: [header("testing.md", "Database integration test guidance")],
        recentTools: [],
        selectorSessionIDs,
        agent: "opencode-memory-recall",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("requires an OpenCode SDK with structured output session.prompt support")
    expect(calls).toEqual([])
    expect(selectorSessionIDs.size).toBe(0)
  })

  test("asks a temporary child session for structured filenames and deletes it", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(options: unknown, _requestOptions?: unknown) {
          calls.push({ method: "create", options })
          return { data: { id: "selector-session" } }
        },
        async prompt(options: unknown, _requestOptions?: unknown) {
          calls.push({ method: "prompt", options })
          expect(selectorSessionIDs.has("selector-session")).toBe(true)
          return {
            data: {
              info: {
                structured: {
                  selected_memories: ["testing.md", "missing.md"],
                },
              },
              parts: [],
            },
          }
        },
        async delete(options: unknown, _requestOptions?: unknown) {
          calls.push({ method: "delete", options })
          return { data: true }
        },
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client,
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "How should we run database integration tests?",
      memories: [
        header("testing.md", "Database integration test guidance"),
        header("release.md", "Release process"),
      ],
      recentTools: ["grep"],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual(["testing.md"])
    expect(selectorSessionIDs.has("selector-session")).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(["create", "prompt", "delete"])

    const createOptions = calls[0]!.options as {
      parentID?: string
      title?: string
      directory?: string
    }
    expect(createOptions.parentID).toBe("parent-session")
    expect(createOptions.directory).toBe("/repo")

    const promptOptions = calls[1]!.options as {
      sessionID?: string
      directory?: string
      agent?: string
      system?: string
      format?: { type?: string }
      parts?: Array<{ text?: string }>
    }
    expect(promptOptions.sessionID).toBe("selector-session")
    expect(promptOptions.directory).toBe("/repo")
    expect(promptOptions.agent).toBe("opencode-memory-recall")
    expect(promptOptions.system).toBe(SELECT_MEMORIES_SYSTEM_PROMPT)
    expect(promptOptions.format?.type).toBe("json_schema")
    expect(promptOptions.parts?.[0]?.text).toContain("Query: How should we run database integration tests?")
    expect(promptOptions.parts?.[0]?.text).toContain("Available memories:")
    expect(promptOptions.parts?.[0]?.text).toContain("Recently used tools: grep")

    const deleteOptions = calls[2]!.options as { sessionID?: string; directory?: string }
    expect(deleteOptions.sessionID).toBe("selector-session")
    expect(deleteOptions.directory).toBe("/repo")
  })

  test("calls session methods with their client receiver intact", async () => {
    const selectorSessionIDs = new Set<string>()
    const session = {
      sessionID: "selector-session",
      deleted: false,
      async create(_parameters?: unknown, _requestOptions?: unknown) {
        return { data: { id: this.sessionID } }
      },
      async prompt(_parameters: unknown, _requestOptions?: unknown) {
        return {
          data: {
            info: {
              structured: {
                selected_memories: [`${this.sessionID}.md`],
              },
            },
            parts: [],
          },
        }
      },
      async delete(_parameters: unknown, _requestOptions?: unknown) {
        this.deleted = true
        return { data: true }
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client: { session },
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "Anything relevant?",
      memories: [header("selector-session.md", "Selector session guidance")],
      recentTools: [],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual(["selector-session.md"])
    expect(session.deleted).toBe(true)
  })

  test("returns empty selection on selector failure and still deletes the child session", async () => {
    const calls: string[] = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(_parameters?: unknown, _requestOptions?: unknown) {
          calls.push("create")
          return { data: { id: "selector-session" } }
        },
        async prompt(_parameters: unknown, _requestOptions?: unknown) {
          calls.push("prompt")
          throw new Error("selector failed")
        },
        async delete(_parameters: unknown, _requestOptions?: unknown) {
          calls.push("delete")
          return { data: true }
        },
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client,
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "Anything relevant?",
      memories: [header("testing.md", "Database integration test guidance")],
      recentTools: [],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual([])
    expect(selectorSessionIDs.has("selector-session")).toBe(false)
    expect(calls).toEqual(["create", "prompt", "delete"])
  })
})
