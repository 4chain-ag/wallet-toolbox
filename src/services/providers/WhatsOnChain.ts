import { Beef, HexString, Utils, WhatsOnChainConfig } from '@bsv/sdk'
import { asArray, asString, doubleSha256BE, sdk, validateScriptHash, wait } from '../../index.client'
import { convertProofToMerklePath } from '../../utility/tscProofToMerklePath'
import SdkWhatsOnChain from './SdkWhatsOnChain'
import { ReqHistoryNote } from '../../sdk'

/**
 *
 */
export class WhatsOnChain extends SdkWhatsOnChain {
  constructor(chain: sdk.Chain = 'main', config: WhatsOnChainConfig = {}) {
    super(chain, config)
  }

  /**
   * 2025-02-16 throwing internal server error 500.
   * @param txid
   * @returns
   */
  async getTxPropagation(txid: string): Promise<number> {
    const requestOptions = {
      method: 'GET',
      headers: this.getHttpHeaders()
    }

    const response = await this.httpClient.request<string>(`${this.URL}/tx/hash/${txid}/propagation`, requestOptions)

    // response.statusText is often, but not always 'OK' on success...
    if (!response.data || !response.ok || response.status !== 200)
      throw new sdk.WERR_INVALID_PARAMETER('txid', `valid transaction. '${txid}' response ${response.statusText}`)

    return 0
  }

  /**
   * May return undefined for unmined transactions that are in the mempool.
   * @param txid
   * @returns raw transaction as hex string or undefined if txid not found in mined block.
   */
  async getRawTx(txid: string): Promise<string | undefined> {
    const headers = this.getHttpHeaders()
    headers['Cache-Control'] = 'no-cache'

    const requestOptions = {
      method: 'GET',
      headers
    }

    const url = `${this.URL}/tx/${txid}/hex`

    for (let retry = 0; retry < 2; retry++) {
      const response = await this.httpClient.request<string>(url, requestOptions)
      if (response.statusText === 'Too Many Requests' && retry < 2) {
        await wait(2000)
        continue
      }

      if (response.status === 404 && response.statusText === 'Not Found') return undefined

      // response.statusText is often, but not always 'OK' on success...
      if (!response.data || !response.ok || response.status !== 200)
        throw new sdk.WERR_INVALID_PARAMETER('txid', `valid transaction. '${txid}' response ${response.statusText}`)

      return response.data
    }
    throw new sdk.WERR_INTERNAL()
  }

  async getRawTxResult(txid: string): Promise<sdk.GetRawTxResult> {
    const r: sdk.GetRawTxResult = { name: 'WoC', txid: asString(txid) }

    try {
      const rawTxHex = await this.getRawTx(txid)
      if (rawTxHex) r.rawTx = asArray(rawTxHex)
    } catch (err: unknown) {
      r.error = sdk.WalletError.fromUnknown(err)
    }

    return r
  }

  /**
   * WhatsOnChain does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.
   *
   * Send rawTx in `txids` order from beef.
   *
   * @param beef
   * @param txids
   * @returns
   */
  async postBeef(beef: Beef, txids: string[]): Promise<sdk.PostBeefResult> {
    const r: sdk.PostBeefResult = {
      name: 'WoC',
      status: 'success',
      txidResults: [],
      notes: []
    }

    let delay = false

    const nn = () => ({ name: 'WoCpostBeef', when: new Date().toISOString() })
    const nne = () => ({ ...nn(), beef: beef.toHex(), txids: txids.join(',') })

    for (const txid of txids) {
      const rawTx = Utils.toHex(beef.findTxid(txid)!.rawTx!)

      if (delay) {
        // For multiple txids, give WoC time to propagate each one.
        await wait(3000)
      }
      delay = true

      const tr = await this.postRawTx(rawTx)
      if (txid !== tr.txid) {
        throw new sdk.WERR_INTERNAL(`woc returned txid ${tr.txid}, expected ${txid}`)
      }

      r.txidResults.push(tr)
      if (r.status === 'success' && tr.status !== 'success') r.status = 'error'
    }

    if (r.status === 'success') {
      r.notes!.push({ ...nn(), what: 'postBeefSuccess' })
    } else {
      r.notes!.push({ ...nne(), what: 'postBeefError' })
    }

    return r
  }

