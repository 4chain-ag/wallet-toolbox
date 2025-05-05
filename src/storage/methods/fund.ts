import { StorageProvider, validateStorageFeeModel } from '../StorageProvider'
import { TableOutput, TableOutputBasket } from '../schema/tables'
import { Random, Script, Utils } from '@bsv/sdk'
import { sdk } from '../../index.client'
import { ValidCreateActionArgs } from '../../sdk'

interface CreateTransactionSdkContext {
  xinputs: XValidCreateActionInput[]
  xoutputs: XValidCreateActionOutput[]
  changeBasket: TableOutputBasket
  noSendChangeIn: TableOutput[]
  availableChangeCount: number
  feeModel: sdk.StorageFeeModel
  transactionId: number
}

interface XValidCreateActionInput extends sdk.ValidCreateActionInput {
  vin: number
  lockingScript: Script
  satoshis: number
  output?: TableOutput
}

export interface XValidCreateActionOutput extends sdk.ValidCreateActionOutput {
  vout: number
  providedBy: sdk.StorageProvidedBy
  purpose?: string
  derivationSuffix?: string
  keyOffset?: string
}

export interface GenerateChangeSdkParams {
  fixedInputs: GenerateChangeSdkInput[]
  fixedOutputs: GenerateChangeSdkOutput[]

  feeModel: sdk.StorageFeeModel

  /**
   * Target for number of new change outputs added minus number of funding change outputs consumed.
   * If undefined, only a single change output will be added if excess fees must be recaptured.
   */
  targetNetCount?: number
  /**
   * Satoshi amount to initialize optional new change outputs.
   */
  changeInitialSatoshis: number
  /**
   * Lowest amount value to assign to a change output.
   * Drop the output if unable to satisfy.
   * default 285
   */
  changeFirstSatoshis: number

  /**
   * Fixed change locking script length.
   *
   * For P2PKH template, 25 bytes
   */
  changeLockingScriptLength: number
  /**
   * Fixed change unlocking script length.
   *
   * For P2PKH template, 107 bytes
   */
  changeUnlockingScriptLength: number

  randomVals?: number[]
  noLogging?: boolean
  log?: string
}

export interface FundingResult {
  allocatedChange: TableOutput[]
  changeOutputs: TableOutput[]
  derivationPrefix: string
  maxPossibleSatoshisAdjustment?: {
    fixedOutputIndex: number
    satoshis: number
  }
}

export async function fundNewTransactionSdk(
  storage: StorageProvider,
  userId: number,
  vargs: sdk.ValidCreateActionArgs,
  ctx: CreateTransactionSdkContext
): Promise<FundingResult> {
  const params: GenerateChangeSdkParams = {
    fixedInputs: ctx.xinputs.map(xi => ({
      satoshis: xi.satoshis,
      unlockingScriptLength: xi.unlockingScriptLength!
    })),
    fixedOutputs: ctx.xoutputs.map(xo => ({
      satoshis: xo.satoshis,
      lockingScriptLength: xo.lockingScript.length / 2
    })),
    feeModel: ctx.feeModel,
    changeInitialSatoshis: ctx.changeBasket.minimumDesiredUTXOValue,
    changeFirstSatoshis: Math.max(1, Math.round(ctx.changeBasket.minimumDesiredUTXOValue / 4)),
    changeLockingScriptLength: 25,
    changeUnlockingScriptLength: 107,
    targetNetCount: ctx.changeBasket.numberOfDesiredUTXOs - ctx.availableChangeCount,
    randomVals: vargs.randomVals
  }

  const noSendChange = [...ctx.noSendChangeIn]

  const wrapper = new WrappedClosures(noSendChange, storage, ctx, userId, vargs)

  const gcr = await generateChangeSdk(params)

  const randomizer = new Randomizer(vargs)

  // Generate a derivation prefix for the payment
  const derivationPrefix = randomizer.randomDerivation(16)

  return {
    maxPossibleSatoshisAdjustment: gcr.maxPossibleSatoshisAdjustment,
    allocatedChange: gcr.allocatedChangeInputs.map(i => wrapper.outputs[i.outputId]),
    changeOutputs: gcr.changeOutputs.map(
      (o, i) =>
        <TableOutput>{
          // what we knnow now and can insert into the database for this new transaction's change output
          created_at: new Date(),
          updated_at: new Date(),
          outputId: 0,
          userId,
          transactionId: ctx.transactionId,
          vout: params.fixedOutputs.length + i,
          satoshis: o.satoshis,
          basketId: ctx.changeBasket.basketId!,
          spendable: false,
          change: true,
          type: 'P2PKH',
          derivationPrefix,
          derivationSuffix: randomizer.randomDerivation(16),
          providedBy: 'storage',
          purpose: 'change',
          customInstructions: undefined,
          senderIdentityKey: undefined,
          outputDescription: '',

          // what will be known when transaction is signed
          txid: undefined,
          lockingScript: undefined,

          // when this output gets spent
          spentBy: undefined,
          spendingDescription: undefined
        }
    ),
    derivationPrefix
  }
}

