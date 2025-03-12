import {
  Hash,
  Utils,
  Random,
  SymmetricKey,
  AbortActionArgs,
  AbortActionResult,
  AcquireCertificateArgs,
  AcquireCertificateResult,
  AuthenticatedResult,
  CreateActionArgs,
  CreateActionResult,
  CreateHmacArgs,
  CreateHmacResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  DiscoverByAttributesArgs,
  DiscoverByIdentityKeyArgs,
  DiscoverCertificatesResult,
  GetHeaderArgs,
  GetHeaderResult,
  GetHeightResult,
  GetNetworkResult,
  GetPublicKeyArgs,
  GetPublicKeyResult,
  GetVersionResult,
  InternalizeActionArgs,
  InternalizeActionResult,
  ListActionsArgs,
  ListActionsResult,
  ListCertificatesArgs,
  ListCertificatesResult,
  ListOutputsArgs,
  ListOutputsResult,
  OriginatorDomainNameStringUnder250Bytes,
  ProveCertificateArgs,
  ProveCertificateResult,
  RelinquishCertificateArgs,
  RelinquishCertificateResult,
  RelinquishOutputArgs,
  RelinquishOutputResult,
  RevealCounterpartyKeyLinkageArgs,
  RevealCounterpartyKeyLinkageResult,
  RevealSpecificKeyLinkageArgs,
  RevealSpecificKeyLinkageResult,
  SignActionArgs,
  SignActionResult,
  VerifyHmacArgs,
  VerifyHmacResult,
  VerifySignatureArgs,
  VerifySignatureResult,
  WalletDecryptArgs,
  WalletDecryptResult,
  WalletEncryptArgs,
  WalletEncryptResult,
  WalletInterface,
  OutpointString,
  PrivateKey,
  LookupResolver,
  LookupAnswer,
  Transaction,
  PushDrop,
  CreateActionInput,
  SHIPBroadcaster
} from '@bsv/sdk'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'

/**
 * Number of rounds used in PBKDF2 for deriving password keys.
 */
export const PBKDF2_NUM_ROUNDS = 7777

/**
 * Describes the structure of a User Management Protocol (UMP) token.
 */
export interface UMPToken {
  /**
   * Primary key encrypted by the XOR of the password and presentation keys.
   */
  passwordPresentationPrimary: number[]

  /**
   * Primary key encrypted by the XOR of the password and recovery keys.
   */
  passwordRecoveryPrimary: number[]

  /**
   * Primary key encrypted by the XOR of the presentation and recovery keys.
   */
  presentationRecoveryPrimary: number[]

  /**
   * Privileged key encrypted by the XOR of the password and primary keys.
   */
  passwordPrimaryPrivileged: number[]

  /**
   * Privileged key encrypted by the XOR of the presentation and recovery keys.
   */
  presentationRecoveryPrivileged: number[]

  /**
   * Hash of the presentation key.
   */
  presentationHash: number[]

  /**
   * PBKDF2 salt used in conjunction with the password to derive the password key.
   */
  passwordSalt: number[]

  /**
   * Hash of the recovery key.
   */
  recoveryHash: number[]

  /**
   * A copy of the presentation key encrypted with the privileged key.
   */
  presentationKeyEncrypted: number[]

  /**
   * A copy of the recovery key encrypted with the privileged key.
   */
  recoveryKeyEncrypted: number[]

  /**
   * A copy of the password key encrypted with the privileged key.
   */
  passwordKeyEncrypted: number[]

  /**
   * Describes the token's location on-chain, if it's already been published.
   */
  currentOutpoint?: OutpointString
}

/**
 * Describes a system capable of finding and updating UMP tokens on the blockchain.
 */
export interface UMPTokenInteractor {
  /**
   * Locates the latest valid copy of a UMP token (including its outpoint)
   * based on the presentation key hash.
   *
   * @param hash The hash of the presentation key.
   * @returns The UMP token if found; otherwise, undefined.
   */
  findByPresentationKeyHash: (hash: number[]) => Promise<UMPToken | undefined>

  /**
   * Locates the latest valid copy of a UMP token (including its outpoint)
   * based on the recovery key hash.
   *
   * @param hash The hash of the recovery key.
   * @returns The UMP token if found; otherwise, undefined.
   */
  findByRecoveryKeyHash: (hash: number[]) => Promise<UMPToken | undefined>

  /**
   * Creates (and optionally consumes the previous version of) a UMP token on-chain.
   *
   * @param wallet            The wallet that might be used to create a new token.
   * @param adminOriginator   The domain name of the administrative originator.
   * @param token             The new UMP token to create.
   * @param oldTokenToConsume If provided, the old token that must be consumed in the same transaction.
   * @returns                 The newly created outpoint.
   */
  buildAndSend: (
    wallet: WalletInterface,
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    token: UMPToken,
    oldTokenToConsume?: UMPToken
  ) => Promise<OutpointString>
}

/**
 * @class OverlayUMPTokenInteractor
 *
 * A concrete implementation of the UMPTokenInteractor interface that interacts
 * with Overlay Services and the UMP (User Management Protocol) topic. This class
 * is responsible for:
 *
 * 1) Locating UMP tokens via overlay lookups (ls_users).
 * 2) Creating and publishing new or updated UMP token outputs on-chain under
 *    the "tm_users" topic.
 * 3) Consuming (spending) an old token if provided.
 */
export class OverlayUMPTokenInteractor implements UMPTokenInteractor {
  /**
   * A `LookupResolver` instance used to query overlay networks.
   */
  private readonly resolver: LookupResolver

  /**
   * A SHIP broadcaster that can be used to publish updated UMP tokens
   * under the `tm_users` topic to overlay service peers.
   */
  private readonly broadcaster: SHIPBroadcaster

  /**
   * Construct a new OverlayUMPTokenInteractor.
   *
   * @param resolver     A LookupResolver instance for performing overlay queries (ls_users).
   * @param broadcaster  A SHIPBroadcaster instance for sharing new or updated tokens across the `tm_users` overlay.
   */
  constructor(
    resolver: LookupResolver = new LookupResolver(),
    broadcaster: SHIPBroadcaster = new SHIPBroadcaster(['tm_users'])
  ) {
    this.resolver = resolver
    this.broadcaster = broadcaster
  }

