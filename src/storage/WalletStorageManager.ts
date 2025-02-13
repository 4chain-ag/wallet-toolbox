import {
  AbortActionArgs,
  AbortActionResult,
  InternalizeActionArgs,
  InternalizeActionResult,
  ListActionsArgs,
  ListActionsResult,
  ListCertificatesResult,
  ListOutputsArgs,
  ListOutputsResult,
  RelinquishCertificateArgs,
  RelinquishOutputArgs
} from '@bsv/sdk'
import {
  EntitySyncState,
  sdk,
  StorageProvider,
  StorageSyncReader,
  TableCertificate,
  TableCertificateX,
  TableOutput,
  TableOutputBasket,
  TableProvenTxReq,
  TableSettings,
  TableUser,
  wait
} from '../index.client'

/**
 * The `WalletStorageManager` class delivers authentication checking storage access to the wallet.
 *
 * If manages multiple `StorageBase` derived storage services: one actice, the rest as backups.
 *
 * Of the storage services, one is 'active' at any one time.
 * On startup, and whenever triggered by the wallet, `WalletStorageManager` runs a syncrhonization sequence:
 *
 * 1. While synchronizing, all other access to storage is blocked waiting.
 * 2. The active service is confirmed, potentially triggering a resolution process if there is disagreement.
 * 3. Changes are pushed from the active storage service to each inactive, backup service.
 *
 * Some storage services do not support multiple writers. `WalletStorageManager` manages wait-blocking write requests
 * for these services.
 */
export class WalletStorageManager implements sdk.WalletStorage {
  stores: sdk.WalletStorageProvider[] = []
  _authId: sdk.AuthId
  _services?: sdk.WalletServices
  _userIdentityKeyToId: Record<string, number> = {}
  _readerCount: number = 0
  _writerCount: number = 0
  /**
   * if true, allow only a single writer to proceed at a time.
   * queue the blocked requests so they get executed in order when released.
   */
  _isSingleWriter: boolean = true
  /**
   * if true, allow no new reader or writers to proceed.
   * queue the blocked requests so they get executed in order when released.
   */
  _syncLocked: boolean = false
  /**
   * if true, allow no new reader or writers or sync to proceed.
   * queue the blocked requests so they get executed in order when released.
   */
  _storageProviderLocked: boolean = false

  constructor(
    identityKey: string,
    active?: sdk.WalletStorageProvider,
    backups?: sdk.WalletStorageProvider[]
  ) {
    this.stores = []
    if (active) this.stores.push(active)
    if (backups) this.stores = this.stores.concat(backups)
    this._authId = { identityKey }
  }

  isStorageProvider(): boolean {
    return false
  }

  async getUserId(): Promise<number> {
    if (!this._authId.userId) await this.getAuth()
    return this._authId.userId!
  }

  async getAuth(mustBeActive?: boolean): Promise<sdk.AuthId> {
    if (!this.isAvailable()) await this.makeAvailable()
    const { user, isNew } = await this.getActive().findOrInsertUser(
      this._authId.identityKey
    )
    if (!user)
      throw new sdk.WERR_INVALID_PARAMETER('identityKey', 'exist on storage.')
    this._authId.userId = user.userId
    this._authId.isActive =
      user.activeStorage === undefined ||
      user.activeStorage === this.getSettings().storageIdentityKey
    if (mustBeActive && !this._authId.isActive) throw new sdk.WERR_NOT_ACTIVE()
    return this._authId
  }

  getActive(): sdk.WalletStorageProvider {
    if (this.stores.length < 1)
      throw new sdk.WERR_INVALID_OPERATION(
        'An active WalletStorageProvider must be added to this WalletStorageManager'
      )
    return this.stores[0]
  }

  async getActiveForWriter(): Promise<sdk.WalletStorageWriter> {
    while (
      this._storageProviderLocked ||
      this._syncLocked ||
      (this._isSingleWriter && this._writerCount > 0) ||
      this._readerCount > 0
    ) {
      await wait(100)
    }
    this._writerCount++
    return this.getActive()
  }

