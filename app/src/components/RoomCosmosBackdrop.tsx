import { useEffect, useRef } from "react"

/**
 * The star map is one static SVG. Pointer movement nudges that layer by a few
 * pixels at most; an idle Room has no animation frame loop or pointer work.
 */
export default function RoomCosmosBackdrop() {
  const skyRef = useRef<HTMLDivElement>(null)
  const glintsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sky = skyRef.current
    const stage = sky?.parentElement
    const glints = glintsRef.current
    if (!sky || !stage || !glints) return

    const updateVisibility = () => {
      glints.dataset.visible = String(document.visibilityState !== "hidden")
    }
    document.addEventListener("visibilitychange", updateVisibility)
    updateVisibility()

    const canParallax =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: fine)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!canParallax) {
      return () =>
        document.removeEventListener("visibilitychange", updateVisibility)
    }

    let lastMove = 0
    const onPointerMove = (event: PointerEvent) => {
      if (
        document.visibilityState === "hidden" ||
        (event.pointerType !== "mouse" && event.pointerType !== "pen")
      )
        return
      const now = performance.now()
      if (now - lastMove < 50) return
      lastMove = now
      const bounds = stage.getBoundingClientRect()
      const x = Math.max(
        -1,
        Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1)
      )
      const y = Math.max(
        -1,
        Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1)
      )
      sky.style.transform = `translate3d(${(-x * 9).toFixed(1)}px, ${(
        -y * 7
      ).toFixed(1)}px, 0)`
    }
    const resetParallax = () => {
      sky.style.transform = ""
    }

    stage.addEventListener("pointermove", onPointerMove, { passive: true })
    stage.addEventListener("pointerleave", resetParallax)
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility)
      stage.removeEventListener("pointermove", onPointerMove)
      stage.removeEventListener("pointerleave", resetParallax)
    }
  }, [])

  return (
    <>
      <div ref={skyRef} className="room-cosmos-sky" aria-hidden="true" />
      <div ref={glintsRef} className="room-cosmos-glints" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
    </>
  )
}
