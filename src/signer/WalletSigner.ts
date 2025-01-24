import { AbortActionArgs, AbortActionResult, AcquireCertificateArgs, AcquireCertificateResult, Transaction as BsvTransaction, CreateActionArgs, CreateActionResult, DiscoverByAttributesArgs, DiscoverByIdentityKeyArgs, DiscoverCertificatesResult, InternalizeActionArgs, InternalizeActionResult, KeyDeriver, KeyDeriverApi, ListActionsArgs, ListActionsResult, ListCertificatesArgs, ListCertificatesResult, ListOutputsArgs, ListOutputsResult, ProtoWallet, ProveCertificateArgs, ProveCertificateResult, RelinquishCertificateArgs, RelinquishCertificateResult, RelinquishOutputArgs, RelinquishOutputResult, SignActionArgs, SignActionResult } from '@bsv/sdk';
import { sdk } from "../index.client";
import { WalletStorageManager } from "../storage/WalletStorageManager";
import { acquireDirectCertificate } from "./methods/acquireDirectCertificate";
import { createAction } from "./methods/createAction";
import { internalizeAction } from "./methods/internalizeAction";
import { proveCertificate } from "./methods/proveCertificate";
import { signAction } from "./methods/signAction";

export class WalletSigner implements sdk.WalletSigner {
    chain: sdk.Chain
    keyDeriver: KeyDeriverApi
    storage: WalletStorageManager
    _services?: sdk.WalletServices
    identityKey: string

    pendingSignActions: Record<string, PendingSignAction>

    constructor(chain: sdk.Chain, keyDeriver: KeyDeriver, storage: WalletStorageManager) {
        if (storage._authId.identityKey != keyDeriver.identityKey) throw new sdk.WERR_INVALID_PARAMETER('storage', `authenticated as the same identityKey (${storage._authId.identityKey}) as the keyDeriver (${keyDeriver.identityKey}).`);
        this.chain = chain
        this.keyDeriver = keyDeriver
        this.storage = storage
        this.identityKey = this.keyDeriver.identityKey

        this.pendingSignActions = {}
    }

    getProtoWallet() : ProtoWallet { return new ProtoWallet(this.keyDeriver) }

    setServices(v: sdk.WalletServices) {
        this._services = v
        this.storage.setServices(v)
    }
    getServices(): sdk.WalletServices {
        if (!this._services)
            throw new sdk.WERR_INVALID_OPERATION('Must set WalletSigner services first.')
        return this._services
    }

    getStorageIdentity(): sdk.StorageIdentity {
        const s = this.storage.getSettings()
        return { storageIdentityKey: s.storageIdentityKey, storageName: s.storageName }
    }

    getClientChangeKeyPair(): sdk.KeyPair {
        const kp: sdk.KeyPair = {
            privateKey: this.keyDeriver.rootKey.toString(),
            publicKey: this.keyDeriver.rootKey.toPublicKey().toString()
        }
        return kp
    }

    async getChain(): Promise<sdk.Chain> {
        return this.chain
    }

    private validateAuthAndArgs<A, T extends sdk.ValidWalletSignerArgs>(args: A, validate: (args: A) => T): { vargs: T, auth: sdk.AuthId } {
        const vargs = validate(args)
        const auth: sdk.AuthId = { identityKey: this.identityKey }
        return { vargs, auth }
    }

    async listActions(args: ListActionsArgs): Promise<ListActionsResult> {
        this.validateAuthAndArgs(args, sdk.validateListActionsArgs)
        const r = await this.storage.listActions(args)
        return r
    }
    async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult> {
        this.validateAuthAndArgs(args, sdk.validateListOutputsArgs)
        const r = await this.storage.listOutputs(args)
        return r
    }
    async listCertificates(args: ListCertificatesArgs): Promise<ListCertificatesResult> {
        const { vargs } = this.validateAuthAndArgs(args, sdk.validateListCertificatesArgs)
        const r = await this.storage.listCertificates(vargs)
        return r
    }

    async abortAction(args: AbortActionArgs): Promise<AbortActionResult> {
        const { auth } = this.validateAuthAndArgs(args, sdk.validateAbortActionArgs)
        const r = await this.storage.abortAction(args)
        return r
    }
    async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
        const { auth, vargs } = this.validateAuthAndArgs(args, sdk.validateCreateActionArgs)
        const r = await createAction(this, auth, vargs)
        return r
    }

    async signAction(args: SignActionArgs): Promise<SignActionResult> {
        const { auth, vargs } = this.validateAuthAndArgs(args, sdk.validateSignActionArgs)
        const r = await signAction(this, auth, vargs)
        return r
    }
    async internalizeAction(args: InternalizeActionArgs): Promise<InternalizeActionResult> {
        const { auth, vargs } = this.validateAuthAndArgs(args, sdk.validateInternalizeActionArgs)
        const r = await internalizeAction(this, auth, args)
        return r
    }
    async relinquishOutput(args: RelinquishOutputArgs): Promise<RelinquishOutputResult> {
        const { vargs } = this.validateAuthAndArgs(args, sdk.validateRelinquishOutputArgs)
        const r = await this.storage.relinquishOutput(args)
        return { relinquished: true }
    }
    async relinquishCertificate(args: RelinquishCertificateArgs): Promise<RelinquishCertificateResult> {
        this.validateAuthAndArgs(args, sdk.validateRelinquishCertificateArgs)
        const r = await this.storage.relinquishCertificate(args)
        return { relinquished: true }
    }
    async acquireDirectCertificate(args: AcquireCertificateArgs): Promise<AcquireCertificateResult> {
        const { auth, vargs } = this.validateAuthAndArgs(args, sdk.validateAcquireDirectCertificateArgs)
        vargs.subject = (await this.getProtoWallet().getPublicKey({ identityKey: true, privileged: args.privileged, privilegedReason: args.privilegedReason })).publicKey
        const r = await acquireDirectCertificate(this, auth, vargs)
        return r
    }
    async proveCertificate(args: ProveCertificateArgs): Promise<ProveCertificateResult> {
        const { auth, vargs } = this.validateAuthAndArgs(args, sdk.validateProveCertificateArgs)
        const r = await proveCertificate(this, auth, vargs)
        return r
    }

    async discoverByIdentityKey(args: DiscoverByIdentityKeyArgs): Promise<DiscoverCertificatesResult> {
        this.validateAuthAndArgs(args, sdk.validateDiscoverByIdentityKeyArgs)
        throw new Error("Method not implemented.");
    }
    async discoverByAttributes(args: DiscoverByAttributesArgs): Promise<DiscoverCertificatesResult> {
        this.validateAuthAndArgs(args, sdk.validateDiscoverByAttributesArgs)
        throw new Error("Method not implemented.");
    }
}

export interface PendingStorageInput {
    vin: number,
    derivationPrefix: string,
    derivationSuffix: string,
    unlockerPubKey?: string,
    sourceSatoshis: number,
    lockingScript: string
}

export interface PendingSignAction {
    reference: string
    dcr: sdk.StorageCreateActionResult
    args: sdk.ValidCreateActionArgs
    tx: BsvTransaction
    amount: number
    pdi: PendingStorageInput[]
}