  async getActiveForReader(): Promise<sdk.WalletStorageReader> {
    while (
      this._storageProviderLocked ||
      this._syncLocked ||
      (this._isSingleWriter && this._writerCount > 0)
    ) {
      await wait(100)
    }
    this._readerCount++
    return this.getActive()
  }

  async getActiveForSync(): Promise<sdk.WalletStorageSync> {
    // Wait for a current sync task to complete...
    while (this._syncLocked) {
      await wait(100)
    }
    // Set syncLocked which prevents any new storageProvider, readers or writers...
    this._syncLocked = true
    // Wait for any current storageProvider, readers and writers to complete
    while (
      this._storageProviderLocked ||
      this._readerCount > 0 ||
      this._writerCount > 0
    ) {
      await wait(100)
    }
    // Allow the sync to proceed on the active store.
    return this.getActive()
  }

  async getActiveForStorageProvider(): Promise<StorageProvider> {
    // Wait for a current storageProvider call to complete...
    while (this._storageProviderLocked) {
      await wait(100)
    }
    // Set storageProviderLocked which prevents any new sync, readers or writers...
    this._storageProviderLocked = true
    // Wait for any current sync, readers and writers to complete
    while (this._syncLocked || this._readerCount > 0 || this._writerCount > 0) {
      await wait(100)
    }
    // We can finally confirm that active storage is still able to support `StorageProvider`
    if (!this.getActive().isStorageProvider())
      throw new sdk.WERR_INVALID_OPERATION(
        'Active "WalletStorageProvider" does not support "StorageProvider" interface.'
      )
    // Allow the sync to proceed on the active store.
    return this.getActive() as unknown as StorageProvider
  }

  async runAsWriter<R>(
    writer: (active: sdk.WalletStorageWriter) => Promise<R>
  ): Promise<R> {
    try {
      const active = await this.getActiveForWriter()
      const r = await writer(active)
      return r
    } finally {
      this._writerCount--
    }
  }

  async runAsReader<R>(
    reader: (active: sdk.WalletStorageReader) => Promise<R>
  ): Promise<R> {
    try {
      const active = await this.getActiveForReader()
      const r = await reader(active)
      return r
    } finally {
      this._readerCount--
    }
  }

  /**
   *
   * @param sync the function to run with sync access lock
   * @param activeSync from chained sync functions, active storage already held under sync access lock.
   * @returns
   */
  async runAsSync<R>(
    sync: (active: sdk.WalletStorageSync) => Promise<R>,
    activeSync?: sdk.WalletStorageSync
  ): Promise<R> {
    try {
      const active = activeSync || (await this.getActiveForSync())
      const r = await sync(active)
      return r
    } finally {
      if (!activeSync) this._syncLocked = false
    }
  }

  async runAsStorageProvider<R>(
    sync: (active: StorageProvider) => Promise<R>
  ): Promise<R> {
    try {
      const active = await this.getActiveForStorageProvider()
      const r = await sync(active)
      return r
    } finally {
      this._storageProviderLocked = false
    }
  }

  /**
   *
   * @returns true if the active `WalletStorageProvider` also implements `StorageProvider`
   */
  isActiveStorageProvider(): boolean {
    return this.getActive().isStorageProvider()
  }

  isAvailable(): boolean {
    return this.getActive().isAvailable()
  }

  async addWalletStorageProvider(
    provider: sdk.WalletStorageProvider
  ): Promise<void> {
    await provider.makeAvailable()
    if (this._services) provider.setServices(this._services)
    this.stores.push(provider)
  }

  setServices(v: sdk.WalletServices) {
    this._services = v
    for (const store of this.stores) store.setServices(v)
  }
  getServices(): sdk.WalletServices {
    if (!this._services)
      throw new sdk.WERR_INVALID_OPERATION('Must setServices first.')
    return this._services
  }