  /**
   * Finds a UMP token on-chain by the given presentation key hash, if it exists.
   * Uses the ls_users overlay service to perform the lookup.
   *
   * @param hash The 32-byte SHA-256 hash of the presentation key.
   * @returns A UMPToken object (including currentOutpoint) if found, otherwise undefined.
   */
  public async findByPresentationKeyHash(hash: number[]): Promise<UMPToken | undefined> {
    // Query ls_users for the given presentationHash
    const question = {
      service: 'ls_users',
      query: { presentationHash: Utils.toHex(hash) }
    }
    const answer = await this.resolver.query(question)
    return this.parseLookupAnswer(answer)
  }

  /**
   * Finds a UMP token on-chain by the given recovery key hash, if it exists.
   * Uses the ls_users overlay service to perform the lookup.
   *
   * @param hash The 32-byte SHA-256 hash of the recovery key.
   * @returns A UMPToken object (including currentOutpoint) if found, otherwise undefined.
   */
  public async findByRecoveryKeyHash(hash: number[]): Promise<UMPToken | undefined> {
    const question = {
      service: 'ls_users',
      query: { recoveryHash: Utils.toHex(hash) }
    }
    const answer = await this.resolver.query(question)
    return this.parseLookupAnswer(answer)
  }

  /**
   * Creates or updates (replaces) a UMP token on-chain. If `oldTokenToConsume` is provided,
   * it is spent in the same transaction that creates the new token output. The new token is
   * then broadcast and published under the `tm_users` topic using a SHIP broadcast, ensuring
   * overlay participants see the updated token.
   *
   * @param wallet            The wallet used to build and sign the transaction.
   * @param adminOriginator   The domain/FQDN of the administrative originator (wallet operator).
   * @param token             The new UMPToken to create on-chain.
   * @param oldTokenToConsume Optionally, an existing token to consume/spend in the same transaction.
   * @returns The outpoint of the newly created UMP token (e.g. "abcd1234...ef.0").
   */
  public async buildAndSend(
    wallet: WalletInterface,
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    token: UMPToken,
    oldTokenToConsume?: UMPToken
  ): Promise<OutpointString> {
    // 1) Construct the data fields for the new UMP token in the same
    //    11-field order used by the UMP protocol's PushDrop definition.
    const fields: number[][] = new Array(11)

    // See: UMP field ordering
    //  0 => passwordSalt
    //  1 => passwordPresentationPrimary
    //  2 => passwordRecoveryPrimary
    //  3 => presentationRecoveryPrimary
    //  4 => passwordPrimaryPrivileged
    //  5 => presentationRecoveryPrivileged
    //  6 => presentationHash
    //  7 => recoveryHash
    //  8 => presentationKeyEncrypted
    //  9 => passwordKeyEncrypted
    // 10 => recoveryKeyEncrypted

    fields[0] = token.passwordSalt
    fields[1] = token.passwordPresentationPrimary
    fields[2] = token.passwordRecoveryPrimary
    fields[3] = token.presentationRecoveryPrimary
    fields[4] = token.passwordPrimaryPrivileged
    fields[5] = token.presentationRecoveryPrivileged
    fields[6] = token.presentationHash
    fields[7] = token.recoveryHash
    fields[8] = token.presentationKeyEncrypted
    fields[9] = token.passwordKeyEncrypted
    fields[10] = token.recoveryKeyEncrypted

    // 2) Create a PushDrop script referencing these fields, locked with the admin key (for easy revocation).
    const script = await new PushDrop(wallet, adminOriginator).lock(
      fields,
      [2, 'admin user management token'], // protocolID
      '1', // keyID
      'self', // counterparty
      /*forSelf=*/ true,
      /*includeSignature=*/ true
    )

    // 3) Prepare the createAction call. If oldTokenToConsume is provided, we gather the outpoint.
    const inputs: CreateActionInput[] = []
    let inputToken: { beef: number[]; outputIndex: number } | undefined
    if (oldTokenToConsume?.currentOutpoint) {
      inputs.push({
        outpoint: oldTokenToConsume.currentOutpoint,
        unlockingScriptLength: 73, // typical signature length
        inputDescription: 'Consume old UMP token'
      })
      inputToken = await this.findByOutpoint(oldTokenToConsume.currentOutpoint)
    }

    const outputs = [
      {
        lockingScript: script.toHex(),
        satoshis: 1,
        outputDescription: 'New UMP token output'
      }
    ]

    // 4) Build the partial transaction via createAction.
    const createResult = await wallet.createAction(
      {
        description: oldTokenToConsume ? 'Renew UMP token (consume old, create new)' : 'Create new UMP token',
        inputs,
        outputs,
        inputBEEF: inputToken?.beef
      },
      adminOriginator
    )

    // If the transaction is fully processed by the wallet (some wallets might do signAndProcess automatically),
    // we retrieve the final TXID from the result.
    if (!createResult.signableTransaction) {
      const finalTxid =
        createResult.txid || (createResult.tx ? Transaction.fromAtomicBEEF(createResult.tx).id('hex') : undefined)
      if (!finalTxid) {
        throw new Error('No signableTransaction and no final TX found.')
      }
      // Now broadcast to `tm_users` using SHIP
      const broadcastTx = Transaction.fromAtomicBEEF(createResult.tx!)
      const result = await this.broadcaster.broadcast(broadcastTx)
      console.log('BROADCAST RESULT', result)
      return `${finalTxid}.0`
    }

    // 5) If oldTokenToConsume is present, we must sign the input referencing it.
    //    (If there's no old token, there's nothing to sign for the input.)
    let finalTxid = ''
    const reference = createResult.signableTransaction.reference
    const partialTx = Transaction.fromBEEF(createResult.signableTransaction.tx)

    if (oldTokenToConsume?.currentOutpoint) {
      // Unlock the old token with a matching PushDrop unlocker
      const unlocker = new PushDrop(wallet, adminOriginator).unlock([2, 'admin user management token'], '1', 'self')
      const unlockingScript = await unlocker.sign(partialTx, 0)

      // Provide it to the wallet
      const signResult = await wallet.signAction(
        {
          reference,
          spends: {
            0: {
              unlockingScript: unlockingScript.toHex()
            }
          }
        },
        adminOriginator
      )
      finalTxid = signResult.txid || (signResult.tx ? Transaction.fromAtomicBEEF(signResult.tx).id('hex') : '')
      if (!finalTxid) {
        throw new Error('Could not finalize transaction for renewed UMP token.')
      }
      // 6) Broadcast to `tm_users`
      const finalAtomicTx = signResult.tx
      const broadcastTx = Transaction.fromAtomicBEEF(finalAtomicTx!)
      const result = await this.broadcaster.broadcast(broadcastTx)
      console.log('BROADCAST RESULT', result)
      return `${finalTxid}.0`
    } else {
      // Fallbaack
      const signResult = await wallet.signAction({ reference, spends: {} }, adminOriginator)
      finalTxid = signResult.txid || (signResult.tx ? Transaction.fromAtomicBEEF(signResult.tx).id('hex') : '')
      if (!finalTxid) {
        throw new Error('Failed to finalize new UMP token transaction.')
      }
      const finalAtomicTx = signResult.tx
      const broadcastTx = Transaction.fromAtomicBEEF(finalAtomicTx!)
      const result = await this.broadcaster.broadcast(broadcastTx)
      console.log('BROADCAST RESULT', result)
      return `${finalTxid}.0`
    }
  }

