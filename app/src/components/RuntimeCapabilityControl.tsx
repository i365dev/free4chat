import { useMemo, useState } from "react"

import type {
  RuntimeCapabilityProjection,
  RuntimeCapabilityResult,
} from "@common/runtimeCapability"

import type {
  RuntimeHostProjection,
  RuntimeHostProviderPublicAssociation,
} from "../room/types"

interface RuntimeCapabilityControlProps {
  runtimeHosts?: Record<string, RuntimeHostProjection>
  runtimeHostProviders?: Record<string, RuntimeHostProviderPublicAssociation>
  localParticipantId?: string
  controlError?: string
  participants: Array<{
    peerId: string
    kind?: "human" | "agent"
    runtimeHostId?: string
    connected?: boolean
  }>
  onSetEnabled: (runtimeHostId: string, enabled: boolean) => boolean
  onRequest: (request: {
    runtimeHostId: string
    capabilityId: string
    operation: "observe" | "invoke"
    action?: string
    args?: Record<string, unknown>
  }) => Promise<RuntimeCapabilityResult>
}

function primitiveDefault(type: "string" | "number" | "boolean"): unknown {
  return type === "string" ? "" : type === "number" ? 0 : false
}

/** Small Phase 1 proof surface for one paired local Runtime Host. */
export default function RuntimeCapabilityControl({
  runtimeHosts,
  runtimeHostProviders,
  localParticipantId,
  controlError = "",
  participants,
  onSetEnabled,
  onRequest,
}: RuntimeCapabilityControlProps) {
  const [pending, setPending] = useState(false)
  const [output, setOutput] = useState("")
  const [argsByAction, setArgsByAction] = useState<Record<string, string>>({})
  const hosts = useMemo(
    () =>
      Object.entries(runtimeHosts ?? {}).filter(
        ([runtimeHostId, host]) =>
          Boolean(host.capabilities?.length) &&
          runtimeHostProviders?.[runtimeHostId]?.humanParticipantId ===
            localParticipantId &&
          participants.some(
            (participant) =>
              participant.kind === "agent" &&
              participant.connected === true &&
              participant.runtimeHostId === runtimeHostId
          )
      ),
    [localParticipantId, participants, runtimeHostProviders, runtimeHosts]
  )

  const run = async (
    runtimeHostId: string,
    capability: RuntimeCapabilityProjection,
    operation: "observe" | "invoke",
    action?: string,
    args?: Record<string, unknown>
  ) => {
    setPending(true)
    setOutput("")
    try {
      const result = await onRequest({
        runtimeHostId,
        capabilityId: capability.capabilityId,
        operation,
        ...(action ? { action } : {}),
        ...(args ? { args } : {}),
      })
      setOutput(
        result.ok
          ? JSON.stringify(result.result ?? {}, null, 2)
          : `Request failed: ${result.error ?? "controller_error"}`
      )
    } finally {
      setPending(false)
    }
  }

  if (!hosts.length) return null

  return (
    <section
      aria-label="Local Runtime controls"
      className="w-72 rounded-xl border border-white/10 bg-black/80 p-3 text-sm text-white shadow-xl"
    >
      <h2 className="mb-2 font-semibold">Local Runtime control</h2>
      {hosts.map(([runtimeHostId, host]) => {
        const enabled =
          runtimeHostProviders?.[runtimeHostId]?.capabilityControlEnabled ===
          true
        return (
          <div key={runtimeHostId} className="space-y-2">
            <p className="text-xs text-white/65">
              {runtimeHostId.slice(0, 12)}
            </p>
            <button
              type="button"
              className="rounded-lg border border-white/20 px-3 py-1.5 hover:bg-white/10"
              onClick={() => onSetEnabled(runtimeHostId, !enabled)}
            >
              {enabled ? "Disable local control" : "Enable local control"}
            </button>
            {enabled &&
              host.capabilities?.map((capability) => (
                <div
                  key={capability.capabilityId}
                  className="space-y-2 rounded-lg bg-white/5 p-2"
                >
                  <div>
                    <div className="font-medium">{capability.title}</div>
                    <div className="text-xs text-white/55">
                      {capability.capabilityId} · v{capability.version}
                    </div>
                  </div>
                  {capability.observe && (
                    <button
                      type="button"
                      disabled={pending}
                      className="rounded border border-white/20 px-2 py-1 disabled:opacity-50"
                      onClick={() =>
                        void run(runtimeHostId, capability, "observe")
                      }
                    >
                      Observe state
                    </button>
                  )}
                  {capability.actions.map((action) => (
                    <div key={action.name} className="space-y-1">
                      <div className="text-xs">{action.title}</div>
                      {Object.entries(action.input.properties).map(
                        ([key, type]) => (
                          <label
                            key={key}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="w-20 truncate">{key}</span>
                            <input
                              aria-label={`${action.title} ${key}`}
                              className="min-w-0 flex-1 rounded bg-black/50 px-2 py-1 text-white"
                              type={type === "number" ? "number" : "text"}
                              value={
                                argsByAction[
                                  `${runtimeHostId}:${action.name}:${key}`
                                ] ?? String(primitiveDefault(type))
                              }
                              onChange={(event) =>
                                setArgsByAction((current) => ({
                                  ...current,
                                  [`${runtimeHostId}:${action.name}:${key}`]:
                                    event.target.value,
                                }))
                              }
                            />
                          </label>
                        )
                      )}
                      <button
                        type="button"
                        disabled={pending}
                        className="rounded border border-white/20 px-2 py-1 disabled:opacity-50"
                        onClick={() => {
                          const args: Record<string, unknown> = {}
                          for (const [key, type] of Object.entries(
                            action.input.properties
                          )) {
                            const value =
                              argsByAction[
                                `${runtimeHostId}:${action.name}:${key}`
                              ] ?? String(primitiveDefault(type))
                            args[key] =
                              type === "number"
                                ? Number(value)
                                : type === "boolean"
                                ? value === "true"
                                : value
                          }
                          void run(
                            runtimeHostId,
                            capability,
                            "invoke",
                            action.name,
                            args
                          )
                        }}
                      >
                        Run {action.title}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        )
      })}
      {controlError && (
        <p role="status" className="mt-2 text-xs text-rose-300">
          Control update failed: {controlError}
        </p>
      )}
      {output && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-2 text-xs">
          {output}
        </pre>
      )}
    </section>
  )
}
