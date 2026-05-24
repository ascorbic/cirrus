import type { Check } from "../types";
import { accountChecks } from "./account";
import { blobsChecks } from "./blobs";
import { firehoseChecks } from "./firehose";
import { identityChecks } from "./identity";
import { oauthDiscoveryChecks } from "./oauth-discovery";
import { repoReadChecks } from "./repo-read";
import { repoWriteChecks } from "./repo-write";
import { serverChecks } from "./server";
import { syncChecks } from "./sync";

// Public/anonymous checks — the main VERIFY button. No auth, no writes.
export const anonymousChecks: readonly Check[] = [
	...identityChecks,
	...serverChecks,
	...repoReadChecks,
	...syncChecks,
	...blobsChecks,
	...firehoseChecks,
	...oauthDiscoveryChecks,
];

// Write tests — gated by sign-in AND an explicit confirmation step.
// Includes identity (to populate ctx.pds/ctx.did) + account (verify session) + the actual writes.
export const writeChecks: readonly Check[] = [
	...identityChecks,
	...accountChecks,
	...repoWriteChecks,
];
