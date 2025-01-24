import { Beef, ListOutputsResult, OriginatorDomainNameStringUnder250Bytes, WalletOutput } from "@bsv/sdk"
import { table } from "../index.client"
import { asString, sdk, verifyId, verifyOne } from "../../index.client"
import { StorageKnex } from "../StorageKnex"

export async function listOutputs(
    dsk: StorageKnex,
    auth: sdk.AuthId,
    vargs: sdk.ValidListOutputsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes,
)
: Promise<ListOutputsResult>
{
    const trx: sdk.TrxToken | undefined = undefined
    const userId = verifyId(auth.userId)
    const limit = vargs.limit
    const offset = vargs.offset

    const k = dsk.toDb(trx)

    const r: ListOutputsResult = {
        totalOutputs: 0,
        outputs: []
    }

    /*
        ListOutputsArgs {
            basket: BasketStringUnder300Bytes

            tags?: OutputTagStringUnder300Bytes[]
            tagQueryMode?: 'all' | 'any' // default any

            limit?: PositiveIntegerDefault10Max10000
            offset?: PositiveIntegerOrZero
        }
    */

    let basketId: number | undefined = undefined
    const basketsById: Record<number, table.OutputBasket> = {}
    if (vargs.basket) {
        const baskets = await dsk.findOutputBaskets({ partial: { userId, name: vargs.basket }, trx })
        if (baskets.length !== 1)
            throw new sdk.WERR_INVALID_PARAMETER('basket', 'valid basket name.')
        const basket = baskets[0]
        basketId = basket.basketId!
        basketsById[basketId!] = basket
    }

    let tagIds: number[] = []
    if (vargs.tags && vargs.tags.length > 0) {
        const q = k<table.OutputTag>('output_tags')
            .where({
                'userId': userId,
                'isDeleted': false
            })
            .whereNotNull('outputTagId')
            .whereIn('tag', vargs.tags)
            .select('outputTagId')
        const r = await q
        tagIds = r.map(r => r.outputTagId!)
    }

    const isQueryModeAll = vargs.tagQueryMode === 'all'
    if (isQueryModeAll && tagIds.length < vargs.tags.length)
        return r

    const columns: string[] = [
        'outputId',
        'transactionId',
        'basketId',
        'spendable',
        'txid',
        'vout',
        'satoshis',
        'lockingScript',
        'customInstructions',
        'outputDescription',
        'spendingDescription',
        'scriptLength',
        'scriptOffset'
    ]

    const noTags = tagIds.length === 0
    const includeSpent = false

    const txStatusOk = `(select status as tstatus from transactions where transactions.transactionId = outputs.transactionId) in ('completed', 'unproven', 'nosend')`
    const txStatusOkCteq = `(select status as tstatus from transactions where transactions.transactionId = o.transactionId) in ('completed', 'unproven', 'nosend')`

    const makeWithTagsQueries = () => {
        let cteqOptions = ''
        if (basketId) cteqOptions += ` AND o.basketId = ${basketId}`
        if (!includeSpent) cteqOptions += ` AND o.spendable`
        const cteq = k.raw(`
            SELECT ${columns.map(c => 'o.' + c).join(',')}, 
                    (SELECT COUNT(*) 
                    FROM output_tags_map AS m 
                    WHERE m.OutputId = o.OutputId 
                    AND m.outputTagId IN (${tagIds.join(',')}) 
                    ) AS tc
            FROM outputs AS o
            WHERE o.userId = ${userId} ${cteqOptions} AND ${txStatusOkCteq}
            `);

        const q = k.with('otc', cteq)
        q.from('otc')
        if (isQueryModeAll)
            q.where('tc', tagIds.length)
        else
            q.where('tc', '>', 0)
        const qcount = q.clone()
        q.select(columns)
        qcount.count('outputId as total')
        return { q, qcount }
    }

    const makeWithoutTagsQueries = () => {
        const where: Partial<table.Output> = { userId }
        if (basketId) where.basketId = basketId
        if (!includeSpent) where.spendable = true
        const q = k('outputs').where(where).whereRaw(txStatusOk)
        const qcount = q.clone().count('outputId as total')
        return { q, qcount }
    }

    const { q, qcount } = noTags
        ? makeWithoutTagsQueries()
        : makeWithTagsQueries();

    // Sort order when limit and offset are possible must be ascending for determinism.
    q.limit(limit).offset(offset).orderBy('outputId', 'asc')

    const outputs: table.Output[] = await q

    if (!limit || outputs.length < limit)
        r.totalOutputs = outputs.length
    else {
        const total = verifyOne(await qcount)['total']
        r.totalOutputs = Number(total)
    }

    /*
        ListOutputsArgs {
            include?: 'locking scripts' | 'entire transactions'
            includeCustomInstructions?: BooleanDefaultFalse
            includeTags?: BooleanDefaultFalse
            includeLabels?: BooleanDefaultFalse
        }

        ListOutputsResult {
            totalOutputs: PositiveIntegerOrZero
            BEEF?: BEEF
            outputs: Array<WalletOutput>
        }

        WalletOutput {
            satoshis: SatoshiValue
            spendable: boolean
            outpoint: OutpointString

            customInstructions?: string
            lockingScript?: HexString
            tags?: OutputTagStringUnder300Bytes[]
            labels?: LabelStringUnder300Bytes[]
        }
    */

    const labelsByTxid: Record<string, string[]> = {}

    const beef = new Beef()

    for (const o of outputs) {
        const wo: WalletOutput = {
            satoshis: Number(o.satoshis),
            spendable: !!o.spendable,
            outpoint: `${o.txid}.${o.vout}`
        }
        r.outputs.push(wo)
        //if (vargs.includeBasket && o.basketId) {
        //    if (!basketsById[o.basketId]) {
        //        basketsById[o.basketId] = verifyTruthy(await dsk.findOutputBasketId(o.basketId!, trx))
        //    }
        //    wo.basket = basketsById[o.basketId].name
        //}
        if (vargs.includeCustomInstructions && o.customInstructions)
            wo.customInstructions = o.customInstructions
        if (vargs.includeLabels && o.txid) {
            if (labelsByTxid[o.txid] === undefined) {
                labelsByTxid[o.txid] = (await dsk.getLabelsForTransactionId(o.transactionId, trx)).map(l => l.label)
            }
            wo.labels = labelsByTxid[o.txid]
        }
        if (vargs.includeTags) {
            wo.tags = (await dsk.getTagsForOutputId(o.outputId, trx)).map(t => t.tag)
        }
        if (vargs.includeLockingScripts) {
            await dsk.validateOutputScript(o, trx)
            if (o.lockingScript)
                wo.lockingScript = asString(o.lockingScript)
        }
        if (vargs.includeTransactions && !beef.findTxid(o.txid!)) {
            await dsk.getValidBeefForKnownTxid(o.txid!, beef, undefined, vargs.knownTxids, trx)
        }
    }

    if (vargs.includeTransactions) {
        r.BEEF = beef.toBinary()
    }

    return r
}