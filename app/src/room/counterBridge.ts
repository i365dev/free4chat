export interface CounterParticipantProjection {
  participantId: string
  displayName: string
  mayAct: boolean
}

export interface CounterProjection {
  value: number
  revision: number
  participant: CounterParticipantProjection
  participants: Array<{
    participantId: string
    displayName: string
    isCurrentTurn: boolean
  }>
  currentTurnParticipantId: string | null
}

export interface CounterIncrementResult {
  value: number
  revision: number
  participantId: string
  duplicate: boolean
}

export class CounterBridgeError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "CounterBridgeError"
    this.status = status
    this.code = code
  }
}

interface CounterCreateResponse {
  instanceId?: unknown
}

interface CounterJoinResponse {
  accessToken?: unknown
  projection?: unknown
}

interface CounterIncrementResponse {
  value?: unknown
  revision?: unknown
  participantId?: unknown
  duplicate?: unknown
}

const PARTICIPANT_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,80}$/

function endpoint(baseUrl: string, path: string): string {
  const root = baseUrl.trim()
  if (!root)
    throw new CounterBridgeError(
      503,
      "counter_unconfigured",
      "Counter is not configured"
    )
  return new URL(
    path.replace(/^\//, ""),
    `${root.replace(/\/$/, "")}/`
  ).toString()
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  let response: Response
  try {
    response = await fetch(endpoint(baseUrl, path), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw new CounterBridgeError(
      503,
      "counter_unavailable",
      "Counter is unavailable"
    )
  }

  const payload = (await response.json().catch(() => null)) as {
    code?: unknown
    message?: unknown
  } | null
  if (!response.ok) {
    const code =
      typeof payload?.code === "string" ? payload.code : "counter_error"
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : "Counter request failed"
    throw new CounterBridgeError(response.status, code, message.slice(0, 160))
  }
  return payload as T
}

function validateParticipantId(participantId: string): void {
  if (!PARTICIPANT_ID_PATTERN.test(participantId))
    throw new CounterBridgeError(
      400,
      "invalid_participant",
      "Invalid participant id"
    )
}

function validateProjection(value: unknown): CounterProjection {
  if (!value || typeof value !== "object")
    throw new CounterBridgeError(
      502,
      "invalid_counter_projection",
      "Counter projection is invalid"
    )
  const projection = value as Partial<CounterProjection>
  const participant = projection.participant
  const participants = projection.participants
  if (
    typeof projection.value !== "number" ||
    !Number.isSafeInteger(projection.value) ||
    typeof projection.revision !== "number" ||
    !Number.isSafeInteger(projection.revision) ||
    !participant ||
    typeof participant !== "object" ||
    typeof participant.participantId !== "string" ||
    typeof participant.displayName !== "string" ||
    typeof participant.mayAct !== "boolean" ||
    !Array.isArray(participants) ||
    !participants.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.participantId === "string" &&
        typeof entry.displayName === "string" &&
        typeof entry.isCurrentTurn === "boolean"
    ) ||
    !(
      projection.currentTurnParticipantId === null ||
      typeof projection.currentTurnParticipantId === "string"
    )
  )
    throw new CounterBridgeError(
      502,
      "invalid_counter_projection",
      "Counter projection is invalid"
    )

  return {
    value: projection.value,
    revision: projection.revision,
    participant: {
      participantId: participant.participantId,
      displayName: participant.displayName,
      mayAct: participant.mayAct,
    },
    participants: participants.map((entry) => ({
      participantId: entry.participantId,
      displayName: entry.displayName,
      isCurrentTurn: entry.isCurrentTurn,
    })),
    currentTurnParticipantId: projection.currentTurnParticipantId ?? null,
  }
}

export async function createCounterInstance(baseUrl: string): Promise<string> {
  const response = await requestJson<CounterCreateResponse>(
    baseUrl,
    "/counter",
    {
      method: "POST",
    }
  )
  if (typeof response.instanceId !== "string" || !response.instanceId)
    throw new CounterBridgeError(
      502,
      "invalid_counter_instance",
      "Counter instance is invalid"
    )
  return response.instanceId
}

export async function joinCounter(
  baseUrl: string,
  instanceId: string,
  participantId: string,
  displayName: string
): Promise<{ accessToken: string; projection: CounterProjection }> {
  validateParticipantId(participantId)
  const response = await requestJson<CounterJoinResponse>(
    baseUrl,
    `/counter/${encodeURIComponent(instanceId)}/join`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId,
        displayName: displayName.trim().slice(0, 80) || participantId,
      }),
    }
  )
  if (typeof response.accessToken !== "string" || !response.accessToken)
    throw new CounterBridgeError(
      502,
      "invalid_counter_capability",
      "Counter capability is invalid"
    )
  return {
    accessToken: response.accessToken,
    projection: validateProjection(response.projection),
  }
}

export async function readCounterProjection(
  baseUrl: string,
  instanceId: string,
  accessToken: string
): Promise<CounterProjection> {
  if (!accessToken)
    throw new CounterBridgeError(
      401,
      "unauthorized",
      "Counter capability is missing"
    )
  const response = await requestJson<unknown>(
    baseUrl,
    `/counter/${encodeURIComponent(instanceId)}/state`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return validateProjection(response)
}

export async function incrementCounter(
  baseUrl: string,
  instanceId: string,
  accessToken: string,
  idempotencyKey: string,
  expectedRevision: number
): Promise<CounterIncrementResult> {
  if (!accessToken)
    throw new CounterBridgeError(
      401,
      "unauthorized",
      "Counter capability is missing"
    )
  const response = await requestJson<CounterIncrementResponse>(
    baseUrl,
    `/counter/${encodeURIComponent(instanceId)}/actions/increment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ idempotencyKey, expectedRevision }),
    }
  )
  if (
    typeof response.value !== "number" ||
    !Number.isSafeInteger(response.value) ||
    typeof response.revision !== "number" ||
    !Number.isSafeInteger(response.revision) ||
    typeof response.participantId !== "string" ||
    typeof response.duplicate !== "boolean"
  )
    throw new CounterBridgeError(
      502,
      "invalid_counter_result",
      "Counter result is invalid"
    )
  return {
    value: response.value,
    revision: response.revision,
    participantId: response.participantId,
    duplicate: response.duplicate,
  }
}
