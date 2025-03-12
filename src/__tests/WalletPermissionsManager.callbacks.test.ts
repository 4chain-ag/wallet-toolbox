import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

import { jest } from '@jest/globals'

// Mock the @bsv/sdk module with our fixture/mocks:
jest.mock('@bsv/sdk', () => MockedBSV_SDK)

describe('WalletPermissionsManager - Callbacks & Event Handling', () => {
  let underlying: ReturnType<typeof mockUnderlyingWallet>
  let manager: WalletPermissionsManager

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
    // Use default config so that protocol permissions are enforced for testing requests
    manager = new WalletPermissionsManager(underlying, 'admin.domain.com')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1) Unit Tests: Callback Registration & Unregistration
  // -------------------------------------------------------------------------

  it('bindCallback() should register multiple callbacks for the same event, which are called in sequence', async () => {
    const cb1 = jest.fn(() => {})
    const cb2 = jest.fn(() => {})

    // Bind both to "onProtocolPermissionRequested"
    manager.bindCallback('onProtocolPermissionRequested', cb1)
    manager.bindCallback('onProtocolPermissionRequested', cb2)

    // Manually trigger the event (private method usage) for direct testing:
    // We'll mimic the manager calling "this.callEvent('onProtocolPermissionRequested', params)"
    // by just calling it ourselves. This is a "unit-level" approach.
    const fakeParam = { type: 'protocol', requestID: 'req-xyz' }
    await (manager as any).callEvent('onProtocolPermissionRequested', fakeParam)

    // Both callbacks should have been called in sequence with the same param
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb1).toHaveBeenCalledWith(fakeParam)
    expect(cb2).toHaveBeenCalledWith(fakeParam)

    // Confirm order
    expect(cb1.mock.invocationCallOrder[0]).toBeLessThan(cb2.mock.invocationCallOrder[0])
  })

  it('unbindCallback() by numeric ID should prevent the callback from being called again', async () => {
    const cb1 = jest.fn(() => {})
    const cb2 = jest.fn(() => {})

    // We get numeric IDs when binding
    const id1 = manager.bindCallback('onProtocolPermissionRequested', cb1)
    manager.bindCallback('onProtocolPermissionRequested', cb2)

    // Fire once (both should be called)
    const param1 = { requestID: 'req-test-1' }
    await (manager as any).callEvent('onProtocolPermissionRequested', param1)

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)

    // Unbind cb1 by numeric ID
    manager.unbindCallback('onProtocolPermissionRequested', id1)

    // Fire again
    const param2 = { requestID: 'req-test-2' }
    await (manager as any).callEvent('onProtocolPermissionRequested', param2)

    // cb1 should NOT receive the second event
    expect(cb1).toHaveBeenCalledTimes(1)
    // cb2 should still receive it
    expect(cb2).toHaveBeenCalledTimes(2)
  })

  it('unbindCallback() by function reference should remove the callback', async () => {
    const cb1 = jest.fn(() => {})
    const cb2 = jest.fn(() => {})
    const cb3 = jest.fn(() => {})

    manager.bindCallback('onProtocolPermissionRequested', cb1)
    manager.bindCallback('onProtocolPermissionRequested', cb2)
    manager.bindCallback('onProtocolPermissionRequested', cb3)

    // Fire once
    const param1 = { requestID: 'req-first-fire' }
    await (manager as any).callEvent('onProtocolPermissionRequested', param1)

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb3).toHaveBeenCalledTimes(1)

    // Unbind cb2 by function reference
    manager.unbindCallback('onProtocolPermissionRequested', cb2)

    // Fire again
    const param2 = { requestID: 'req-second-fire' }
    await (manager as any).callEvent('onProtocolPermissionRequested', param2)

    // cb2 should no longer be called
    expect(cb1).toHaveBeenCalledTimes(2)
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb3).toHaveBeenCalledTimes(2)
  })

  it('a failing callback (throwing an error) does not block subsequent callbacks', async () => {
    const goodCb = jest.fn(() => {})
    const badCb = jest.fn().mockImplementation(() => {
      throw new Error('Intentional error')
    })
    const finalCb = jest.fn(() => {})

    manager.bindCallback('onProtocolPermissionRequested', goodCb)
    manager.bindCallback('onProtocolPermissionRequested', badCb as any)
    manager.bindCallback('onProtocolPermissionRequested', finalCb)

    const param = { requestID: 'req-err-test' }
    // callEvent should swallow the error from badCb and continue
    await (manager as any).callEvent('onProtocolPermissionRequested', param)

    // All callbacks are invoked once
    expect(goodCb).toHaveBeenCalledTimes(1)
    expect(badCb).toHaveBeenCalledTimes(1)
    expect(finalCb).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // 2) Integration Tests: Real permission request flow
  // -------------------------------------------------------------------------

  it('should trigger onProtocolPermissionRequested with correct params when a non-admin domain requests a protocol operation', async () => {
    const requestedCb = jest.fn(() => {})

    // We bind to onProtocolPermissionRequested
    manager.bindCallback('onProtocolPermissionRequested', requestedCb)

    // Attempt an operation that requires protocol permission:
    // e.g., createSignature with level=1 protocol
    const signPromise = manager.createSignature(
      {
        protocolID: [1, 'some-protocol'],
        keyID: '1',
        data: [0x01, 0x02],
        privileged: false
      },
      'non-admin.example.com'
    )

    // Wait a tick so the request can be queued
    await new Promise(r => setTimeout(r, 10))

    // We expect onProtocolPermissionRequested to have been fired once
    expect(requestedCb).toHaveBeenCalledTimes(1)

    // The callback param should include fields from the `PermissionRequest`
    const callArg = (requestedCb.mock as any).calls[0][0]
    expect(callArg.type).toBe('protocol')
    expect(callArg.originator).toBe('non-admin.example.com')
    expect(callArg.requestID).toMatch(/^proto:non-admin.example.com:false/) // The manager auto-generates an ID

    // The original sign call is still pending (since we haven't granted or denied).
    // We'll deny it for cleanup:
    manager.denyPermission(callArg.requestID)

    await expect(signPromise).rejects.toThrow(/Permission denied/)
  })

  it('should resolve the original caller promise when requests are granted', async () => {
    const requestedCb = jest.fn(() => {})
    manager.bindCallback('onProtocolPermissionRequested', requestedCb)

    // Start an operation that requires permission
    const signPromise = manager.createSignature(
      {
        protocolID: [1, 'testproto'],
        keyID: '1',
        data: [0xaa],
        privileged: false
      },
      'nonadmin.com'
    )

    // Wait for request to appear
    await new Promise(r => setTimeout(r, 10))
    expect(requestedCb).toHaveBeenCalledTimes(1)

    // Extract the requestID from the callback
    const requestID = (requestedCb.mock as any).calls[0][0].requestID

    // Now grant the request
    const grantParams = {
      requestID,
      expiry: 123456789,
      ephemeral: true
    }
    await manager.grantPermission(grantParams)

    // The signPromise should now resolve (meaning the original createSignature call finishes successfully).
    await expect(signPromise).resolves.toBeDefined()
  })

  it('should reject the original caller promise when permission is denied', async () => {
    const requestedCb = jest.fn(() => {})

    manager.bindCallback('onProtocolPermissionRequested', requestedCb)
    // Start an operation that requires protocol permission
    const encryptPromise = manager.encrypt(
      {
        protocolID: [1, 'secretproto'],
        keyID: 'session',
        plaintext: [0xff, 0xff],
        privileged: false
      },
      'unauthorized-domain.com'
    )

    // Wait to ensure request is triggered
    await new Promise(r => setTimeout(r, 10))
    expect(requestedCb).toHaveBeenCalledTimes(1)

    const requestID = (requestedCb.mock as any).calls[0][0].requestID

    // Deny the request
    manager.denyPermission(requestID)

    // The original encryptPromise should reject
    await expect(encryptPromise).rejects.toThrow(/Permission denied/i)
  })

  it('multiple pending requests for the same resource should trigger only one onXxxRequested callback', async () => {
    const requestedCb = jest.fn(() => {})
    manager.bindCallback('onProtocolPermissionRequested', requestedCb)

    // We'll do two calls that require the SAME resource:
    //  same originator, same protocolID, same privileged=false, same counterparty

    const call1 = manager.createSignature(
      {
        protocolID: [1, 'parallel-test'],
        data: [0x01],
        keyID: '1',
        privileged: false
      },
      'parallel-user.com'
    )
    const call2 = manager.createSignature(
      {
        protocolID: [1, 'parallel-test'],
        data: [0x02],
        keyID: '1',
        privileged: false
      },
      'parallel-user.com'
    )

    // Wait for the manager to handle them
    await new Promise(r => setTimeout(r, 10))

    // Because the resource is identical, only ONE request event should be triggered
    expect(requestedCb).toHaveBeenCalledTimes(1)

    // We'll grant the request once
    await manager.grantPermission({
      requestID: (requestedCb.mock as any).calls[0][0].requestID,
      ephemeral: true
    })

    // Both calls should now resolve
    await expect(call1).resolves.toBeDefined()
    await expect(call2).resolves.toBeDefined()
  })

  it('multiple pending requests for different resources should trigger separate onXxxRequested callbacks', async () => {
    const requestedCb = jest.fn(() => {})
    manager.bindCallback('onProtocolPermissionRequested', requestedCb)

    // We'll do two calls that require DIFFERENT resources:
    //  call1 -> protocolID=[1, 'resourceA']
    //  call2 -> protocolID=[1, 'resourceB']

    const call1 = manager.createSignature(
      {
        protocolID: [1, 'resourceA'],
        data: [0xaa],
        keyID: '1',
        privileged: false
      },
      'user.com'
    )

    const call2 = manager.createSignature(
      {
        protocolID: [1, 'resourceB'],
        data: [0xbb],
        keyID: '1',
        privileged: false
      },
      'user.com'
    )

    // Wait for them to be triggered
    await new Promise(r => setTimeout(r, 10))

    // We expect 2 distinct request events
    expect(requestedCb).toHaveBeenCalledTimes(2)

    // Each request has a distinct resource
    const firstID = (requestedCb.mock as any).calls[0][0].requestID
    const secondID = (requestedCb.mock as any).calls[1][0].requestID
    expect(firstID).not.toBe(secondID)

    // We'll grant the first, deny the second
    manager.grantPermission({ requestID: firstID, ephemeral: true })
    manager.denyPermission(secondID)

    // call1 resolves, call2 rejects
    await expect(call1).resolves.toBeDefined()
    await expect(call2).rejects.toThrow(/Permission denied/)
  })
})
