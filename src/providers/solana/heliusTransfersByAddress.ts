const HELIUS_MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/";
const RPC_REQUEST_ID = "tqe-transfer-history-probe";

type JsonObject = Record<string, unknown>;

export type HeliusTransferErrorCategory =
  | "configuration"
  | "transport"
  | "http"
  | "rpc"
  | "malformed_response"
  | "pagination";

export class HeliusTransferProviderError extends Error {
  constructor(
    readonly category: HeliusTransferErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "HeliusTransferProviderError";
  }
}

/** Provider-shaped observation retained only by the development feasibility probe. */
export interface HeliusTransferObservation {
  signature: string;
  slot: number;
  blockTime?: number | null;
  type?: string | null;
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  mint?: string | null;
  amount: {
    rawAmount: string | null;
    exactRawAvailable: boolean;
    reportedAmount: string | null;
    reportedAmountType:
      | "integer_string"
      | "non_integer_string"
      | "safe_integer_number"
      | "non_integer_number"
      | "unsafe_integer_number"
      | "null"
      | "missing";
    /** Present only when the provider supplied a string uiAmount. */
    reportedUiAmount?: string | null;
    /** Records the UI field's JSON type without treating it as raw token units. */
    reportedUiAmountType?: "string" | "number" | "null";
  };
}

export interface HeliusTransferPage {
  observations: HeliusTransferObservation[];
  paginationToken: string | null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringField(
  row: JsonObject,
  key: string,
  required: boolean,
): string | null | undefined {
  if (!(key in row)) {
    if (required) throw new HeliusTransferProviderError("malformed_response", "Helius transfer response omitted a required field.");
    return undefined;
  }
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained a malformed field.");
  }
  return value;
}

function parseAmount(row: JsonObject): HeliusTransferObservation["amount"] {
  if (!("amount" in row) || row.amount === undefined) {
    return { rawAmount: null, exactRawAvailable: false, reportedAmount: null, reportedAmountType: "missing" };
  }
  const value = row.amount;
  if (value === null) {
    return { rawAmount: null, exactRawAvailable: false, reportedAmount: null, reportedAmountType: "null" };
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained an empty amount.");
    }
    if (/^[0-9]+$/.test(value)) {
      return {
        rawAmount: value,
        exactRawAvailable: true,
        reportedAmount: value,
        reportedAmountType: "integer_string",
      };
    }
    return {
      rawAmount: null,
      exactRawAvailable: false,
      reportedAmount: value,
      reportedAmountType: "non_integer_string",
    };
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    if (Number.isSafeInteger(value)) {
      return {
        rawAmount: null,
        exactRawAvailable: false,
        reportedAmount: String(value),
        reportedAmountType: "safe_integer_number",
      };
    }
    if (Number.isInteger(value)) {
      return {
        rawAmount: null,
        exactRawAvailable: false,
        reportedAmount: null,
        reportedAmountType: "unsafe_integer_number",
      };
    }
    return {
      rawAmount: null,
      exactRawAvailable: false,
      reportedAmount: String(value),
      reportedAmountType: "non_integer_number",
    };
  }

  throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained a malformed amount.");
}

