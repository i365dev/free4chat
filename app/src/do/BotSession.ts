type AiMessage = { role: "system" | "user" | "assistant"; content: string }
type AiRunFn = (
  model: string,
  inputs: { messages: AiMessage[] },
  options?: { gateway?: { id: string; skipCache?: boolean } }
) => Promise<{ response?: string }>

interface Env {
  AI: { run: AiRunFn }
  CF_AI_GATEWAY_ID?: string
}

const BOT_SYSTEM_PROMPT =
  "You are Luna, a concise and friendly AI assistant in a voice+text chat room. " +
  "Keep replies short (1-3 sentences). If the user speaks Chinese, reply in Chinese."

const MAX_HISTORY = 20
const HOURLY_RATE_LIMIT = 30
const BOT_MODEL = "@cf/zai-org/glm-4.7-flash"

export class BotSession implements DurableObject {
  private history: AiMessage[] = []
  private hourlyCount = 0
  private hourlyWindow = 0

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 })
    }

    const { userMessage, userName } = await request.json<{
      userMessage: string
      userName: string
    }>()

    if (!userMessage || !userName) {
      return Response.json({ error: "invalid_input" }, { status: 400 })
    }

    const currentHour = Math.floor(Date.now() / 3_600_000)
    if (currentHour !== this.hourlyWindow) {
      this.hourlyWindow = currentHour
      this.hourlyCount = 0
    }
    if (this.hourlyCount >= HOURLY_RATE_LIMIT) {
      return Response.json({ error: "rate_limited" })
    }
    this.hourlyCount++

    this.history.push({
      role: "user",
      content: `${userName}: ${userMessage}`,
    })
    if (this.history.length > MAX_HISTORY) {
      this.history.shift()
    }

    const messages: AiMessage[] = [
      { role: "system", content: BOT_SYSTEM_PROMPT },
      ...this.history,
    ]

    const gatewayOptions = this.env.CF_AI_GATEWAY_ID
      ? { gateway: { id: this.env.CF_AI_GATEWAY_ID, skipCache: false } }
      : undefined

    try {
      const result = await this.env.AI.run(
        BOT_MODEL,
        { messages },
        gatewayOptions
      )
      const reply = result?.response ?? ""
      this.history.push({ role: "assistant", content: reply })
      return Response.json({ reply })
    } catch (err) {
      console.error("[BotSession] AI error:", err)
      return Response.json({ error: "ai_error" }, { status: 500 })
    }
  }
}
