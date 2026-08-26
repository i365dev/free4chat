#!/usr/bin/env node
// Node DRIVER for the issue #100 Phase 1 Pion spike.
//
// Boundary (aligned with #100 §14 target architecture):
//   - THIS driver owns ALL Free4Chat communication: MCP join_room /
//     wait_for_events heartbeat / room_info grant polling, and every
//     /api/sfu/* REST call. It holds the participant handle and never
//     hands credentials to Go.
//   - The Go child owns ONLY the media engine: PeerConnection, SDP
//     create/apply, OnTrack metadata, ReadRTP counters, exchanged via
//     line-delimited JSON stdio.
//
// Local debugging policy (#100 brief §7-9): dump everything into --dump-dir,
// including full HTTP bodies and handles; NEVER commit them.

import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

function parseArgs(argv) {
  const args = {
    baseUrl: "https://www.free4.chat",
    room: "",
    name: "Pion Spike",
    target: "",
    mode: "client-offer",
    listenSeconds: 12,
    waitGrantSeconds: 600,
    dumpDir: "",
    goBin: "",
  };
  const alias = {
    "base-url": "baseUrl",
    room: "room",
    name: "name",
    target: "target",
    mode: "mode",
    "listen-seconds": "listenSeconds",
    "wait-grant-seconds": "waitGrantSeconds",
    "dump-dir": "dumpDir",
    "go-bin": "goBin",
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    if (k === "--help") return null;
    const key = alias[k.slice(2)];
    if (!key) {
      console.error(`unknown flag ${k}`);
      return null;
    }
    args[key] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args || !args.room) {
  console.error(`usage: node driver.mjs --room <room-id> [--name N] [--base-url U]
  [--target HUMAN_NAME_SUBSTR] [--mode client-offer|server-offer]
  [--listen-seconds S] [--wait-grant-seconds S] [--dump-dir D] [--go-bin PATH]`);
  process.exit(2);
}
const dumpDir = args.dumpDir || `/tmp/free4chat-pion/run-${Date.now()}`;
mkdirSync(dumpDir, { recursive: true });
console.log(`[driver] dump dir: ${dumpDir}`);

let lastStage = "setup";
const stage = (s, msg) => {
  lastStage = s;
  console.log(`[${s}] ${msg}`);
};
function fail(reason) {
  console.log(
    `RESULT FAIL last_stage=${lastStage} reason=${JSON.stringify(reason)}`,
  );
  process.exitCode = 1;
  throw new Error(reason);
}
const httpLog = (entry) =>
  appendFileSync(
    join(dumpDir, "http-trace.jsonl"),
    JSON.stringify(entry) + "\n",
  );

async function sfuCall(method, path, body) {
  const t0 = Date.now();
  const res = await fetch(args.baseUrl + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  httpLog({
    ts: new Date().toISOString(),
    method,
    path,
    status: res.status,
    ms: Date.now() - t0,
    req: body ?? null,
    respText: text.slice(0, 20000),
  });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error bodies are evidence too */
  }
  if (!res.ok)
    throw new Error(
      `${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  return json;
}

// ---------- MCP side ----------
// Modern-era MCP caller (2026-07-28): per-request _meta envelope + matching
// Mcp-Method/Mcp-Name headers; no legacy initialize handshake.
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
let mcpRpcId = 0;
async function mcpCall(toolName, toolArgs) {
  const body = {
    jsonrpc: "2.0",
    id: ++mcpRpcId,
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs, _meta: { ...MODERN_META } },
  };
  const t0 = Date.now();
  const res = await fetch(args.baseUrl + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": "tools/call",
      "Mcp-Name": toolName,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  httpLog({
    ts: new Date().toISOString(),
    method: `MCP ${toolName}`,
    path: "/mcp",
    status: res.status,
    ms: Date.now() - t0,
    req: body,
    respText: text.slice(0, 20000),
  });
  if (!res.ok)
    throw new Error(
      `mcp ${toolName} -> HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  let payload = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) payload = JSON.parse(line.slice(5).trim());
    }
  } else {
    payload = JSON.parse(text);
  }
  if (payload.error)
    throw new Error(
      `mcp ${toolName} rpc error: ${JSON.stringify(payload.error)}`,
    );
  const parsed = JSON.parse(payload.result.content[0].text);
  if (payload.result.isError || parsed.error)
    throw new Error(`mcp ${toolName}: ${parsed.error ?? "tool error"}`);
  return parsed;
}
console.log("[driver] modern MCP caller ready");

