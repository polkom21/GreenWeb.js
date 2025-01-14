import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Bytes, SExp } from "clvm";
import { SmartCoin } from "./smart_coin"
import { Util } from "./util";
import { uint } from "./util/serializer/basic_types";
import { CoinSpend } from "./util/serializer/types/coin_spend";
import { ConditionOpcode } from "./util/sexp/condition_opcodes";
import { bytes, Coin } from "./xch/providers/provider_types";

export type StandardCoinConstructorArgs = {
    parentCoinInfo?: bytes | null,
    puzzleHash?: bytes | null,
    amount?: uint | null,
    puzzle?: SExp | null,
    coin?: Coin | null,
    publicKey?: bytes | null,
    isSyntheticKey?: boolean,
    forceUsePuzzle?: boolean,
};

export class StandardCoin extends SmartCoin {
    public publicKey: bytes | null = null;
    
    constructor({
        parentCoinInfo = null,
        puzzleHash = null,
        amount = null,
        coin = null,
        puzzle = null,
        publicKey = null,
        isSyntheticKey = false,
        forceUsePuzzle = false,
    }: StandardCoinConstructorArgs = {}) {
        super({
            parentCoinInfo, puzzleHash, amount, coin
        });

        if(forceUsePuzzle) {
            if(puzzle === null || puzzle === undefined) {
                throw new Error("StandardCoin: 'forceUsePuzzle' is true, but no puzzle was given.");
            } else {
                this.puzzle = puzzle;
                this.calculatePuzzleHash();
            }
        }

        if(!forceUsePuzzle && publicKey !== null) {
            const publicKeyObj = Util.key.hexToPublicKey(publicKey);
            const pkey: any = isSyntheticKey ? publicKeyObj : Util.sexp.calculateSyntheticPublicKey(publicKeyObj);

            this.puzzle = this.getPuzzleForSyntheticPublicKey(pkey);
            this.publicKey = isSyntheticKey ? publicKey : Util.key.publicKeyToHex(pkey);
            this.calculatePuzzleHash();
        }
    }

    public copyWith({
        parentCoinInfo = null,
        puzzleHash = null,
        amount = null,
        coin = null,
        puzzle = null,
        publicKey = null,
        isSyntheticKey = false,
        forceUsePuzzle = false,
    }: StandardCoinConstructorArgs): StandardCoin {
        const pubKeyGiven = publicKey !== undefined && publicKey !== null;
        const isSyntheticKeyGiven = isSyntheticKey !== undefined;

        const useGivenIsSynthKey = pubKeyGiven && isSyntheticKeyGiven;
        
        return new StandardCoin({
            parentCoinInfo: parentCoinInfo !== undefined && parentCoinInfo !== null ? parentCoinInfo : this.parentCoinInfo,
            puzzleHash: puzzleHash !== undefined && puzzleHash !== null ? puzzleHash : this.puzzleHash,
            amount: amount !== undefined && amount !== null ? amount : this.amount,
            puzzle: forceUsePuzzle ? puzzle : null,
            coin: coin !== undefined && coin !== null ? coin : null,
            publicKey: pubKeyGiven ? publicKey : this.publicKey,
            isSyntheticKey: useGivenIsSynthKey ? isSyntheticKey : true,
            forceUsePuzzle: forceUsePuzzle,
        });
    }

    private getPuzzleForSyntheticPublicKey(publicKey: any): SExp {
        return Util.sexp.standardCoinPuzzle(publicKey, true);
    }

    public withPublicKey(publicKey: bytes, isSyntheticKey: boolean = false) : StandardCoin {
        return this.copyWith({
            publicKey: publicKey,
            isSyntheticKey: isSyntheticKey,
        });
    }

    public withParentCoinInfo(newValue: string): StandardCoin {
        return this.copyWith({
            parentCoinInfo: newValue
        });
    }