  /**
   * Attempts to parse a LookupAnswer from the UMP lookup service. If successful,
   * extracts the token fields from the resulting transaction and constructs
   * a UMPToken object.
   *
   * @param answer The LookupAnswer returned by a query to ls_users.
   * @returns The parsed UMPToken or `undefined` if none found/decodable.
   */
  private parseLookupAnswer(answer: LookupAnswer): UMPToken | undefined {
    if (answer.type !== 'output-list') {
      return undefined
    }
    if (!answer.outputs || answer.outputs.length === 0) {
      return undefined
    }

    // We expect only one relevant UMP token in most queries, so let's parse the first.
    // If multiple are returned, we can parse the first.
    const { beef, outputIndex } = answer.outputs[0]
    try {
      const tx = Transaction.fromBEEF(beef)
      const outpoint = `${tx.id('hex')}.${outputIndex}`

      const decoded = PushDrop.decode(tx.outputs[outputIndex].lockingScript)

      // Expecting 11 fields for UMP
      if (!decoded.fields || decoded.fields.length < 11) return undefined

      // Build the UMP token from these fields, preserving outpoint
      const t: UMPToken = {
        passwordSalt: decoded.fields[0],
        passwordPresentationPrimary: decoded.fields[1],
        passwordRecoveryPrimary: decoded.fields[2],
        presentationRecoveryPrimary: decoded.fields[3],
        passwordPrimaryPrivileged: decoded.fields[4],
        presentationRecoveryPrivileged: decoded.fields[5],
        presentationHash: decoded.fields[6],
        recoveryHash: decoded.fields[7],
        presentationKeyEncrypted: decoded.fields[8],
        passwordKeyEncrypted: decoded.fields[9],
        recoveryKeyEncrypted: decoded.fields[10],
        currentOutpoint: outpoint
      }
      return t
    } catch (e) {
      // If we fail to parse or decode, return undefined
      return undefined
    }
  }

  /**
   * Finds by outpoint for unlocking / spending previous tokens.
   * @param outpoint The outpoint we are searching by
   * @returns The result so that we can use it to unlock the transaction
   */
  private async findByOutpoint(outpoint: string): Promise<{ beef: number[]; outputIndex: number } | undefined> {
    const results = await this.resolver.query({
      service: 'ls_users',
      query: {
        outpoint
      }
    })
    if (results.type !== 'output-list') {
      return undefined
    }
    if (!results.outputs.length) {
      return undefined
    }
    return results.outputs[0]
  }
}

/**
 * Manages a "CWI-style" wallet that uses a UMP token and a
 * multi-key authentication scheme (password, presentation key, and recovery key).
 */
export class CWIStyleWalletManager implements WalletInterface {
  /**
   * Whether the user is currently authenticated.
   */
  authenticated: boolean

  /**
   * The domain name of the administrative originator (wallet operator / vendor, or your own).
   */
  private adminOriginator: string

  /**
   * The system that locates and publishes UMP tokens on-chain.
   */
  private UMPTokenInteractor: UMPTokenInteractor

  /**
   * A function called to persist the newly generated recovery key.
   * It should generally trigger a UI prompt where the user is asked to write it down.
   */
  private recoveryKeySaver: (key: number[]) => Promise<true>

  /**
   * Asks the user to enter their password, for a given reason.
   * The test function can be used to see if the password is correct before resolving.
   * Only resolve with the correct password or reject with an error.
   * Resolving with an incorrect password will throw an error.
   */
  private passwordRetriever: (reason: string, test: (passwordCandidate: string) => boolean) => Promise<string>

  /**
   * An optional function that funds a new Wallet after the new-user flow, before the system proceeds.
   * Allows integration with faucets, and provides the presentation key for use in claiming faucet funds
   * that may be bound to it.
   */
  private newWalletFunder?: (
    presentationKey: number[],
    wallet: WalletInterface,
    adminOriginator: OriginatorDomainNameStringUnder250Bytes
  ) => Promise<void>

  /**
   * Builds the underlying wallet once the user has been authenticated.
   */
  private walletBuilder: (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager) => Promise<WalletInterface>

  /**
   * The current mode of authentication:
   *  - 'presentation-key-and-password'
   *  - 'presentation-key-and-recovery-key'
   *  - 'recovery-key-and-password'
   */
  authenticationMode:
    | 'presentation-key-and-password'
    | 'presentation-key-and-recovery-key'
    | 'recovery-key-and-password' = 'presentation-key-and-password'

  /**
   * Indicates whether this is a new user or an existing user flow:
   *  - 'new-user'
   *  - 'existing-user'
   */
  authenticationFlow: 'new-user' | 'existing-user' = 'new-user'

  /**
   * The current UMP token in use (representing the user's keys on-chain).
   */
  private currentUMPToken?: UMPToken

  /**
   * The presentation key, temporarily retained after being provided until authenticated.
   */
  private presentationKey?: number[]

  /**
   * The recovery key, temporarily retained after being provided until authenticated.
   */
  private recoveryKey?: number[]

  /**
   * The user's primary key, which is used to operate the underlying wallet.
   * It is also stored within state snapshots.
   */
  private primaryKey?: number[]

