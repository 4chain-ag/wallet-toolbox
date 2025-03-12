import { AuthMethodInteractor, AuthPayload, StartAuthResponse, CompleteAuthResponse } from './AuthMethodInteractor'

/**
 * TwilioPhoneInteractor
 *
 * A client-side class that knows how to call the WAB server for Twilio-based phone verification.
 */
export class TwilioPhoneInteractor extends AuthMethodInteractor {
  public methodType = 'TwilioPhone'

  /**
   * Start the Twilio phone verification on the server.
   * - The server will send an SMS code to the user’s phone, using Twilio Verify.
   * @param serverUrl         - The base URL of the WAB server (e.g. http://localhost:3000)
   * @param presentationKey   - The 256-bit key the client is attempting to authenticate with
   * @param payload           - { phoneNumber: string } (the phone number to verify)
   * @returns                 - { success, message, data }
   */
  public async startAuth(serverUrl: string, presentationKey: string, payload: AuthPayload): Promise<StartAuthResponse> {
    const res = await fetch(`${serverUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        methodType: this.methodType,
        presentationKey,
        payload
      })
    })

    if (!res.ok) {
      return {
        success: false,
        message: `HTTP error ${res.status}`
      }
    }

    return res.json()
  }

  /**
   * Complete the Twilio phone verification on the server.
   * - The server will verify the code with Twilio Verify’s verificationChecks endpoint.
   * @param serverUrl         - The base URL of the WAB server
   * @param presentationKey   - The 256-bit key
   * @param payload           - { phoneNumber: string, otp: string } (the code that was received via SMS)
   * @returns                 - { success, message, presentationKey }
   */
  public async completeAuth(
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload
  ): Promise<CompleteAuthResponse> {
    const res = await fetch(`${serverUrl}/auth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        methodType: this.methodType,
        presentationKey,
        payload
      })
    })

    if (!res.ok) {
      return {
        success: false,
        message: `HTTP error ${res.status}`
      }
    }

    return res.json()
  }
}
