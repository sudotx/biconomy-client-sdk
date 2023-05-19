import { JsonRpcProvider } from '@ethersproject/providers'
import { ethers, BigNumber, BigNumberish, Signer, BytesLike } from 'ethers'
import { IAccount } from './interfaces/IAccount'
import { defaultAbiCoder, keccak256, arrayify } from 'ethers/lib/utils'
import { UserOperation, ChainId } from '@biconomy/core-types'
import { calcPreVerificationGas, DefaultGasLimits } from './utils/Preverificaiton'
import { packUserOp } from '@biconomy/common'
import { DEFAULT_CALL_GAS_LIMIT, DEFAULT_VERIFICATION_GAS_LIMIT, DEFAULT_PRE_VERIFICATION_GAS } from './utils/Constants'
import { IBundler, Bundler } from '@biconomy/bundler-rpc'
import { IPaymasterAPI } from '@biconomy/paymaster-service'
import {
    EntryPoint_v100,
    SmartAccount_v100,
} from '@biconomy/common'

export const DEFAULT_USER_OP: UserOperation = {
    sender: ethers.constants.AddressZero,
    nonce: ethers.constants.Zero,
    initCode: ethers.utils.hexlify("0x"),
    callData: ethers.utils.hexlify("0x"),
    callGasLimit: DEFAULT_CALL_GAS_LIMIT,
    verificationGasLimit: DEFAULT_VERIFICATION_GAS_LIMIT,
    preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
    maxFeePerGas: ethers.constants.Zero,
    maxPriorityFeePerGas: ethers.constants.Zero,
    paymasterAndData: ethers.utils.hexlify("0x"),
    signature: ethers.utils.hexlify("0x"),
}

export class Account implements IAccount {
    userOp!: UserOperation
    bundler!: IBundler
    paymaster!: IPaymasterAPI
    initCode: string = '0x'
    proxy!: SmartAccount_v100
    provider!: JsonRpcProvider
    entryPoint!: EntryPoint_v100
    chainId!: ChainId
    signer!: Signer

    constructor(readonly epAddress: string, readonly bundlerUrl?: string) {
        this.userOp = { ...DEFAULT_USER_OP }
        if (bundlerUrl)
            this.bundler = new Bundler(bundlerUrl, epAddress)
    }

    async resolveFields(op: Partial<UserOperation>): Promise<Partial<UserOperation>> {
        const obj = {
            sender:
                op.sender !== undefined
                    ? ethers.utils.getAddress(op.sender)
                    : undefined,
            nonce:
                op.nonce !== undefined ? ethers.BigNumber.from(op.nonce) : undefined,
            initCode:
                op.initCode !== undefined
                    ? ethers.utils.hexlify(op.initCode)
                    : undefined,
            callData:
                op.callData !== undefined
                    ? ethers.utils.hexlify(op.callData)
                    : undefined,
            callGasLimit:
                op.callGasLimit !== undefined
                    ? ethers.BigNumber.from(op.callGasLimit)
                    : undefined,
            verificationGasLimit:
                op.verificationGasLimit !== undefined
                    ? ethers.BigNumber.from(op.verificationGasLimit)
                    : undefined,
            preVerificationGas:
                op.preVerificationGas !== undefined
                    ? ethers.BigNumber.from(op.preVerificationGas)
                    : undefined,
            maxFeePerGas:
                op.maxFeePerGas !== undefined
                    ? ethers.BigNumber.from(op.maxFeePerGas)
                    : undefined,
            maxPriorityFeePerGas:
                op.maxPriorityFeePerGas !== undefined
                    ? ethers.BigNumber.from(op.maxPriorityFeePerGas)
                    : undefined,
            paymasterAndData:
                op.paymasterAndData !== undefined
                    ? ethers.utils.hexlify(op.paymasterAndData)
                    : undefined,
            signature:
                op.signature !== undefined
                    ? ethers.utils.hexlify(op.signature)
                    : undefined,
        };
        return Object.keys(obj).reduce(
            (prev, curr) =>
                (obj as any)[curr] !== undefined
                    ? { ...prev, [curr]: (obj as any)[curr] }
                    : prev,
            {}
        );
    }

