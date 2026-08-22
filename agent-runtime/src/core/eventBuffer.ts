import type { RoomEvent } from "../types.js"

const DEFAULT_MAX_EVENTS = 50
const DEFAULT_MAX_CHARS = 32_000

export class EventBuffer {
  private events: RoomEvent[] = []

  constructor(
    private readonly maxEvents = DEFAULT_MAX_EVENTS,
    private readonly maxChars = DEFAULT_MAX_CHARS
  ) {}

  add(event: RoomEvent): void {
    this.events.push(event)
    while (
      this.events.length > this.maxEvents ||
      JSON.stringify(this.events).length > this.maxChars
    )
      this.events.shift()
  }

  since(sequence: number, through = Number.POSITIVE_INFINITY): RoomEvent[] {
    return this.events.filter(
      (event) => event.sequence > sequence && event.sequence <= through
    )
  }

  snapshot(): RoomEvent[] {
    return [...this.events]
  }

  clear(): void {
    this.events = []
  }
}

export function boundedPush<T>(items: T[], item: T, maxItems: number): void {
  items.push(item)
  while (items.length > maxItems) items.shift()
}
