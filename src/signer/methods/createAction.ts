import {
  AtomicBEEF,
  Beef,
  CreateActionResult,
  OutpointString,
  SendWithResult,
  SignableTransaction,
  SignActionResult,
  SignActionSpend,
  TXIDHexString
} from '@bsv/sdk'
import { Script, Transaction } from '@bsv/sdk'
import {
  asBsvSdkScript,
  makeAtomicBeef,
  PendingSignAction,
  ScriptTemplateBRC29,
  sdk,
  verifyTruthy,
  Wallet
} from '../../index.client'
import { buildSignableTransaction } from './buildSignableTransaction'
import { ReviewActionResult } from '../../sdk/WalletStorage.interfaces'

export interface CreateActionResultX extends CreateActionResult {
  txid?: TXIDHexString
  tx?: AtomicBEEF
  noSendChange?: OutpointString[]
  sendWithResults?: SendWithResult[]
  signableTransaction?: SignableTransaction
  notDelayedResults?: ReviewActionResult[]
}

export async function createAction(
  wallet: Wallet,
  auth: sdk.AuthId,
  vargs: sdk.ValidCreateActionArgs
): Promise<CreateActionResultX> {
  const r: CreateActionResultX = {}

  let prior: PendingSignAction | undefined = undefined

  if (vargs.isNewTx) {
    prior = await createNewTx(wallet, vargs)

    if (vargs.isSignAction) {
      return makeSignableTransactionResult(prior, wallet, vargs)
    }

    prior.tx = await completeSignedTransaction(prior, {}, wallet)

    r.txid = prior.tx.id('hex')
    r.noSendChange = prior.dcr.noSendChangeOutputVouts?.map(vout => `${r.txid}.${vout}`)
    if (!vargs.options.returnTXIDOnly) r.tx = makeAtomicBeef(prior.tx, prior.dcr.inputBeef!)
  }

  const { sendWithResults, notDelayedResults } = await processAction(prior, wallet, auth, vargs)

  r.sendWithResults = sendWithResults
  r.notDelayedResults = notDelayedResults

  return r
}

async function createNewTx(wallet: Wallet, args: sdk.ValidCreateActionArgs): Promise<PendingSignAction> {
  const storageArgs = removeUnlockScripts(args)
  const dcr = await wallet.storage.createAction(storageArgs)

  const reference = dcr.reference

  const { tx, amount, pdi } = buildSignableTransaction(dcr, args, wallet)

  const prior: PendingSignAction = { reference, dcr, args, amount, tx, pdi }

  return prior
}

function makeSignableTransactionResult(
  prior: PendingSignAction,
  wallet: Wallet,
  args: sdk.ValidCreateActionArgs
): CreateActionResult {
  if (!prior.dcr.inputBeef) throw new sdk.WERR_INTERNAL('prior.dcr.inputBeef must be valid')

  const txid = prior.tx.id('hex')

  const r: CreateActionResult = {
    noSendChange: args.isNoSend ? prior.dcr.noSendChangeOutputVouts?.map(vout => `${txid}.${vout}`) : undefined,
    signableTransaction: {
      reference: prior.dcr.reference,
      tx: makeSignableTransactionBeef(prior.tx, prior.dcr.inputBeef)
    }
  }

  wallet.pendingSignActions[r.signableTransaction!.reference] = prior

  return r
}

function makeSignableTransactionBeef(tx: Transaction, inputBEEF: number[]): number[] {
  // This is a special case beef for transaction signing.
  // We only need the transaction being signed, and for each input, the raw source transaction.
  const beef = new Beef()
  for (const input of tx.inputs) {
    if (!input.sourceTransaction)
      throw new sdk.WERR_INTERNAL('Every signableTransaction input must have a sourceTransaction')
    beef.mergeRawTx(input.sourceTransaction!.toBinary())
  }
  beef.mergeRawTx(tx.toBinary())
  return beef.toBinaryAtomic(tx.id('hex'))
}

/**
 * Derive a change output locking script
 */
export function makeChangeLock(
  out: sdk.StorageCreateTransactionSdkOutput,
  dctr: sdk.StorageCreateActionResult,
  args: sdk.ValidCreateActionArgs,
  changeKeys: sdk.KeyPair,
  wallet: Wallet
): Script {
  const derivationPrefix = dctr.derivationPrefix
  const derivationSuffix = verifyTruthy(out.derivationSuffix)
  const sabppp = new ScriptTemplateBRC29({
    derivationPrefix,
    derivationSuffix,
    keyDeriver: wallet.keyDeriver
  })
  const lockingScript = sabppp.lock(changeKeys.privateKey, changeKeys.publicKey)
  return lockingScript
}

