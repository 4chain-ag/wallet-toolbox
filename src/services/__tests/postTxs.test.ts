import { Beef, Utils } from '@bsv/sdk'
import { Services } from "../../index.client"

describe('postTxs service tests', () => {
    jest.setTimeout(99999999)

    test('0', async () => {
        
        const options = Services.createDefaultOptions('main')
        const services = new Services(options)

        const txid = '1e3a4e2a952414081ec8576480b00dc2c1eeb04655480a09f167f7d82ac6e74a'
        const rawTx = await services.getRawTx(txid)
        const rawTxHex = Utils.toHex(rawTx.rawTx!)
        const beef = new Beef()
        beef.mergeRawTx(rawTx.rawTx!)
        const r = await services.postTxs(beef, [txid])
        expect(r[0].status).toBe('success')
    })
})