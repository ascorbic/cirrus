# PLC Rotation Keys and Recovery Keys

**Status:** 📋 Planning
**Priority:** P1 (affects every did:plc account migrated to Cirrus)

## Problem

`pds identity` asks the source PDS to sign a PLC operation that changes the PDS endpoint and the atproto verification method, but passes `rotationKeys: undefined` (`packages/pds/src/cli/utils/plc-client.ts`). The source PDS keeps the rotation keys unchanged, so after migration:

- The Cirrus signing key is a verification method only. Cirrus cannot sign PLC operations for the account.
- The old PDS (for bsky.social, Bluesky's PLC key) still holds a rotation key and can rewrite the DID, including the PDS endpoint.
- Every later DID change has to go through the old PDS: handle changes (`updateHandle`, PR #250), migrating away from Cirrus, and rotating a leaked signing key.
- If the user deletes their old account and never added a recovery key, nobody they can reach can change the DID.
- Outbound migration from Cirrus is broken for these accounts. `signPlcOperation` (`packages/pds/src/xrpc/identity.ts`) signs with `SIGNING_KEY` without checking it is a rotation key, so plc.directory rejects the result.

Cirrus already recommends its signing key as a rotation key in `getRecommendedDidCredentials`. The CLI never uses it.

Nothing in the CLI or docs mentions rotation or recovery keys, although the root README's Key Safety section assumes users may have one.

## Target state

After migration, a did:plc account's rotation keys are, in priority order:

1. User-held recovery key(s), kept offline, if any.
2. The Cirrus signing key, as reported by the deployed PDS.

The old PDS's key is removed. Cirrus can make routine identity changes on its own. A recovery key ranked above it can override a Cirrus-signed operation for 72 hours, and can update the DID if Cirrus is lost.

did:web accounts are unaffected; they have no rotation keys.

## Decisions

| Decision                                                  | Choice                                            | Notes                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Old PDS rotation key                                      | Removed                                           | Keeping it leaves the old host able to redirect the DID.                                                                                         |
| Recovery key                                              | Offered by default, skippable                     | Skipping still leaves Cirrus as a rotation key, which fixes the bugs above.                                                                      |
| Where the Cirrus rotation key lives                       | `SIGNING_KEY`                                     | Same key as the verification method. A separate secret would sit in the same Worker secrets, so the offline recovery key is the real protection. |
| Source of the Cirrus key                                  | The deployed PDS's `getRecommendedDidCredentials` | Not the local `.dev.vars` copy, which may differ from what is deployed.                                                                          |
| Recovery key type                                         | secp256k1, generated locally by the CLI           | Never sent to Cloudflare or written to `.dev.vars`.                                                                                              |
| Emergency override (nullifying a malicious op within 72h) | Documented, using `goat`                          | Building a nullification flow is a separate piece of work.                                                                                       |

**Open:** the export format for the recovery key. It must be usable by `goat` for the emergency path. Check which private key encodings `goat plc` accepts (hex vs multibase) before implementing, and print the key in that form alongside the `did:key`.

## Changes

Each phase is one commit, building and passing tests on its own.

### Phase 1: refuse unsignable operations on the server

`packages/pds/src/xrpc/identity.ts`

- `signPlcOperation`: after fetching the current operation, return `400 InvalidRequest` if `SIGNING_KEY`'s `did:key` is not in `currentOp.operation.rotationKeys`. The message says this PDS cannot sign identity changes for the DID and points to `pds rotation-keys`.
- Move `signOperation`, `getLatestPlcOperation` and the PLC operation types into a shared module (`packages/pds/src/plc.ts`) so the CLI can sign locally in phase 4. PR #250's `updatePlcHandle` uses the same helpers; whichever lands second rebases onto the shared module.

Tests (`packages/pds/test/identity.test.ts`): rejects when the key is not a rotation key, signs when it is, preserves fields not in the request body.

### Phase 2: CLI building blocks

`packages/pds/src/cli/utils/plc-client.ts`

- `SourcePdsPlcClient.signPlcOperation` takes `rotationKeys` and passes it through instead of `undefined`.
- `SourcePdsPlcClient.getRecommendedDidCredentials()`, used to identify which current rotation keys belong to the source PDS.
- `PlcDirectoryClient.getLatestOperation(did)`: last non-nullified entry from the audit log.

`packages/pds/src/cli/utils/pds-client.ts`

- `getRecommendedDidCredentials()`, `signPlcOperation(token, fields)` and `submitPlcOperation(op)` against the user's own PDS. With `getMigrationToken()` these let the deployed PDS sign with its own key, so the CLI never needs the signing key locally.

`packages/pds/src/cli/utils/rotation-keys.ts` (new, pure functions)

- `buildRotationKeys({ userKeys, pdsKey })`: user keys first, then the PDS key; deduplicated; rejects more than five keys or anything that is not a `did:key`.
- `labelRotationKeys(current, { pdsKey, sourcePdsKeys })`: tags each key as this PDS, the source PDS, or unknown, for display and for deciding what to keep.

`packages/pds/src/cli/utils/secrets.ts` and `cli-helpers.ts`

- Extract the signing key backup prompt in `init.ts` (1Password, clipboard, file, show, skip) into a helper that takes what is being backed up. Parameterise `saveTo1Password` and `saveKeyBackup` titles and warnings so they work for a recovery key. `init.ts` switches to the helper with no change in behaviour.
- `generateRecoveryKey()`: secp256k1 keypair, returned in the export format chosen above plus its `did:key`.
- `importRotationKey(input)`: parses a pasted private key (secp256k1, and P-256 if `goat` keys may be P-256) and returns a keypair.

Tests in `packages/pds/test/cli/`: `rotation-keys.test.ts` (ordering, dedupe, limits, labelling), additions to `plc-client.test.ts` (rotation keys sent, recommended credentials parsed), and key generation/import round trips.

### Phase 3: set rotation keys during migration

`packages/pds/src/cli/commands/identity.ts`

1. Fetch the Cirrus key from the deployed PDS's recommended credentials. If a local `SIGNING_KEY` exists and derives a different `did:key`, stop with an error. Use this key for both `verificationMethods.atproto` and the rotation key, replacing the local derivation.
2. Read the DID's current rotation keys from plc.directory.
3. When the command has a source session (no `--token`), fetch the source PDS's recommended credentials and label its keys. With `--token` there is no session, so every existing key is unknown.
4. For each key not belonging to the source PDS, ask whether the user holds it. Confirmed keys are kept, in their existing order.
5. If no user-held key remains, offer to generate a recovery key (default yes). Run the backup helper, then require the user to confirm it is saved before continuing.
6. Show the resulting rotation keys, with labels, in the existing "DID Update" note.
7. Pass the rotation keys to the source PDS's `signPlcOperation`.
8. After submitting, read the latest operation back and check the rotation keys and endpoint match. Warn with the expected and actual lists if not.

### Phase 4: `pds rotation-keys` for existing accounts

New command `packages/pds/src/cli/commands/rotation-keys.ts`, registered in `packages/pds/src/cli/index.ts`. did:web accounts exit with an explanation.

1. Show the current rotation keys, labelled as this PDS or other.
2. **If this PDS is not a rotation key**, choose who signs the fix:
   - The previous PDS: log in with its password, request an email token, and have it sign an operation with the new rotation keys. Works only while the old account exists. The source PDS URL is not in the DID document any more, so ask for it, defaulting to bsky.social.
   - A rotation key the user holds: paste it, check its `did:key` is in the current list, and sign locally with the shared helper from phase 1.
     Key selection, recovery key generation and backup follow phase 3 steps 4 to 6.
3. **If this PDS is a rotation key but there is no other key**, offer to generate and add a recovery key. The deployed PDS signs via `getMigrationToken`, `signPlcOperation` and `submitPlcOperation`.
4. Submit, then verify as in phase 3 step 8.

Every operation keeps `services`, `verificationMethods` and `alsoKnownAs` from the current operation.

### Phase 5: surface it in `pds status`

`packages/pds/src/cli/commands/status.ts`, did:plc only:

- ✓ when this PDS's key is a rotation key, ✗ otherwise, with a hint to run `pds rotation-keys`.
- ⚠ when it is the only rotation key, suggesting a recovery key.

### Phase 6: docs and release

- `packages/pds/README.md`: update migration step 3 to describe the rotation key and recovery key prompts. Add a "Rotation and recovery keys" section: what they are, the 72-hour override, how to fix an already-migrated account, and how to use the recovery key with `goat` in an emergency.
- Root `README.md` Key Safety: the "If You've Lost Your Key" section should explain that the Cirrus signing key is also a rotation key, so losing it leaves the recovery key as the only way to update the DID.
- `plans/complete/migration-wizard.md`: note rotation key handling in the identity step.
- Changeset, `@getcirrus/pds` minor, describing the user-visible change: migration now gives your PDS control of your identity and offers a recovery key; existing accounts can run `pds rotation-keys`; leaving Cirrus reports a clear error instead of a PLC rejection.

## Verification

PLC operations are permanent, so manual testing uses throwaway did:plc accounts, never a real one.

- Migrate a fresh bsky.social test account with the updated `pds identity`, with and without generating a recovery key. Check the audit log shows the expected rotation keys and Bluesky's key is gone.
- Run `pds rotation-keys` on an account migrated with the current CLI, signing through the old PDS.
- Repeat with the old account deleted and a pre-existing recovery key.
- Change the handle through PR #250's `updateHandle` on a fixed account; the PLC step should succeed.
- Migrate the fixed account out of Cirrus to another PDS.
- Use the generated recovery key with `goat` to sign an operation, confirming the export format works.

## Risks

- **Writing the wrong rotation keys can lock the user out.** Mitigations: the Cirrus key comes from the deployed PDS, user-held keys are only dropped when the user says they don't hold them, the full list is shown before signing, and the result is read back after submitting.
- **The fix for existing accounts depends on the old account.** Users who deleted it and have no recovery key cannot be fixed. The command should say so plainly.
- **bsky.social behaviour.** Confirm on a test account that bsky.social's `signPlcOperation` accepts replacement `rotationKeys` and that deactivated accounts can still request PLC tokens.
