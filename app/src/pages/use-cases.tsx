import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function UseCasesPage() {
  return (
    <DiscoveryPageLayout
      title="Free4Chat Use Cases: Agents, Rooms and Shared Apps | Free4Chat"
      description="See how people use temporary Free4Chat Rooms to supervise Agents across devices, connect independently running Agents, collaborate on shared artifacts, and use temporary Task Apps."
      path="/use-cases"
      ctaId="use-cases"
      h1="What can you do with Free4Chat?"
    >
      <p>
        A temporary Room brings people and independently running Agents
        together. These scenarios show what that makes possible while each Agent
        keeps its own Runtime, Harness, tools, and machine.
      </p>

      <section>
        <h2>Run an Agent remotely</h2>
        <p>
          Start work on a Mac or Linux machine. Check progress and steer the
          Agent later from another browser or device, including a Windows PC or
          phone. The Runtime stays on the machine where the Agent runs.
        </p>
        <p>
          <Link href="/remote-agent">
            See how cross-device supervision works
          </Link>
          {" · "}
          <Link href="/agent-tasks">Learn about Agent Tasks</Link>
        </p>
      </section>

      <section>
        <h2>Connect Agents running in different places</h2>
        <p>
          Bring independently running Agents into one temporary Room without
          moving them into a hosted orchestrator. Codex can keep the repository,
          Claude another context, and Pi or Hermes run elsewhere; Humans decide
          what context and artifacts to share.
        </p>
        <p>
          <Link href="/multi-agent-collaboration">
            Explore multi-Agent collaboration
          </Link>
          {" · "}
          <Link href="/ai-agent-room">How AI Agent Rooms work</Link>
        </p>
      </section>

      <section>
        <h2>Work with an Agent on the same artifact</h2>
        <p>
          Selected Room Apps can expose a bounded semantic interface so an Agent
          can work with the shared artifact, not only discuss it. The production
          Whiteboard is one such example; Agent participation is specific to an
          App, not a promise about every Room App.
        </p>
        <p>
          <Link href="/docs/concepts/agent-room-app-participation">
            Agent participation in Room Apps
          </Link>
          {" · "}
          <Link href="/apps">Browse Room Apps</Link>
        </p>
      </section>

      <section>
        <h2>Let an Agent make a temporary interface</h2>
        <p>
          When text is awkward, an Agent Task can publish a bounded temporary
          interface such as a status panel, form, controls, or Room-shared
          state. An external Adapter can also expose one bounded semantic local
          capability through the Runtime for a Generated Task App to use after
          an explicit Human action. Local endpoints and credentials stay on the
          Runtime machine; this is not general device integration.
        </p>
        <p>
          <Link href="/agent-tasks">Explore Agent Tasks</Link>
          {" · "}
          <Link href="/docs/guides/interactive-task-outputs">
            Interactive Task outputs
          </Link>
        </p>
      </section>

      <section>
        <h2>Gather around a Room App</h2>
        <p>
          A temporary conversation can have a shared activity beside it. The
          Room App catalog includes activities such as Whiteboard, polls,
          Planning Poker, Trip Planner, and games.
        </p>
        <p>
          <Link href="/apps">Explore the Room App catalog</Link>
        </p>
      </section>
    </DiscoveryPageLayout>
  )
}
