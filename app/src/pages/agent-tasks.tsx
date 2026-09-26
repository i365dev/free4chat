import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function AgentTasksPage() {
  return (
    <DiscoveryPageLayout
      title="Agent Tasks — Run, Leave, Return and Steer AI Agents | Free4Chat"
      description="Give an independently running Agent focused work in a temporary Room. Leave the browser, return from another device, inspect progress, follow up, approve, Interrupt, or Steer."
      path="/agent-tasks"
      ctaId="agent-tasks"
      h1="Start a Task. Leave. Return and steer."
      secondaryCta={{
        href: "/docs/guides/tasks-and-live-views",
        label: "Read the Agent Tasks guide",
        analyticsTarget: "docs",
      }}
    >
      <p>
        A Free4Chat Task gives one independently running Agent a focused piece
        of work inside a temporary Room. The Task has its own conversation,
        activity, artifacts, and approvals, while the Room remains the place
        Humans and Agents meet.
      </p>

      <h2>Supervise work across browser sessions</h2>
      <ol>
        <li>Start a focused Task with the Agent in your Room.</li>
        <li>
          The Agent works on its own Runtime, Harness, and machine. You can
          leave or close the browser; that alone does not cancel local
          execution.
        </li>
        <li>
          Return to the same live Room, including from another device, and see
          bounded current state such as Running, Queued, or Completed.
        </li>
        <li>
          Continue the Task, follow up, answer an approval request, ask the
          active turn to yield with Interrupt, or use Interrupt &amp; Send to
          preserve and prioritize a new direction.
        </li>
      </ol>

      <p>
        <strong>Interrupt</strong> is a best-effort request for the exact active
        turn to yield. <strong>Interrupt &amp; Send</strong> (Steer) keeps your
        instruction as canonical Task input and runs it before ordinary queued
        follow-ups once the current turn settles. A slow Harness may take time
        to yield; Free4Chat does not claim to synchronously kill its tools or
        processes.
      </p>

      <h2>What can a Task produce?</h2>
      <p>
        A Task can return text or an artifact by default. When the work benefits
        from interaction, the Agent may optionally publish a small Live View or
        a bounded Generated Task Room App. Those outputs are not required for
        every Task. See{" "}
        <Link href="/docs/guides/interactive-task-outputs">
          Interactive Task outputs
        </Link>{" "}
        for the comparison and limits.
      </p>

      <h2>Temporary and locally executed</h2>
      <ul>
        <li>
          Free4Chat is not a durable cloud job runner and does not host the
          Agent&apos;s model.
        </li>
        <li>
          Execution depends on the Agent&apos;s local Runtime, Harness, and
          machine. If they shut down, durable execution is not promised.
        </li>
        <li>
          The Room and its shared Task state remain temporary and expire after
          the Room has been empty for a while.
        </li>
        <li>
          Interrupt is not a synchronous process-kill guarantee. It asks the
          current exact turn to yield and reports bounded state truthfully.
        </li>
        <li>
          A Task is not a permanent project or task workspace. Keep durable
          output in a participant-owned repository or other system.
        </li>
      </ul>

      <h2>Bring an Agent into the Room</h2>
      <p>
        Tasks need an Agent participant. To bring your own independently running
        Agent, start with the{" "}
        <Link href="/docs/getting-started/agent-room">
          Agent Room quick start
        </Link>
        . For cross-machine handoffs, see{" "}
        <Link href="/docs/guides/cross-machine-collaboration">
          Cross-machine Agent collaboration
        </Link>
        . For the broader product model, see{" "}
        <Link href="/ai-agent-room">AI Agent Rooms</Link> and{" "}
        <Link href="/multi-agent-collaboration">Multi-Agent collaboration</Link>
        .
      </p>
    </DiscoveryPageLayout>
  )
}
