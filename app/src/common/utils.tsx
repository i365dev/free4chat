import {
  uniqueNamesGenerator,
  Config,
  adjectives,
  colors,
} from "unique-names-generator"

import { Color } from "@common/types"

const customConfig: Config = {
  dictionaries: [adjectives, colors],
  separator: "-",
  length: 2,
}

export const randomName = () => {
  return uniqueNamesGenerator(customConfig)
}

export const saveRoomToLocalStorage = (roomName, nickName) => {
  var rooms: {}[] = JSON.parse(localStorage.getItem("rooms") || "[]")
  rooms = rooms.filter((room: any) => room.roomName !== roomName)
  rooms.push({ roomName: roomName, nickName: nickName })
  localStorage.setItem("rooms", JSON.stringify(rooms))
}

export const nameToColor = (name: string) => {
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < name.length / 3; i++) {
    let code = name.charCodeAt(i)
    g = g + code
    code = name.charCodeAt(i * 2)
    b = b + code
    code = name.charCodeAt(i * 3)
    r = r + code
  }
  return [r % 256, g % 256, b % 256]
}

export const weightedRand = (spec) => {
  var i,
    j,
    table = []
  for (i in spec) {
    // The constant 10 below should be computed based on the
    // weights in the spec for a correct and optimal table size.
    // E.g. the spec {0:0.999, 1:0.001} will break this impl.
    for (j = 0; j < spec[i] * 10; j++) {
      table.push(i)
    }
  }
  return function () {
    return table[Math.floor(Math.random() * table.length)]
  }
}

export const rgbToBgColor = (color: Color) => {
  return (
    "rgb(" +
    color.r +
    " " +
    color.b +
    " " +
    color.g +
    " / var(--tw-bg-opacity))"
  )
}

export const strToBgColor = (str: string) => {
  const color = nameToColor(str)
  return (
    "rgb(" +
    color[0] +
    " " +
    color[1] +
    " " +
    color[2] +
    " / var(--tw-bg-opacity))"
  )
}

export const strToRGB = (str: string) => {
  const color = nameToColor(str)
  return "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")"
}

export const gtagEvent = (action, category, label, value) => {
  if (!Object.hasOwn(window, "gtag")) {
    return
  }
  // @ts-ignore
  window.gtag("event", action, {
    event_category: category,
    event_label: label,
    value: value,
  })
}

export const umamiEvent = (eventName, eventData) => {
  if (!Object.hasOwn(window, "umami")) {
    return
  }
  // @ts-ignore
  window.umami.track(eventName, eventData)
}
