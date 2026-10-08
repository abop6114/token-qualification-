import { getSolanaMintExtensionTypes, normalizeSolanaMintAccount } from "./normalization/solanaMint";
import { normalizeMarketSnapshot } from "./normalization/marketSnapshot";
import { normalizeSolanaHolderStructure } from "./normalization/solanaHolders";
import { normalizeOwnerAuthorityBalanceDistribution } from "./normalization/ownerAuthorityBalanceDistribution";
import { getSolanaAccount } from "./providers/solana/heliusRpc";
import { getSolanaTokenAccountPages } from "./providers/solana/heliusTokenAccounts";
import { getSolanaMintMarkets } from "./providers/market/dexScreener";
import { isSolanaPublicKeySyntax } from "./validation/solanaAddress";

async function main(): Promise<void> {
  const mintArguments: string[] = process.argv.slice(2);
  const usage = "Usage: npm start -- <solana-mint-address>";

  if (mintArguments.length === 0) {
    console.error(`Error: a Solana token mint address is required.\n${usage}`);
    process.exitCode = 1;
    return;
  }

  if (mintArguments.length > 1) {
    console.error(`Error: exactly one Solana token mint address must be supplied.\n${usage}`);
    process.exitCode = 1;
    return;
  }

  const [mintAddress] = mintArguments;

  if (!isSolanaPublicKeySyntax(mintAddress)) {
    console.error("Error: mint address must be Base58 encoded and decode to exactly 32 bytes.");
    process.exitCode = 1;
    return;
  }

  try {
    const account = await getSolanaAccount(mintAddress);
    const resolution = normalizeSolanaMintAccount(account);
    let status: "account_not_found" | "account_found_not_mint" | "mint_found";

    if (!resolution.exists) {
      status = "account_not_found";
    } else if (!resolution.isMint) {
      status = "account_found_not_mint";
    } else {
      status = "mint_found";
    }

    if (resolution.isMint) {
      const providerMarkets = await getSolanaMintMarkets(mintAddress);
      const market = normalizeMarketSnapshot("solana", mintAddress, providerMarkets);
      if (account === null) throw new Error("Resolved mint account evidence is missing.");
      const mintExtensionTypes = getSolanaMintExtensionTypes(account, resolution.tokenProgram);
      const holderPages = await getSolanaTokenAccountPages(mintAddress, resolution.tokenProgram);
      const holderStructure = normalizeSolanaHolderStructure({
        mintAddress,
        tokenProgram: resolution.tokenProgram,
        decimals: resolution.decimals,
        currentMintSupplyRaw: resolution.rawSupply,
        mintExtensionTypes,
        pages: holderPages,
      });
      const ownerAuthorityBalanceDistribution = normalizeOwnerAuthorityBalanceDistribution({
        chain: holderStructure.chain,
        assetAddress: holderStructure.mintAddress,
        snapshotAt: holderStructure.fetchedAt,
        decimals: holderStructure.decimals,
        currentSupplyRaw: holderStructure.currentMintSupplyRaw,
        enumeration: holderStructure.enumeration,
        amountCoverage: holderStructure.amountCoverage,
        rawOwnerCount: holderStructure.rawOwnerCount,
        rawOwnerAuthorities: holderStructure.rawOwnerAuthorities,
      });
      const { mintAddress: resolvedMintAddress, ...mintEvidence } = resolution;
      console.log(JSON.stringify({ chain: "solana", mintAddress: resolvedMintAddress, status, ...mintEvidence, market, holderStructure, ownerAuthorityBalanceDistribution }));
      return;
    }

    console.log(JSON.stringify({ chain: "solana", mintAddress, status, ...resolution }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected provider error.";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

void main();
