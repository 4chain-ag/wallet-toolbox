/**
 * AuthMethodInteractor
 *
 * A base interface/class for client-side logic to interact with a server
 * for a specific Auth Method's flow (start, complete).
 */

export interface AuthPayload {
  [key: string]: any
}

export interface StartAuthResponse {
  success: boolean
  message?: string
  data?: any
}

export interface CompleteAuthResponse {
  success: boolean
  message?: string
  presentationKey?: string
}

/**
 * Abstract client-side interactor for an Auth Method
 */
export abstract class AuthMethodInteractor {
  public abstract methodType: string

  /**
   * Start the flow (e.g. request an OTP or create a session).
   */
  public abstract startAuth(
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload
  ): Promise<StartAuthResponse>

  /**
   * Complete the flow (e.g. confirm OTP).
   */
  public abstract completeAuth(
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload
  ): Promise<CompleteAuthResponse>
}