class WrappedClosures {
  noSendChange: TableOutput[]
  outputs: Record<number, TableOutput> = {}
  storage: StorageProvider
  ctx: CreateTransactionSdkContext
  userId: number
  vargs: sdk.ValidCreateActionArgs

  constructor(
    noSendChange: TableOutput[],
    storage: StorageProvider,
    ctx: CreateTransactionSdkContext,
    userId: number,
    vargs: ValidCreateActionArgs
  ) {
    this.noSendChange = noSendChange
    this.storage = storage
    this.ctx = ctx
    this.userId = userId
    this.vargs = vargs
  }

  async allocateChangeInput(
    targetSatoshis: number,
    exactSatoshis?: number
  ): Promise<GenerateChangeSdkChangeInput | undefined> {
    // noSendChange gets allocated first...typically only one input...just allocate in order...
    if (this.noSendChange.length > 0) {
      const o = this.noSendChange.pop()!
      this.outputs[o.outputId!] = o
      // allocate the output in storage, noSendChange is by definition spendable false and part of noSpend transaction batch.
      await this.storage.updateOutput(o.outputId!, {
        spendable: false,
        spentBy: this.ctx.transactionId
      })
      o.spendable = false
      o.spentBy = this.ctx.transactionId
      const r: GenerateChangeSdkChangeInput = {
        outputId: o.outputId!,
        satoshis: o.satoshis!
      }
      return r
    }

    const basketId = this.ctx.changeBasket.basketId!

    //TODO: check what is this
    const o = await this.storage.allocateChangeInput(
      this.userId,
      basketId,
      targetSatoshis,
      exactSatoshis,
      !this.vargs.isDelayed,
      this.ctx.transactionId
    )
    if (!o) return undefined
    this.outputs[o.outputId!] = o
    const r: GenerateChangeSdkChangeInput = {
      outputId: o.outputId!,
      satoshis: o.satoshis!
    }
    return r
  }

  async releaseChangeInput(outputId: number): Promise<void> {
    const nsco = this.ctx.noSendChangeIn.find(o => o.outputId === outputId)
    if (nsco) {
      this.noSendChange.push(nsco)
      return
    }
    await this.storage.updateOutput(outputId, {
      spendable: true,
      spentBy: undefined
    })
  }
}

class Randomizer {
  vargs: sdk.ValidCreateActionArgs

  constructor(vargs: ValidCreateActionArgs) {
    this.vargs = vargs
  }

  nextRandomVal(): number {
    let val = 0
    if (!this.vargs.randomVals || this.vargs.randomVals.length === 0) {
      val = Math.random()
    } else {
      val = this.vargs.randomVals.shift() || 0
      this.vargs.randomVals.push(val)
    }
    return val
  }

  /**
   * @returns a random integer betweenn min and max, inclussive.
   */
  rand(min: number, max: number): number {
    if (max < min) throw new sdk.WERR_INVALID_PARAMETER('max', `less than min (${min}). max is (${max})`)
    return Math.floor(this.nextRandomVal() * (max - min + 1) + min)
  }

  randomDerivation(count: number): string {
    let val: number[] = []
    if (!this.vargs.randomVals || this.vargs.randomVals.length === 0) {
      val = Random(count)
    } else {
      for (let i = 0; i < count; i++) val.push(this.rand(0, 255))
    }
    return Utils.toBase64(val)
  }
}