    public withPuzzleHash(newValue: string): StandardCoin {
        return this.copyWith({
            puzzleHash: newValue,
            puzzle: null
        });
    }

    public withAmount(newValue: uint): StandardCoin {
        return this.copyWith({
            amount: BigNumber.from(newValue),
        });
    }

    private createCreateCoinCondition(puzzleHash: bytes, amount: BigNumber): SExp {
        return SExp.to([
            Bytes.from(
                Buffer.from(ConditionOpcode.CREATE_COIN, "hex"),
            ),
            Bytes.from(
                Buffer.from(puzzleHash, "hex"),
            ),
            Bytes.from(
                Buffer.from(amount.toHexString().slice(2), "hex")
            ),
        ]);
    }

    private createReserveFeeCondition(fee: BigNumber): SExp {
        return SExp.to([
            Bytes.from(
                Buffer.from(ConditionOpcode.RESERVE_FEE, "hex"),
            ),
            Bytes.from(
                Buffer.from(fee.toHexString().slice(2), "hex")
            ),
        ]);
    }

    public send(
        addressOrPuzzleHash: string,
        fee?: BigNumberish,
        amount?: BigNumberish,
        changeAddressOrPuzzleHash?: string
    ): CoinSpend | null {
        if(amount === undefined) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            amount = this.amount!;
        }

        const recipientsAndAmounts: Array<[string, BigNumberish]> = [
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            [addressOrPuzzleHash, amount!]
        ];
        return this.multisend(
            recipientsAndAmounts,
            fee,
            changeAddressOrPuzzleHash
        );
    }

    public multisend(
        recipientsAndAmounts: Array<[string, BigNumberish]>,
        fee?: BigNumberish,
        changeAddressOrPuzzleHash?: string
    ): CoinSpend | null {
        if(!this.hasCoinInfo()) {
            return null;
        }

        const txFee: BigNumber = fee === undefined ? BigNumber.from(0) : BigNumber.from(fee);
        let totalSpent: BigNumber = BigNumber.from(0);
        const conditions: SExp[] = [];

        for(const recipientAndAmount of recipientsAndAmounts) {
            const recipient = recipientAndAmount[0];
            const amount = BigNumber.from(recipientAndAmount[1]);
            totalSpent = totalSpent.add(amount);

            const recipientPh = Util.address.validateHashString(recipient);
            const targetPuzzleHash = recipientPh === "" ? Util.address.addressToPuzzleHash(recipient) : recipientPh;
            if(targetPuzzleHash === "") {
                throw new Error(`StandardCoin: Invalid recipient ${recipient}`);
            }

            conditions.push(
                this.createCreateCoinCondition(targetPuzzleHash, amount)
            );
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if(txFee.add(totalSpent).gt(this.amount!)) {
            throw new Error("StandardCoin: fee + totalSpent > currentCoinAmount");
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if(txFee.add(totalSpent).lt(this.amount!)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const changeAmount = this.amount!.sub(totalSpent).sub(txFee);
            let changePuzzleHash: string = changeAddressOrPuzzleHash === undefined ?
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                this.puzzleHash! : Util.address.validateHashString(changeAddressOrPuzzleHash);

            if(changePuzzleHash === "") {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                changePuzzleHash = Util.address.addressToPuzzleHash(changeAddressOrPuzzleHash!)
            }
            if(changePuzzleHash === "") {
                throw new Error("StandardCoin: changeAddressOrPuzzleHash is not a valid puzzle hash or address")
            }

            conditions.push(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                this.createCreateCoinCondition(changePuzzleHash, changeAmount)
            );
        }

        if(!txFee.eq(0)) {
            conditions.push(
                this.createReserveFeeCondition(txFee)
            );
        }

        const solution: SExp = SExp.to([
            SExp.to([]),
            SExp.to([1, ...conditions]), // 1 = 'q'
            SExp.to([])
        ]);

        return this.spend(solution);
    }
}