// The opaque participant handle IS the credential store: base64url JSON of
// {room, participantId, participantToken}. join_room deliberately does NOT
// return the token as a separate field.
function decodeHandle(encoded) {
  const b64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

const joinPayload = await mcpCall("join_room", {
  roomId: args.room,
  name: args.name,
});
if (joinPayload.error) fail(`join_room: ${joinPayload.error}`);
writeFileSync(
  join(dumpDir, "join-result.json"),
  JSON.stringify(joinPayload, null, 2),
);
const handle = joinPayload.participantHandle;
const creds = decodeHandle(handle);
const myId = creds.participantId;
if (!creds.room || !myId || !creds.participantToken)
  fail("handle decode produced incomplete credentials");
console.log(`[driver] joined room="${args.room}" participantId=${myId}`);

let stopHeartbeat = false;
const heartbeat = (async () => {
  let cursor = Number(joinPayload.cursor ?? 0);
  while (!stopHeartbeat) {
    try {
      const ev = await Promise.race([
        mcpCall("wait_for_events", {
          participantHandle: handle,
          cursor,
          timeoutSeconds: 8,
        }),
        new Promise((r) => setTimeout(() => r(null), 15000)),
      ]);
      if (ev?.content?.[0]) {
        const data = JSON.parse(ev.content[0].text);
        if (typeof data.cursor === "number" && data.cursor > cursor)
          cursor = data.cursor;
      }
    } catch {
      /* transient; lease window is 90s */
    }
  }
})();

// Wait for the human-created Meeting Notes grant naming THIS agent. The
// grant is a room-visible Human action in the browser UI — never bypassed.
stage(
  "grant-wait",
  `polling room_info for the Meeting Notes grant (max ${args.waitGrantSeconds}s)`,
);
console.log(`
>> ACTION REQUIRED <<
Open ${args.baseUrl}/room?id=${encodeURIComponent(args.room)} in a real
browser, enable the microphone, click "Start Meeting Notes" and select
"${args.name}" as the note-taker. Then SPEAK so the spike can count RTP.
`);
{
  const grantDeadline = Date.now() + Number(args.waitGrantSeconds) * 1000;
  let granted = false;
  while (!granted && Date.now() < grantDeadline) {
    const info = await mcpCall("room_info", { roomId: args.room });
    const state = info;
    const notes = state.meetingNotes ?? {};
    if (notes.active === true && notes.agentParticipantId === myId) {
      if (state.meetingNotesMediaAvailable === false) {
        fail(
          "grant is ours but meetingNotesMediaAvailable=false (AGENT_MEDIA_ENABLED off)",
        );
      }
      granted = true;
      console.log("[grant-wait] grant confirmed");
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!granted) fail("timed out waiting for Meeting Notes grant");
}

// ---------- Go child ----------
import { dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
const goBin =
  args.goBin ||
  join(pathDirname(fileURLToPath(import.meta.url)), "pion-cloudflare");
const goProc = spawn(goBin, ["-dump-dir", dumpDir], {
  stdio: ["pipe", "pipe", "inherit"],
});
if (!goProc || !goProc.stdin) fail(`failed to spawn go child at ${goBin}`);
goProc.on("error", (e) =>
  console.error(`[driver] go child error: ${e.message}`),
);
if (goProc.stderr)
  goProc.stderr.on("data", (d) => process.stderr.write(`[go] ${d}`));

let pendingId = 0;
const pending = new Map();
const events = [];
const eventWaiters = [];

goProc.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.log(`[driver] unparseable go stdout: ${trimmed.slice(0, 120)}`);
      continue;
    }
    if (msg.ev) {
      events.push(msg);
      for (let i = eventWaiters.length - 1; i >= 0; i--) {
        const w = eventWaiters[i];
        if (w.pred(msg)) {
          eventWaiters.splice(i, 1);
          w.resolve(msg);
        }
      }
      continue;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  }
});