// =================================================================================================
// =================================================================================================
// ==================================== generateChange.ts ==========================================
// =================================================================================================
// =================================================================================================

/**
 * An output of this satoshis amount will be adjusted to the largest fundable amount.
 */
export const maxPossibleSatoshis = 2099999999999999

export interface GenerateChangeSdkResult {
  allocatedChangeInputs: GenerateChangeSdkChangeInput[]
  changeOutputs: GenerateChangeSdkChangeOutput[]
  size: number
  fee: number
  satsPerKb: number
  maxPossibleSatoshisAdjustment?: {
    fixedOutputIndex: number
    satoshis: number
  }
}

/**
 * Simplifications:
 *  - only support one change type with fixed length scripts.
 *  - only support satsPerKb fee model.
 *
 * Confirms for each availbleChange output that it remains available as they are allocated and selects alternate if not.
 *
 * @param params
 * @returns
 */
export async function generateChangeSdk(
  params: GenerateChangeSdkParams
): Promise<GenerateChangeSdkResult> {
  const r: GenerateChangeSdkResult = {
    allocatedChangeInputs: [], //from-do: probably those are allocated UTXOs
    changeOutputs: [],
    size: 0,
    fee: 0,
    satsPerKb: 0
  }

  // eslint-disable-next-line no-useless-catch
  try {
    const vgcpr = validateGenerateChangeSdkParams(params)

    const satsPerKb = params.feeModel.value || 0

    const randomVals = [...(params.randomVals || [])]

    const generator = new ChangeGenerator(satsPerKb, randomVals, params.fixedInputs, params.fixedOutputs, params.changeUnlockingScriptLength, params.changeLockingScriptLength, params.targetNetCount, params.changeFirstSatoshis, params.changeInitialSatoshis, r)
    
    generator.feeExcess()


    // If we'd like to have more change outputs create them now.
    // They may be removed if it turns out we can't fund them.
    while (
      (generator.hasTargetNetCount && generator.targetNetCount > generator.netChangeCount()) ||
      (r.changeOutputs.length === 0 && generator.feeExcess() > 0)
    ) {
      r.changeOutputs.push({
        satoshis: r.changeOutputs.length === 0 ? params.changeFirstSatoshis : params.changeInitialSatoshis,
        lockingScriptLength: params.changeLockingScriptLength
      })
    }

    /**
     * Add funding to achieve a non-negative feeExcess value, if necessary.
     */
    await generator.fundTransaction()

    if (generator.feeExcess() < 0 && vgcpr.hasMaxPossibleOutput !== undefined) {
      // Reduce the fixed output with satoshis of maxPossibleSatoshis to what will just fund the transaction...
      if (generator.fixedOutputs[vgcpr.hasMaxPossibleOutput].satoshis !== maxPossibleSatoshis) throw new sdk.WERR_INTERNAL()
      generator.fixedOutputs[vgcpr.hasMaxPossibleOutput].satoshis += generator.feeExcess()
      r.maxPossibleSatoshisAdjustment = {
        fixedOutputIndex: vgcpr.hasMaxPossibleOutput,
        satoshis: generator.fixedOutputs[vgcpr.hasMaxPossibleOutput].satoshis
      }
    }

    /**
     * Trigger an account funding event if we don't have enough to cover this transaction.
     */
    if (generator.feeExcess() < 0) {
      throw new sdk.WERR_INSUFFICIENT_FUNDS(generator.spending() + generator.feeTarget(), -generator.feeExcessNow)
    }

    /**
     * If needed, seek funding to avoid overspending on fees without a change output to recapture it.
     */
    if (r.changeOutputs.length === 0 && generator.feeExcessNow > 0) {
      throw new sdk.WERR_INSUFFICIENT_FUNDS(generator.spending() + generator.feeTarget(), params.changeFirstSatoshis)
    }

    /**
     * Distribute the excess fees across the changeOutputs added.
     */
    while (r.changeOutputs.length > 0 && generator.feeExcessNow > 0) {
      if (r.changeOutputs.length === 1) {
        r.changeOutputs[0].satoshis += generator.feeExcessNow
        generator.feeExcessNow = 0
      } else if (r.changeOutputs[0].satoshis < params.changeInitialSatoshis) {
        const sats = Math.min(generator.feeExcessNow, params.changeInitialSatoshis - r.changeOutputs[0].satoshis)
        generator.feeExcessNow -= sats
        r.changeOutputs[0].satoshis += sats
      } else {
        // Distribute a random percentage between 25% and 50% but at least one satoshi
        const sats = Math.max(1, Math.floor((generator.rand(2500, 5000) / 10000) * generator.feeExcessNow))
        generator.feeExcessNow -= sats
        const index = generator.rand(0, r.changeOutputs.length - 1)
        r.changeOutputs[index].satoshis += sats
      }
    }

    r.size = generator.size()
    ;(r.fee = generator.fee()), (r.satsPerKb = satsPerKb)

    const { ok, log } = validateGenerateChangeSdkResult(params, r)
    if (!ok) {
      throw new sdk.WERR_INTERNAL(`generateChangeSdk error: ${log}`)
    }

    if (r.allocatedChangeInputs.length > 4 && r.changeOutputs.length > 4) {
      console.log('generateChangeSdk_Capture_too_many_ins_and_outs')
      logGenerateChangeSdkParams(params)
    }

    return r
  } catch (eu: unknown) {
    const e = sdk.WalletError.fromUnknown(eu)
    if (e.code === 'WERR_INSUFFICIENT_FUNDS') throw eu

    // Capture the params in cloud run log which has a 100k text length limit per line.
    // logGenerateChangeSdkParams(params, eu)

    throw eu
  }
}