  /**
   * The underlying wallet that handles the
   * actual signing, encryption, and other wallet operations.
   */
  private underlying?: WalletInterface

  /**
   * Privileged key manager associated with the underlying wallet, used for
   * short-term administrative tasks (e.g. re-wrapping or rotating keys).
   */
  private underlyingPrivilegedKeyManager?: PrivilegedKeyManager

  /**
   * Constructs a new CWIStyleWalletManager.
   *
   * @param adminOriginator   The domain name of the administrative originator.
   * @param walletBuilder     A function that can build an underlying wallet instance
   *                          from a primary key and a privileged key manager
   * @param interactor        An instance of UMPTokenInteractor capable of managing UMP tokens.
   * @param recoveryKeySaver  A function that can persist or display a newly generated recovery key.
   * @param passwordRetriever A function to request the user's password, given a reason and a test function.
   * @param newWalletFunder   An optional function called with the presentation key and a new Wallet post-construction to fund it before use.
   * @param stateSnapshot     If provided, a previously saved snapshot of the wallet's state.
   */
  constructor(
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    walletBuilder: (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager) => Promise<WalletInterface>,
    interactor: UMPTokenInteractor = new OverlayUMPTokenInteractor(),
    recoveryKeySaver: (key: number[]) => Promise<true>,
    passwordRetriever: (reason: string, test: (passwordCandidate: string) => boolean) => Promise<string>,
    newWalletFunder?: (
      presentationKey: number[],
      wallet: WalletInterface,
      adminOriginator: OriginatorDomainNameStringUnder250Bytes
    ) => Promise<void>,
    stateSnapshot?: number[]
  ) {
    this.adminOriginator = adminOriginator
    this.walletBuilder = walletBuilder
    this.UMPTokenInteractor = interactor
    this.recoveryKeySaver = recoveryKeySaver
    this.passwordRetriever = passwordRetriever
    this.authenticated = false
    this.newWalletFunder = newWalletFunder

    // If a saved snapshot is provided, attempt to load it.
    if (stateSnapshot) {
      this.loadSnapshot(stateSnapshot)
    }
  }

  /**
   * Provides the presentation key in an authentication mode that requires it.
   * If a UMP token is found based on the key's hash, this is an existing-user flow.
   * Otherwise, it is treated as a new-user flow.
   *
   * @param key The user's presentation key (32 bytes).
   * @throws {Error} if user is already authenticated, or if the current mode does not require a presentation key.
   */
  async providePresentationKey(key: number[]): Promise<void> {
    if (this.authenticated) {
      throw new Error('User is already authenticated')
    }
    if (this.authenticationMode === 'recovery-key-and-password') {
      throw new Error('Presentation key is not needed in this mode')
    }

    const hash = Hash.sha256(key)
    const token = await this.UMPTokenInteractor.findByPresentationKeyHash(hash)

    if (!token) {
      // No token found -> New user
      this.authenticationFlow = 'new-user'
      this.presentationKey = key
    } else {
      // Found token -> existing user
      this.authenticationFlow = 'existing-user'
      this.presentationKey = key
      this.currentUMPToken = token
    }
  }

