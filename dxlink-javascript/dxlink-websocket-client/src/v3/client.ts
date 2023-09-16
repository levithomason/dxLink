import {
  DXLinkAuthState,
  DXLinkAuthStateChangeListener,
  DXLinkErrorListener,
  DXLinkWebSocketClient,
  DXLinkError,
  DXLinkConnectionDetails,
  DXLinkConnectionStateChangeListener,
  DXLinkConnectionState,
  DXLinkChannelStatus,
} from './dxlink'
import {
  Message,
  SetupMessage,
  isConnectionMessage,
  AuthStateMessage,
  ErrorMessage,
  isChannelLifecycleMessage,
  isChannelMessage,
} from './messages'
import { WebSocketConnector } from './connector'
import { Channel } from './channel'
import { DXLinkLogLevel, DXLinkLogger, Logger } from './logger'

export interface DXLinkWebSocketConfig {
  readonly keepaliveInterval: number
  readonly keepaliveTimeout: number
  readonly acceptKeepaliveTimeout: number
  readonly actionTimeout: number
  readonly logLevel: DXLinkLogLevel
}

export const DXLINK_WS_PROTOCOL_VERSION = '0.1'

const DEFAULT_CONNECTION_DETAILS: DXLinkConnectionDetails = {
  protocolVersion: DXLINK_WS_PROTOCOL_VERSION,
  clientVersion: '0.0.0', // TODO: get from package.json
}

export class DXLinkWebSocket implements DXLinkWebSocketClient {
  private readonly config: DXLinkWebSocketConfig

  private connector: WebSocketConnector | undefined

  private connectionState: DXLinkConnectionState = DXLinkConnectionState.NOT_CONNECTED
  private connectionDetails: DXLinkConnectionDetails = DEFAULT_CONNECTION_DETAILS

  private authState: DXLinkAuthState = DXLinkAuthState.UNAUTHORIZED

  private readonly connectionStateChangeListeners = new Set<DXLinkConnectionStateChangeListener>()
  private readonly errorListeners = new Set<DXLinkErrorListener>()
  private readonly authStateChangeListeners = new Set<DXLinkAuthStateChangeListener>()

  private timeoutIds: Record<string, any> = {}

  /**
   * Authorization type that was determined by server behavior during setup phase.
   * This value is used to determine if authorization is required or optional or not defined yet.
   */
  private isFirstAuthState = true
  private lastSettedAuthToken: string | undefined

  // TODO: mb move to connector
  private lastReceivedMillis = 0
  private lastSentMillis = 0

  // Count of reconnect attempts since last successful connection
  private reconnectAttempts = 0

  private globalChannelId = 1
  private readonly channels = new Map<number, Channel>()

  private readonly logger: DXLinkLogger

  constructor(config?: Partial<DXLinkWebSocketConfig>) {
    this.config = {
      keepaliveInterval: 30,
      keepaliveTimeout: 60,
      acceptKeepaliveTimeout: 60,
      actionTimeout: 10,
      logLevel: DXLinkLogLevel.WARN,
      ...config,
    }

    this.logger = new Logger('DXLinkWebSocket', this.config.logLevel)
  }

  connect = async (url: string): Promise<void> => {
    // Do nothing if already connected to the same url
    if (this.connector?.getUrl() === url) return

    // Disconnect from previous connection if any exists
    this.disconnect()

    // Immediately set connection state to CONNECTING
    this.setConnectionState(DXLinkConnectionState.CONNECTING)

    this.connector = new WebSocketConnector(url)
    this.connector.setOpenListener(this.processTransportOpen)
    this.connector.setMessageListener(this.processMessage)
    this.connector.setCloseListener(this.processTransportClose)

    this.connector.start()

    return new Promise((resolve, reject) => {
      const listener: DXLinkConnectionStateChangeListener = (state) => {
        this.removeConnectionStateChangeListener(listener)

        if (state === DXLinkConnectionState.CONNECTED) {
          resolve()
        } else if (state === DXLinkConnectionState.NOT_CONNECTED) {
          reject(new Error('Connection failed'))
        }
      }

      this.addConnectionStateChangeListener(listener)
    })
  }

