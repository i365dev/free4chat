import { useEffect, useMemo, useState } from "react"

import {
  applyTaskLiveViewAction,
  reconcileTaskLiveViewState,
  validateTaskLiveViewSnapshot,
  type TaskLiveViewAction,
  type TaskLiveViewComponent,
  type TaskLiveViewLocalState,
  type TaskLiveViewScalar,
  type TaskLiveViewSnapshot,
  type TaskLiveViewStateStore,
} from "../common/taskLiveView"

function valueFor(
  data: Record<string, TaskLiveViewScalar>,
  path: string
): string {
  const value = data[path]
  return value === undefined ? "" : String(value)
}

function componentClass(type: TaskLiveViewComponent["type"]): string {
  switch (type) {
    case "Row":
      return "flex flex-wrap items-center gap-2"
    case "Column":
      return "flex flex-col gap-2"
    case "Card":
      return "rounded-lg border border-gray-700/70 bg-gray-950/50 p-3"
    default:
      return ""
  }
}

function renderComponent(
  component: TaskLiveViewComponent,
  data: Record<string, TaskLiveViewScalar>,
  dispatch: (action: TaskLiveViewAction) => void,
  onInteract: () => void
): React.ReactNode {
  switch (component.type) {
    case "Text":
      return <span>{component.text}</span>
    case "Value":
      return (
        <span data-testid={`live-view-value-${component.path}`}>
          {valueFor(data, component.path)}
        </span>
      )
    case "Button":
      return (
        <button
          type="button"
          className="rounded-md border border-blue-400/60 bg-blue-600/80 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          onClick={() => {
            onInteract()
            dispatch(component.action)
          }}
        >
          {component.label}
        </button>
      )
    case "Input":
      return (
        <input
          className="min-w-0 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-white"
          value={valueFor(data, component.path)}
          placeholder={component.placeholder}
          onChange={(event) => {
            if (event.target.value !== valueFor(data, component.path))
              onInteract()
            dispatch({
              type: "set",
              path: component.path,
              value: event.target.value,
            })
          }}
        />
      )
    case "Row":
    case "Column":
    case "Card":
      return (
        <div className={componentClass(component.type)}>
          {component.children.map((child, index) => (
            <span key={`${child.type}-${index}`}>
              {renderComponent(child, data, dispatch, onInteract)}
            </span>
          ))}
        </div>
      )
  }
}

export default function TaskLiveView({
  snapshot,
  stateStore,
  onVisible,
  onInteract,
}: {
  snapshot: TaskLiveViewSnapshot
  stateStore: TaskLiveViewStateStore
  onVisible?: (taskRequestId: string, surfaceId: string) => void
  onInteract?: (taskRequestId: string, surfaceId: string) => void
}) {
  const validation = useMemo(
    () => validateTaskLiveViewSnapshot(snapshot),
    [snapshot]
  )
  const [localState, setLocalState] = useState<TaskLiveViewLocalState>(() =>
    validation.ok
      ? reconcileTaskLiveViewState(
          stateStore.current.get(snapshot.taskRequestId),
          validation.snapshot
        )
      : {
          surfaceId: "",
          revision: 0,
          data: {},
        }
  )

  useEffect(() => {
    if (!validation.ok) return
    const next = reconcileTaskLiveViewState(
      stateStore.current.get(snapshot.taskRequestId),
      validation.snapshot
    )
    stateStore.current.set(snapshot.taskRequestId, next)
    setLocalState(next)
  }, [
    snapshot.taskRequestId,
    snapshot.surfaceId,
    snapshot.revision,
    validation,
    stateStore,
  ])

  useEffect(() => {
    if (!validation.ok) return
    onVisible?.(snapshot.taskRequestId, snapshot.surfaceId)
  }, [onVisible, snapshot.surfaceId, snapshot.taskRequestId, validation.ok])

  if (!validation.ok) return null

  const dispatch = (action: TaskLiveViewAction) => {
    setLocalState((current) => {
      const next = {
        ...current,
        data: applyTaskLiveViewAction(current.data, action),
      }
      stateStore.current.set(snapshot.taskRequestId, next)
      return next
    })
  }

  const reportInteraction = () => {
    onInteract?.(snapshot.taskRequestId, snapshot.surfaceId)
  }

  return (
    <section
      aria-label="Task Live View"
      data-testid="task-live-view"
      className="flex min-h-0 flex-1 flex-col overflow-auto bg-gray-950 p-4 text-gray-100"
    >
      {renderComponent(
        validation.snapshot.root,
        localState.data,
        dispatch,
        reportInteraction
      )}
    </section>
  )
}
