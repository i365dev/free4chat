---
name: free4chat-ui-regression
description: Use when changing shared Free4Chat CSS, layout, responsive behavior, visual components, or interaction affordances; verify the real routes and browser hit targets affected by the change.
---

# Free4Chat UI regression workflow

Use this skill for changes to global styles, shared components, navigation,
responsive layouts, overlays, participant cards, or visual effects. The goal is
to catch regressions in the real product surface before review or deployment.

## Start from the real surface

- Inspect the actual page/component tree and global selectors. A prototype or
  isolated component is useful for visual exploration, but it does not prove
  the production DOM, stacking contexts, responsive sizing, or controls behave
  the same way.
- List the routes and UI states that consume the changed selector/component.
  Include both the normal state and relevant overlays, split panes, fullscreen,
  or mobile surface switches.
- Preserve existing Room ownership, feature behavior, and app-host boundaries.
  Keep cosmetic decoration out of hit testing with `pointer-events: none`.

## Choose browser checks by affected surface

Run the existing browser suite for each changed surface from `app/`:

| Surface                                               | Check                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Homepage width or scrolling                           | `yarn e2e:homepage-ui` (real-route browser gate; runs in CI)               |
| Homepage signal-collapse animation                    | `yarn e2e:homepage` (Chromium + WebKit; optional animation-specific check) |
| Room participant/Stage, overlays, or Room App layout  | `yarn e2e:room-app-host`                                                   |
| Room join, messaging, or participant interaction flow | `yarn e2e:room`                                                            |

Use the configured viewport projects rather than a single desktop screenshot.
The Room App host matrix covers Chromium desktop and WebKit desktop, phone,
tablet portrait, tablet landscape, and 1024px tablet layouts. Add a narrower or
shorter viewport when the reported bug depends on available vertical space.
For Stage composition changes, include participant count as a separate axis:
compare one participant with two or more at the same desktop viewport. The Room
App host browser gate asserts the single- and two-person planet centers stay on
the same vertical baseline in both desktop engines.
Participant identity visuals must be viewer-independent: the same participant
must render the same planet SVG for self and remote viewers. Self/remote status
may change surrounding UI affordances such as a halo, label, or controls, but
must not recolor or otherwise mutate the planet itself.
Follow the repository's local browser setup in
`.agent/skills/free4chat-local-e2e/SKILL.md`; do not weaken production origin
checks to make a local browser test pass.

## Check geometry and interaction in the browser

- **Scroll:** `yarn e2e:homepage-ui` loads the production homepage at
  390×844, 768×1024, 1024×768, and 1440×900. It asserts
  `documentElement.scrollWidth <= window.innerWidth` and that wheel input over the
  top intro, hero, and lower page moves `window.scrollY`. Header.tsx emits
  metadata only, so the test uses the visible top intro as the top-page target.
  For other homepage layout changes, also inspect reaching both top and bottom
  and identify nested `overflow-y` containers; remove competing scroll owners
  when they are not intentional.
- **Overlap:** Compare bounding boxes for headings, cards, tabs, dialogs, and
  fixed browser-safe regions. Assert visible controls are not clipped or
  covered by a higher stacking context.
- **Hit targets:** For important buttons, inspect the center with
  `document.elementFromPoint` and verify the target receives the hit. On touch
  layouts, aim for at least 44 by 44 CSS pixels. Do not infer clickability from
  a screenshot or `isVisible()` alone.
- **Room states:** Check the People/Stage and Room chat surfaces, relevant
  popovers, and any surface that takes over Stage (Room App, screen share, or
  Task Live View) when the change can affect them. Verify the navigation still
  identifies its destination.
- **Keyboard and accessibility:** Confirm visible focus, accessible names, and
  reduced-motion behavior for changed controls/effects.

Add browser assertions for the discovered geometry or hit-testing contract so
the same regression is caught in CI. Homepage width and document-scroll
contracts belong in `homepage-ui-regression.spec.ts`, which is wired to the
selective `homepage-ui-compat` CI workflow. Keep unit tests for component
behavior; they do not replace browser checks for CSS stacking, scroll
ownership, or pointer targeting.

## Keep long-running Room costs bounded

- Do not add an idle animation-frame loop or continuously repainting background
  for decorative effects. Prefer static layers and interactions that run only
  while needed.
- If audio or speaking state drives an effect, keep analysis local, sample at a
  bounded cadence, and activate CSS motion only while the participant is
  speaking. Verify idle state stops the active pulse; honor
  `prefers-reduced-motion`.
- Check that text, shadows, filters, and pseudo-elements do not intercept
  pointer events or create a large painted surface over controls.

## Report evidence precisely

Record which route/state, browser engine, and viewport were inspected; list the
automated checks and their results; call out any case that was only visually
inspected or not exercised. Do not describe a prototype preview as proof of a
production route, or claim layout compatibility from unit tests alone. A local
or temporary preview does not authorize deployment.