  /**
   * @param rawTx raw transaction to broadcast as hex string
   * @returns txid returned by transaction processor of transaction broadcast
   */
  async postRawTx(rawTx: HexString): Promise<sdk.PostTxResultForTxid> {
    let txid = Utils.toHex(doubleSha256BE(Utils.toArray(rawTx, 'hex')))

    const r: sdk.PostTxResultForTxid = {
      txid,
      status: 'success',
      notes: []
    }

    const headers = this.getHttpHeaders()
    headers['Content-Type'] = 'application/json'
    headers['Accept'] = 'text/plain'

    const requestOptions = {
      method: 'POST',
      headers,
      data: { txhex: rawTx }
    }

    const url = `${this.URL}/tx/raw`
    const nn = () => ({ name: 'WoCpostRawTx', when: new Date().toISOString() })
    const nne = () => ({ ...nn(), rawTx, txid, url })

    const retryLimit = 5
    for (let retry = 0; retry < retryLimit; retry++) {
      try {
        const response = await this.httpClient.request<string>(url, requestOptions)
        if (response.statusText === 'Too Many Requests' && retry < 2) {
          r.notes!.push({ ...nn(), what: 'postRawTxRateLimit' })
          await wait(2000)
          continue
        }
        if (response.ok) {
          const txid = response.data
          r.notes!.push({ ...nn(), what: 'postRawTxSuccess' })
        } else if (response.data === 'unexpected response code 500: Transaction already in the mempool') {
          r.notes!.push({ ...nne(), what: 'postRawTxSuccessAlreadyInMempool' })
        } else {
          r.status = 'error'
          const n: ReqHistoryNote = {
            ...nne(),
            what: 'postRawTxError'
          }
          if (typeof response.data === 'string') {
            n.data = response.data.slice(0, 128)
            r.data = response.data
          } else {
            r.data = ''
          }
          if (typeof response.statusText === 'string') {
            n.statusText = response.statusText.slice(0, 128)
            r.data += `,${response.statusText}`
          }
          if (typeof response.status === 'string') {
            n.status = (response.status as string).slice(0, 128)
            r.data += `,${response.status}`
          }
          if (typeof response.status === 'number') {
            n.status = response.status
            r.data += `,${response.status}`
          }
          r.notes!.push(n)
        }
      } catch (eu: unknown) {
        r.status = 'error'
        const e = sdk.WalletError.fromUnknown(eu)
        r.notes!.push({
          ...nne(),
          what: 'postRawTxCatch',
          code: e.code,
          description: e.description
        })
        r.data = `${e.code} ${e.description}`
      }
      return r
    }
    r.status = 'error'
    r.notes!.push({
      ...nne(),
      what: 'postRawTxRetryLimit',
      retryLimit
    })
    return r
  }

  /**
   * @param txid
   * @returns
   */
  async getMerklePath(txid: string, services: sdk.WalletServices): Promise<sdk.GetMerklePathResult> {
    const r: sdk.GetMerklePathResult = { name: 'WoCTsc', notes: [] }

    const headers = this.getHttpHeaders()
    const requestOptions = {
      method: 'GET',
      headers
    }

    for (let retry = 0; retry < 2; retry++) {
      try {
        const response = await this.httpClient.request<WhatsOnChainTscProof | WhatsOnChainTscProof[]>(
          `${this.URL}/tx/${txid}/proof/tsc`,
          requestOptions
        )
        if (response.statusText === 'Too Many Requests' && retry < 2) {
          r.notes!.push({
            what: 'getMerklePathRetry',
            name: r.name,
            status: response.status,
            statusText: response.statusText
          })
          await wait(2000)
          continue
        }

        if (response.status === 404 && response.statusText === 'Not Found') {
          r.notes!.push({
            what: 'getMerklePathNotFound',
            name: r.name,
            status: response.status,
            statusText: response.statusText
          })
          return r
        }

        // response.statusText is often, but not always 'OK' on success...
        if (!response.ok || response.status !== 200) {
          r.notes!.push({
            what: 'getMerklePathBadStatus',
            name: r.name,
            status: response.status,
            statusText: response.statusText
          })
          throw new sdk.WERR_INVALID_PARAMETER('txid', `valid transaction. '${txid}' response ${response.statusText}`)
        }

        if (!response.data) {
          // Unmined, proof not yet available.
          r.notes!.push({
            what: 'getMerklePathNoData',
            name: r.name,
            status: response.status,
            statusText: response.statusText
          })
          return r
        }

        if (!Array.isArray(response.data)) response.data = [response.data]

        if (response.data.length != 1) return r

        const p = response.data[0]
        const header = await services.hashToHeader(p.target)
        if (header) {
          const proof = {
            index: p.index,
            nodes: p.nodes,
            height: header.height
          }
          r.merklePath = convertProofToMerklePath(txid, proof)
          r.header = header
          r.notes!.push({
            what: 'getMerklePathSuccess',
            name: r.name,
            status: response.status,
            statusText: response.statusText
          })
        } else {
          r.notes!.push({
            what: 'getMerklePathNoHeader',
            target: p.target,
            name: r.name,
            status: response.status,
            statusText: response.statusText
          })
          throw new sdk.WERR_INVALID_PARAMETER('blockhash', 'a valid on-chain block hash')
        }
      } catch (eu: unknown) {
        const e = sdk.WalletError.fromUnknown(eu)
        r.notes!.push({
          what: 'getMerklePathError',
          name: r.name,
          code: e.code,
          description: e.description
        })
        r.error = e
      }
      return r
    }
    r.notes!.push({ what: 'getMerklePathInternal', name: r.name })
    throw new sdk.WERR_INTERNAL()
  }