  /**
   * Provides the password in an authentication mode that requires it.
   *
   * - **Existing user**:
   *   Decrypts the primary key using the provided password (and either the presentation key or recovery key, depending on the mode).
   *   Then builds the underlying wallet, marking the user as authenticated.
   *
   * - **New user**:
   *   Generates a new UMP token with fresh keys (primary, privileged, recovery). Publishes it on-chain and builds the wallet.
   *
   * @param password The user's password as a string.
   * @throws {Error} If the user is already authenticated, if the mode does not use a password, or if required keys are missing.
   */
  async providePassword(password: string): Promise<void> {
    if (this.authenticated) {
      throw new Error('User is already authenticated')
    }
    if (this.authenticationMode === 'presentation-key-and-recovery-key') {
      throw new Error('Password is not needed in this mode')
    }

    // If we detect an existing user flow:
    if (this.authenticationFlow === 'existing-user') {
      if (!this.currentUMPToken) {
        throw new Error(
          'Provide either a presentation key or a recovery key first, depending on the authentication mode.'
        )
      }
      const derivedPasswordKey = Hash.pbkdf2(
        Utils.toArray(password, 'utf8'),
        this.currentUMPToken.passwordSalt,
        PBKDF2_NUM_ROUNDS,
        32,
        'sha512'
      )

      if (this.authenticationMode === 'presentation-key-and-password') {
        if (!this.presentationKey) {
          throw new Error('No presentation key found!')
        }

        // Decrypt the primary key with XOR(presentationKey, derivedPasswordKey).
        const xorKey = this.XOR(this.presentationKey, derivedPasswordKey)
        const decryptedPrimary = new SymmetricKey(xorKey).decrypt(
          this.currentUMPToken.passwordPresentationPrimary
        ) as number[]

        await this.buildUnderlying(decryptedPrimary)
      } else {
        // 'recovery-key-and-password' mode
        if (!this.recoveryKey) {
          throw new Error('No recovery key found!')
        }

        // Decrypt the primary key with XOR(recoveryKey, derivedPasswordKey).
        const primaryDecryptionKey = this.XOR(this.recoveryKey, derivedPasswordKey)
        const decryptedPrimary = new SymmetricKey(primaryDecryptionKey).decrypt(
          this.currentUMPToken.passwordRecoveryPrimary
        ) as number[]

        // Decrypt the privileged key for immediate use.
        const privilegedDecryptionKey = this.XOR(decryptedPrimary, derivedPasswordKey)
        const decryptedPrivileged = new SymmetricKey(privilegedDecryptionKey).decrypt(
          this.currentUMPToken.passwordPrimaryPrivileged
        ) as number[]

        await this.buildUnderlying(decryptedPrimary, decryptedPrivileged)
      }

      return
    }

    // Otherwise, handle new user flow (only valid in 'presentation-key-and-password').
    if (this.authenticationMode !== 'presentation-key-and-password') {
      throw new Error('New-user flow requires presentation key and password, not recovery key mode.')
    }

    if (!this.presentationKey) {
      throw new Error('No presentation key provided for new-user flow.')
    }

    // Generate new random keys/salt and create a new UMP token.
    const recoveryKey = Random(32)
    await this.recoveryKeySaver(recoveryKey)

    const passwordSalt = Random(32)
    const passwordKey = Hash.pbkdf2(Utils.toArray(password, 'utf8'), passwordSalt, PBKDF2_NUM_ROUNDS, 32, 'sha512')

    const primaryKey = Random(32)
    const privilegedKey = Random(32)

    // Build XOR-based symmetrical keys:
    const presentationPassword = new SymmetricKey(this.XOR(this.presentationKey, passwordKey))
    const presentationRecovery = new SymmetricKey(this.XOR(this.presentationKey, recoveryKey))
    const recoveryPassword = new SymmetricKey(this.XOR(recoveryKey, passwordKey))
    const primaryPassword = new SymmetricKey(this.XOR(primaryKey, passwordKey))

    // Temporarily create a privileged key manager for encrypting the keys in the token.
    const tempPrivilegedKeyManager = new PrivilegedKeyManager(async () => new PrivateKey(privilegedKey))

    // Build the new UMP token:
    const newToken: UMPToken = {
      passwordSalt,
      passwordPresentationPrimary: presentationPassword.encrypt(primaryKey) as number[],
      passwordRecoveryPrimary: recoveryPassword.encrypt(primaryKey) as number[],
      presentationRecoveryPrimary: presentationRecovery.encrypt(primaryKey) as number[],
      passwordPrimaryPrivileged: primaryPassword.encrypt(privilegedKey) as number[],
      presentationRecoveryPrivileged: presentationRecovery.encrypt(privilegedKey) as number[],
      presentationHash: Hash.sha256(this.presentationKey),
      recoveryHash: Hash.sha256(recoveryKey),
      presentationKeyEncrypted: (
        await tempPrivilegedKeyManager.encrypt({
          plaintext: this.presentationKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      passwordKeyEncrypted: (
        await tempPrivilegedKeyManager.encrypt({
          plaintext: passwordKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      recoveryKeyEncrypted: (
        await tempPrivilegedKeyManager.encrypt({
          plaintext: recoveryKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext
    }

    // Now, we can create our new wallet!
    this.currentUMPToken = newToken
    await this.buildUnderlying(primaryKey)

    // Before we do anything, the new wallet is most likely empty right now.
    // We want to provide a chance for someone to fund it, if they want.
    if (this.newWalletFunder) {
      try {
        await this.newWalletFunder(this.presentationKey, this.underlying!, this.adminOriginator)
      } catch (e) {
        // swallow error
        // TODO: Implement better error handling
        console.error(e)
      }
    }

    // Publish the new UMP token on-chain and store the resulting outpoint.
    this.currentUMPToken.currentOutpoint = await this.UMPTokenInteractor.buildAndSend(
      this.underlying!,
      this.adminOriginator,
      newToken
    )
  }

  /**
   * Provides the recovery key in an authentication flow that requires it.
   *
   * @param recoveryKey The user's recovery key (32 bytes).
   * @throws {Error} if user is already authenticated, if the mode does not use a recovery key,
   *                 or if a required presentation key is missing in "presentation-key-and-recovery-key" mode.
   */
  async provideRecoveryKey(recoveryKey: number[]): Promise<void> {
    if (this.authenticated) {
      throw new Error('Already authenticated')
    }

    // Cannot use recovery key in a new-user flow
    if (this.authenticationFlow === 'new-user') {
      throw new Error('Do not submit recovery key in new-user flow')
    }

    if (this.authenticationMode === 'presentation-key-and-password') {
      throw new Error('No recovery key required in this mode')
    } else if (this.authenticationMode === 'recovery-key-and-password') {
      // We will need to wait until the user provides the password as well.
      const hash = Hash.sha256(recoveryKey)
      const token = await this.UMPTokenInteractor.findByRecoveryKeyHash(hash)
      if (!token) {
        throw new Error('No user found with this key')
      }
      this.recoveryKey = recoveryKey
      this.currentUMPToken = token
    } else {
      // 'presentation-key-and-recovery-key'
      if (!this.presentationKey) {
        throw new Error('Provide the presentation key first')
      }
      if (!this.currentUMPToken) {
        throw new Error('Current UMP token not found')
      }

      // Decrypt the primary key:
      const xorKey = this.XOR(this.presentationKey, recoveryKey)
      const primaryKey = new SymmetricKey(xorKey).decrypt(this.currentUMPToken.presentationRecoveryPrimary) as number[]

      // Decrypt the privileged key (for account recovery).
      const privilegedKey = new SymmetricKey(xorKey).decrypt(
        this.currentUMPToken.presentationRecoveryPrivileged
      ) as number[]

      await this.buildUnderlying(primaryKey, privilegedKey)
    }
  }

  /**
   * Saves the current wallet state (including the current UMP token and primary key)
   * into an encrypted snapshot. This snapshot can be stored locally and later passed
   * to `loadSnapshot` to restore the wallet state without re-authenticating manually.
   *
   * @remarks
   * Storing the snapshot provides a fully authenticated state.
   * This **must** be securely stored (e.g. system keychain or encrypted file).
   * If attackers gain access to this snapshot, they can fully control the wallet.
   *
   * @returns An array of bytes representing the encrypted snapshot.
   * @throws {Error} if no primary key or token is currently set.
   */
  saveSnapshot(): number[] {
    if (!this.primaryKey || !this.currentUMPToken) {
      throw new Error('No primary key or current UMP token set')
    }

    // Generate a random snapshot encryption key:
    const snapshotKey = Random(32)

    // Serialize the relevant data to a preimage buffer:
    const snapshotPreimageWriter = new Utils.Writer()

    // Write the primary key (32 bytes):
    snapshotPreimageWriter.write(this.primaryKey)

    // Write the serialized UMP token:
    const serializedToken = this.serializeUMPToken(this.currentUMPToken)
    snapshotPreimageWriter.write(serializedToken)

    // Encrypt the combined data with the snapshotKey:
    const snapshotPreimage = snapshotPreimageWriter.toArray()
    const snapshotPayload = new SymmetricKey(snapshotKey).encrypt(snapshotPreimage) as number[]

    // Build the final snapshot structure: [snapshotKey (32 bytes) + encryptedPayload]
    const snapshotWriter = new Utils.Writer()
    snapshotWriter.write(snapshotKey)
    snapshotWriter.write(snapshotPayload)

    return snapshotWriter.toArray()
  }

  /**
   * Loads a previously saved state snapshot (e.g. from `saveSnapshot`).
   * Upon success, the wallet becomes authenticated without needing to re-enter keys.
   *
   * @param snapshot An array of bytes that was previously produced by `saveSnapshot`.
   * @throws {Error} If the snapshot format is invalid or decryption fails.
   */
  async loadSnapshot(snapshot: number[]): Promise<void> {
    try {
      const reader = new Utils.Reader(snapshot)

      // First 32 bytes is the snapshotKey:
      const snapshotKey = reader.read(32)

      // The rest is the encrypted payload:
      const encryptedPayload = reader.read()

      // Decrypt the payload:
      const decryptedPayload = new SymmetricKey(snapshotKey).decrypt(encryptedPayload) as number[]

      const payloadReader = new Utils.Reader(decryptedPayload)

      // Read the primary key (32 bytes):
      const primaryKey = payloadReader.read(32)

      // Read the remainder as the serialized UMP token:
      const tokenBytes = payloadReader.read()
      const token = this.deserializeUMPToken(tokenBytes)

      // Assign and build:
      this.currentUMPToken = token
      await this.buildUnderlying(primaryKey)
    } catch (error) {
      throw new Error(`Failed to load snapshot: ${(error as Error).message}`)
    }
  }

  /**
   * Destroys the underlying wallet, returning to a default state
   */
  destroy(): void {
    this.underlying = undefined
    this.underlyingPrivilegedKeyManager = undefined
    this.authenticated = false
    this.primaryKey = undefined
    this.currentUMPToken = undefined
    this.presentationKey = undefined
    this.recoveryKey = undefined
    this.authenticationMode = 'presentation-key-and-password'
    this.authenticationFlow = 'new-user'
  }

  /**
   * Changes the user's password, re-wrapping the primary and privileged keys with the new password factor.
   *
   * @param newPassword The user's new password as a string.
   * @throws {Error} If the user is not authenticated, or if underlying token references are missing.
   */
  async changePassword(newPassword: string): Promise<void> {
    if (!this.authenticated) {
      throw new Error('Not authenticated.')
    }
    if (!this.currentUMPToken) {
      throw new Error('No UMP token to update.')
    }

    const passwordSalt = Random(32)
    const passwordKey = Hash.pbkdf2(Utils.toArray(newPassword, 'utf8'), passwordSalt, PBKDF2_NUM_ROUNDS, 32, 'sha512')

    // Decrypt existing factors via the privileged key manager:
    const recoveryKey = (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.recoveryKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
    const presentationKey = (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.presentationKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
    const privilegedKey = new SymmetricKey(this.XOR(presentationKey, recoveryKey)).decrypt(
      this.currentUMPToken.presentationRecoveryPrivileged
    ) as number[]

    await this.updateAuthFactors(
      passwordSalt,
      passwordKey,
      presentationKey,
      recoveryKey,
      this.primaryKey!,
      privilegedKey
    )
  }

  /**
   * Retrieves the current recovery key.
   *
   * @throws {Error} If the user is not authenticated, or if underlying token references are missing.
   */
  async getRecoveryKey(): Promise<number[]> {
    if (!this.authenticated) {
      throw new Error('Not authenticated.')
    }
    if (!this.currentUMPToken) {
      throw new Error('No UMP token!')
    }
    return (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.recoveryKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
  }

  /**
   * Changes the user's recovery key, prompting the user to save the new key.
   *
   * @throws {Error} If the user is not authenticated, or if underlying token references are missing.
   */
  async changeRecoveryKey(): Promise<void> {
    if (!this.authenticated) {
      throw new Error('Not authenticated.')
    }
    if (!this.currentUMPToken) {
      throw new Error('No UMP token to update.')
    }

    // Decrypt existing password/presentation keys via the privileged key manager:
    const passwordKey = (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.passwordKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
    const presentationKey = (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.presentationKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
    const privilegedKey = new SymmetricKey(this.XOR(passwordKey, this.primaryKey!)).decrypt(
      this.currentUMPToken.passwordPrimaryPrivileged
    ) as number[]

    const recoveryKey = Random(32)
    await this.recoveryKeySaver(recoveryKey)

    await this.updateAuthFactors(
      this.currentUMPToken.passwordSalt,
      passwordKey,
      presentationKey,
      recoveryKey,
      this.primaryKey!,
      privilegedKey
    )
  }

  /**
   * Changes the user's presentation key.
   *
   * @param presentationKey The new presentation key (32 bytes).
   * @throws {Error} If the user is not authenticated, or if underlying token references are missing.
   */
  async changePresentationKey(presentationKey: number[]): Promise<void> {
    if (!this.authenticated) {
      throw new Error('Not authenticated.')
    }
    if (!this.currentUMPToken) {
      throw new Error('No UMP token to update.')
    }

    // Decrypt existing password/recovery keys via the privileged key manager:
    const recoveryKey = (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.recoveryKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
    const passwordKey = (
      await this.underlyingPrivilegedKeyManager!.decrypt({
        ciphertext: this.currentUMPToken.passwordKeyEncrypted,
        protocolID: [2, 'admin key wrapping'],
        keyID: '1'
      })
    ).plaintext
    const privilegedKey = new SymmetricKey(this.XOR(passwordKey, this.primaryKey!)).decrypt(
      this.currentUMPToken.passwordPrimaryPrivileged
    ) as number[]

    await this.updateAuthFactors(
      this.currentUMPToken.passwordSalt,
      passwordKey,
      presentationKey,
      recoveryKey,
      this.primaryKey!,
      privilegedKey
    )
  }

  /**
   * Internal helper to recompute a UMP token with updated authentication factors and consume the old token on-chain.
   *
   * @param passwordSalt    The PBKDF2 salt for the new password factor.
   * @param passwordKey     The PBKDF2-derived password key (32 bytes).
   * @param presentationKey The new or existing presentation key (32 bytes).
   * @param recoveryKey     The new or existing recovery key (32 bytes).
   * @param primaryKey      The user's primary key for re-wrapping.
   * @param privilegedKey   The user's privileged key for re-wrapping.
   * @throws {Error} If the user is not authenticated or if keys are unavailable.
   */
  private async updateAuthFactors(
    passwordSalt: number[],
    passwordKey: number[],
    presentationKey: number[],
    recoveryKey: number[],
    primaryKey: number[],
    privilegedKey: number[]
  ): Promise<void> {
    if (!this.authenticated || !this.primaryKey || !this.currentUMPToken) {
      throw new Error('Wallet is not properly authenticated or missing data.')
    }

    // Derive symmetrical encryption keys via XOR:
    const presentationPassword = new SymmetricKey(this.XOR(presentationKey, passwordKey))
    const presentationRecovery = new SymmetricKey(this.XOR(presentationKey, recoveryKey))
    const recoveryPassword = new SymmetricKey(this.XOR(recoveryKey, passwordKey))
    const primaryPassword = new SymmetricKey(this.XOR(this.primaryKey, passwordKey))

    // Build a temporary privileged key manager just to encrypt the new fields:
    const tempPrivilegedKeyManager = new PrivilegedKeyManager(async () => new PrivateKey(privilegedKey))

    // Construct the new UMP token:
    const newToken: UMPToken = {
      passwordSalt,
      passwordPresentationPrimary: presentationPassword.encrypt(this.primaryKey) as number[],
      passwordRecoveryPrimary: recoveryPassword.encrypt(this.primaryKey) as number[],
      presentationRecoveryPrimary: presentationRecovery.encrypt(this.primaryKey) as number[],
      passwordPrimaryPrivileged: primaryPassword.encrypt(privilegedKey) as number[],
      presentationRecoveryPrivileged: presentationRecovery.encrypt(privilegedKey) as number[],
      presentationHash: Hash.sha256(presentationKey),
      recoveryHash: Hash.sha256(recoveryKey),
      presentationKeyEncrypted: (
        await tempPrivilegedKeyManager.encrypt({
          plaintext: presentationKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      passwordKeyEncrypted: (
        await tempPrivilegedKeyManager.encrypt({
          plaintext: passwordKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      recoveryKeyEncrypted: (
        await tempPrivilegedKeyManager.encrypt({
          plaintext: recoveryKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext
    }

    // Publish the new token on-chain and consume the old one:
    newToken.currentOutpoint = await this.UMPTokenInteractor.buildAndSend(
      this.underlying!,
      this.adminOriginator,
      newToken,
      this.currentUMPToken
    )
    this.currentUMPToken = newToken
  }

  /**
   * A helper function to XOR two equal-length byte arrays.
   *
   * @param n1 The first byte array.
   * @param n2 The second byte array.
   * @returns A new byte array which is the element-wise XOR of the two inputs.
   * @throws {Error} if the two arrays are not the same length.
   */
  private XOR(n1: number[], n2: number[]): number[] {
    if (n1.length !== n2.length) {
      throw new Error('lengths mismatch')
    }
    const r = new Array<number>(n1.length)
    for (let i = 0; i < n1.length; i++) {
      r[i] = n1[i] ^ n2[i]
    }
    return r
  }

  /**
   * A helper function to serialize a UMP token to a binary format (version=1).
   * The serialization layout is:
   *   - [1 byte version (value=1)]
   *   - For each array field in the UMP token, [varint length + bytes]
   *   - Then [varint length + outpoint string in UTF-8]
   *
   * @param token The UMP token to serialize.
   * @returns A byte array representing the serialized token.
   * @throws {Error} if the token has no currentOutpoint (required for serialization).
   */
  private serializeUMPToken(token: UMPToken): number[] {
    if (!token.currentOutpoint) {
      throw new Error('Token must have outpoint for serialization')
    }

    const writer = new Utils.Writer()
    // Write version byte
    writer.writeUInt8(1)

    // Helper to write array with length prefix
    const writeArray = (arr: number[]) => {
      writer.writeVarIntNum(arr.length)
      writer.write(arr)
    }

    // Write each array-based field in the order they appear on UMPToken
    writeArray(token.passwordPresentationPrimary)
    writeArray(token.passwordRecoveryPrimary)
    writeArray(token.presentationRecoveryPrimary)
    writeArray(token.passwordPrimaryPrivileged)
    writeArray(token.presentationRecoveryPrivileged)
    writeArray(token.presentationHash)
    writeArray(token.passwordSalt)
    writeArray(token.recoveryHash)
    writeArray(token.presentationKeyEncrypted)
    writeArray(token.recoveryKeyEncrypted)
    writeArray(token.passwordKeyEncrypted)

    // Finally, write the outpoint string:
    const outpointBytes = Utils.toArray(token.currentOutpoint, 'utf8')
    writer.writeVarIntNum(outpointBytes.length)
    writer.write(outpointBytes)

    return writer.toArray()
  }

  /**
   * A helper function to deserialize a UMP token from the format described in `serializeUMPToken`.
   *
   * @param bin The serialized byte array.
   * @returns The reconstructed UMP token.
   * @throws {Error} if the version byte is unexpected or if parsing fails.
   */
  private deserializeUMPToken(bin: number[]): UMPToken {
    const reader = new Utils.Reader(bin)

    // Check version:
    const version = reader.readUInt8()
    if (version !== 1) {
      throw new Error(`Unsupported UMP token version: ${version}`)
    }

    // Helper to read an array with length prefix
    const readArray = (): number[] => {
      const length = reader.readVarIntNum()
      return reader.read(length)
    }

    // Read in the correct order:
    const passwordPresentationPrimary = readArray()
    const passwordRecoveryPrimary = readArray()
    const presentationRecoveryPrimary = readArray()
    const passwordPrimaryPrivileged = readArray()
    const presentationRecoveryPrivileged = readArray()
    const presentationHash = readArray()
    const passwordSalt = readArray()
    const recoveryHash = readArray()
    const presentationKeyEncrypted = readArray()
    const recoveryKeyEncrypted = readArray()
    const passwordKeyEncrypted = readArray()

    // Read outpoint string:
    const outpointLen = reader.readVarIntNum()
    const outpointBytes = reader.read(outpointLen)
    const currentOutpoint = Utils.toUTF8(outpointBytes)

    const token: UMPToken = {
      passwordPresentationPrimary,
      passwordRecoveryPrimary,
      presentationRecoveryPrimary,
      passwordPrimaryPrivileged,
      presentationRecoveryPrivileged,
      presentationHash,
      passwordSalt,
      recoveryHash,
      presentationKeyEncrypted,
      recoveryKeyEncrypted,
      passwordKeyEncrypted,
      currentOutpoint
    }

    return token
  }

  /**
   * Builds the underlying wallet once the user is authenticated.
   *
   * @param primaryKey      The user's primary key (32 bytes).
   * @param privilegedKey   Optionally, a privileged key (for short-term usage in account recovery).
   */
  private async buildUnderlying(primaryKey: number[], privilegedKey?: number[]): Promise<void> {
    if (!this.currentUMPToken) {
      throw new Error('A UMP token must exist before building underlying wallet!')
    }

    this.primaryKey = primaryKey

    // Create a privileged manager that either uses the ephemeral privilegedKey if provided,
    // or derives it later from the user's password on demand.
    const privilegedManager = new PrivilegedKeyManager(async (reason: string) => {
      if (privilegedKey) {
        // For account recovery: a one-off opportunity to recover.
        const tempKey = new PrivateKey(privilegedKey)
        privilegedKey = undefined
        return tempKey
      }
      // Otherwise, ask user for their password to decrypt the privileged key.
      const password = await this.passwordRetriever(reason, (passwordCandidate: string) => {
        try {
          const derivedPasswordKey = Hash.pbkdf2(
            Utils.toArray(passwordCandidate, 'utf8'),
            this.currentUMPToken!.passwordSalt,
            PBKDF2_NUM_ROUNDS,
            32,
            'sha512'
          )
          // Decrypt the privileged key with XOR(primaryKey, derivedPasswordKey).
          const privilegedDecryptor = this.XOR(this.primaryKey!, derivedPasswordKey)
          const decryptedPrivileged = new SymmetricKey(privilegedDecryptor).decrypt(
            this.currentUMPToken!.passwordPrimaryPrivileged
          ) as number[]
          if (decryptedPrivileged) {
            return true
          }
          return false
        } catch (e) {
          return false
        }
      })
      const derivedPasswordKey = Hash.pbkdf2(
        Utils.toArray(password, 'utf8'),
        this.currentUMPToken!.passwordSalt,
        PBKDF2_NUM_ROUNDS,
        32,
        'sha512'
      )
      // Decrypt the privileged key with XOR(primaryKey, derivedPasswordKey).
      const privilegedDecryptor = this.XOR(this.primaryKey!, derivedPasswordKey)
      const decryptedPrivileged = new SymmetricKey(privilegedDecryptor).decrypt(
        this.currentUMPToken!.passwordPrimaryPrivileged
      ) as number[]
      return new PrivateKey(decryptedPrivileged)
    })

    this.underlyingPrivilegedKeyManager = privilegedManager

    // Build the underlying wallet with the primary key and privileged manager.
    this.underlying = await this.walletBuilder(primaryKey, privilegedManager)

    this.authenticated = true
  }

  /*
   * ---------------------------------------------------------------------------------------
   * Below are the standard WalletInterface methods that simply proxy through to this.underlying,
   * ensuring that the user is authenticated and that the admin originator is not misused.
   * ---------------------------------------------------------------------------------------
   */

  async getPublicKey(
    args: GetPublicKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetPublicKeyResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.getPublicKey(args, originator)
  }

  async revealCounterpartyKeyLinkage(
    args: RevealCounterpartyKeyLinkageArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.revealCounterpartyKeyLinkage(args, originator)
  }

  async revealSpecificKeyLinkage(
    args: RevealSpecificKeyLinkageArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealSpecificKeyLinkageResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.revealSpecificKeyLinkage(args, originator)
  }

  async encrypt(
    args: WalletEncryptArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletEncryptResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.encrypt(args, originator)
  }

  async decrypt(
    args: WalletDecryptArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletDecryptResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.decrypt(args, originator)
  }

  async createHmac(
    args: CreateHmacArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateHmacResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.createHmac(args, originator)
  }

  async verifyHmac(
    args: VerifyHmacArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifyHmacResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.verifyHmac(args, originator)
  }

  async createSignature(
    args: CreateSignatureArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateSignatureResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.createSignature(args, originator)
  }

  async verifySignature(
    args: VerifySignatureArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifySignatureResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.verifySignature(args, originator)
  }

  async createAction(
    args: CreateActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateActionResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.createAction(args, originator)
  }

  async signAction(
    args: SignActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.signAction(args, originator)
  }

  async abortAction(
    args: AbortActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AbortActionResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.abortAction(args, originator)
  }

  async listActions(
    args: ListActionsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListActionsResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.listActions(args, originator)
  }

  async internalizeAction(
    args: InternalizeActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<InternalizeActionResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.internalizeAction(args, originator)
  }

  async listOutputs(
    args: ListOutputsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListOutputsResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.listOutputs(args, originator)
  }

  async relinquishOutput(
    args: RelinquishOutputArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishOutputResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.relinquishOutput(args, originator)
  }

  async acquireCertificate(
    args: AcquireCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AcquireCertificateResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.acquireCertificate(args, originator)
  }

  async listCertificates(
    args: ListCertificatesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListCertificatesResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.listCertificates(args, originator)
  }

  async proveCertificate(
    args: ProveCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.proveCertificate(args, originator)
  }

  async relinquishCertificate(
    args: RelinquishCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishCertificateResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.relinquishCertificate(args, originator)
  }

  async discoverByIdentityKey(
    args: DiscoverByIdentityKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.discoverByIdentityKey(args, originator)
  }

  async discoverByAttributes(
    args: DiscoverByAttributesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.discoverByAttributes(args, originator)
  }

  async isAuthenticated(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<AuthenticatedResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return { authenticated: true }
  }

  async waitForAuthentication(
    _: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AuthenticatedResult> {
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    while (!this.authenticated) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { authenticated: true }
  }

  async getHeight(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetHeightResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.getHeight({}, originator)
  }

  async getHeaderForHeight(
    args: GetHeaderArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetHeaderResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.getHeaderForHeight(args, originator)
  }

  async getNetwork(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetNetworkResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.getNetwork({}, originator)
  }

  async getVersion(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetVersionResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return this.underlying!.getVersion({}, originator)
  }
}
