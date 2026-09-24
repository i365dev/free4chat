import { useEffect, useState } from "react"

import ParticipantAvatar from "../components/ParticipantAvatar"
import RoomCosmosBackdrop from "../components/RoomCosmosBackdrop"
import TaskSessionPicker from "../components/TaskSessionPicker"

type PreviewParticipant = {
  name: string
  role: string
  tone: "amber" | "cyan" | "violet" | "mint" | "rose" | "blue"
}

const previewParticipants: PreviewParticipant[] = [
  { name: "PR457 Witness", role: "YOU · HUMAN", tone: "amber" },
  { name: "Mira", role: "HUMAN", tone: "cyan" },
  { name: "Kepler", role: "AGENT", tone: "mint" },
  { name: "Nora", role: "HUMAN", tone: "rose" },
  { name: "Atlas", role: "AGENT", tone: "mint" },
  { name: "Orion", role: "HUMAN", tone: "amber" },
]

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4m-4 0h8" />
      {muted && <path d="M3 3l18 18" strokeWidth="2" />}
    </svg>
  )
}

function ParticipantStation({
  participant,
  index,
  speaking,
  onToggleVoice,
  compact,
}: {
  participant: PreviewParticipant
  index: number
  speaking: boolean
  onToggleVoice?: () => void
  compact: boolean
}) {
  const isSelf = index === 0
  const muted = isSelf && !speaking

  return (
    <article
      className={`cosmic-v3-station cosmic-v3-station--${participant.tone} ${
        speaking ? "cosmic-v3-station--speaking" : ""
      } ${compact ? "cosmic-v3-station--compact" : ""}`}
      aria-label={`${participant.name}, ${participant.role}${
        speaking ? ", transmitting" : ""
      }`}
    >
      <div className="cosmic-v3-orbit" aria-hidden="true" />
      <div className="cosmic-v3-planet-wrap">
        <div className="cosmic-v3-transmission" aria-hidden="true" />
        <ParticipantAvatar name={participant.name} />
      </div>
      <div className="cosmic-v3-station-label">
        <span className="cosmic-v3-station-index">
          0{index + 1} / {participant.role}
        </span>
        <strong>{participant.name}</strong>
        <span className="cosmic-v3-station-frequency">
          <span
            className={speaking ? "cosmic-v3-live-dot" : "cosmic-v3-idle-dot"}
          />
          {speaking ? "TRANSMITTING" : "CONNECTED"}
          <span className="cosmic-v3-station-freq-value">143.8 MHZ</span>
        </span>
        {isSelf && (
          <button
            type="button"
            className="cosmic-v3-mic"
            onClick={onToggleVoice}
            aria-label={
              muted
                ? "Turn preview microphone on"
                : "Turn preview microphone off"
            }
          >
            <MicIcon muted={muted} />
            {muted ? "MIC OFF" : "MIC ON"}
          </button>
        )}
      </div>
    </article>
  )
}

