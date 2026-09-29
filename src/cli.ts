const mintArguments: string[] = process.argv.slice(2);
const usage = "Usage: npm start -- <solana-mint-address>";

if (mintArguments.length === 0) {
  console.error(`Error: a Solana token mint address is required.\n${usage}`);
  process.exitCode = 1;
} else if (mintArguments.length > 1) {
  console.error(`Error: exactly one Solana token mint address must be supplied.\n${usage}`);
  process.exitCode = 1;
} else {
  const [mintAddress] = mintArguments;

  console.log(
    JSON.stringify({
      chain: "solana",
      mintAddress,
      status: "input_received",
    }),
  );
}