function parseObservation(value: unknown, requestedMint: string): HeliusTransferObservation {
  if (!isJsonObject(value)) {
    throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained a malformed record.");
  }
  if (
    typeof value.signature !== "string" || value.signature.length === 0 ||
    !Number.isSafeInteger(value.slot) || (value.slot as number) < 0
  ) {
    throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained malformed transaction identity fields.");
  }

  const blockTime = value.blockTime;
  if (blockTime !== undefined && blockTime !== null && (!Number.isSafeInteger(blockTime) || (blockTime as number) < 0)) {
    throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained a malformed block time.");
  }

  const mint = optionalStringField(value, "mint", false);
  if (typeof mint === "string" && mint !== requestedMint) {
    throw new HeliusTransferProviderError("malformed_response", "Helius returned a transfer for a mint other than the requested mint.");
  }

  const type = optionalStringField(value, "type", false);
  const fromUserAccount = optionalStringField(value, "fromUserAccount", false);
  const toUserAccount = optionalStringField(value, "toUserAccount", false);
  const fromTokenAccount = optionalStringField(value, "fromTokenAccount", false);
  const toTokenAccount = optionalStringField(value, "toTokenAccount", false);
  const amount = parseAmount(value);

  if ("uiAmount" in value) {
    const uiAmount = value.uiAmount;
    if (uiAmount === null) {
      amount.reportedUiAmountType = "null";
      amount.reportedUiAmount = null;
    } else if (typeof uiAmount === "string") {
      amount.reportedUiAmountType = "string";
      amount.reportedUiAmount = uiAmount;
    } else if (typeof uiAmount === "number" && Number.isFinite(uiAmount)) {
      amount.reportedUiAmountType = "number";
    } else {
      throw new HeliusTransferProviderError("malformed_response", "Helius transfer response contained a malformed UI amount.");
    }
  }

  const observation: HeliusTransferObservation = {
    signature: value.signature,
    slot: value.slot as number,
    amount,
  };
  if (blockTime !== undefined) observation.blockTime = blockTime as number | null;
  if (type !== undefined) observation.type = type;
  if (fromUserAccount !== undefined) observation.fromUserAccount = fromUserAccount;
  if (toUserAccount !== undefined) observation.toUserAccount = toUserAccount;
  if (fromTokenAccount !== undefined) observation.fromTokenAccount = fromTokenAccount;
  if (toTokenAccount !== undefined) observation.toTokenAccount = toTokenAccount;
  if (mint !== undefined) observation.mint = mint;
  return observation;
}

export interface GetHeliusTransferPageInput {
  mintAddress: string;
  ownerAuthority: string;
  fromUnixSeconds: number;
  toUnixSecondsExclusive: number;
  limit: number;
  paginationToken: string | null;
}

export async function getHeliusTransferPage(
  input: GetHeliusTransferPageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<HeliusTransferPage> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new HeliusTransferProviderError("configuration", "HELIUS_API_KEY is not configured.");
  }

  const endpoint = `${HELIUS_MAINNET_RPC_URL}?api-key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: RPC_REQUEST_ID,
        method: "getTransfersByAddress",
        params: [input.ownerAuthority, {
          mint: input.mintAddress,
          direction: "any",
          limit: input.limit,
          filters: {
            blockTime: {
              gte: input.fromUnixSeconds,
              lt: input.toUnixSecondsExclusive,
            },
          },
          ...(input.paginationToken === null ? {} : { paginationToken: input.paginationToken }),
        }],
      }),
    });
  } catch {
    throw new HeliusTransferProviderError("transport", "Helius transfer-history request failed.");
  }

  if (!response.ok) {
    throw new HeliusTransferProviderError("http", `Helius transfer-history HTTP request failed (status ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HeliusTransferProviderError("malformed_response", "Helius returned malformed transfer-history JSON.");
  }

  if (
    !isJsonObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== RPC_REQUEST_ID
  ) {
    throw new HeliusTransferProviderError("malformed_response", "Helius returned a malformed transfer-history JSON-RPC response.");
  }
  if ("error" in payload) {
    const error = payload.error;
    if (isJsonObject(error) && typeof error.code === "number") {
      throw new HeliusTransferProviderError("rpc", `Helius transfer-history JSON-RPC error (code ${error.code}).`);
    }
    throw new HeliusTransferProviderError("malformed_response", "Helius returned a malformed transfer-history JSON-RPC error.");
  }

  const result = payload.result;
  if (!isJsonObject(result) || !Array.isArray(result.data)) {
    throw new HeliusTransferProviderError("malformed_response", "Helius returned a malformed transfer-history page.");
  }
  const observations = result.data.map((row) => parseObservation(row, input.mintAddress));
  if (observations.length > input.limit) {
    throw new HeliusTransferProviderError("malformed_response", "Helius returned more transfer records than requested.");
  }

  const token = result.paginationToken;
  if (token !== undefined && token !== null && (typeof token !== "string" || token.length === 0)) {
    throw new HeliusTransferProviderError("malformed_response", "Helius returned a malformed transfer-history pagination token.");
  }
  return { observations, paginationToken: typeof token === "string" ? token : null };
}