function goSend(cmd, timeoutMs = 45000) {
  cmd.id = ++pendingId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(cmd.id);
      reject(new Error(`go op=${cmd.op} timed out`));
    }, timeoutMs);
    pending.set(cmd.id, (msg) => {
      clearTimeout(timer);
      msg.ok ? resolve(msg) : reject(new Error(msg.error ?? "go op failed"));
    });
    goProc.stdin.write(JSON.stringify(cmd) + "\n");
  });
}
const waitForEvent = (pred, timeoutMs, what) =>
  new Promise((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${what}`)),
      timeoutMs,
    );
    eventWaiters.push({
      pred,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });

try {
  // Stage A: PC + server-events DC before any offer.
  stage("A", "init PeerConnection + server-events DataChannel");
  await goSend({ op: "init" });

  // Stage B: fully gathered local offer.
  stage("B", "CreateOffer + SetLocalDescription + full ICE gathering");
  const offerMsg = await goSend({ op: "create-offer" }, 30000);
  const offer = offerMsg.offer;

  // Stage C: authorized Cloudflare session creation carrying our complete
  // gathered offer. Two deployment contracts exist:
  //   - native initial-offer: agent-session takes sessionDescription and
  //     returns {sessionId, sessionDescription(answer)} (current prod)
  //   - blank-session: agent-session returns {sessionId}; transport then
  //     bootstraps via datachannels/establish carrying the offer (cf-sfu HEAD)
  stage("C", "agent-session (adaptive contract)");
  let sessionId;
  let initialDesc = null;
  try {
    const r = await sfuCall("POST", "/api/sfu/agent-session", {
      room: args.room,
      participantId: myId,
      token: creds.participantToken,
      sessionDescription: { type: offer.type, sdp: offer.sdp },
    });
    sessionId = r.sessionId;
    initialDesc = r.sessionDescription ?? null;
    console.log("[C] native-initial-offer contract accepted");
  } catch (err) {
    if (!/HTTP 400/.test(err.message)) throw err;
    console.log(
      `[C] native-offer rejected (${err.message}); trying blank-session contract`,
    );
    const r = await sfuCall("POST", "/api/sfu/agent-session", {
      room: args.room,
      participantId: myId,
      token: creds.participantToken,
    });
    sessionId = r.sessionId;
  }
  if (!initialDesc) {
    const transport = await sfuCall("POST", "/api/sfu/datachannels/establish", {
      room: args.room,
      participantId: myId,
      token: creds.participantToken,
      sessionId,
      dataChannel: { location: "remote", dataChannelName: "server-events" },
      sessionDescription: { type: offer.type, sdp: offer.sdp },
    }).catch(async (err) => {
      console.log(
        `[C] establish-with-offer rejected (${err.message}); server-offer fallback`,
      );
      return sfuCall("POST", "/api/sfu/datachannels/establish", {
        room: args.room,
        participantId: myId,
        token: creds.participantToken,
        sessionId,
        dataChannel: { location: "remote", dataChannelName: "server-events" },
      });
    });
    initialDesc = transport.sessionDescription;
  }

  // Stage D: apply initial remote description by its ACTUAL type (#101 §4).
  stage("D", "apply initial remote description (type-inspect)");
  if (!initialDesc) fail("session creation returned no sessionDescription");
  const appliedInitial = await goSend({
    op: "apply-remote",
    type: initialDesc.type,
    sdp: initialDesc.sdp,
  });
  if (appliedInitial.appliedType === "offer") {
    await sfuCall("PUT", "/api/sfu/renegotiate", {
      room: args.room,
      participantId: myId,
      token: creds.participantToken,
      sessionId,
      sessionDescription: appliedInitial.answer,
    });
  }
  console.log(`[D] initial description type=${initialDesc.type} applied`);

  // Stage E: connected.
  stage("E", "waiting PeerConnectionStateConnected");
  await goSend({ op: "wait-connected", timeoutMs: 30000 }, 40000);
  console.log("[E] connected");

  // Stage F: discover exactly ONE live human audio source.
  stage("F", "discovering live human audio tracks");
  const media = await sfuCall("POST", "/api/sfu/agent-room-media", {
    room: args.room,
    participantId: myId,
    token: creds.participantToken,
  });
  for (const p of media.participants ?? []) {
    console.log(`[F]   human "${p.name}" tracks=${JSON.stringify(p.tracks)}`);
  }
  const candidates = (media.participants ?? []).filter(
    (p) =>
      p.sessionId &&
      (!args.target ||
        p.name.toLowerCase().includes(args.target.toLowerCase())),
  );
  let picked = null;
  for (const p of candidates) {
    const audio = (p.tracks ?? []).find(
      (t) => t.kind === "audio" && t.trackName,
    );
    if (audio) {
      picked = { participant: p, trackName: audio.trackName };
      break;
    }
  }
  if (!picked)
    fail(
      `no live human audio source found (target=${JSON.stringify(args.target)})`,
    );
  console.log(
    `[F] selected "${picked.participant.name}" track=${picked.trackName}`,
  );

  // Stage G: authorized subscribe; inspect response by its actual type.
  stage("G", "tracks/new subscription");
  const sub = await sfuCall("POST", "/api/sfu/tracks", {
    room: args.room,
    participantId: myId,
    token: creds.participantToken,
    sessionId,
    tracks: [
      {
        location: "remote",
        sessionId: picked.participant.sessionId,
        trackName: picked.trackName,
      },
    ],
  });
  if (!sub.sessionDescription)
    fail("tracks/new returned no sessionDescription");
  const expectedMid = sub.tracks?.[0]?.mid;
  if (!expectedMid) fail("tracks/new returned no usable mid");
  console.log(
    `[G] remote-type=${sub.sessionDescription.type} mid=${expectedMid}`,
  );
  await goSend({ op: "arm-track", mid: expectedMid });

  // Stage H: apply server offer -> answer -> renegotiate; expect OnTrack.
  stage("H/I", "subscription renegotiation + RTP read");
  const appliedSub = await goSend({
    op: "apply-remote",
    type: sub.sessionDescription.type,
    sdp: sub.sessionDescription.sdp,
  });
  if (appliedSub.appliedType === "offer") {
    await sfuCall("PUT", "/api/sfu/renegotiate", {
      room: args.room,
      participantId: myId,
      token: creds.participantToken,
      sessionId,
      sessionDescription: appliedSub.answer,
    });
  }

  const trackEv = await waitForEvent(
    (e) => e.ev === "ontrack" && e.track?.mid === expectedMid,
    15000,
    `OnTrack(mid=${expectedMid})`,
  );
  const t = trackEv.track;
  console.log(
    `[H] ontrack kind=${t.kind} mime=${t.mime} clock=${t.clockRate} ch=${t.channels} pt=${t.payloadType} ssrc=${t.ssrc}`,
  );

  console.log(
    `>> SPEAK NOW: human mic audio should flow for ${args.listenSeconds}s <<`,
  );
  const listenStart = Date.now();
  let packets = 0,
    bytes = 0;
  while (Date.now() - listenStart < Number(args.listenSeconds) * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    const countsMsg = await goSend({ op: "rtp-stats" }, 5000);
    packets = countsMsg.counts?.[t.mid] ?? 0;
  }
  const finalCounts = (await goSend({ op: "rtp-stats" }, 5000)).counts ?? {};
  bytes = packets * 76;
  console.log(
    `[I] rtp_packets=${packets} counts=${JSON.stringify(finalCounts)}`,
  );
  if (!(packets > 0))
    fail(`stage I: ReadRTP produced 0 packets (mid=${t.mid})`);

  console.log(
    `RESULT PASS rtp_packets=${packets} codec=${t.mime}/${t.clockRate}/${t.channels} pt=${t.payloadType} ssrc=${t.ssrc} mid=${t.mid}`,
  );
  console.log(
    "issue #100 Phase 1 acceptance criterion SATISFIED: TrackRemote.ReadRTP() > 0",
  );
} catch (err) {
  console.log(
    `RESULT FAIL last_stage=${lastStage} reason=${JSON.stringify(String(err.message ?? err))}`,
  );
  process.exitCode = 1;
} finally {
  stopHeartbeat = true;
  goProc.stdin.write(JSON.stringify({ id: 999999, op: "close" }) + "\n");
  setTimeout(() => goProc.kill("SIGKILL"), 2000);
  try {
    mcpCall("leave_room", { participantHandle: handle }).catch(() => {});
  } catch {}
  heartbeat.catch(() => {});
}
