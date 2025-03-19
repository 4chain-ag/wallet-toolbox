import { Beef, defaultHttpClient, HexString, HttpClient, Utils } from '@bsv/sdk'
import { convertProofToMerklePath, doubleSha256BE, sdk, wait } from '../../index.client'
import { ReqHistoryNote } from '../../sdk'

export interface BitailsConfig {
  /** Authentication token for BitTails API */
  apiKey?: string
  /** The HTTP client used to make requests to the API. */
  httpClient?: HttpClient
}

/**
 *
 */
export class Bitails {
  readonly chain: sdk.Chain
  readonly apiKey: string
  readonly URL: string
  readonly httpClient: HttpClient

  constructor(chain: sdk.Chain = 'main', config: BitailsConfig = {}) {
    const { apiKey, httpClient } = config
    this.chain = chain
    this.URL = chain === 'main' ? `https://api.bitails.io/` : `https://test-api.bitails.io/`
    this.httpClient = httpClient ?? defaultHttpClient()
    this.apiKey = apiKey ?? ''
  }

  getHttpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    }

    if (typeof this.apiKey === 'string' && this.apiKey.trim() !== '') {
      headers.Authorization = this.apiKey
    }

    return headers
  }

  /**
   * Bitails does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.
   *
   * Send rawTx in `txids` order from beef.
   *
   * @param beef
   * @param txids
   * @returns
   */
  async postBeef(beef: Beef, txids: string[]): Promise<sdk.PostBeefResult> {
    const nn = () => ({
      name: 'BitailsPostBeef',
      when: new Date().toISOString()
    })
    const nne = () => ({ ...nn(), beef: beef.toHex(), txids: txids.join(',') })

    const note: ReqHistoryNote = { ...nn(), what: 'postBeef' }

    const raws: string[] = []
    for (const txid of txids) {
      const rawTx = Utils.toHex(beef.findTxid(txid)!.rawTx!)
      raws.push(rawTx)
    }

    const r = await this.postRaws(raws)

    r.notes!.unshift(note)
    if (r.status !== 'success') r.notes!.push({ ...nne(), what: 'postBeefError' })
    else r.notes!.push({ ...nn(), what: 'postBeefSuccess' })

    return r
  }

  /**
   * @param raws Array of raw transactions to broadcast as hex strings
   * @returns
   */
  async postRaws(raws: HexString[]): Promise<sdk.PostBeefResult> {
    const r: sdk.PostBeefResult = {
      name: 'BitailsPostRaws',
      status: 'success',
      txidResults: [],
      notes: []
    }

    for (const raw of raws) {
      const txid = Utils.toHex(doubleSha256BE(Utils.toArray(raw, 'hex')))
      r.txidResults.push({
        txid,
        status: 'success',
        notes: []
      })
    }

    const headers = this.getHttpHeaders()
    headers['Content-Type'] = 'application/json'
    //headers['Accept'] = 'text/json'

    const data = { raws: raws }
    const requestOptions = {
      method: 'POST',
      headers,
      data
    }

    const url = `${this.URL}tx/broadcast/multi`
    const nn = () => ({
      name: 'BitailsPostRawTx',
      when: new Date().toISOString()
    })
    const nne = () => ({
      ...nn(),
      raws: raws.join(','),
      txids: r.txidResults.map(r => r.txid).join(','),
      url
    })

    try {
      const response = await this.httpClient.request<BitailsPostRawsResult[]>(url, requestOptions)
      if (response.ok) {
        // status: 201, statusText: 'Created'
        const btrs: BitailsPostRawsResult[] = response.data
        for (const rt of r.txidResults) {
          const btr = btrs.find(btr => (btr.txid = rt.txid))
          const txid = rt.txid
          if (!btr) {
            rt.status = 'error'
            rt.notes!.push({ ...nne(), what: 'postRawsMissingResult', txid })
          } else if (btr.error) {
            // code: -25, message: 'missing-inputs'
            // code: -27, message: 'already-in-mempool'
            const { code, message } = btr.error
            if (code === -27) {
              rt.notes!.push({ ...nne(), what: 'postRawsSuccessAlreadyInMempool' })
            } else {
              rt.status = 'error'
              rt.notes!.push({ ...nne(), what: 'postRawsError', txid, code, message })
            }
          } else {
            rt.notes!.push({ ...nn(), what: 'postRawsSuccess' })
          }
          if (rt.status !== 'success' && r.status === 'success') r.status = 'error'
        }
      } else {
        r.status = 'error'
        const n: ReqHistoryNote = { ...nne(), what: 'postRawsError' }
        r.notes!.push(n)
      }
    } catch (eu: unknown) {
      r.status = 'error'
      const e = sdk.WalletError.fromUnknown(eu)
      const { code, description } = e
      r.notes!.push({ ...nne(), what: 'postRawsCatch', code, description })
    }
    return r
  }

  /**
   *
   * @param txid
   * @param services
   * @returns
   */
  async getMerklePath(txid: string, services: sdk.WalletServices): Promise<sdk.GetMerklePathResult> {
    const r: sdk.GetMerklePathResult = { name: 'BitailsTsc', notes: [] }

    const url = `${this.URL}tx/${txid}/proof/tsc`

    const nn = () => ({ name: 'BitailsProofTsc', when: new Date().toISOString(), txid, url })

    const headers = this.getHttpHeaders()
    const requestOptions = { method: 'GET', headers }

    try {
      const response = await this.httpClient.request<BitailsMerkleProof>(url, requestOptions)

      const nne = () => ({ ...nn(), txid, url, status: response.status, statusText: response.statusText })

      if (response.status === 404 && response.statusText === 'Not Found') {
        r.notes!.push({ ...nn(), what: 'getMerklePathNotFound' })
      } else if (!response.ok || response.status !== 200 || response.statusText !== 'OK') {
        r.notes!.push({ ...nne(), what: 'getMerklePathBadStatus' })
      } else if (!response.data) {
        r.notes!.push({ ...nne(), what: 'getMerklePathNoData' })
      } else {
        const p = response.data
        const header = await services.hashToHeader(p.target)
        if (header) {
          const proof = { index: p.index, nodes: p.nodes, height: header.height }
          r.merklePath = convertProofToMerklePath(txid, proof)
          r.header = header
          r.notes!.push({ ...nne(), what: 'getMerklePathSuccess' })
        } else {
          r.notes!.push({ ...nne(), what: 'getMerklePathNoHeader', target: p.target })
        }
      }
    } catch (eu: unknown) {
      const e = sdk.WalletError.fromUnknown(eu)
      const { code, description } = e
      r.notes!.push({ ...nn(), what: 'getMerklePathCatch', code, description })
      r.error = e
    }
    return r
  }
}

interface BitailsPostRawsResult {
  txid: string
  error?: {
    code: number
    message: string
  }
}

export interface BitailsMerkleProof {
  index: number
  txOrId: string
  target: string
  nodes: string[]
}
