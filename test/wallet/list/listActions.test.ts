import * as bsv from '@bsv/sdk'
import { sdk, StorageProvider, table } from '../../../src/index.client'
import { _tu, expectToThrowWERR, TestSetup1, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { asBuffer, StorageKnex } from '../../../src'
import { Script, Transaction, TransactionInput } from '@bsv/sdk'

describe('listActions tests', () => {
  jest.setTimeout(99999999)

  const storages: StorageProvider[] = []
  const chain: sdk.Chain = 'test'
  const setups: { setup: TestSetup1; storage: StorageProvider }[] = []

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const testName = () => expect.getState().currentTestName || 'test'
  const name = testName.name

  beforeAll(async () => {
    if (!env.noMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy(name))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy(name))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('0 invalid params', async () => {
    for (const { wallet } of ctxs) {
      const invalidArgs: bsv.ListActionsArgs[] = [
        { labels: [] },
        { includeLabels: true, labels: [] }
        // Oh so many things to test...
      ]

      for (const args of invalidArgs) {
        await expectToThrowWERR(sdk.WERR_INVALID_PARAMETER, () => wallet.listActions(args))
      }
    }
  })

  test('3_label babbage_protocol_perm', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeLabels: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        expect(r.totalActions).toBeGreaterThanOrEqual(r.actions.length)
        expect(r.actions.length).toBe(args.limit || 10)
        let i = 0
        for (const a of r.actions) {
          expect(a.inputs).toBeUndefined()
          expect(a.outputs).toBeUndefined()
          expect(Array.isArray(a.labels)).toBe(true)
          expect(a.labels?.indexOf('babbage_protocol_perm')).toBeGreaterThan(-1)
        }
      }
    }
  })

  test('4_label babbage_protocol_perm', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeLabels: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        expect(r.totalActions).toBeGreaterThanOrEqual(r.actions.length)
        expect(r.actions.length).toBe(args.limit || 10)
        let i = 0
        for (const a of r.actions) {
          expect(a.inputs).toBeUndefined()
          expect(a.outputs).toBeUndefined()
          expect(Array.isArray(a.labels)).toBe(true)
          for (const label of args.labels) {
            expect(a.labels?.indexOf(label)).toBeGreaterThan(-1)
          }
        }
      }
    }
  })

  test('5_label babbage_protocol_perm or babbage_basket_access', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeLabels: true,
          labels: ['babbage_protocol_perm', 'babbage_basket_access']
        }
        const r = await wallet.listActions(args)
        expect(r.totalActions).toBeGreaterThanOrEqual(r.actions.length)
        expect(r.actions.length).toBe(args.limit || 10)
        let i = 0
        for (const a of r.actions) {
          expect(a.inputs).toBeUndefined()
          expect(a.outputs).toBeUndefined()
          expect(Array.isArray(a.labels)).toBe(true)
          let count = 0
          for (const label of args.labels) {
            if (a.labels!.indexOf(label) > -1) count++
          }
          expect(count).toBeGreaterThan(0)
        }
      }
    }
  })

  test('6_label babbage_protocol_perm and babbage_basket_access', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeLabels: true,
          labels: ['babbage_protocol_perm', 'babbage_basket_access'],
          labelQueryMode: 'all'
        }
        const r = await wallet.listActions(args)
        expect(r.totalActions).toBe(0)
      }
    }
  })

  test('7_includeOutputs', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeOutputs: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        expect(r.totalActions).toBeGreaterThanOrEqual(r.actions.length)
        expect(r.actions.length).toBe(args.limit || 10)
        let i = 0
        for (const a of r.actions) {
          expect(a.isOutgoing === true || a.isOutgoing === false).toBe(true)
          expect(a.inputs).toBeUndefined()
          expect(Array.isArray(a.outputs)).toBe(true)
          expect(a.labels).toBeUndefined()
          for (const o of a.outputs!) {
            expect(o.outputIndex).toBeGreaterThanOrEqual(0)
            expect(o.lockingScript).toBeUndefined()
          }
        }
      }
    }
  })

  test('8_includeOutputs and script', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeOutputs: true,
          includeOutputLockingScripts: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        let i = 0
        for (const a of r.actions) {
          for (const o of a.outputs!) {
            expect(o.lockingScript?.length).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  test('9_includeInputs', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeInputs: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        let i = 0
        for (const a of r.actions) {
          expect(a.isOutgoing === true || a.isOutgoing === false).toBe(true)
          expect(a.outputs).toBeUndefined()
          expect(Array.isArray(a.inputs)).toBe(true)
          expect(a.labels).toBeUndefined()
          for (const i of a.inputs!) {
            expect(i.sourceLockingScript).toBeUndefined()
            expect(i.unlockingScript).toBeUndefined()
          }
        }
      }
    }
  })

  test('10_includeInputs and unlock', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeInputs: true,
          includeInputUnlockingScripts: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        let i = 0
        for (const a of r.actions) {
          expect(a.isOutgoing === true || a.isOutgoing === false).toBe(true)
          expect(a.outputs).toBeUndefined()
          expect(Array.isArray(a.inputs)).toBe(true)
          expect(a.labels).toBeUndefined()
          for (const i of a.inputs!) {
            expect(i.sourceLockingScript).toBeUndefined()
            expect(i.unlockingScript?.length).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  test('11_includeInputs and lock', async () => {
    for (const { wallet } of ctxs) {
      {
        const args: bsv.ListActionsArgs = {
          includeInputs: true,
          includeInputSourceLockingScripts: true,
          labels: ['babbage_protocol_perm']
        }
        const r = await wallet.listActions(args)
        let i = 0
        for (const a of r.actions) {
          expect(a.isOutgoing === true || a.isOutgoing === false).toBe(true)
          expect(a.outputs).toBeUndefined()
          expect(Array.isArray(a.inputs)).toBe(true)
          expect(a.labels).toBeUndefined()
          for (const i of a.inputs!) {
            expect(i.sourceLockingScript?.length).toBeGreaterThan(0)
            expect(i.unlockingScript).toBeUndefined()
          }
        }
      }
    }
  })
})