  reconnect = () => {
    if (
      this.connectionState === DXLinkConnectionState.NOT_CONNECTED ||
      this.connector === undefined
    )
      return

    this.connector.stop()

    // Clear all timeouts
    for (const key of Object.keys(this.timeoutIds)) {
      this.cancelSchedule(key)
    }

    // Set initial state
    this.connectionDetails = DEFAULT_CONNECTION_DETAILS
    this.lastReceivedMillis = 0
    this.lastSentMillis = 0
    this.isFirstAuthState = true

    this.reconnectAttempts++

    this.setConnectionState(DXLinkConnectionState.CONNECTING)

    this.schedule(
      'RECONNECT',
      () => {
        if (this.connector === undefined) return

        // Start new connection attempt
        this.connector.start()
      },
      this.reconnectAttempts * 1000
    )
  }

  disconnect = () => {
    if (this.connectionState === DXLinkConnectionState.NOT_CONNECTED) return

    this.connector?.stop()
    this.connector = undefined

    for (const key of Object.keys(this.timeoutIds)) {
      this.cancelSchedule(key)
    }

    // Set initial state
    this.connectionDetails = DEFAULT_CONNECTION_DETAILS
    this.lastReceivedMillis = 0
    this.lastSentMillis = 0
    this.isFirstAuthState = true
    this.reconnectAttempts = 0

    this.setConnectionState(DXLinkConnectionState.NOT_CONNECTED)
    this.setAuthState(DXLinkAuthState.UNAUTHORIZED)
  }

  getConnectionDetails = () => this.connectionDetails
  getConnectionState = () => this.connectionState
  addConnectionStateChangeListener = (listener: DXLinkConnectionStateChangeListener) =>
    this.connectionStateChangeListeners.add(listener)
  removeConnectionStateChangeListener = (listener: DXLinkConnectionStateChangeListener) =>
    this.connectionStateChangeListeners.delete(listener)

  setAuthToken = (token: string): void => {
    this.lastSettedAuthToken = token

    if (this.connectionState === DXLinkConnectionState.CONNECTED) {
      this.sendAuthMessage(token)
    }
  }

  getAuthState = (): DXLinkAuthState => this.authState
  addAuthStateChangeListener = (listener: DXLinkAuthStateChangeListener) =>
    this.authStateChangeListeners.add(listener)
  removeAuthStateChangeListener = (listener: DXLinkAuthStateChangeListener) =>
    this.authStateChangeListeners.delete(listener)

  addErrorListener = (listener: DXLinkErrorListener) => this.errorListeners.add(listener)
  removeErrorListener = (listener: DXLinkErrorListener) => this.errorListeners.delete(listener)

  openChannel = (service: string, parameters: Record<string, unknown>) => {
    const channelId = this.globalChannelId
    this.globalChannelId += 2

    const channel = new Channel(channelId, service, parameters, this.sendMessage)

    this.channels.set(channelId, channel)

    // Send channel request if connection is already established
    if (
      this.connectionState === DXLinkConnectionState.CONNECTED &&
      this.authState === DXLinkAuthState.AUTHORIZED
    ) {
      this.requestChannel(channel)
    }

    return channel
  }

  private setConnectionState = (newStatus: DXLinkConnectionState) => {
    const prev = this.connectionState
    if (prev === newStatus) return

    this.connectionState = newStatus
    for (const listener of this.connectionStateChangeListeners) {
      listener(newStatus, prev)
    }
  }

  private sendMessage = (message: Message): void => {
    this.connector?.sendMessage(message)

    this.scheduleKeepalive()

    // TODO: mb move to connector
    this.lastSentMillis = Date.now()
  }

  private sendAuthMessage = (token: string): void => {
    this.setAuthState(DXLinkAuthState.AUTHORIZING)

    this.sendMessage({
      type: 'AUTH',
      channel: 0,
      token,
    })
  }

