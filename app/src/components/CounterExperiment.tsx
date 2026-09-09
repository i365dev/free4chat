import { useCallback, useEffect, useState } from "react"

import type { CounterProjection } from "../room/counterBridge"
import type { CounterTaskPublic } from "../room/types"

interface RoomAuth {
  roomId: string
  participantId: string
  token: string
}

interface CounterResponse {
  projection?: CounterProjection
  error?: string
}

interface CounterExperimentProps {
  counterTask?: CounterTaskPublic
  auth: RoomAuth | null
}

export default function CounterExperiment({
  counterTask,
  auth,
}: CounterExperimentProps) {
  const [projection, setProjection] = useState<CounterProjection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const roomId = auth?.roomId
  const localParticipantId = auth?.participantId
  const roomToken = auth?.token

  const request = useCallback(
    async (operation: "start" | "join" | "state" | "increment") => {
      if (!roomId || !localParticipantId || !roomToken) return null
      setBusy(true)
      setError("")
      try {
        const response = await fetch("/api/room/experiments/counter", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Room-Id": roomId,
            "X-Room-Participant-Id": localParticipantId,
            "X-Room-Participant-Token": roomToken,
          },
          body: JSON.stringify({ operation }),
        })
        const payload = (await response
          .json()
          .catch(() => ({}))) as CounterResponse
        if (!response.ok) {
          setError(payload.error ?? `counter_${response.status}`)
          return null
        }
        if (payload.projection) setProjection(payload.projection)
        return payload
      } catch {
        setError("counter_unavailable")
        return null
      } finally {
        setBusy(false)
      }
    },
    [localParticipantId, roomId, roomToken]
  )

  const isAttached = Boolean(
    counterTask &&
      localParticipantId &&
      counterTask.participants.some(
        (participant) => participant.participantId === localParticipantId
      )
  )

  useEffect(() => {
    setError("")
    if (
      !counterTask ||
      !roomId ||
      !localParticipantId ||
      !roomToken ||
      !isAttached
    ) {
      setProjection(null)
      return
    }
    void request("state")
  }, [
    counterTask,
    counterTask?.taskId,
    counterTask?.revision,
    isAttached,
    localParticipantId,
    request,
    roomId,
    roomToken,
  ])

  if (!auth) return null

  if (!counterTask) {
    return (
      <section
        className="border-b border-gray-800 bg-gray-950/50 p-4"
        data-testid="counter-experiment"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">
              Counter experiment
            </h2>
            <p className="text-xs text-gray-400">
              Start one shared deterministic task for this Room.
            </p>
          </div>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void request("start")}
          >
            {busy ? "Starting…" : "Start Counter"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}
      </section>
    )
  }

  if (!isAttached) {
    return (
      <section
        className="border-b border-gray-800 bg-gray-950/50 p-4"
        data-testid="counter-experiment"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">
              {counterTask.surface.title}
            </h2>
            <p className="text-xs text-gray-400">
              A Room participant is already running this shared task.
            </p>
          </div>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={busy || counterTask.participants.length >= 2}
            onClick={() => void request("join")}
          >
            {busy
              ? "Joining…"
              : counterTask.participants.length >= 2
              ? "Full"
              : "Join Counter"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}
      </section>
    )
  }

  const mayAct = projection?.participant.mayAct === true
  return (
    <section
      className="border-b border-gray-800 bg-gray-950/50 p-4"
      data-testid="counter-experiment"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">
            {counterTask.surface.title}
          </h2>
          <p data-testid="counter-status" className="text-xs text-gray-400">
            Count:{" "}
            <span data-testid="counter-value">
              {projection?.value ?? counterTask.value}
            </span>
            {" · "}
            Revision: {projection?.revision ?? counterTask.revision}
            {" · "}
            {projection ? (mayAct ? "your turn" : "waiting") : "loading"}
          </p>
        </div>
        <button
          type="button"
          data-testid="counter-increment"
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !projection || !mayAct}
          onClick={() => void request("increment")}
        >
          {busy ? "Updating…" : counterTask.surface.actions[0].label}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-amber-300" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
