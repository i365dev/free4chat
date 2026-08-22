import { spawnSync } from "node:child_process"

import { listLaunchers } from "./adapters/launchers.js"
import { RUNTIME_PACKAGE_NAME, RUNTIME_PACKAGE_VERSION } from "./bootstrap.js"
import type { AgentLauncher } from "./types.js"

export interface DoctorLauncherReport {
  id: string
  maturity: string
  security: string
  executable: string
  executableAvailable: boolean
  ready: boolean
  note?: string
}

export interface DoctorReport {
  package: string
  version: string
  node: string
  nodeCompatible: boolean
  platform: string
  launchers: DoctorLauncherReport[]
}

const DOCTOR_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
] as const

export function buildDoctorEnvironment(
  launcher: AgentLauncher,
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of DOCTOR_ENVIRONMENT_KEYS) {
    const value = baseEnvironment[key]
    if (value !== undefined) environment[key] = value
  }
  for (const [key, value] of Object.entries(launcher.environment ?? {}))
    environment[key] = value
  return environment
}

function canRun(command: string, environment: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
    timeout: 5_000,
    env: environment,
  })
  return result.error === undefined && result.status === 0
}

export function collectDoctorReport(
  environment: NodeJS.ProcessEnv = process.env
): DoctorReport {
  const nodeVersion = process.versions.node
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10)
  const hasDeepSeekRepo = Boolean(environment.FREE4CHAT_DEEPSEEK_REPO)

  return {
    package: RUNTIME_PACKAGE_NAME,
    version: RUNTIME_PACKAGE_VERSION,
    node: nodeVersion,
    nodeCompatible: nodeMajor >= 22,
    platform: `${process.platform}/${process.arch}`,
    launchers: listLaunchers().map((launcher) => {
      const executableAvailable = canRun(
        launcher.command,
        buildDoctorEnvironment(launcher, environment)
      )
      const configured = launcher.id !== "deepseek-harness" || hasDeepSeekRepo
      const ready = executableAvailable && configured
      let note: string | undefined
      if (!executableAvailable)
        note = `Executable ${launcher.command} is not available`
      else if (!configured)
        note = "Set the local DeepSeek Harness checkout before joining"
      else if (launcher.command === "npx")
        note = "The pinned bridge package is installed on first join"
      return {
        id: launcher.id,
        maturity: launcher.maturity,
        security: launcher.security,
        executable: launcher.command,
        executableAvailable,
        ready,
        note,
      }
    }),
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `${report.package} ${report.version}`,
    `Node ${report.node} (${report.nodeCompatible ? "compatible" : "requires Node >=22"})`,
    `Platform ${report.platform}`,
    "Launchers:",
  ]
  for (const launcher of report.launchers) {
    lines.push(
      `  ${launcher.id}: ${launcher.ready ? "ready" : "unavailable"} | ${launcher.maturity} | ${launcher.security}`
    )
    if (launcher.note) lines.push(`    ${launcher.note}`)
  }
  return lines.join("\n")
}
