import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"
import { saveMemory } from "../src/memory.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "index-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("MemoryPlugin system transform", () => {
  test("suppresses memory context when user explicitly asks to ignore memory", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "hidden", "Hidden Memory", "Should be ignored", "user", "Secret context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const transform = plugin["experimental.chat.system.transform"] as unknown as (
      input: { model: unknown; messages: Array<{ role: string; content: string }> },
      output: { system: string[] },
    ) => Promise<void>
    const output = { system: [] as string[] }

    await transform(
      {
        model: "test-model",
        messages: [
          { role: "user", content: "Ignore memory and answer from fresh context only." },
        ],
      },
      output,
    )

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("# Auto Memory")
    expect(output.system[0]).not.toContain("## MEMORY.md")
    expect(output.system[0]).not.toContain("Hidden Memory")
    expect(output.system[0]).not.toContain("## Recalled Memories")
  })

  test("keeps memory context for normal turns", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "visible", "Visible Memory", "Should be injected", "user", "Visible context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const transform = plugin["experimental.chat.system.transform"] as unknown as (
      input: { model: unknown; messages: Array<{ role: string; content: string }> },
      output: { system: string[] },
    ) => Promise<void>
    const output = { system: [] as string[] }

    await transform(
      {
        model: "test-model",
        messages: [
          { role: "user", content: "What do you remember about visible context?" },
        ],
      },
      output,
    )

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("## MEMORY.md")
    expect(output.system[0]).toContain("Visible Memory")
  })

  test("suppresses memory context when real runtime message text lives in parts", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "parts_hidden", "Parts Hidden", "Should be ignored", "user", "Parts context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as (
      input: {},
      output: {
        messages: Array<{
          info: { role: string; sessionID: string }
          parts: Array<{ type: string; text?: string }>
        }>
      },
    ) => Promise<void>
    const transform = plugin["experimental.chat.system.transform"] as unknown as (
      input: {
        model: unknown
        sessionID: string
      },
      output: { system: string[] },
    ) => Promise<void>
    const output = { system: [] as string[] }

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_test_ignore" },
            parts: [{ type: "text", text: "Ignore memory and answer from fresh context only." }],
          },
        ],
      },
    )

    await transform(
      {
        model: "test-model",
        sessionID: "ses_test_ignore",
      },
      output,
    )

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).not.toContain("## MEMORY.md")
    expect(output.system[0]).not.toContain("Parts Hidden")
    expect(output.system[0]).not.toContain("## Recalled Memories")
  })

  test("removes Auto Memory system message in messages transform for ignore-memory turns", async () => {
    const repo = makeTempGitRepo()
    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as (
      input: {},
      output: {
        messages: Array<{
          info: { role: string; sessionID?: string }
          parts: Array<{ type: string; text?: string }>
        }>
      },
    ) => Promise<void>

    const output = {
      messages: [
        {
          info: { role: "system" },
          parts: [{ type: "text", text: "# Auto Memory\n\n## MEMORY.md\n\n- [Secret](secret.md) — hidden" }],
        },
        {
          info: { role: "user", sessionID: "ses_ignore_messages" },
          parts: [{ type: "text", text: "Ignore memory and answer from fresh context only." }],
        },
      ],
    }

    await messagesTransform({}, output)

    expect(output.messages).toHaveLength(1)
    expect(output.messages[0]!.info.role).toBe("user")
  })

  test("suppresses memory context when env override is set", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "env_hidden", "Env Hidden", "Should be ignored by env", "user", "Env context")

    const original = process.env.OPENCODE_MEMORY_IGNORE
    process.env.OPENCODE_MEMORY_IGNORE = "1"

    try {
      const plugin = await MemoryPlugin({ worktree: repo } as never)
      const transform = plugin["experimental.chat.system.transform"] as unknown as (
        input: { model: unknown; sessionID: string },
        output: { system: string[] },
      ) => Promise<void>
      const output = { system: [] as string[] }

      await transform({ model: "test-model", sessionID: "ses_env_ignore" }, output)

      expect(output.system).toHaveLength(1)
      expect(output.system[0]).not.toContain("## MEMORY.md")
      expect(output.system[0]).not.toContain("Env Hidden")
      expect(output.system[0]).not.toContain("## Recalled Memories")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_MEMORY_IGNORE
      else process.env.OPENCODE_MEMORY_IGNORE = original
    }
  })
})

describe("MemoryPlugin tool.execute.after hook", () => {
  test("exposes tool.execute.after hook", async () => {
    const repo = makeTempGitRepo()
    const plugin = await MemoryPlugin({ worktree: repo } as never)
    expect(plugin["tool.execute.after"]).toBeDefined()
    expect(typeof plugin["tool.execute.after"]).toBe("function")
  })

  test("tracks recent tools per session", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "grep_ref", "Grep Tool API", "Usage reference for grep tool", "reference", "How to use grep tool")
    saveMemory(repo, "project_info", "Project Info", "General project info", "project", "Project setup details")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const afterHook = plugin["tool.execute.after"] as unknown as (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown },
    ) => Promise<void>

    await afterHook(
      { tool: "grep", sessionID: "ses_tools_test", callID: "call_1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    const transform = plugin["experimental.chat.system.transform"] as unknown as (
      input: { model: unknown; sessionID: string },
      output: { system: string[] },
    ) => Promise<void>
    const output = { system: [] as string[] }

    await transform({ model: "test-model", sessionID: "ses_tools_test" }, output)

    expect(output.system[0]).toContain("Project Info")
  })
})

describe("MemoryPlugin alreadySurfaced tracking", () => {
  test("does not re-surface same memories across turns in same session", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "only_mem", "Only Memory", "The sole memory", "user", "Single memory content")

    const plugin = await MemoryPlugin({ worktree: repo } as never)

    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as (
      input: {},
      output: {
        messages: Array<{
          info: { role: string; sessionID: string }
          parts: Array<{ type: string; text?: string }>
        }>
      },
    ) => Promise<void>

    const transform = plugin["experimental.chat.system.transform"] as unknown as (
      input: { model: unknown; sessionID: string },
      output: { system: string[] },
    ) => Promise<void>

    await messagesTransform({}, {
      messages: [{
        info: { role: "user", sessionID: "ses_surfaced" },
        parts: [{ type: "text", text: "Tell me about the only memory" }],
      }],
    })

    const output1 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_surfaced" }, output1)
    expect(output1.system[0]).toContain("## Recalled Memories")
    expect(output1.system[0]).toContain("Only Memory")

    await messagesTransform({}, {
      messages: [{
        info: { role: "user", sessionID: "ses_surfaced" },
        parts: [{ type: "text", text: "Tell me about the only memory again" }],
      }],
    })

    const output2 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_surfaced" }, output2)
    expect(output2.system[0]).not.toContain("## Recalled Memories")
  })
})
