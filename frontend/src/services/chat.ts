import {
  MembraneWebRTC,
  Peer,
  SerializedMediaEvent,
} from "@membraneframework/membrane-webrtc-js"
import { Socket, Push } from "phoenix"
import { Subject } from "rxjs"

import {
  LOCAL_PEER_ID,
  AUDIO_TRACK_CONSTRAINTS,
  GET_API_SERVER_URL,
} from "@common/consts"

import { UserInfo, Message } from "../common/types"
import { gtagEvent, umamiEvent } from "../common/utils"

export class ChatService {
  private room: string
  private participants: UserInfo[] = []
  private messages: Message[] = []

  private localAudioStream: MediaStream | null = null
  private localAudioTrackIds: string[] = []

  private socket: Socket

  private webrtc: MembraneWebRTC
  private webrtcSocketRefs: string[] = []
  private webrtcChannel

  private subject: Subject<UserInfo[]>
  private messageSubject: Subject<Message[]>

  constructor(roomName: string, subject, messageSubject) {
    this.room = roomName
    this.subject = subject
    this.messageSubject = messageSubject
    this.socket = new Socket(GET_API_SERVER_URL())
    this.socket.connect()
    if (!this.socket.isConnected) {
      this.subject.error("cannot connect server!")
      gtagEvent("Room", roomName, "Server", "NotConnect") // send gtag event
      umamiEvent("Room", { type: "Server", message: "NotConnect" }) // send umami event
      return
    }
    this.webrtcChannel = this.socket.channel(`room:` + roomName, {
      isSimulcastOn: false, // audio not need simulcast
    })

    this.webrtcChannel.onError((e) => {
      this.socketOff()
      this.subject.error("on error, please refresh the page!")
      gtagEvent("Room", roomName, "Socket", "OnError") // send gtag event
      umamiEvent("Room", { type: "Socket", message: "OnError" }) // send umami event
    })

    this.webrtcChannel.onClose(() => {
      this.socketOff()
      this.subject.error("on close, please refresh the page!")
      gtagEvent("Room", roomName, "Socket", "OnClose") // send gtag event
      umamiEvent("Room", { type: "Socket", message: "OnClose" }) // send umami event
    })

    this.webrtcSocketRefs.push(this.socket.onError(this.leave))
    this.webrtcSocketRefs.push(this.socket.onClose(this.leave))

    this.webrtc = new MembraneWebRTC({
      callbacks: {
        onSendMediaEvent: (mediaEvent: SerializedMediaEvent) => {
          this.webrtcChannel.push("mediaEvent", { data: mediaEvent })
        },
        onConnectionError: () => {
          this.subject.error(
            "Cannot connect to server, refresh the page and try again"
          )
          gtagEvent("Room", roomName, "Server", "NotConnect") // send gtag event
          umamiEvent("Room", { type: "Server", message: "NotConnect" }) // send umami event
        },
        onJoinSuccess: (_peerId, peersInRoom) => {
          this.localAudioStream?.getTracks().forEach((track) => {
            const trackId = this.webrtc.addTrack(
              track,
              this.localAudioStream!,
              {
                active: true,
              }
            )
            this.localAudioTrackIds.push(trackId)
          })
          peersInRoom.map((p) => {
            this.addPeer(p)
          })
        },
        onJoinError: (_metadata) => {
          throw `Peer denied.`
        },
        onTrackReady: (ctx) => {
          this.attachStream(ctx.peer.id, ctx.stream)
          if (ctx.track?.kind === "audio") {
            this.updateTrackStatus(ctx.peer.id, ctx.metadata.active)
          }
        },
        onTrackAdded: (_ctx) => {},
        onTrackRemoved: (_ctx) => {},
        onTrackUpdated: (ctx) => {
          if (ctx.track?.kind == "audio") {
            this.updateTrackStatus(ctx.peer.id, ctx.metadata.active)
          }
        },
        onPeerJoined: (peer) => {
          this.addPeer(peer)
        },
        onPeerLeft: (peer) => {
          this.removePeer(peer)
        },
        onPeerUpdated: (_ctx) => {},
        onTrackEncodingChanged: (_ctx) => {},
      },
    })

    this.webrtcChannel.on("mediaEvent", (event: any) => {
      this.webrtc.receiveMediaEvent(event.data)
    })

    this.webrtcChannel.on("textEvent", (event: any) => {
      const data = event.data
      const userName = this.getNameByPeerId(data.peerId)
      if (userName !== null) {
        this.messages.push({
          peerId: data.peerId,
          name: userName,
          text: data.text,
        })
        this.messageSubject.next([...this.messages])
      }
    })
  }

