import type { Check } from "../types";
import { accountChecks } from "./account";
import { blobsChecks } from "./blobs";
import {
	firehoseChecks,
	firehoseLiveEndChecks,
	firehoseLiveStartChecks,
} from "./firehose";
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
// Subscribes to the firehose live tail before the write probe so the
// create/applyWrites/delete operations produce a fresh sample that strictly
// validates Sync 1.1 (prevData, ops[].prev).
export const writeChecks: readonly Check[] = [
	...identityChecks,
	...accountChecks,
	...firehoseLiveStartChecks,
	...repoWriteChecks,
	...firehoseLiveEndChecks,
];
