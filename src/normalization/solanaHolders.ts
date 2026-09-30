import type {
  RawSolanaTokenAccountPage,
  SolanaHolderStructure,
  HolderConcentration,
} from "../types/holders";
import { SOLANA_TOKEN_PROGRAM_IDS, type TokenProgram } from "../types/solana";
import { decodeSolanaPublicKey, encodeSolanaPublicKey, isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import { parseToken2022TokenAccountExtensionTypes } from "./token2022Extensions";

const TOKEN_ACCOUNT_BASE_SIZE = 165;
const TOKEN_2022_TYPE_OFFSET = 165;
const TOKEN_2022_TLV_OFFSET = 166;
const TOKEN_2022_MULTISIG_SIZE = 355;
const KNOWN_ACCOUNT_EXTENSIONS = new Set([2, 5, 7, 8, 11, 13, 15, 17, 27]);
// Current SPL Token-2022 ExtensionType IDs: TransferFeeConfig (1),
// ConfidentialTransferMint (4), ConfidentialTransferFeeConfig (16),
// ConfidentialMintBurn (24). ScaledUiAmount (25) changes UI display only.
const BALANCE_AFFECTING_MINT_EXTENSIONS = new Set([1, 4, 16, 24]);
const BALANCE_AFFECTING_ACCOUNT_EXTENSIONS = new Set([2, 5, 17]);
const TOP_N_VALUES = [1, 5, 10, 20] as const;

function decodeAccountData(value: string): Uint8Array {
  const pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!pattern.test(value)) throw new Error("Helius returned malformed token-account base64 data.");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw new Error("Helius returned malformed token-account base64 data.");
  return data;
}

function validCOption(data: Uint8Array, offset: number): boolean {
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  return tag === 0 || tag === 1;
}

function validateBase(data: Uint8Array): void {
  if (
    data.byteLength < TOKEN_ACCOUNT_BASE_SIZE ||
    !validCOption(data, 72) ||
    (data[108] !== 1 && data[108] !== 2) ||
    !validCOption(data, 109) ||
    !validCOption(data, 129)
  ) {
    throw new Error("Helius returned a malformed or uninitialized token account.");
  }
}

export interface NormalizeSolanaHolderStructureInput {
  mintAddress: string;
  tokenProgram: TokenProgram;
  decimals: number;
  currentMintSupplyRaw: string;
  mintExtensionTypes: number[];
  pages: RawSolanaTokenAccountPage[];
  fetchedAt?: string;
}