export function validateGenerateChangeSdkResult(
  params: GenerateChangeSdkParams,
  r: GenerateChangeSdkResult
): { ok: boolean; log: string } {
  let ok = true
  let log = ''
  const sumIn =
    params.fixedInputs.reduce((a, e) => a + e.satoshis, 0) + r.allocatedChangeInputs.reduce((a, e) => a + e.satoshis, 0)
  const sumOut =
    params.fixedOutputs.reduce((a, e) => a + e.satoshis, 0) + r.changeOutputs.reduce((a, e) => a + e.satoshis, 0)
  if (r.fee && Number.isInteger(r.fee) && r.fee < 0) {
    log += `basic fee error ${r.fee};`
    ok = false
  }
  const feePaid = sumIn - sumOut
  if (feePaid !== r.fee) {
    log += `exact fee error ${feePaid} !== ${r.fee};`
    ok = false
  }
  const feeRequired = Math.ceil(((r.size || 0) / 1000) * (r.satsPerKb || 0))
  if (feeRequired !== r.fee) {
    log += `required fee error ${feeRequired} !== ${r.fee};`
    ok = false
  }

  return { ok, log }
}


class ChangeGenerator {
  randomVals: number[]
  randomValsUsed: number[] = []
  fixedInputs: GenerateChangeSdkInput[]
  fixedOutputs: GenerateChangeSdkOutput[]
  satsPerKb: number
  targetNetCount: number
  changeLockingScriptLength: number
  changeFirstSatoshis: number
  changeInitialSatoshis: number
  changeUnlockingScriptLength: number
  r: GenerateChangeSdkResult
  feeExcessNow = 0
  hasTargetNetCount: boolean

  constructor(
    satsPerKb: number,
    randomVals: number[],
    fixedInputs: GenerateChangeSdkInput[],
    fixedOutputs: GenerateChangeSdkOutput[],
    changeUnlockingScriptLength: number,
    changeLockingScriptLength: number,
    targetNetCount: number | undefined,
    changeFirstSatoshis: number,
    changeInitialSatoshis: number,
    result: GenerateChangeSdkResult
  ) {
    this.changeFirstSatoshis = changeFirstSatoshis
    this.changeInitialSatoshis = changeInitialSatoshis
    this.targetNetCount = targetNetCount || 0
    this.hasTargetNetCount = targetNetCount !== undefined
    this.changeLockingScriptLength = changeLockingScriptLength
    this.satsPerKb = satsPerKb
    this.changeUnlockingScriptLength = changeUnlockingScriptLength
    this.randomVals = randomVals
    this.fixedInputs = fixedInputs
    this.fixedOutputs = fixedOutputs
    this.r = result
  }