export async function completeSignedTransaction(
  prior: PendingSignAction,
  spends: Record<number, SignActionSpend>,
  wallet: Wallet
): Promise<Transaction> {
  /////////////////////
  // Insert the user provided unlocking scripts from "spends" arg
  /////////////////////
  for (const [key, spend] of Object.entries(spends)) {
    const vin = Number(key)
    const createInput = prior.args.inputs[vin]
    const input = prior.tx.inputs[vin]
    if (!createInput || !input || createInput.unlockingScript || !Number.isInteger(createInput.unlockingScriptLength))
      throw new sdk.WERR_INVALID_PARAMETER(
        'args',
        `spend does not correspond to prior input with valid unlockingScriptLength.`
      )
    if (spend.unlockingScript.length / 2 > createInput.unlockingScriptLength!)
      throw new sdk.WERR_INVALID_PARAMETER(
        'args',
        `spend unlockingScript length ${spend.unlockingScript.length} exceeds expected length ${createInput.unlockingScriptLength}`
      )
    input.unlockingScript = asBsvSdkScript(spend.unlockingScript)
    if (spend.sequenceNumber !== undefined) input.sequence = spend.sequenceNumber
  }

  const results = {
    sdk: <SignActionResult>{}
  }

  /////////////////////
  // Insert SABPPP unlock templates for storage signed inputs
  /////////////////////
  for (const pdi of prior.pdi) {
    const sabppp = new ScriptTemplateBRC29({
      derivationPrefix: pdi.derivationPrefix,
      derivationSuffix: pdi.derivationSuffix,
      keyDeriver: wallet.keyDeriver
    })
    const keys = wallet.getClientChangeKeyPair()
    const lockerPrivKey = keys.privateKey
    const unlockerPubKey = pdi.unlockerPubKey || keys.publicKey
    const sourceSatoshis = pdi.sourceSatoshis
    const lockingScript = asBsvSdkScript(pdi.lockingScript)
    const unlockTemplate = sabppp.unlock(lockerPrivKey, unlockerPubKey, sourceSatoshis, lockingScript)
    const input = prior.tx.inputs[pdi.vin]
    input.unlockingScriptTemplate = unlockTemplate
  }

  /////////////////////
  // Sign storage signed inputs making transaction fully valid.
  /////////////////////
  await prior.tx.sign()

  return prior.tx
}
function removeUnlockScripts(args: sdk.ValidCreateActionArgs) {
  let storageArgs = args
  if (!storageArgs.inputs.every(i => i.unlockingScript === undefined)) {
    // Never send unlocking scripts to storage, all it needs is the script length.
    storageArgs = { ...args, inputs: [] }
    for (const i of args.inputs) {
      const di: sdk.ValidCreateActionInput = {
        ...i,
        unlockingScriptLength: i.unlockingScript !== undefined ? i.unlockingScript.length : i.unlockingScriptLength
      }
      delete di.unlockingScript
      storageArgs.inputs.push(di)
    }
  }
  return storageArgs
}

export async function processAction(
  prior: PendingSignAction | undefined,
  wallet: Wallet,
  auth: sdk.AuthId,
  vargs: sdk.ValidProcessActionArgs
): Promise<sdk.StorageProcessActionResults> {
  const args: sdk.StorageProcessActionArgs = {
    isNewTx: vargs.isNewTx,
    isSendWith: vargs.isSendWith,
    isNoSend: vargs.isNoSend,
    isDelayed: vargs.isDelayed,
    reference: prior ? prior.reference : undefined,
    txid: prior ? prior.tx.id('hex') : undefined,
    rawTx: prior ? prior.tx.toBinary() : undefined,
    sendWith: vargs.isSendWith ? vargs.options.sendWith : []
  }
  const r: sdk.StorageProcessActionResults = await wallet.storage.processAction(args)

  return r
}

function makeDummyTransactionForOutputSatoshis(vout: number, satoshis: number): Transaction {
  const tx = new Transaction()
  for (let i = 0; i < vout; i++) tx.addOutput({ lockingScript: new Script(), satoshis: 0 })
  tx.addOutput({ lockingScript: new Script(), satoshis })
  return tx
}