  getSettings(): TableSettings {
    return this.getActive().getSettings()
  }

  async makeAvailable(): Promise<TableSettings> {
    return await this.runAsWriter(async writer => {
      writer.makeAvailable()
      return writer.getSettings()
    })
  }

  async migrate(
    storageName: string,
    storageIdentityKey: string
  ): Promise<string> {
    return await this.runAsWriter(async writer => {
      return writer.migrate(storageName, storageIdentityKey)
    })
  }

  async destroy(): Promise<void> {
    return await this.runAsWriter(async writer => {
      for (const store of this.stores) await store.destroy()
    })
  }

  async findOrInsertUser(
    identityKey: string
  ): Promise<{ user: TableUser; isNew: boolean }> {
    const auth = await this.getAuth()
    if (identityKey != auth.identityKey) throw new sdk.WERR_UNAUTHORIZED()

    return await this.runAsWriter(async writer => {
      const r = await writer.findOrInsertUser(identityKey)

      if (auth.userId && auth.userId !== r.user.userId)
        throw new sdk.WERR_INTERNAL(
          'userId may not change for given identityKey'
        )
      this._authId.userId = r.user.userId
      return r
    })
  }

  async abortAction(args: AbortActionArgs): Promise<AbortActionResult> {
    sdk.validateAbortActionArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.abortAction(auth, args)
    })
  }
  async createAction(
    vargs: sdk.ValidCreateActionArgs
  ): Promise<sdk.StorageCreateActionResult> {
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.createAction(auth, vargs)
    })
  }
  async internalizeAction(
    args: InternalizeActionArgs
  ): Promise<InternalizeActionResult> {
    sdk.validateInternalizeActionArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.internalizeAction(auth, args)
    })
  }

  async relinquishCertificate(
    args: RelinquishCertificateArgs
  ): Promise<number> {
    sdk.validateRelinquishCertificateArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.relinquishCertificate(auth, args)
    })
  }
  async relinquishOutput(args: RelinquishOutputArgs): Promise<number> {
    sdk.validateRelinquishOutputArgs(args)
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.relinquishOutput(auth, args)
    })
  }

  async processAction(
    args: sdk.StorageProcessActionArgs
  ): Promise<sdk.StorageProcessActionResults> {
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.processAction(auth, args)
    })
  }
  async insertCertificate(certificate: TableCertificate): Promise<number> {
    return await this.runAsWriter(async writer => {
      const auth = await this.getAuth(true)
      return await writer.insertCertificateAuth(auth, certificate)
    })
  }

  async listActions(
    vargs: sdk.ValidListActionsArgs
  ): Promise<ListActionsResult> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.listActions(auth, vargs)
    })
  }
  async listCertificates(
    args: sdk.ValidListCertificatesArgs
  ): Promise<ListCertificatesResult> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.listCertificates(auth, args)
    })
  }
  async listOutputs(
    vargs: sdk.ValidListOutputsArgs
  ): Promise<ListOutputsResult> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.listOutputs(auth, vargs)
    })
  }
  async findCertificates(
    args: sdk.FindCertificatesArgs
  ): Promise<TableCertificateX[]> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.findCertificatesAuth(auth, args)
    })
  }
  async findOutputBaskets(
    args: sdk.FindOutputBasketsArgs
  ): Promise<TableOutputBasket[]> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.findOutputBasketsAuth(auth, args)
    })
  }
  async findOutputs(args: sdk.FindOutputsArgs): Promise<TableOutput[]> {
    const auth = await this.getAuth()
    return await this.runAsReader(async reader => {
      return await reader.findOutputsAuth(auth, args)
    })
  }

  async findProvenTxReqs(
    args: sdk.FindProvenTxReqsArgs
  ): Promise<TableProvenTxReq[]> {
    return await this.runAsReader(async reader => {
      return await reader.findProvenTxReqs(args)
    })
  }

  async syncFromReader(
    identityKey: string,
    reader: StorageSyncReader
  ): Promise<void> {
    const auth = await this.getAuth()
    if (identityKey !== auth.identityKey) throw new sdk.WERR_UNAUTHORIZED()

    const readerSettings = await reader.makeAvailable()

    return await this.runAsSync(async sync => {
      const writer = sync
      const writerSettings = this.getSettings()

      let log = ''
      let inserts = 0,
        updates = 0
      for (;;) {
        const ss = await EntitySyncState.fromStorage(
          writer,
          identityKey,
          readerSettings
        )
        const args = ss.makeRequestSyncChunkArgs(
          identityKey,
          writerSettings.storageIdentityKey
        )
        const chunk = await reader.getSyncChunk(args)
        const r = await writer.processSyncChunk(args, chunk)
        inserts += r.inserts
        updates += r.updates
        //log += `${r.maxUpdated_at} inserted ${r.inserts} updated ${r.updates}\n`
        if (r.done) break
      }
      //console.log(log)
      console.log(`sync complete: ${inserts} inserts, ${updates} updates`)
    })
  }

  async updateBackups(activeSync?: sdk.WalletStorageSync) {
    const auth = await this.getAuth()
    return await this.runAsSync(async sync => {
      for (const backup of this.stores.slice(1)) {
        await this.syncToWriter(auth, backup, sync)
      }
    }, activeSync)
  }

  async syncToWriter(
    auth: sdk.AuthId,
    writer: sdk.WalletStorageProvider,
    activeSync?: sdk.WalletStorageSync
  ): Promise<{ inserts: number; updates: number }> {
    const identityKey = auth.identityKey

    const writerSettings = await writer.makeAvailable()

    return await this.runAsSync(async sync => {
      const reader = sync
      const readerSettings = this.getSettings()

      let log = ''
      let inserts = 0,
        updates = 0
      for (;;) {
        const ss = await EntitySyncState.fromStorage(
          writer,
          identityKey,
          readerSettings
        )
        const args = ss.makeRequestSyncChunkArgs(
          identityKey,
          writerSettings.storageIdentityKey
        )
        const chunk = await reader.getSyncChunk(args)
        const r = await writer.processSyncChunk(args, chunk)
        inserts += r.inserts
        updates += r.updates
        log += `${r.maxUpdated_at} inserted ${r.inserts} updated ${r.updates}\n`
        if (r.done) break
      }
      //console.log(log)
      //console.log(`sync complete: ${inserts} inserts, ${updates} updates`)
      return { inserts, updates }
    }, activeSync)
  }

  /**
   * Updates backups and switches to new active storage provider from among current backup providers.
   *
   * @param storageIdentityKey of current backup storage provider that is to become the new active provider.
   */
  async setActive(storageIdentityKey: string): Promise<void> {
    const newActiveIndex = this.stores.findIndex(
      s => s.getSettings().storageIdentityKey === storageIdentityKey
    )
    if (newActiveIndex < 0)
      throw new sdk.WERR_INVALID_PARAMETER(
        'storageIdentityKey',
        `registered with this "WalletStorageManager" as a backup data store.`
      )
    if (newActiveIndex === 0)
      /** Setting the current active as the new active is a permitted no-op. */
      return

    const auth = await this.getAuth()
    const newActive = this.stores[newActiveIndex]
    const newActiveStorageIdentityKey = (await newActive.makeAvailable())
      .storageIdentityKey

    return await this.runAsSync(async sync => {
      await sync.setActive(auth, newActiveStorageIdentityKey)
      await this.updateBackups(sync)
      // swap stores...
      const oldActive = this.stores[0]
      this.stores[0] = this.stores[newActiveIndex]
      this.stores[newActiveIndex] = oldActive
      this._authId = {
        ...this._authId,
        userId: undefined,
        isActive: undefined
      }
    })
  }
}
