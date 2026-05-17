import OpenAI from "openai"

type AiMessage = { role: "system" | "user" | "assistant"; content: string }

interface Env {
  CF_AIG_TOKEN: string
  CF_AI_GATEWAY_BASEURL: string
}

interface HourlyState {
  window: number
  count: number
}

const BOT_SYSTEM_PROMPT =
  "You are Luna, a concise and friendly AI assistant in a voice+text chat room. " +
  "Keep replies short (1-3 sentences). If the user speaks Chinese, reply in Chinese. " +
  "Never use markdown tables or code blocks — plain text only."

function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim()
}

const MAX_HISTORY = 20
const HOURLY_RATE_LIMIT = 30
const BOT_MODEL = "workers-ai/@cf/zai-org/glm-4.7-flash"

export class BotSession implements DurableObject {
  private history: AiMessage[] | null = null
  private hourlyWindow = 0
  private hourlyCount = 0
  private loadPromise: Promise<void> | null = null
  private readonly client: OpenAI

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    this.client = new OpenAI({
      apiKey: env.CF_AIG_TOKEN,
      baseURL: env.CF_AI_GATEWAY_BASEURL,
    })
  }

  private async loadState(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      this.history =
        (await this.state.storage.get<AiMessage[]>("history")) ?? []
      const hourly = (await this.state.storage.get<HourlyState>("hourly")) ?? {
        window: 0,
        count: 0,
      }
      this.hourlyWindow = hourly.window
      this.hourlyCount = hourly.count
    })()
    return this.loadPromise
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 })
    }

    let userMessage: string, userName: string
    try {
      const body = await request.json<{
        userMessage: string
        userName: string
      }>()
      userMessage = body.userMessage
      userName = body.userName
    } catch {
      return new Response("Bad Request", { status: 400 })
    }

    if (
      !userMessage ||
      !userName ||
      typeof userMessage !== "string" ||
      typeof userName !== "string"
    ) {
      return Response.json({ error: "invalid_input" }, { status: 400 })
    }

    await this.loadState()

    const history = this.history!
    const currentHour = Math.floor(Date.now() / 3_600_000)
    if (currentHour !== this.hourlyWindow) {
      this.hourlyWindow = currentHour
      this.hourlyCount = 0
    }
    if (this.hourlyCount >= HOURLY_RATE_LIMIT) {
      return Response.json({ error: "rate_limited" })
    }

    history.push({ role: "user", content: `${userName}: ${userMessage}` })
    while (history.length > MAX_HISTORY) history.shift()

    const messages: AiMessage[] = [
      { role: "system", content: BOT_SYSTEM_PROMPT },
      ...history,
    ]

    try {
      const completion = await this.client.chat.completions.create({
        model: BOT_MODEL,
        messages,
      })
      const reply = stripThinkTags(
        completion.choices[0]?.message?.content ?? ""
      )
      if (reply) {
        history.push({ role: "assistant", content: reply })
        while (history.length > MAX_HISTORY) history.shift()
      }
      this.hourlyCount++
      await this.state.storage.put({
        hourly: {
          window: this.hourlyWindow,
          count: this.hourlyCount,
        } as HourlyState,
        history,
      })
      return Response.json({ reply })
    } catch (err) {
      console.error("[BotSession] AI error:", err)
      return Response.json({ error: "ai_error" }, { status: 500 })
    }
  }
}
