import { generateChangeSdk, generateChangeSdkMakeStorage, GenerateChangeSdkParams } from '../../generateChange'
import { randomValsUsed1 } from './randomValsUsed1'
import { WERR_INSUFFICIENT_FUNDS } from '../../../../sdk'
import { GenerateChangeSdkResult } from '../../fund'
import knex, { Knex } from 'knex'
import path from 'path'

describe('analyze generate change', () => {
  test('single_utxo', async () => {
      const report = new Report('single_utxo')
      await report.init()

      for (let i = -1; i <= 30; i++) {
        const count = i == 30 ? 100_000 : 10_000
        const state = new TestState(i, report, count)

        while (state.shouldRunNext()) {
          state.next()

          const { allocateChangeInput, releaseChangeInput } = state.getStorage()

          try {
            const r = await generateChangeSdk(state.params(), allocateChangeInput, releaseChangeInput)
            await state.result(r)
          } catch (e) {
            if (e instanceof WERR_INSUFFICIENT_FUNDS) {
              await state.insufficientFunds(e)
            } else {
              await state.error(e)
            }
          }
        }

        await state.finished()
      }

      await report.finishedAll()
    },
    1000 * 60 * 10 // 10 minutes
  )
})

class TestState {
  i: number = -1
  errorState = new ErrorState()

  constructor(
    public targetNetCount: number,
    public report: Report,
    public max: number
  ) {
    report.startNewTestCase(targetNetCount)
  }

  shouldRunNext() {
    return this.i < this.max
  }

  next() {
    this.i++
    this.report.nextIteration(this.i, this.value())
  }

  getStorage() {
    return generateChangeSdkMakeStorage([{ satoshis: this.value(), outputId: 14101 }])
  }

  private value() {
    return 2 + this.i
  }

  async result(r: GenerateChangeSdkResult) {
    await this.report.result(r)
    this.errorState = new ErrorState()
  }

  async insufficientFunds(e: WERR_INSUFFICIENT_FUNDS) {
    await this.report.insufficientFunds(e)
    this.errorState.record(this.i, e)
    this.i = this.errorState.nextValue()
  }

  async error(e) {
    await this.report.unexpectedError(e)
  }

  params(): GenerateChangeSdkParams {
    return {
      fixedInputs: [],
      fixedOutputs: [{ satoshis: 1, lockingScriptLength: 34 }],
      feeModel: { model: 'sat/kb', value: 1 },
      changeInitialSatoshis: 1000,
      changeFirstSatoshis: 285,
      changeLockingScriptLength: 25,
      changeUnlockingScriptLength: 107,
      targetNetCount: this.targetNetCount,
      randomVals: [...randomValsUsed1],
      noLogging: true
    }
  }

  async finished() {
    await this.report.finished()
  }
}

class ErrorState {
  first = 0
  base = 0
  count = 0
  // how many times you want to jump over possibly error cases
  maxSkips = 1
  // configures where to jump after reaching insufficient funds
  skipToElementsBeforeNeeded = 1

  record(i: number, e: WERR_INSUFFICIENT_FUNDS) {
    if (this.count === 0) {
      this.first = i
      this.base = i + e.moreSatoshisNeeded - this.skipToElementsBeforeNeeded
    }
    this.count++
  }

  nextValue(): number {
    const chunk = Math.floor(this.skipToElementsBeforeNeeded / this.maxSkips)
    return this.base + this.count * chunk - 1
  }
}

class Tables {
  constructor(private prefix: string) {}

  get eventsTable() {
    return this.prefix + '_events'
  }

  get changesTable() {
    return this.prefix + '_changes'
  }

  get allocatedTable() {
    return this.prefix + '_allocated'
  }
}

class Report {
  cases: Case[] = []
  currentCase?: Case
  testCaseNumber = 0
  private db: Knex<any, unknown[]>
  private tables: Tables

  constructor(prefix: string = 'single_utxo') {
    this.db = knex({
      client: 'sqlite3',
      connection: {
        filename: path.join(__dirname, 'analysis.sqlite')
      },
      pool: {
        min: 1, // Minimum number of connections
        max: 1, // Maximum number of connections
        idleTimeoutMillis: 300 // Time before idle connections are destroyed
      },
      useNullAsDefault: true
    })

    this.tables = new Tables(prefix)
  }

  async init() {
    const eventsTableExists = await this.db.schema.hasTable(this.tables.eventsTable)
    if (eventsTableExists) {
      await this.db.schema.dropTable(this.tables.eventsTable)
    }

    await this.db.schema.createTable(this.tables.eventsTable, table => {
      table.text('id').primary()
      table.timestamp('created_at').defaultTo(this.db.fn.now())
      table.integer('target_net_count').notNullable()
      table.integer('idx').notNullable()
      table.integer('value').notNullable()
      table.string('type').notNullable()
      table.integer('changes_count_prev').nullable()
      table.integer('changes_count_current').nullable()
      table.text('changes_count_change').nullable()
      table.text('details').nullable()
    })

    const changesTableExists = await this.db.schema.hasTable(this.tables.changesTable)
    if (changesTableExists) {
      await this.db.schema.dropTable(this.tables.changesTable)
    }

    await this.db.schema.createTable(this.tables.changesTable, table => {
      table.text('event_id')
      table.integer('target_net_count').notNullable()
      table.integer('idx').notNullable()
      table.integer('value').notNullable()
      table.integer('satoshis').notNullable()
      table.integer('length').notNullable()
    })

    const allocatedTableExists = await this.db.schema.hasTable(this.tables.allocatedTable)
    if (allocatedTableExists) {
      await this.db.schema.dropTable(this.tables.allocatedTable)
    }

    await this.db.schema.createTable(this.tables.allocatedTable, table => {
      table.text('event_id')
      table.integer('target_net_count').notNullable()
      table.integer('idx').notNullable()
      table.integer('value').notNullable()
      table.integer('satoshis').notNullable()
      table.integer('output_id').notNullable()
    })
  }