  async fundTransaction(): Promise<void> {
    let removingOutputs = false

    // from-do: looks like this is a main code responsible for utxo selection and change output creation
    for (;;) {
      // This is the starvation loop, drops change outputs one at a time if unable to fund them...
      await this.releaseAllocatedChangeInputs()

      while (this.feeExcess() < 0) {
        // This is the funding loop, add one change input at a time...
        const ok = await this.attemptToFundTransaction(removingOutputs)
        if (!ok) break
      }

      // Done if blanced overbalanced or impossible (all funding applied, all change outputs removed).
      if (this.feeExcess() >= 0 || this.r.changeOutputs.length === 0) break

      removingOutputs = true
      while (this.r.changeOutputs.length > 0 && this.feeExcess() < 0) {
        this.r.changeOutputs.pop()
      }
      if (this.feeExcess() < 0)
        // Not enough available funding even if no change outputs
        break
      // and try again...
    }
  }

  async attemptToFundTransaction(removingOutputs: boolean): Promise<boolean> {
    if (this.feeExcess() > 0) return true

    let exactSatoshis: number | undefined = undefined
    if (!this.hasTargetNetCount && this.r.changeOutputs.length === 0) {
      exactSatoshis = -this.feeExcess(1)
    }
    const ao = this.addOutputToBalanceNewInput() ? 1 : 0
    const targetSatoshis = -this.feeExcess(1, ao) + (ao === 1 ? 2 * this.changeInitialSatoshis : 0)

    const allocatedChangeInput = await this.allocateChangeInput(targetSatoshis, exactSatoshis)

    if (!allocatedChangeInput) {
      // Unable to add another funding change input
      return false
    }

    this.r.allocatedChangeInputs.push(allocatedChangeInput)

    if (!removingOutputs && this.feeExcess() > 0) {
      if (ao == 1 || this.r.changeOutputs.length === 0) {
        this.r.changeOutputs.push({
          satoshis: Math.min(
            this.feeExcess(),
            this.r.changeOutputs.length === 0 ? this.changeFirstSatoshis : this.changeInitialSatoshis
          ),
          lockingScriptLength: this.changeLockingScriptLength
        })
      }
    }
    return true
  }

  rand(min: number, max: number): number {
    if (max < min) throw new sdk.WERR_INVALID_PARAMETER('max', `less than min (${min}). max is (${max})`)
    return Math.floor(this.nextRandomVal() * (max - min + 1) + min)
  }

  nextRandomVal(): number {
    let val = 0
    if (!this.randomVals || this.randomVals.length === 0) {
      val = Math.random()
    } else {
      val = this.randomVals.shift() || 0
      this.randomVals.push(val)
    }
    // Capture random sequence used if not supplied
    this.randomValsUsed.push(val)
    return val
  }

  /**
   * @returns sum of transaction fixedInputs satoshis and fundingInputs satoshis
   */
  funding(): number {
    return (
      this.fixedInputs.reduce((a, e) => a + e.satoshis, 0) +
      this.r.allocatedChangeInputs.reduce((a, e) => a + e.satoshis, 0)
    )
  }

  /**
   * @returns sum of transaction changeOutputs satoshis
   */
  change(): number {
    return this.r.changeOutputs.reduce((a, e) => a + e.satoshis, 0)
  }

  /**
   * @returns sum of transaction fixedOutputs satoshis
   */
  spending(): number {
    return this.fixedOutputs.reduce((a, e) => a + e.satoshis, 0)
  }

  fee(): number {
    return this.funding() - this.spending() - this.change()
  }

  size(addedChangeInputs?: number, addedChangeOutputs?: number): number {
    const inputScriptLengths = [
      ...this.fixedInputs.map(x => x.unlockingScriptLength),
      ...Array(this.r.allocatedChangeInputs.length + (addedChangeInputs || 0)).fill(this.changeUnlockingScriptLength)
    ]
    const outputScriptLengths = [
      ...this.fixedOutputs.map(x => x.lockingScriptLength),
      ...Array(this.r.changeOutputs.length + (addedChangeOutputs || 0)).fill(this.changeLockingScriptLength)
    ]
    const size = transactionSize(inputScriptLengths, outputScriptLengths)
    return size
  }

