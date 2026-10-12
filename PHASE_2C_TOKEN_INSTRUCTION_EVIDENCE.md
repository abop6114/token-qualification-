# Phase 2C — Solana Token Instruction Evidence

## Purpose and scope

Phase 2C-2 adds a deterministic, Solana-specific decoder for supported SPL Token and Token-2022 instruction data already present in `SolanaTransactionEvidence`. It performs no provider requests and does not change transaction acquisition or normalization.

The output records instruction bytes, recognized instruction variants, encoded amount/decimal fields, account references, execution linkage, and evidence coverage. It is instruction evidence only. An instruction’s presence does not establish an effective token transfer, completed mint or burn, trade, swap, buy, sell, or other economic effect.

## Architectural boundary

The Token Qualification Engine is multi-chain. Solana is its first chain adapter, not the definition of the global qualification engine. SPL Token and Token-2022 instruction formats and account positions remain Solana-specific mechanics. Universal economic questions and normalized evidence semantics remain chain-independent; this decoder does not answer those questions or provide a global transaction schema.

## Source provenance

The decoder’s supported tags, data prefixes, and account positions are pinned to these immutable upstream revisions:

- Classic SPL Token: [`token/program/src/instruction.rs`](https://github.com/solana-labs/solana-program-library/blob/b1c44c171bc95e6ee74af12365cb9cbab68be76c/token/program/src/instruction.rs), commit `b1c44c171bc95e6ee74af12365cb9cbab68be76c`. The source was checked for the instruction discriminants, serialized fields, account-meta order, and the unpacking behavior that accepts a recognized instruction prefix while returning any remaining bytes separately.
- Token-2022: [`interface/src/instruction.rs`](https://github.com/solana-program/token-2022/blob/8867f751c0f69367ba03af4f85510b5611989491/interface/src/instruction.rs), commit `8867f751c0f69367ba03af4f85510b5611989491`. The source was checked for the corresponding base instruction discriminants, serialized fields, account-meta order, and prefix-unpacking behavior. This does not enable Token-2022 extension-specific instruction decoding.

The same six base variants are implemented for the existing classic Token and Token-2022 program IDs. The source pins are also recorded beside the decoder’s variant table.

## Supported instruction matrix

Instruction data is Base58-decoded. The first byte is the instruction tag. Amount bytes are an unsigned 64-bit little-endian integer at offsets 1–8 and are serialized as a canonical decimal string. Checked variants carry decimals at offset 9. Account positions below are zero-based within the compiled instruction’s ordered account list.

| Instruction | Tag | Required data prefix | Account roles in order |
| --- | ---: | ---: | --- |
| Transfer | 3 | 9 bytes | source, destination, authority-or-multisig reference, then optional signer references |
| TransferChecked | 12 | 10 bytes | source, mint reference, destination, authority-or-multisig reference, then optional signer references |
| MintTo | 7 | 9 bytes | mint reference, destination, authority-or-multisig reference, then optional signer references |
| MintToChecked | 14 | 10 bytes | mint reference, destination, authority-or-multisig reference, then optional signer references |
| Burn | 8 | 9 bytes | source, mint reference, authority-or-multisig reference, then optional signer references |
| BurnChecked | 15 | 10 bytes | source, mint reference, authority-or-multisig reference, then optional signer references |

The supported account list requires all listed base positions and allows at most 11 additional signer references. Those positions are references only; the decoder does not establish authority identity or multisig membership.

For a supported tag, a payload shorter than its required prefix is `malformed_payload` with reason `truncated_payload`. A sufficiently long payload is decoded from the canonical prefix, and `trailingByteCount` reports the number of bytes after that prefix. Trailing bytes are not silently discarded, marked malformed solely for being present, or assigned a meaning. Unsupported tags have no known canonical prefix, so their trailing-byte count is unavailable (`null`).

## Evidence schema and API

The public decoder is:

```ts
decodeSolanaTokenProgramInstructionEvidence(
  transaction: SolanaTransactionEvidence,
): SolanaTokenProgramInstructionEvidence
```

The schema version is `solana-token-program-instruction-evidence-v1`. The result identifies chain `solana`, the transaction signature, transaction execution linkage, collection/processing/account-space coverage, and an ordered record for each supplied outer and inner instruction entry that can be represented.

Each record retains its instruction location (outer index or inner parent outer index, group position, and instruction index), source position, normalized source instruction when usable, source program reference, resolved program identity (`spl-token` or `token-2022`) or `unsupported`/`unresolved`/`unavailable`, original Base58 data when available, and a deterministic decode result. Recognized account roles preserve source order and each role carries the normalized resolved or unresolved account reference. Unclassified account positions remain `unknown_account_reference`.

Decode statuses are:

- `decoded_supported` — supported variant and all account references resolved;
- `account_reference_unresolved` — supported payload with at least one unresolved account reference;
- `unsupported_variant` — data has a tag not decoded by this implementation, including Token-2022 extension-specific tags;
- `malformed_payload` — empty, invalid Base58, or truncated instruction data;
- `malformed_account_list` — a supported variant has missing required account positions or more than 11 additional signer references;
- `source_instruction_unavailable` — the normalized source entry is malformed or internally inconsistent;
- `unresolved_program` and `unsupported_program` — program identity cannot be resolved or is outside the two supported token programs;
- `account_space_conflicting` — canonical transaction account-space evidence contradicts itself and decoded payloads are suppressed.

Execution linkage independently preserves normalized `succeeded`, `failed`, or `unavailable` execution evidence. Structurally contradictory execution evidence is represented as `contradictory`; it does not erase instruction observations or classify their economic effect.

Coverage is separate for outer instructions and inner instruction groups. Each collection reports its status, reason, provider-reported count where available, supplied entry count, and processed entry count. Processing is either `complete_for_supplied_instruction_entries` or `partial`. “Complete” here means the supplied entries were accounted for; it does not mean all token activity was observed or understood. Account-space coverage is `consistent`, `partial`, or `conflicting`, with deterministic reason codes where applicable.

## Uncertainty, coverage, and conflicts

- **Missing versus empty:** An unavailable inner-instruction collection remains unavailable with its reason; it is not treated as an empty collection. An explicitly available collection with zero groups is an observed empty collection within this transaction response.
- **Unsupported versus absent:** Unsupported variants and programs are retained as evidence statuses. They are not converted into “no token activity” or favorable no-activity evidence.
- **Unresolved references:** A complete account space can contain a locally out-of-range instruction index, represented as an unresolved reference. A partial account space can leave a reference unresolved with reason `account_space_partial`. Neither case fabricates an address.
- **Instruction-local inconsistencies:** A reference whose resolution conflicts with the canonical address at that index, or whose unresolved reason is inconsistent with the account-space state, makes that instruction unavailable and lowers processing coverage. It does not by itself invalidate unrelated instructions or relabel the whole account space as conflicting.
- **Canonical account-space contradiction:** Contradictions in the transaction-wide account-space evidence—such as invalid canonical ordering, duplicate addresses, or incompatible lookup/loaded-address structure—are reported as `conflicting`. Decoded payloads are suppressed because their index-to-address foundation is not trustworthy.
- **Partial collection evidence:** Partial or unavailable outer/inner collections remain so in coverage. Missing entries are not inferred, and processing a supplied subset does not strengthen collection completeness.

## Deterministic guarantees and limits

The amount decoder uses `BigInt` arithmetic for the full unsigned 64-bit range, from `0` through `18446744073709551615`, and emits the exact amount as a decimal string. It does not convert token amounts through JavaScript `Number`.

Mint account positions are labeled `mint_reference`; they are not validated as token mints. Authority and signer positions are references, not identities. No account reference is called a wallet, person, owner, or economic actor. Instruction data alone does not establish execution success, a balance effect, transfer direction in an economic sense, or market participation.

## Validation checkpoint

The recorded Phase 2C-2 implementation checkpoint reports:

- 24 focused instruction-evidence tests passing;
- 609 tests passing in the full suite;
- TypeScript build passing;
- `git diff --check` and whitespace checks passing.

These are recorded checkpoint results, not a new test or build run performed while preparing this document.

## Explicit non-goals

- Additional instruction families beyond the six listed above.
- Token-2022 extension instruction decoding.
- Transaction-version expansion.
- Provider, acquisition, or transaction-normalization changes.
- DEX or aggregator instruction decoding.
- Swap, trade, buy/sell, funding, clustering, wallet-quality, or economic-owner inference.
- Scoring, qualification-methodology changes, or a global evidence-schema change.
