import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function RemoteAgentPage() {
  return (
    <DiscoveryPageLayout
      title="Remote Agent Supervision Across Devices | Free4Chat"
      description="Run an Agent on macOS or Linux and supervise its focused Tasks from another browser or device. The Agent stays on its own Runtime and machine."
      path="/remote-agent"
      ctaId="remote-agent"
      h1="Run the Agent there. Supervise it from here."
      secondaryCta={{
        href: "/docs/getting-started/agent-room",
        label: "Read the Agent Room quick start",
        analyticsTarget: "docs",
      }}
    >
      <p>
        Start the Agent where its repository, tools, and Harness already are.
        Use a temporary Free4Chat Room to check a focused Task from another
        browser or device while execution stays on that machine.
      </p>

      <p>
        <strong>
          Agent Runtime: macOS + Linux. Human supervision: any supported modern
          browser, including Windows and mobile.
        </strong>{" "}
        Windows does not currently host the Agent Runtime.
      </p>

      <pre>
        <code>{`Mac / Linux machine
    ↓
Agent Runtime + Harness
    ↓
temporary Free4Chat Room
    ↓
Human browser
Windows / macOS / Linux / mobile`}</code>
      </pre>

      <h2>Start, leave, and return</h2>
      <ol>
        <li>
          Start or join your Agent on its own macOS or Linux machine. Its local
          Runtime and Harness own execution.
        </li>
        <li>Start a focused Task with that Agent in a temporary Room.</li>
        <li>
          Leave or close the browser if needed. Closing it does not itself stop
          local execution.
        </li>
        <li>
          Return to the same live Room from another supported browser or device,
          including Windows or mobile.
        </li>
        <li>Inspect whether the Task is Running, Queued, or Completed.</li>
        <li>
          Follow up, answer an approval request, ask the active turn to yield
          with Interrupt, or steer it with Interrupt &amp; Send.
        </li>
      </ol>

      <h2>The machine still owns the work</h2>
      <p>
        Closing a browser does not itself stop local execution, but the Agent
        Runtime, Harness, and machine must keep running for that work to
        continue. If that machine or Runtime stops, durable execution is not
        promised. Free4Chat provides a temporary Room for supervision; it is not
        a cloud job runner, and the Room itself is not permanent.
      </p>

      <h2>Learn more</h2>
      <ul>
        <li>
          <Link href="/agent-tasks">Agent Tasks</Link> — follow up, approve,
          Interrupt, and Steer.
        </li>
        <li>
          <Link href="/docs/getting-started/agent-room">
            Agent Room quick start
          </Link>{" "}
          — install a supported Runtime and join a Room.
        </li>
        <li>
          <Link href="/docs/concepts/runtime-harness">Runtime and Harness</Link>{" "}
          — how local execution is owned.
        </li>
      </ul>
    </DiscoveryPageLayout>
  )
}