  /**
   * @returns the target fee required for the transaction as currently configured under feeModel.
   */
  feeTarget(addedChangeInputs?: number, addedChangeOutputs?: number): number {
    const fee = Math.ceil((this.size(addedChangeInputs, addedChangeOutputs) / 1000) * this.satsPerKb)
    return fee
  }

  /**
   * @returns the current excess fee for the transaction as currently configured.
   *
   * This is funding() - spending() - change() - feeTarget()
   *
   * The goal is an excess fee of zero.
   *
   * A positive value is okay if the cost of an additional change output is greater.
   *
   * A negative value means the transaction is under funded, or over spends, and may be rejected.
   */
  feeExcess(addedChangeInputs?: number, addedChangeOutputs?: number): number {
    const fe = this.funding() - this.spending() - this.change() - this.feeTarget(addedChangeInputs, addedChangeOutputs)
    if (!addedChangeInputs && !addedChangeOutputs) this.feeExcessNow = fe
    return fe
  }

  netChangeCount(): number {
    return this.r.changeOutputs.length - this.r.allocatedChangeInputs.length
  }

  addOutputToBalanceNewInput(): boolean {
    if (!this.hasTargetNetCount) return false
    return this.netChangeCount() - 1 < this.targetNetCount
  }

  async releaseAllocatedChangeInputs(): Promise<void> {
    while (this.r.allocatedChangeInputs.length > 0) {
      const i = this.r.allocatedChangeInputs.pop()
      if (i) {
        await this.releaseChangeInput(i.outputId)
      }
    }
    this.feeExcessNow = this.feeExcess()
  }

  async releaseChangeInput(outputId: number): Promise<void> {
    // from-do: see WrappedClosures.releaseChangeInput
    // or the code below (as it is copied from it and commented out)
    //
    // const nsco = this.ctx.noSendChangeIn.find(o => o.outputId === outputId)
    // if (nsco) {
    //   this.noSendChange.push(nsco)
    //   return
    // }
    // await this.storage.updateOutput(outputId, {
    //   spendable: true,
    //   spentBy: undefined
    // })
  }

  async allocateChangeInput(
    targetSatoshis: number,
    exactSatoshis?: number
  ): Promise<GenerateChangeSdkChangeInput | undefined> {
    // from-do: see WrappedClosures.allocateChangeInput
    // or the code below (as it is copied from it and commented out)
    //
    // // noSendChange gets allocated first...typically only one input...just allocate in order...
    // if (this.noSendChange.length > 0) {
    //   const o = this.noSendChange.pop()!
    //   this.outputs[o.outputId!] = o
    //   // allocate the output in storage, noSendChange is by definition spendable false and part of noSpend transaction batch.
    //   await this.storage.updateOutput(o.outputId!, {
    //     spendable: false,
    //     spentBy: this.ctx.transactionId
    //   })
    //   o.spendable = false
    //   o.spentBy = this.ctx.transactionId
    //   const r: GenerateChangeSdkChangeInput = {
    //     outputId: o.outputId!,
    //     satoshis: o.satoshis!
    //   }
    //   return r
    // }
    //
    // const basketId = this.ctx.changeBasket.basketId!
    //
    // //TODO: check what is this
    // const o = await this.storage.allocateChangeInput(
    //   this.userId,
    //   basketId,
    //   targetSatoshis,
    //   exactSatoshis,
    //   !this.vargs.isDelayed,
    //   this.ctx.transactionId
    // )
    // if (!o) return undefined
    // this.outputs[o.outputId!] = o
    // const r: GenerateChangeSdkChangeInput = {
    //   outputId: o.outputId!,
    //   satoshis: o.satoshis!
    // }
    // return r

    throw new Error('Method not implemented.')
  }
}