    async estimateUserOpGas(): Promise<void> {
        if (!this.bundler || !this.userOp.callData)
            return
        const userOpGasEstimatesResonse = await this.bundler.getUserOpGasPrices(this.userOp, this.chainId)
        console.log('userOpGasEstimatesResonse ', userOpGasEstimatesResonse);        
        const { callGasLimit, verificationGasLimit, preVerificationGas, gasPrice, maxFeePerGas, maxPriorityFeePerGas } = userOpGasEstimatesResonse.result
        if (gasPrice)
            this.userOp.maxFeePerGas = this.userOp.maxPriorityFeePerGas = gasPrice
        else {
            this.userOp.maxFeePerGas = maxFeePerGas
            this.userOp.maxPriorityFeePerGas = maxPriorityFeePerGas
        }
        this.userOp.verificationGasLimit = verificationGasLimit
        this.userOp.callGasLimit = callGasLimit
        this.userOp.preVerificationGas = preVerificationGas
    }

    async getPaymasterAndData(): Promise<void> {
        console.log('paymaster state ', this.paymaster);
        
        if (this.paymaster) {
            this.userOp.paymasterAndData = await this.paymaster.getPaymasterAndData(this.userOp)
        }
    }

    async useDefaults(partialOp: Partial<UserOperation>): Promise<this> {
        console.log('partialOp ', partialOp);

        const resolvedOp = await this.resolveFields(partialOp);
        console.log('resolvedOp ', resolvedOp);

        this.userOp = { ...this.userOp, ...resolvedOp };
        return this;
    }
    setCallData(val: BytesLike) {
        this.userOp.callData = ethers.utils.hexlify(val);
        return this;
    }
    nonce(): Promise<BigNumber> {        
        return this.proxy.nonce()
    }

    async signUserOpHash(userOpHash: string, signer: Signer): Promise<string> {
        return await signer.signMessage(arrayify(userOpHash))
    }

    getPreVerificationGas(userOp: Partial<UserOperation>): number {
        return calcPreVerificationGas(userOp)
    }

    async getVerificationGasLimit(): Promise<BigNumberish> {
        // Verification gas should be max(initGas(wallet deployment) + validateUserOp + validatePaymasterUserOp , postOp)    
        const initGas = await this.estimateCreationGas()
        console.log('initgas estimated is ', initGas)

        let verificationGasLimit = initGas
        const validateUserOpGas =
            DefaultGasLimits.validatePaymasterUserOpGas + DefaultGasLimits.validateUserOpGas
        const postOpGas = DefaultGasLimits.postOpGas

        verificationGasLimit = BigNumber.from(validateUserOpGas).add(initGas)

        if (BigNumber.from(postOpGas).gt(verificationGasLimit)) {
            verificationGasLimit = postOpGas
        }
        return verificationGasLimit
    }

    async getUserOpHash(userOp: UserOperation): Promise<string> {
        const userOpHash = keccak256(packUserOp(userOp, true))
        const enc = defaultAbiCoder.encode(
            ['bytes32', 'address', 'uint256'],
            [userOpHash, this.entryPoint.address, this.chainId]
        )
        return keccak256(enc)
    }

    getAccountAddress(): string {
        return this.proxy.address
    }

    async estimateCreationGas(): Promise<BigNumberish> {
        const deployerAddress = this.initCode.substring(0, 42)
        const deployerCallData = '0x' + this.initCode.substring(42)
        return await this.provider.estimateGas({ to: deployerAddress, data: deployerCallData })
    }

    async buildUserOp(): Promise<UserOperation>{
        // TODO: fetch nonce and initCode
        this.userOp.nonce = await this.nonce()
        this.userOp.initCode = this.userOp.nonce.eq(0) ? this.initCode : "0x";

        console.log('Building userOp');
        await this.estimateUserOpGas()
        await this.getPaymasterAndData()
        return this.userOp
    }

    async signUserOp(): Promise<UserOperation>{
        const userOpHash = await this.getUserOpHash(this.userOp)
        let signature = await this.signUserOpHash(userOpHash, this.signer)
        const potentiallyIncorrectV = parseInt(signature.slice(-2), 16)
        if (![27, 28].includes(potentiallyIncorrectV)) {
          const correctV = potentiallyIncorrectV + 27
          signature = signature.slice(0, -2) + correctV.toString(16)
        }
        if (signature.slice(0, 2) !== '0x') signature = '0x' + signature
        console.log('userOp signature: ', signature)
        this.userOp.signature = signature
        return this.userOp
    }
    
    async sendUserOp(): Promise<void>{
        await this.bundler.sendUserOp(this.userOp, this.chainId)
    }
}