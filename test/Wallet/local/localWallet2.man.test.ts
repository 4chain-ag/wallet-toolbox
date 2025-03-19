import { EntitySyncState, sdk } from '../../../src'
import { _tu } from '../../utils/TestUtilsWalletStorage'
import { specOpInvalidChange } from '../../../src/sdk'
import {
  burnOneSatTestOutput,
  createOneSatTestOutput,
  createSetup,
  recoverOneSatTestOutputs
} from './localWalletMethods'

const chain: sdk.Chain = 'test'

describe('localWallet2 tests', () => {
  jest.setTimeout(99999999)

  test('0 monitor runOnce', async () => {
    const setup = await createSetup(chain)
    await setup.monitor.runOnce()
    await setup.wallet.destroy()
  })

  test('1 recover 1 sat outputs', async () => {
    const setup = await createSetup(chain)
    await recoverOneSatTestOutputs(setup)
    await setup.wallet.destroy()
  })

  test('2a create 1 sat immediate', async () => {
    const setup = await createSetup(chain)
    const car = await createOneSatTestOutput(setup, { acceptDelayedBroadcast: false }, 1)
    await setup.wallet.destroy()
  })

  test('2c burn 1 sat output', async () => {
    const setup = await createSetup(chain)
    await burnOneSatTestOutput(setup, {}, 1)
    await setup.wallet.destroy()
  })

  test('4 review change utxos', async () => {
    const setup = await createSetup(chain)
    const lor = await setup.wallet.listOutputs({
      basket: specOpInvalidChange,
      tags: ['all']
    })
    if (lor.totalOutputs > 0) {
      debugger
      const lor = await setup.wallet.listOutputs({
        basket: specOpInvalidChange,
        tags: ['all', 'release']
      })
    }
    await setup.wallet.destroy()
  })
})