  async updateBsvExchangeRate(rate?: sdk.BsvExchangeRate, updateMsecs?: number): Promise<sdk.BsvExchangeRate> {
    if (rate) {
      // Check if the rate we know is stale enough to update.
      updateMsecs ||= 1000 * 60 * 15
      if (new Date(Date.now() - updateMsecs) < rate.timestamp) return rate
    }

    const requestOptions = {
      method: 'GET',
      headers: this.getHttpHeaders()
    }

    for (let retry = 0; retry < 2; retry++) {
      const response = await this.httpClient.request<{
        rate: number
        time: number
        currency: string
      }>(`${this.URL}/exchangerate`, requestOptions)
      if (response.statusText === 'Too Many Requests' && retry < 2) {
        await wait(2000)
        continue
      }

      // response.statusText is often, but not always 'OK' on success...
      if (!response.data || !response.ok || response.status !== 200)
        throw new sdk.WERR_INVALID_OPERATION(`WoC exchangerate response ${response.statusText}`)

      const wocrate = response.data
      if (wocrate.currency !== 'USD') wocrate.rate = NaN

      const newRate: sdk.BsvExchangeRate = {
        timestamp: new Date(),
        base: 'USD',
        rate: wocrate.rate
      }

      return newRate
    }
    throw new sdk.WERR_INTERNAL()
  }

  async getUtxoStatus(output: string, outputFormat?: sdk.GetUtxoStatusOutputFormat): Promise<sdk.GetUtxoStatusResult> {
    const r: sdk.GetUtxoStatusResult = {
      name: 'WoC',
      status: 'error',
      error: new sdk.WERR_INTERNAL(),
      details: []
    }

    for (let retry = 0; ; retry++) {
      let url: string = ''

      try {
        const scriptHash = validateScriptHash(output, outputFormat)

        const requestOptions = {
          method: 'GET',
          headers: this.getHttpHeaders()
        }

        const response = await this.httpClient.request<WhatsOnChainUtxoStatus[]>(
          `${this.URL}/script/${scriptHash}/unspent`,
          requestOptions
        )
        if (response.statusText === 'Too Many Requests' && retry < 2) {
          await wait(2000)
          continue
        }

        // response.statusText is often, but not always 'OK' on success...
        if (!response.data || !response.ok || response.status !== 200)
          throw new sdk.WERR_INVALID_OPERATION(`WoC exchangerate response ${response.statusText}`)

        if (Array.isArray(response.data)) {
          const data = response.data
          if (data.length === 0) {
            r.status = 'success'
            r.error = undefined
            r.isUtxo = false
          } else {
            r.status = 'success'
            r.error = undefined
            r.isUtxo = true
            for (const s of data) {
              r.details.push({
                txid: s.tx_hash,
                satoshis: s.value,
                height: s.height,
                index: s.tx_pos
              })
            }
          }
        } else {
          throw new sdk.WERR_INTERNAL('data is not an array')
        }

        return r
      } catch (eu: unknown) {
        const e = sdk.WalletError.fromUnknown(eu)
        if (e.code !== 'ECONNRESET' || retry > 2) {
          r.error = new sdk.WERR_INTERNAL(
            `service failure: ${url}, error: ${JSON.stringify(sdk.WalletError.fromUnknown(eu))}`
          )
          return r
        }
      }
    }
  }
}

interface WhatsOnChainTscProof {
  index: number
  nodes: string[]
  target: string
  txOrId: string
}

interface WhatsOnChainUtxoStatus {
  value: number
  height: number
  tx_pos: number
  tx_hash: string
}