function logGenerateChangeSdkParams(params: GenerateChangeSdkParams, eu?: unknown) {
  let s = JSON.stringify(params)
  console.log(`generateChangeSdk params length ${s.length}${eu ? ` error: ${eu}` : ''}`)
  let i = -1
  const maxlen = 99900
  for (;;) {
    i++
    console.log(`generateChangeSdk params ${i} XXX${s.slice(0, maxlen)}XXX`)
    s = s.slice(maxlen)
    if (!s || i > 100) break
  }
}

export interface GenerateChangeSdkParams {
  fixedInputs: GenerateChangeSdkInput[]
  fixedOutputs: GenerateChangeSdkOutput[]

  feeModel: sdk.StorageFeeModel

  /**
   * Target for number of new change outputs added minus number of funding change outputs consumed.
   * If undefined, only a single change output will be added if excess fees must be recaptured.
   */
  targetNetCount?: number
  /**
   * Satoshi amount to initialize optional new change outputs.
   */
  changeInitialSatoshis: number
  /**
   * Lowest amount value to assign to a change output.
   * Drop the output if unable to satisfy.
   * default 285
   */
  changeFirstSatoshis: number

  /**
   * Fixed change locking script length.
   *
   * For P2PKH template, 25 bytes
   */
  changeLockingScriptLength: number
  /**
   * Fixed change unlocking script length.
   *
   * For P2PKH template, 107 bytes
   */
  changeUnlockingScriptLength: number

  randomVals?: number[]
  noLogging?: boolean
  log?: string
}

export interface GenerateChangeSdkInput {
  satoshis: number
  unlockingScriptLength: number
}

export interface GenerateChangeSdkOutput {
  satoshis: number
  lockingScriptLength: number
}

export interface GenerateChangeSdkChangeInput {
  outputId: number
  satoshis: number
}

export interface GenerateChangeSdkChangeOutput {
  satoshis: number
  lockingScriptLength: number
}

export interface ValidateGenerateChangeSdkParamsResult {
  hasMaxPossibleOutput?: number
}

export function validateGenerateChangeSdkParams(
  params: GenerateChangeSdkParams
): ValidateGenerateChangeSdkParamsResult {
  if (!Array.isArray(params.fixedInputs)) throw new sdk.WERR_INVALID_PARAMETER('fixedInputs', 'an array of objects')

  const r: ValidateGenerateChangeSdkParamsResult = {}

  params.fixedInputs.forEach((x, i) => {
    sdk.validateSatoshis(x.satoshis, `fixedInputs[${i}].satoshis`)
    sdk.validateInteger(x.unlockingScriptLength, `fixedInputs[${i}].unlockingScriptLength`, undefined, 0)
  })

  if (!Array.isArray(params.fixedOutputs)) throw new sdk.WERR_INVALID_PARAMETER('fixedOutputs', 'an array of objects')
  params.fixedOutputs.forEach((x, i) => {
    sdk.validateSatoshis(x.satoshis, `fixedOutputs[${i}].satoshis`)
    sdk.validateInteger(x.lockingScriptLength, `fixedOutputs[${i}].lockingScriptLength`, undefined, 0)
    if (x.satoshis === maxPossibleSatoshis) {
      if (r.hasMaxPossibleOutput !== undefined)
        throw new sdk.WERR_INVALID_PARAMETER(
          `fixedOutputs[${i}].satoshis`,
          `valid satoshis amount. Only one 'maxPossibleSatoshis' output allowed.`
        )
      r.hasMaxPossibleOutput = i
    }
  })

  params.feeModel = validateStorageFeeModel(params.feeModel)
  if (params.feeModel.model !== 'sat/kb') throw new sdk.WERR_INVALID_PARAMETER('feeModel.model', `'sat/kb'`)

  sdk.validateOptionalInteger(params.targetNetCount, `targetNetCount`)

  sdk.validateSatoshis(params.changeFirstSatoshis, 'changeFirstSatoshis', 1)
  sdk.validateSatoshis(params.changeInitialSatoshis, 'changeInitialSatoshis', 1)

  sdk.validateInteger(params.changeLockingScriptLength, `changeLockingScriptLength`)
  sdk.validateInteger(params.changeUnlockingScriptLength, `changeUnlockingScriptLength`)

  return r
}

export interface GenerateChangeSdkStorageChange extends GenerateChangeSdkChangeInput {
  spendable: boolean
}

