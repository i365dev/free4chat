import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { AcpHarnessAdapter } from "../src/adapters/acp.js"
import { renderUntrustedRoomTurn } from "../src/adapters/types.js"
import type { AgentLauncher, HarnessTurnInput } from "../src/types.js"

function fakeAgentScript(images = false): string {
  return `
const sessions = new Set();
let promptCount = 0;
let pendingPrompt;
let pendingPermission;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const update = (text) => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"session-1",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}});
const reply = (id, result) => send({jsonrpc:"2.0",id,result});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, {protocolVersion:1,agentCapabilities:{promptCapabilities:{${images ? "image:true" : ""}},sessionCapabilities:{close:{}}}});
    } else if (message.method === "session/new") {
      sessions.add("session-1"); reply(message.id, {sessionId:"session-1"});
    } else if (message.method === "session/prompt") {
      promptCount += 1; pendingPrompt = message;
      if (message.params.prompt[0].text.includes("permission-test")) {
        pendingPermission = {id: 77};
        send({jsonrpc:"2.0",id:77,method:"session/request_permission",params:{sessionId:"session-1",toolCall:{toolCallId:"tool-1",title:"unsafe operation",kind:"execute",status:"pending"},options:[]}});
      } else if (!message.params.prompt[0].text.includes("cancel-test")) {
        update("reply-" + promptCount); reply(message.id, {stopReason:"end_turn"}); pendingPrompt = undefined;
      }
    } else if (pendingPermission && message.id === pendingPermission.id && message.result) {
        update("permission-cancelled"); reply(pendingPrompt.id, {stopReason:"cancelled"}); pendingPermission = undefined; pendingPrompt = undefined;
    } else if (message.method === "session/cancel") {
      if (pendingPrompt) { update("cancelled"); reply(pendingPrompt.id, {stopReason:"cancelled"}); pendingPrompt = undefined; }
    } else if (message.method === "session/close") {
      reply(message.id, {});
    }
  }
});
`
}

function launcher(script: string): AgentLauncher {
  return {
    id: "fake",
    displayName: "Fake ACP",
    command: process.execPath,
    args: ["-e", script],
    maturity: "preview",
  }
}

function input(text: string): HarnessTurnInput {
  return {
    room: { ephemeral: true },
    events: [
      {
        sender: "Human",
        kind: "human",
        text,
        addressed: true,
        sequence: 1,
        createdAt: Date.now(),
      },
    ],
  }
}

test("generic ACP adapter negotiates once and reuses one session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "free4chat-acp-"))
  const adapter = new AcpHarnessAdapter(launcher(fakeAgentScript()), workspace)
  try {
    await adapter.ensureSession()
    assert.deepEqual(adapter.capabilities, {
      text: true,
      images: false,
      resume: false,
    })
    assert.equal((await adapter.runTurn(input("first"))).text, "reply-1")
    assert.equal((await adapter.runTurn(input("second"))).text, "reply-2")
  } finally {
    await adapter.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("ACP permission requests are cancelled and image capability is negotiated", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "free4chat-acp-"))
  const adapter = new AcpHarnessAdapter(
    launcher(fakeAgentScript(true)),
    workspace
  )
  try {
    await adapter.ensureSession()
    assert.equal(adapter.capabilities?.images, true)
    assert.equal(
      (await adapter.runTurn(input("permission-test"))).text,
      "permission-cancelled"
    )
  } finally {
    await adapter.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("ACP cancel stops an in-flight prompt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "free4chat-acp-"))
  const adapter = new AcpHarnessAdapter(launcher(fakeAgentScript()), workspace)
  try {
    await adapter.ensureSession()
    const turn = adapter.runTurn(input("cancel-test"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await adapter.cancelTurn()
    assert.equal((await turn).text, "cancelled")
  } finally {
    await adapter.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("room capability never enters the ACP prompt", () => {
  const rendered = renderUntrustedRoomTurn(input("hello"))
  assert.equal(rendered.includes("participantHandle"), false)
  assert.equal(rendered.includes("token"), false)
})

test("ACP process exit fails promptly", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "free4chat-acp-"))
  const adapter = new AcpHarnessAdapter(
    launcher("setTimeout(() => process.exit(0), 10)"),
    workspace
  )
  try {
    await assert.rejects(
      adapter.ensureSession(),
      /ACP process exited|closed|read/i
    )
  } finally {
    await adapter.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
