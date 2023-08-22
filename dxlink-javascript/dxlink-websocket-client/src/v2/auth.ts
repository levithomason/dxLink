import { AuthHandler } from './handler'
import { AuthState } from './messages'
import { TransportConnection } from './transport'

type AuthStateHandler = AuthHandler['handleAuthState']

export class AuthManager implements AuthHandler {
  private handlers = new Set<AuthStateHandler>()

  private timeoutId: any

  private currentState: AuthState | undefined

  constructor(private readonly connection: TransportConnection) {}

  handleAuthState(state: AuthState) {
    for (const handler of this.handlers) {
      handler(state)
    }
    this.currentState = state
  }

  handleClose(): void {
    this.handlers.clear()

    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId)
      this.timeoutId = undefined
    }
  }

  whenReady(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let handler = () => {
        resolve()

        this.handlers.delete(handler)

        if (this.timeoutId !== undefined) {
          clearTimeout(this.timeoutId)
          this.timeoutId = undefined
        }
      }
      this.handlers.add(handler)

      this.timeoutId = setTimeout(() => {
        if (this.timeoutId !== undefined) {
          clearTimeout(this.timeoutId)
          this.timeoutId = undefined
        }
        reject(new Error('Timeout waiting for server auth state message'))
      }, timeout)
    })
  }

  auth = (token: string): Promise<void> => {
    this.connection.send({
      type: 'AUTH',
      channel: 0,
      token,
    })

    return new Promise((resolve, reject) => {
      let handler = (state: AuthState) => {
        resolve()

        if (this.currentState !== undefined) {
          if (state === 'AUTHORIZED') {
            resolve()
          } else {
            reject()
          }
        }
        this.handlers.delete(handler)
      }
      this.handlers.add(handler)
    })
  }

  addHandler(handler: AuthStateHandler) {
    this.handlers.add(handler)
  }

  removeHandler(handler: AuthStateHandler) {
    this.handlers.delete(handler)
  }
}