  public join = async (nickName: string) => {
    await this.askForPermissions()
    try {
      this.localAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_TRACK_CONSTRAINTS,
      })
    } catch (error) {
      console.error("Error while getting local audio stream", error)
      // Optional: surface a user-facing error and abort join
      this.subject.error("Could not access microphone")
      return
    }

    const localPeer: Peer = {
      id: LOCAL_PEER_ID,
      metadata: { displayName: nickName, active: true },
      trackIdToMetadata: null,
    }
    this.addPeer(localPeer)
    this.attachStream(LOCAL_PEER_ID, this.localAudioStream!)
    await this.phoenixChannelPushResult(this.webrtcChannel.join())
    this.webrtc.join({ displayName: nickName })
  }


  private updateParticipants = (users: UserInfo[]) => {
    const me = this.getSelf()
    this.participants = users
    if (me) {
      this.participants
        .filter((p) => p.peerId === LOCAL_PEER_ID)
        .map((p) => {
          p.audioStream = me.audioStream
          p.muteState = me.muteState || false
          p.room = me.room
        })
    }
    this.subject.next(this.participants)
  }

  public sendTextMessage = (message: string) => {
    this.webrtcChannel.push("textEvent", { data: message })
    this.messages.push({
      peerId: LOCAL_PEER_ID,
      name: this.getSelf().name,
      text: message,
    })
    this.messageSubject.next([...this.messages]) // deep copy the array to make react to re-render when array updates
  }

  public muteSelf = () => {
    const me = this.getSelf()
    if (me === null) return
    // update local audio track status
    this.localAudioStream
      .getAudioTracks()
      .forEach((track) => (track.enabled = !track.enabled))
    // update local audio track status to server who will broadcast to all room user
    this.localAudioTrackIds.forEach((track) => {
      this.webrtc.updateTrackMetadata(track, { active: me.muteState })
    })
    // update local peer mute status
    this.updateParticipants(
      this.participants.map((p) => {
        if (p.peerId === LOCAL_PEER_ID) {
          p.muteState = !me.muteState
        }
        return p
      })
    )
  }

  private getSelf = () => {
    const findMe = this.participants.filter((p) => p.peerId === LOCAL_PEER_ID)
    return findMe.length > 0 ? findMe[0] : null
  }

  private getNameByPeerId = (peerId: string) => {
    const findMe = this.participants.filter((p) => p.peerId === peerId)
    return findMe.length > 0 ? findMe[0].name : null
  }

  private attachStream = (peerId: string, audio: MediaStream) => {
    this.updateParticipants(
      this.participants.map((p) => {
        if (p.peerId === peerId) {
          p.audioStream = audio
        }
        return p
      })
    )
  }

  private updateTrackStatus = (peerId: string, status: boolean) => {
    this.updateParticipants(
      this.participants.map((p) => {
        if (p.peerId === peerId) {
          p.muteState = !status
        }
        return p
      })
    )
  }

  private socketOff = () => {
    this.socket.off(this.webrtcSocketRefs)
    while (this.webrtcSocketRefs.length > 0) {
      this.webrtcSocketRefs.pop()
    }
  }

  private leave = () => {
    this.webrtc.leave() // notify webrtc engine leave
    this.webrtcChannel.leave() // notify phoniex channel leave
    this.socketOff() // close socket
  }

  private addPeer = (peer: Peer) => {
    const users = this.participants
    const findPeers = users.filter((u) => u.peerId === peer.id)
    if (findPeers.length === 0) {
      users.push({
        name: peer.metadata.displayName,
        peerId: peer.id,
        room: this.room,
      })
    }
    this.updateParticipants(users)
  }

  private removePeer = (peer: Peer) => {
    this.updateParticipants(
      this.participants.filter((u) => u.peerId !== peer.id)
    )
  }

  private askForPermissions = async (): Promise<void> => {
    try {
      let tmpVideoStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      tmpVideoStream.getTracks().forEach((track) => track.stop())
    } catch (e) {
      console.error("Error while asking for permissions", e)
      throw e
    }
  }

  private phoenixChannelPushResult = async (push: Push): Promise<any> => {
    return new Promise((resolve, reject) => {
      push
        .receive("ok", (response: any) => resolve(response))
        .receive("error", (response: any) => reject(response))
    })
  }
}
