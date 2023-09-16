import {
  DXLinkChannel,
  DXLinkChannelMessage,
  DXLinkChannelMessageListener,
  DXLinkChannelStatus,
  DXLinkChannelStatusListener,
  DXLinkError,
  DXLinkErrorListener,
} from './dxlink'
import { ChannelPayloadMessage, Message } from './messages'

export class Channel implements DXLinkChannel {
  private status = DXLinkChannelStatus.REQUESTED

  private readonly messageListeners = new Set<DXLinkChannelMessageListener>()
  private readonly statusListeners = new Set<DXLinkChannelStatusListener>()
  private readonly errorListeners = new Set<DXLinkErrorListener>()

  constructor(
    public readonly id: number,
    public readonly service: string,
    public readonly parameters: Record<string, unknown>,
    private readonly sendMessage: (message: Message) => void
  ) {}

  send = ({ type, ...payload }: DXLinkChannelMessage) => {
    if (this.status !== DXLinkChannelStatus.OPENED) {
      throw new Error('Channel is not ready')
    }

    this.sendMessage({
      type,
      channel: this.id,
      ...payload,
    })
  }

  addMessageListener = (listener: DXLinkChannelMessageListener) =>
    this.messageListeners.add(listener)
  removeMessageListener = (listener: DXLinkChannelMessageListener) =>
    this.messageListeners.delete(listener)

  getStatus = () => this.status
  addStatusListener = (listener: DXLinkChannelStatusListener) => this.statusListeners.add(listener)
  removeStatusListener = (listener: DXLinkChannelStatusListener) =>
    this.statusListeners.delete(listener)

  addErrorListener = (listener: DXLinkErrorListener) => this.errorListeners.add(listener)
  removeErrorListener = (listener: DXLinkErrorListener) => this.errorListeners.delete(listener)

  error = ({ type, message }: DXLinkError) =>
    this.send({
      type: 'ERROR',
      error: type,
      message,
    })

  close = () => {
    this.send({
      type: 'CHANNEL_CANCEL',
    })

    this.clear()

    // After sending CHANNEL_CANCEL we can think that channel is closed already
    this.setStatus(DXLinkChannelStatus.CLOSED)
  }

  processPayloadMessage = (message: ChannelPayloadMessage) => {
    for (const listener of this.messageListeners) {
      listener(message)
    }
  }

  processStatusOpened = () => {
    this.setStatus(DXLinkChannelStatus.OPENED)
  }

  processStatusRequested = () => {
    this.setStatus(DXLinkChannelStatus.REQUESTED)
  }

  processStatusClosed = () => {
    this.setStatus(DXLinkChannelStatus.CLOSED)
    this.clear()
  }

  processError = (error: DXLinkError) => {
    if (this.errorListeners.size === 0) {
      console.error(`Unhandled error in channel#${this.id}: `, error)
      return
    }

    for (const listener of this.errorListeners) {
      try {
        listener(error)
      } catch (e) {
        console.error(`Error in channel#${this.id} error listener: `, e)
      }
    }
  }

  private setStatus = (newStatus: DXLinkChannelStatus) => {
    if (this.status === newStatus) return

    const prev = this.status
    this.status = newStatus

    for (const listener of this.statusListeners) {
      try {
        listener(newStatus, prev)
      } catch (e) {
        console.error(`Error in channel#${this.id} status listener: `, e)
      }
    }
  }

  private clear = () => {
    this.messageListeners.clear()
    this.statusListeners.clear()
    this.errorListeners.clear()
  }
}