  private setAuthState = (newState: DXLinkAuthState): void => {
    const prev = this.authState

    this.authState = newState
    for (const listener of this.authStateChangeListeners) {
      try {
        listener(newState, prev)
      } catch (e) {
        this.logger.error('Auth state listener error', e)
      }
    }
  }

  private processMessage = (message: Message): void => {
    this.lastReceivedMillis = Date.now()

    // Send keepalive message if no messages sent for a while (keepaliveInterval)
    // Because browser sometimes doesn't run scheduled tasks when tab is inactive
    if (this.lastReceivedMillis - this.lastSentMillis >= this.config.keepaliveInterval * 1000) {
      this.sendMessage({
        type: 'KEEPALIVE',
        channel: 0,
      })
    }

    /**
     * Connection messages are messages that are sent to the channel 0.
     */
    if (isConnectionMessage(message)) {
      switch (message.type) {
        case 'SETUP':
          return this.processSetupMessage(message)
        case 'AUTH_STATE':
          return this.processAuthStateMessage(message)
        case 'ERROR':
          return this.publishError({
            type: message.error,
            message: message.message,
          })
        case 'KEEPALIVE':
          // Ignore keepalive messages coz they are used only to maintain connection
          return
      }
    } else if (isChannelMessage(message)) {
      const channel = this.channels.get(message.channel)
      if (channel === undefined) {
        this.logger.warn('Received lifecycle message for unknown channel', message)
        return
      }

      if (isChannelLifecycleMessage(message)) {
        switch (message.type) {
          case 'CHANNEL_OPENED':
            return channel.processStatusOpened()
          case 'CHANNEL_CLOSED':
            return channel.processStatusClosed()
          case 'ERROR':
            return channel.processError({
              type: message.error,
              message: message.message,
            })
        }
        return
      }

      return channel.processPayloadMessage(message)
    }

    this.logger.warn('Unhandeled message: ', message.type)
  }

  private processSetupMessage = (serverSetup: SetupMessage): void => {
    // Clear setup timeout check from connect method
    this.cancelSchedule('SETUP_TIMEOUT')

    // Mark connection as connected after first setup message and subsequent ones
    if (
      this.connectionState === DXLinkConnectionState.CONNECTING ||
      this.connectionState === DXLinkConnectionState.CONNECTED
    ) {
      this.connectionDetails = {
        ...this.connectionDetails,
        serverVersion: serverSetup.version,
        clientKeepaliveTimeout: this.config.keepaliveTimeout,
        serverKeepaliveTimeout: serverSetup.keepaliveTimeout,
      }

      // Reset reconnect attempts counter after successful connection
      this.reconnectAttempts = 0

      if (this.lastSettedAuthToken === undefined) {
        this.setConnectionState(DXLinkConnectionState.CONNECTED)
      }
    }

    // Connection maintance: Setup keepalive timeout check
    const timeoutMills = (serverSetup.keepaliveTimeout ?? 60) * 1000
    this.schedule('TIMEOUT', () => this.timeoutCheck(timeoutMills), timeoutMills)
  }

  private publishError = (error: DXLinkError): void => {
    if (this.errorListeners.size === 0) {
      this.logger.error('Unhandled dxLink error', error)
      return
    }

    for (const listener of this.errorListeners) {
      try {
        listener(error)
      } catch (e) {
        this.logger.error('Error listener error', e)
      }
    }
  }

  private processAuthStateMessage = ({ state }: AuthStateMessage): void => {
    // Clear auth state timeout check
    this.cancelSchedule('AUTH_STATE_TIMEOUT')

    // Ignore first auth state message because it is sent during connection setup
    if (this.isFirstAuthState) {
      this.isFirstAuthState = false
    } else {
      // Reset auth token if server rejected it
      if (state === 'UNAUTHORIZED') {
        this.lastSettedAuthToken = undefined
      }
    }

    // Request active channels if connection is authorized
    if (state === 'AUTHORIZED') {
      this.setConnectionState(DXLinkConnectionState.CONNECTED)

      this.requestActiveChannels()
    }

    this.setAuthState(DXLinkAuthState[state])
  }

