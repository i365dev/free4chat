import { Fragment, type ReactNode } from "react"

export interface CollaborationDiagramProps {
  variant: "tree" | "branches" | "stack"
  rows: string[]
  target?: string
}

const baseClasses =
  "mt-3 overflow-x-auto whitespace-nowrap font-mono text-[11px] leading-relaxed text-cyan-300"

function Connector(): ReactNode {
  return <span aria-hidden="true">|</span>
}

export default function CollaborationDiagram({
  variant,
  rows,
  target,
}: CollaborationDiagramProps) {
  if (variant === "tree") {
    return (
      <div className={baseClasses}>
        <div>{rows[0]}</div>
        <div className="ml-1 border-l border-cyan-300/70 pl-2">
          {rows.slice(1).map((row) => (
            <div key={row}>{row}</div>
          ))}
        </div>
      </div>
    )
  }

  if (variant === "stack") {
    return (
      <div className={baseClasses + " flex min-w-full flex-col items-center"}>
        <span>{rows[0]}</span>
        <Connector />
        <span>{target ?? rows[1]}</span>
        <Connector />
        <span>{rows[rows.length - 1]}</span>
      </div>
    )
  }

  const targetIndex = Math.floor(rows.length / 2)
  return (
    <div
      className={
        baseClasses +
        " grid w-max min-w-full grid-cols-[max-content_auto] items-center gap-x-3"
      }
    >
      {rows.map((row, index) => (
        <Fragment key={row}>
          <span>{row}</span>
          <span aria-hidden="true">
            {index === targetIndex
              ? "+-- " + (target ?? "Temporary Room")
              : "|"}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
