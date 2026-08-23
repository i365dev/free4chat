import { createInterface } from "node:readline"
import { stdin, stderr } from "node:process"

import type { SpeechSetupField } from "./types.js"

export interface SetupInput {
  read(field: SpeechSetupField): Promise<string>
}

/** Small injectable boundary; tests never need to create a real TTY. */
export class TerminalSetupInput implements SetupInput {
  async read(field: SpeechSetupField): Promise<string> {
    stderr.write(`${field.label}: `)
    if (field.secret && stdin.isTTY && typeof stdin.setRawMode === "function")
      return this.readHidden()
    const rl = createInterface({ input: stdin, terminal: Boolean(stdin.isTTY) })
    try {
      return (
        await new Promise<string>((resolve) => {
          rl.question("", resolve)
        })
      ).trim()
    } finally {
      rl.close()
      if (field.secret) stderr.write("\n")
    }
  }

  private readHidden(): Promise<string> {
    stdin.setRawMode!(true)
    stdin.setEncoding("utf8")
    stdin.resume()
    return new Promise<string>((resolve, reject) => {
      let value = ""
      const cleanup = () => {
        stdin.removeListener("data", onData)
        stdin.setRawMode?.(false)
        stdin.pause()
        stderr.write("\n")
      }
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            cleanup()
            reject(new Error("secret input cancelled"))
            return
          }
          if (character === "\r" || character === "\n") {
            cleanup()
            resolve(value)
            return
          }
          if (character === "\u007f") {
            value = value.slice(0, -1)
            continue
          }
          value += character
        }
      }
      stdin.on("data", onData)
    })
  }
}
