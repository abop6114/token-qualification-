import { normalizeSolanaMintAccount } from "./normalization/solanaMint";
import { getSolanaAccount } from "./providers/solana/heliusRpc";
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

    console.log(JSON.stringify({ chain: "solana", mintAddress, status, ...resolution }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected provider error.";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

void main();
