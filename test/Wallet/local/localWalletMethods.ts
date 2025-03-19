import {
  Beef,
  CreateActionArgs,
  CreateActionOptions,
  CreateActionResult,
  OutpointString,
  P2PKH,
  PublicKey,
  SignActionArgs
} from '@bsv/sdk'
import { EntityProvenTxReq, sdk, wait } from '../../../src'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { parseWalletOutpoint, validateCreateActionArgs, ValidCreateActionArgs } from '../../../src/sdk'

const setActiveClient = true
const useMySQLConnectionForClient = true
const useTestIdentityKey = true
const useIdentityKey2 = false

export async function createSetup(chain: sdk.Chain): Promise<TestWalletNoSetup> {
  const env = _tu.getEnv(chain)
  let identityKey: string | undefined
  let filePath: string | undefined
  if (useTestIdentityKey) {
    identityKey = env.testIdentityKey
    filePath = env.testFilePath
  } else {
    if (useIdentityKey2) {
      identityKey = env.identityKey2
    } else {
      identityKey = env.identityKey
      filePath = env.filePath
    }
  }
  if (!identityKey) throw new sdk.WERR_INVALID_PARAMETER('identityKey', 'valid')
  if (!filePath) filePath = `./backup-${chain}-${identityKey}.sqlite`

  const setup = await _tu.createTestWallet({
    chain,
    rootKeyHex: env.devKeys[identityKey],
    filePath,
    setActiveClient,
    addLocalBackup: false,
    useMySQLConnectionForClient
  })

  console.log(`ACTIVE STORAGE: ${setup.storage.getActiveStoreName()}`)

  return setup
}

export async function burnOneSatTestOutput(
  setup: TestWalletNoSetup,
  options: CreateActionOptions = {},
  howMany: number = 1
): Promise<void> {
  const outputs = await setup.wallet.listOutputs({
    basket: 'test-output',
    include: 'entire transactions',
    limit: 1000
  })

  while (howMany-- > 0) {
    const o = outputs.outputs.find(o => o.satoshis === 1)
    if (!o) break
    console.log(`burning ${o.outpoint}`)
    const inputBEEF = outputs.BEEF

    const p2pkh = new P2PKH()
    const args: CreateActionArgs = {
      inputBEEF,
      inputs: [
        {
          unlockingScriptLength: 108,
          outpoint: o.outpoint,
          inputDescription: 'burn 1 sat output'
        }
      ],
      description: 'burn output'
    }
    const bcar = await setup.wallet.createAction(args)
    expect(bcar.signableTransaction)

    const st = bcar.signableTransaction!
    const beef = Beef.fromBinary(st.tx)
    const tx = beef.findAtomicTransaction(beef.txs.slice(-1)[0].txid)!
    const unlock = p2pkh.unlock(setup.keyDeriver.rootKey, 'all', false)
    const unlockingScript = (await unlock.sign(tx, 0)).toHex()
    const signArgs: SignActionArgs = {
      reference: st.reference,
      spends: { 0: { unlockingScript } }
    }
    const sar = await setup.wallet.signAction(signArgs)
    console.log(sar.txid)
    expect(sar.txid)
  }
}