  private requestActiveChannels = (): void => {
    for (const channel of this.channels.values()) {
      if (channel.getStatus() === DXLinkChannelStatus.CLOSED) {
        this.channels.delete(channel.id)
        continue
      }

      this.requestChannel(channel)
    }
  }

  private processTransportOpen = (): void => {
    const setupMessage: SetupMessage = {
      type: 'SETUP',
      channel: 0,
      version: `${this.connectionDetails.protocolVersion}-${this.connectionDetails.clientVersion}`,
      keepaliveTimeout: this.config.keepaliveTimeout,
      acceptKeepaliveTimeout: this.config.acceptKeepaliveTimeout,
    }

    // Setup timeout check
    this.schedule(
      'SETUP_TIMEOUT',
      () => {
        const errorMessage: ErrorMessage = {
          type: 'ERROR',
          channel: 0,
          error: 'TIMEOUT',
          message: 'No setup message received for ' + this.config.actionTimeout + 's',
        }

        this.sendMessage(errorMessage)

        this.publishError({
          type: errorMessage.error,
          message: `${errorMessage.message} from server`,
        })

        this.disconnect()
      },
      this.config.actionTimeout * 1000
    )

    this.sendMessage(setupMessage)

    this.schedule(
      'AUTH_STATE_TIMEOUT',
      () => {
        const errorMessage: ErrorMessage = {
          type: 'ERROR',
          channel: 0,
          error: 'TIMEOUT',
          message: 'No auth state message received for ' + this.config.actionTimeout + 's',
        }

        this.sendMessage(errorMessage)

        this.publishError({
          type: errorMessage.error,
          message: `${errorMessage.message} from server`,
        })

        this.disconnect()
      },
      this.config.actionTimeout * 1000
    )

    if (this.lastSettedAuthToken !== undefined) {
      this.sendAuthMessage(this.lastSettedAuthToken)
    }
  }

  private processTransportClose = (): void => {
    if (this.authState === DXLinkAuthState.UNAUTHORIZED) {
      this.lastSettedAuthToken = undefined
      this.disconnect()
      return
    }

    this.reconnect()
  }

  private requestChannel = (channel: Channel): void => {
    this.sendMessage({
      type: 'CHANNEL_REQUEST',
      channel: channel.id,
      service: channel.service,
      parameters: channel.parameters,
    })

    channel.processStatusRequested()
  }

  private timeoutCheck = (timeoutMills: number) => {
    const now = Date.now()
    const noKeepaliveDuration = now - this.lastReceivedMillis
    if (noKeepaliveDuration >= timeoutMills) {
      this.sendMessage({
        type: 'ERROR',
        channel: 0,
        error: 'TIMEOUT',
        message: 'No keepalive received for ' + noKeepaliveDuration + 'ms',
      })

      return this.reconnect()
    }

    const nextTimeout = Math.max(200, timeoutMills - noKeepaliveDuration)
    this.schedule('TIMEOUT', () => this.timeoutCheck(timeoutMills), nextTimeout)
  }

  private scheduleKeepalive = () => {
    this.schedule(
      'KEEPALIVE',
      () => {
        this.sendMessage({
          type: 'KEEPALIVE',
          channel: 0,
        })

        this.scheduleKeepalive()
      },
      this.config.keepaliveInterval * 1000
    )
  }

  private schedule = (key: string, callback: () => void, timeout: number) => {
    this.cancelSchedule(key)
    this.timeoutIds[key] = setTimeout(callback, timeout)
  }

  private cancelSchedule = (key: string) => {
    if (this.timeoutIds[key] !== undefined) {
      clearTimeout(this.timeoutIds[key])
      delete this.timeoutIds[key]
    }
  }
}