export function normalizeSolanaHolderStructure(
  input: NormalizeSolanaHolderStructureInput,
): SolanaHolderStructure {
  const mintBytes = decodeSolanaPublicKey(input.mintAddress);
  if (!mintBytes) throw new Error("Resolved mint address is malformed.");
  if (!/^(0|[1-9][0-9]*)$/.test(input.currentMintSupplyRaw)) throw new Error("Resolved mint supply is malformed.");
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 255) throw new Error("Resolved mint decimals are malformed.");
  if (input.pages.length === 0) throw new Error("Helius returned no holder enumeration pages.");
  const seenCursors = new Set<string>();
  for (let index = 0; index < input.pages.length; index += 1) {
    const cursor = input.pages[index].paginationKey;
    if (index === input.pages.length - 1) {
      if (cursor !== null) throw new Error("Helius holder enumeration is incomplete; final cursor is not null.");
    } else {
      if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor)) {
        throw new Error("Helius holder enumeration has an invalid or repeated pagination cursor.");
      }
      seenCursors.add(cursor);
    }
  }

  const seenAddresses = new Set<string>();
  const ownerTotals = new Map<string, { amount: bigint; accounts: number }>();
  const unsupportedExtensions = new Set<number>();
  for (const extensionType of input.mintExtensionTypes) {
    if (BALANCE_AFFECTING_MINT_EXTENSIONS.has(extensionType)) unsupportedExtensions.add(extensionType);
  }

  let tokenAccountCount = 0;
  let nonzeroTokenAccountCount = 0;
  const expectedProgram = SOLANA_TOKEN_PROGRAM_IDS[input.tokenProgram];

  for (const page of input.pages) {
    if (!Number.isSafeInteger(page.contextSlot) || page.contextSlot < 0 || !Array.isArray(page.accounts)) {
      throw new Error("Helius returned malformed holder page context.");
    }
    for (const account of page.accounts) {
      if (!isSolanaPublicKeySyntax(account.address) || seenAddresses.has(account.address)) {
        throw new Error("Helius returned a malformed or duplicate token-account address.");
      }
      seenAddresses.add(account.address);
      if (account.programOwner !== expectedProgram) throw new Error("Helius returned an account owned by an unexpected token program.");
      const data = decodeAccountData(account.dataBase64);
      if (account.reportedSpace !== null && account.reportedSpace !== data.byteLength) {
        throw new Error("Helius token-account data length does not match its reported space.");
      }
      validateBase(data);
      if (!Buffer.from(data.subarray(0, 32)).equals(Buffer.from(mintBytes))) {
        throw new Error("Helius returned a token account for a different mint.");
      }

      if (input.tokenProgram === "spl-token") {
        if (data.byteLength !== TOKEN_ACCOUNT_BASE_SIZE) throw new Error("Classic SPL token account has an unexpected data length.");
      } else if (data.byteLength > TOKEN_ACCOUNT_BASE_SIZE) {
        if (data.byteLength === TOKEN_2022_MULTISIG_SIZE || data.byteLength < TOKEN_2022_TLV_OFFSET || data[TOKEN_2022_TYPE_OFFSET] !== 2) {
          throw new Error("Token-2022 token account has an invalid extension layout.");
        }
        const extensions = parseToken2022TokenAccountExtensionTypes(data);
        if (extensions === null) throw new Error("Token-2022 token account has malformed extension data.");
        for (const type of extensions) {
          if (BALANCE_AFFECTING_ACCOUNT_EXTENSIONS.has(type) || !KNOWN_ACCOUNT_EXTENSIONS.has(type)) unsupportedExtensions.add(type);
        }
      }

      const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
      const ownerAddress = encodeSolanaPublicKey(data.subarray(32, 64));
      const current = ownerTotals.get(ownerAddress) ?? { amount: 0n, accounts: 0 };
      current.amount += amount;
      current.accounts += 1;
      ownerTotals.set(ownerAddress, current);
      tokenAccountCount += 1;
      if (amount > 0n) nonzeroTokenAccountCount += 1;
    }
  }

  const owners = [...ownerTotals.entries()]
    .filter(([, value]) => value.amount > 0n)
    .map(([ownerAddress, value]) => ({ ownerAddress, balance: value.amount, tokenAccountCount: value.accounts }))
    .sort((a, b) => a.balance === b.balance ? (a.ownerAddress < b.ownerAddress ? -1 : a.ownerAddress > b.ownerAddress ? 1 : 0) : a.balance > b.balance ? -1 : 1);

  const supply = BigInt(input.currentMintSupplyRaw);
  const observedPositiveBalance = owners.reduce((sum, owner) => sum + owner.balance, 0n);
  const supplyDifference = supply - observedPositiveBalance;
  const supplyInconsistent = observedPositiveBalance > supply;
  const partial = unsupportedExtensions.size > 0 || supplyInconsistent;
  const concentrationFor = (topN: typeof TOP_N_VALUES[number]): HolderConcentration => {
    const numerator = owners.slice(0, topN).reduce((sum, owner) => sum + owner.balance, 0n);
    if (supplyInconsistent || partial || supply === 0n) {
      return {
        status: "unavailable", topN, numeratorRaw: null, denominatorRaw: input.currentMintSupplyRaw,
        denominatorBasis: "current_mint_supply", percentage: null,
        reason: supplyInconsistent
          ? "supply_inconsistency"
          : partial
            ? "unsupported_balance_affecting_extension"
            : "zero_supply",
      };
    }
    // Percentage uses half-up rounding to six decimal places; raw balances remain exact.
    const scale = 1_000_000n;
    const scaledPercentage = (numerator * 100n * scale + supply / 2n) / supply;
    const whole = scaledPercentage / scale;
    const fraction = (scaledPercentage % scale).toString().padStart(6, "0");
    return {
      status: "available", topN, numeratorRaw: numerator.toString(), denominatorRaw: input.currentMintSupplyRaw,
      denominatorBasis: "current_mint_supply", percentage: `${whole}.${fraction}`,
    };
  };

  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(fetchedAt))) throw new Error("Holder snapshot timestamp is invalid.");
  const unsupportedExtensionTypes = [...unsupportedExtensions].sort((a, b) => a - b);
  return {
    chain: "solana",
    mintAddress: input.mintAddress,
    tokenProgram: input.tokenProgram,
    decimals: input.decimals,
    currentMintSupplyRaw: input.currentMintSupplyRaw,
    observedPositiveBalanceRaw: observedPositiveBalance.toString(),
    supplyDifferenceRaw: supplyDifference.toString(),
    fetchedAt,
    enumeration: {
      completeness: "complete",
      slotConsistency: "not_guaranteed",
      pageCount: input.pages.length,
      contextSlots: input.pages.map((page) => page.contextSlot),
    },
    tokenAccountCount,
    nonzeroTokenAccountCount,
    rawOwnerCount: owners.length,
    rawOwnerAuthorities: owners.map(({ ownerAddress, balance, tokenAccountCount: count }) => ({ ownerAddress, balanceRaw: balance.toString(), tokenAccountCount: count })),
    amountCoverage: {
      state: partial ? "partial" : "complete",
      unsupportedExtensionTypes,
      reason: supplyInconsistent
        ? "supply_inconsistency"
        : unsupportedExtensions.size > 0
          ? "unsupported_balance_affecting_extension"
          : null,
    },
    concentration: {
      top1: concentrationFor(1), top5: concentrationFor(5), top10: concentrationFor(10), top20: concentrationFor(20),
    },
  };
}