export async function createOneSatTestOutput(
  setup: TestWalletNoSetup,
  options: CreateActionOptions = {},
  howMany: number = 1
): Promise<CreateActionResult> {
  if (howMany < 1) throw new sdk.WERR_INVALID_PARAMETER('howMany', 'at least 1')

  let car: CreateActionResult = {}

  let noSendChange: OutpointString[] | undefined = undefined
  let txids: string[] = []
  let vargs: ValidCreateActionArgs

  for (let i = 0; i < howMany; i++) {
    const args: CreateActionArgs = {
      outputs: [
        {
          lockingScript: new P2PKH().lock(PublicKey.fromString(setup.identityKey).toAddress()).toHex(),
          satoshis: 1,
          outputDescription: 'test output',
          customInstructions: JSON.stringify({
            type: 'P2PKH',
            key: 'identity'
          }),
          basket: 'test-output'
        }
      ],
      description: 'create test output',
      options: {
        ...options,
        noSendChange
      }
    }
    vargs = validateCreateActionArgs(args)
    car = await setup.wallet.createAction(args)
    expect(car.txid)
    txids.push(car.txid!)
    noSendChange = car.noSendChange

    const req = await EntityProvenTxReq.fromStorageTxid(setup.activeStorage, car.txid!)
    expect(req !== undefined && req.history.notes !== undefined)
    if (req && req.history.notes) {
      if (vargs.isNoSend) {
        expect(req.status === 'nosend').toBe(true)
        expect(req.history.notes.length).toBe(1)
        const n = req.history.notes[0]
        expect(n.what === 'status' && n.status_now === 'nosend').toBe(true)
      } else {
        expect(req.status === 'unsent').toBe(true)
        expect(req.history.notes.length).toBe(1)
        const n = req.history.notes[0]
        expect(n.what === 'status' && n.status_now === 'unsent').toBe(true)
      }
    }
  }

  if (vargs!.isNoSend) {
    // Create final sending transaction
    const args: CreateActionArgs = {
      description: 'send batch',
      options: {
        ...options,
        sendWith: txids
      }
    }
    vargs = validateCreateActionArgs(args)
    car = await setup.wallet.createAction(args)
  }

  return car
}

export async function recoverOneSatTestOutputs(setup: TestWalletNoSetup): Promise<void> {
  const outputs = await setup.wallet.listOutputs({
    basket: 'test-output',
    include: 'entire transactions',
    limit: 1000
  })

  if (outputs.outputs.length > 8) {
    const args: CreateActionArgs = {
      inputBEEF: outputs.BEEF!,
      inputs: [],
      description: 'recover test output'
    }
    const p2pkh = new P2PKH()
    for (const o of outputs.outputs) {
      args.inputs!.push({
        unlockingScriptLength: 108,
        outpoint: o.outpoint,
        inputDescription: 'recovered test output'
      })
    }
    const car = await setup.wallet.createAction(args)
    expect(car.signableTransaction)

    const st = car.signableTransaction!
    const beef = Beef.fromBinary(st.tx)
    const tx = beef.findAtomicTransaction(beef.txs.slice(-1)[0].txid)!
    const signArgs: SignActionArgs = {
      reference: st.reference,
      spends: {} //  0: { unlockingScript } },
    }
    for (let i = 0; i < outputs.outputs.length; i++) {
      const o = outputs.outputs[i]
      const unlock = p2pkh.unlock(setup.keyDeriver.rootKey, 'all', false)
      const unlockingScript = (await unlock.sign(tx, i)).toHex()
      signArgs.spends[i] = { unlockingScript }
    }
    const sar = await setup.wallet.signAction(signArgs)
    expect(sar.txid)
  }
}

export async function trackReqByTxid(setup: TestWalletNoSetup, txid: string): Promise<void> {
  const req = await EntityProvenTxReq.fromStorageTxid(setup.activeStorage, txid)

  expect(req !== undefined && req.history.notes !== undefined)
  if (!req || !req.history.notes) throw new sdk.WERR_INTERNAL()

  let newBlocks = 0
  let lastHeight: number | undefined
  for (; req.status !== 'completed'; ) {
    let height = setup.monitor.lastNewHeader?.height
    if (req.status === 'unsent') {
      // send it...
    }
    if (req.status === 'sending') {
      // send it...
    }
    if (req.status === 'unmined') {
      if (height && lastHeight) {
        if (height === lastHeight) {
          await wait(1000 * 60)
        } else {
          newBlocks++
          expect(newBlocks < 5)
        }
      }
    }

    await setup.monitor.runOnce()
    await req.refreshFromStorage(setup.activeStorage)
    lastHeight = height
  }
}