export function generateChangeSdkMakeStorage(availableChange: GenerateChangeSdkChangeInput[]): {
  allocateChangeInput: (
    targetSatoshis: number,
    exactSatoshis?: number
  ) => Promise<GenerateChangeSdkChangeInput | undefined>
  releaseChangeInput: (outputId: number) => Promise<void>
  getLog: () => string
} {
  const change: GenerateChangeSdkStorageChange[] = availableChange.map(c => ({
    ...c,
    spendable: true
  }))
  change.sort((a, b) =>
    a.satoshis < b.satoshis
      ? -1
      : a.satoshis > b.satoshis
        ? 1
        : a.outputId < b.outputId
          ? -1
          : a.outputId > b.outputId
            ? 1
            : 0
  )

  let log = ''
  for (const c of change) log += `change ${c.satoshis} ${c.outputId}\n`

  const getLog = (): string => log

  const allocate = (c: GenerateChangeSdkStorageChange) => {
    log += ` -> ${c.satoshis} sats, id ${c.outputId}\n`
    c.spendable = false
    return c
  }

  const allocateChangeInput = async (
    targetSatoshis: number,
    exactSatoshis?: number
  ): Promise<GenerateChangeSdkChangeInput | undefined> => {
    log += `allocate target ${targetSatoshis} exact ${exactSatoshis}`

    if (exactSatoshis !== undefined) {
      const exact = change.find(c => c.spendable && c.satoshis === exactSatoshis)
      if (exact) return allocate(exact)
    }
    const over = change.find(c => c.spendable && c.satoshis >= targetSatoshis)
    if (over) return allocate(over)
    let under: GenerateChangeSdkStorageChange | undefined = undefined
    for (let i = change.length - 1; i >= 0; i--) {
      if (change[i].spendable) {
        under = change[i]
        break
      }
    }
    if (under) return allocate(under)
    log += `\n`
    return undefined
  }

  const releaseChangeInput = async (outputId: number): Promise<void> => {
    log += `release id ${outputId}\n`
    const c = change.find(x => x.outputId === outputId)
    if (!c) throw new sdk.WERR_INTERNAL(`unknown outputId ${outputId}`)
    if (c.spendable) throw new sdk.WERR_INTERNAL(`release of spendable outputId ${outputId}`)
    c.spendable = true
  }

  return { allocateChangeInput, releaseChangeInput, getLog }
}

/**
 * Returns the byte size required to encode number as Bitcoin VarUint
 * @publicbody
 */
export function varUintSize(val: number): 1 | 3 | 5 | 9 {
  if (val < 0) throw new sdk.WERR_INVALID_PARAMETER('varUint', 'non-negative')
  return val <= 0xfc ? 1 : val <= 0xffff ? 3 : val <= 0xffffffff ? 5 : 9
}

/**
 * @param scriptSize byte length of input script
 * @returns serialized byte length a transaction input
 */
export function transactionInputSize(scriptSize: number): number {
  return (
    32 + // txid
    4 + // vout
    varUintSize(scriptSize) + // script length, this is already in bytes
    scriptSize + // script
    4
  ) // sequence number
}

/**
 * @param scriptSize byte length of output script
 * @returns serialized byte length a transaction output
 */
export function transactionOutputSize(scriptSize: number): number {
  return (
    varUintSize(scriptSize) + // output script length, from script encoded as hex string
    scriptSize + // output script
    8
  ) // output amount (satoshis)
}

/**
 * Compute the serialized binary transaction size in bytes
 * given the number of inputs and outputs,
 * and the size of each script.
 * @param inputs array of input script lengths, in bytes
 * @param outputs array of output script lengths, in bytes
 * @returns total transaction size in bytes
 */
export function transactionSize(inputs: number[], outputs: number[]): number {
  return (
    4 + // Version
    varUintSize(inputs.length) + // Number of inputs
    inputs.reduce((a, e) => a + transactionInputSize(e), 0) + // all inputs
    varUintSize(outputs.length) + // Number of outputs
    outputs.reduce((a, e) => a + transactionOutputSize(e), 0) + // all outputs
    4
  ) // lock time
}
