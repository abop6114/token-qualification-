const HELIUS_MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/";
const RPC_REQUEST_ID = 1;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function solanaAccountExists(address: string): Promise<boolean> {
  const apiKey = process.env.HELIUS_API_KEY;

  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("HELIUS_API_KEY is not configured. Set it in .env or the process environment.");
  }

  const endpoint = `${HELIUS_MAINNET_RPC_URL}?api-key=${encodeURIComponent(apiKey)}`;
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: RPC_REQUEST_ID,
        method: "getAccountInfo",
        params: [address, { encoding: "base64" }],
      }),
    });
  } catch {
    throw new Error("Helius RPC request failed.");
  }

  if (!response.ok) {
    throw new Error(`Helius RPC HTTP request failed (status ${response.status}).`);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new Error("Helius RPC returned malformed JSON.");
  }

  if (
    !isJsonObject(payload) ||
    payload.jsonrpc !== "2.0" ||
    payload.id !== RPC_REQUEST_ID
  ) {
    throw new Error("Helius RPC returned a malformed JSON-RPC response.");
  }

  if ("error" in payload) {
    const rpcError = payload.error;

    if (isJsonObject(rpcError) && typeof rpcError.code === "number") {
      throw new Error(`Helius JSON-RPC error (code ${rpcError.code}).`);
    }

    throw new Error("Helius RPC returned a malformed JSON-RPC error.");
  }

  const result = payload.result;

  if (
    !isJsonObject(result) ||
    !isJsonObject(result.context) ||
    typeof result.context.slot !== "number" ||
    !("value" in result)
  ) {
    throw new Error("Helius RPC returned a malformed getAccountInfo response.");
  }

  if (result.value === null) {
    return false;
  }

  if (!isJsonObject(result.value)) {
    throw new Error("Helius RPC returned a malformed account value.");
  }

  return true;
}