  startNewTestCase(count: number) {
    this.testCaseNumber = count
    console.log('Starting new test case with target net count:', count)
    const testCase = new Case(count, this.db, this.tables)
    this.cases.push(testCase)
    this.currentCase = testCase
  }

  nextIteration(idx: number, value: number) {
    this.currentCase?.next(idx, value)
  }

  async result(r: GenerateChangeSdkResult) {
    await this.currentCase?.result(r)
  }

  async insufficientFunds(e: WERR_INSUFFICIENT_FUNDS) {
    await this.currentCase?.insufficientFunds(e)
  }

  async unexpectedError(e: Error) {
    await this.currentCase?.unexpectedError(e)
  }

  async finished() {
    await this.currentCase?.finished()
  }

  async finishedAll() {
    await this.db.destroy()
  }
}

interface EventToStore {
  id?: string
  idx?: number
  target_net_count?: number
  value?: number
  type: string
  details?: string | object
  changes_count_prev?: number | null
  changes_count_current?: number | null
  changes_count_change?: string | null
}

class Case {
  private probesIndexes: number[] = [2500, 5000, 7500]
  private idx: number = -1
  private value: number = -1
  private previousChangeCount: number = 0
  private lastResult?: GenerateChangeSdkResult

  constructor(
    public targetNetCount: number,
    private db: Knex<any, unknown[]>,
    private tables: Tables
  ) {}

  next(idx: number, value: number) {
    this.idx = idx
    this.value = value
  }

  async result(r: GenerateChangeSdkResult) {
    this.lastResult = r
    if (this.probesIndexes.includes(this.idx)) {
      await this.probe()
    }

    const currentChangeCount = r.changeOutputs.length
    if (currentChangeCount !== this.previousChangeCount) {
      await this.changeCountChanged(this.previousChangeCount, currentChangeCount)
      this.previousChangeCount = currentChangeCount
    }
  }

  async changeCountChanged(previous: number, current: number) {
    // console.log(`Target: ${this.targetNetCount} | for value ${this.value} (idx: ${this.idx})`, 'number of changes:', previous, '=>', current)
    await this.storeEventForResult({
      type: 'change_count_changed',
      details: { previous, current }
    })
  }

  async insufficientFunds(e: WERR_INSUFFICIENT_FUNDS) {
    // console.log(`Target: ${this.targetNetCount} | for value ${this.value} (idx: ${this.idx})`, 'there was an insufficient funds error:', e)
    await this.logEvent('insufficient_funds', { error: e.message })
    this.previousChangeCount = 0
  }

  async unexpectedError(e: Error) {
    console.error(
      `Target: ${this.targetNetCount} | for value ${this.value} (idx: ${this.idx})`,
      'there was an unexpected error:',
      e
    )
    await this.logEvent('unexpected_error', { error: e.message })
    this.previousChangeCount = 0
  }

  async finished() {
    const r = this.lastResult

    await this.storeEventForResult({
      type: 'last'
    })
  }

  private async probe() {
    await this.storeEventForResult({
      type: 'probe'
    })
  }

  private async logEvent(type: string, details?: any) {
    await this.storeEvent({
      type,
      details: details
    })
  }

  private async storeEventForResult(event: EventToStore) {
    const r = this.lastResult
    const eventRecord = {
      changes_count_prev: this.previousChangeCount,
      changes_count_current: r?.changeOutputs.length || 0,
      details: { result: r },
      ...event
    }

    if (eventRecord.details && typeof eventRecord.details === 'object' && !('result' in eventRecord.details)) {
      eventRecord.details = { ...eventRecord.details, result: r }
    }

    const eventId = await this.storeEvent(eventRecord)
    if (r) {
      await this.storeResult(r, eventId)
    }
  }

  private async storeEvent(event: EventToStore) {
    if (event.details && typeof event.details !== 'string') {
      event.details = JSON.stringify(event.details)
    }
    event.target_net_count = event.target_net_count != null ? event.target_net_count : this.targetNetCount
    event.idx = event.idx != null ? event.idx : this.idx
    event.value = event.value != null ? event.value : this.value

    if (event.changes_count_prev && event.changes_count_current) {
      event.changes_count_change =
        event.changes_count_prev > event.changes_count_current
          ? 'decreased'
          : event.changes_count_prev < event.changes_count_current
            ? 'increased'
            : 'unchanged'
    }

    event.id = `${event.type}-${event.target_net_count}-${event.idx}`

    await this.db.insert(event).into(this.tables.eventsTable)

    return event.id
  }

  private async storeResult(r: GenerateChangeSdkResult, id: string = `${this.targetNetCount}-${this.idx}`) {
    return Promise.all([
      Promise.all(
        r.changeOutputs
          .map(ch => ({
            event_id: id,
            target_net_count: this.targetNetCount,
            idx: this.idx,
            value: this.value,
            satoshis: ch.satoshis,
            length: ch.lockingScriptLength
          }))
          .map(it => this.db.insert(it).into(this.tables.changesTable))
      ),
      Promise.all(
        r.allocatedChangeInputs
          .map(it => ({
            event_id: id,
            target_net_count: this.targetNetCount,
            idx: this.idx,
            value: this.value,
            satoshis: it.satoshis,
            output_id: it.outputId
          }))
          .map(it => this.db.insert(it).into(this.tables.allocatedTable))
      )
    ])
  }
}