export default function CosmicPrototypePage() {
  const [voiceOn, setVoiceOn] = useState(false)
  const [participantCount, setParticipantCount] = useState<2 | 6>(2)
  const [stageOpen, setStageOpen] = useState(true)
  const [taskOpen, setTaskOpen] = useState(false)
  const [sessionMode, setSessionMode] = useState<"new" | "continue">("new")
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [visible, setVisible] = useState(true)
  const visibleParticipants = previewParticipants.slice(0, participantCount)
  const compact = participantCount > 4

  useEffect(() => {
    const updateVisibility = () =>
      setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", updateVisibility)
    updateVisibility()
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility)
  }, [])

  return (
    <main
      className="cosmic-v3 room-shell flex h-screen min-h-[480px] flex-col overflow-hidden text-white"
      data-visible={visible}
    >
      <header className="cosmic-v3-header">
        <div className="cosmic-v3-brand" aria-hidden="true">
          F<span>4</span>C <em>⟡</em>
        </div>
        <div className="cosmic-v3-room-heading">
          <span className="cosmic-v3-eyebrow">FREE4CHAT // ROOM RELAY</span>
          <h1>#cosmic-radio-lab</h1>
        </div>
        <div className="cosmic-v3-header-right">
          <span className="cosmic-v3-header-status">
            <i /> CHANNEL OPEN
          </span>
          <button type="button" onClick={() => setTaskOpen(true)}>
            TASK WINDOW
          </button>
          <button
            type="button"
            onClick={() =>
              setParticipantCount((count) => (count === 2 ? 6 : 2))
            }
          >
            {participantCount === 2 ? "VIEW 6 PEOPLE" : "VIEW 2 PEOPLE"}
          </button>
        </div>
      </header>

      <div className="cosmic-v3-body">
        <section
          className={`cosmic-v3-stage ${
            stageOpen ? "cosmic-v3-stage--open" : ""
          }`}
          aria-label="Room participants"
        >
          <RoomCosmosBackdrop />
          <div className="cosmic-v3-stage-grid" aria-hidden="true" />
          <div className="cosmic-v3-stage-hud">
            <div>
              <span className="cosmic-v3-eyebrow">01 / DEEP SPACE RELAY</span>
              <h2>
                THE ROOM <span>IS LIVE</span>
              </h2>
            </div>
            <div className="cosmic-v3-stage-count">
              <span>●</span> {participantCount.toString().padStart(2, "0")}{" "}
              ONLINE
            </div>
          </div>

          <div
            className={`cosmic-v3-scene ${
              compact ? "cosmic-v3-scene--compact" : ""
            }`}
          >
            {!compact && (
              <div
                className={`cosmic-v3-connection ${
                  voiceOn ? "cosmic-v3-connection--active" : ""
                }`}
                aria-hidden="true"
              >
                <span className="cosmic-v3-connection-line" />
                <span className="cosmic-v3-connection-label">
                  VOICE LINK / 143.8 MHZ
                </span>
              </div>
            )}
            {visibleParticipants.map((participant, index) => (
              <ParticipantStation
                key={participant.name}
                participant={participant}
                index={index}
                speaking={index === 0 && voiceOn}
                onToggleVoice={() => setVoiceOn((on) => !on)}
                compact={compact}
              />
            ))}
          </div>

          <div className="cosmic-v3-stage-footer">
            <span>
              <b>◇</b> ENCRYPTED ROOM FREQUENCY
            </span>
            <span>
              EPHEMERAL CONNECTION <b>✦</b>
            </span>
          </div>
          <button
            type="button"
            className="cosmic-v3-mobile-switch"
            onClick={() => setStageOpen(false)}
          >
            OPEN ROOM CHAT ↗
          </button>
        </section>

        <aside className="cosmic-v3-chat" aria-label="Room chat preview">
          <div className="cosmic-v3-chat-head">
            <div>
              <span className="cosmic-v3-eyebrow">02 / TRANSMISSION LOG</span>
              <h2>ROOM CHAT</h2>
            </div>
            <span className="cosmic-v3-chat-live">
              <i /> LIVE
            </span>
            <button
              type="button"
              className="cosmic-v3-mobile-people"
              onClick={() => setStageOpen(true)}
            >
              PEOPLE ↗
            </button>
          </div>
          <div className="cosmic-v3-chat-toolbar">
            <span className="cosmic-v3-chat-tab">◈ &nbsp; ROOM</span>
            <span>ALL PARTICIPANTS</span>
          </div>
          <div className="cosmic-v3-chat-feed">
            <div className="cosmic-v3-log-date">
              <span>TRANSMISSION BEGINS</span>
            </div>
            <div className="cosmic-v3-log-system">
              ◈ &nbsp; Room established. Your channel is ready.
            </div>
            <div className="cosmic-v3-message">
              <div className="cosmic-v3-message-meta">
                <span className="cosmic-v3-avatar-dot cosmic-v3-avatar-dot--cyan" />{" "}
                MIRA <time>21:42</time>
              </div>
              <p>Can you hear me from this side of the universe?</p>
            </div>
            <div className="cosmic-v3-message cosmic-v3-message--self">
              <div className="cosmic-v3-message-meta">
                <span className="cosmic-v3-avatar-dot cosmic-v3-avatar-dot--amber" />{" "}
                YOU <time>21:42</time>
              </div>
              <p>Signal is clear. Coming through perfectly.</p>
            </div>
            <div
              className={`cosmic-v3-voice-log ${
                voiceOn ? "cosmic-v3-voice-log--active" : ""
              }`}
            >
              <span className="cosmic-v3-voice-bars" aria-hidden="true">
                ▂▅▃▆▂▅▃
              </span>
              {voiceOn ? "YOU ARE TRANSMITTING" : "VOICE CHANNEL STANDBY"}
              <span>{voiceOn ? "LIVE" : "READY"}</span>
            </div>
          </div>
          <div className="cosmic-v3-composer">
            <label htmlFor="cosmic-v3-message" className="sr-only">
              Message the room
            </label>
            <input
              id="cosmic-v3-message"
              placeholder="Transmit a message to the room…"
            />
            <button type="button" aria-label="Preview send message">
              ↗
            </button>
            <p>
              ↵ SEND MESSAGE <span>·</span> VOICE CONNECTED <span>·</span>{" "}
              PREVIEW CONTENT
            </p>
          </div>
        </aside>
      </div>
      {taskOpen && (
        <div
          className="cosmic-v3-task-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cosmic-v3-task-title"
        >
          <form
            className="room-task-dialog w-full max-w-md border p-5"
            onSubmit={(event) => {
              event.preventDefault()
              setTaskOpen(false)
            }}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <span className="cosmic-v3-eyebrow">
                  03 / NEW TASK TRANSMISSION
                </span>
                <h2
                  id="cosmic-v3-task-title"
                  className="mt-2 text-base font-semibold"
                >
                  Start task with Kepler
                </h2>
                <p className="mt-1 text-xs text-gray-400">
                  Give this Agent one thing to work on.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTaskOpen(false)}
                aria-label="Close task preview"
              >
                ×
              </button>
            </div>
            <fieldset className="mb-4">
              <legend className="mb-2 block text-sm text-gray-200">
                Session
              </legend>
              <div
                role="radiogroup"
                aria-label="Session"
                className="flex gap-2"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={sessionMode === "new"}
                  onClick={() => setSessionMode("new")}
                  className="flex-1 border px-3 py-1.5 text-xs"
                >
                  New session
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={sessionMode === "continue"}
                  onClick={() => setSessionMode("continue")}
                  className="flex-1 border px-3 py-1.5 text-xs"
                >
                  Continue session
                </button>
              </div>
              {sessionMode === "continue" && (
                <div className="mt-3">
                  <TaskSessionPicker
                    status="ready"
                    sessions={[
                      {
                        token: "session-a",
                        title: "Investigate the signal relay",
                        projectToken: "project-a",
                        projectLabel: "free4chat",
                        updatedAt: new Date().toISOString(),
                      },
                    ]}
                    projects={[{ token: "project-a", label: "free4chat" }]}
                    hasMore={false}
                    loadingMore={false}
                    error=""
                    selectedToken={selectedSession}
                    projectToken={null}
                    onSelect={(session) => setSelectedSession(session.token)}
                    onProjectChange={() => undefined}
                    onLoadMore={() => undefined}
                    onRefresh={() => undefined}
                  />
                </div>
              )}
            </fieldset>
            <label
              htmlFor="cosmic-v3-task-instruction"
              className="mb-2 block text-sm text-gray-200"
            >
              What should this Agent do?
            </label>
            <textarea
              id="cosmic-v3-task-instruction"
              rows={4}
              className="w-full resize-none border px-3 py-2 text-sm text-white outline-none"
              placeholder="Describe the task…"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTaskOpen(false)}
                className="border px-3 py-2 text-sm text-gray-300"
              >
                Cancel
              </button>
              <button type="submit" className="px-3 py-2 text-sm font-medium">
                Start task
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}
