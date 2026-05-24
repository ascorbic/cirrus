import { decodeFirst, fromBytes, isBytes } from "@atcute/cbor";
import { isCidLink } from "@atcute/cid";
import { CarReader } from "@ipld/car";
import type { Check, CheckOutcome } from "../types";

interface FrameHeader {
	op: number;
	t?: string;
}

interface Frame {
	header: FrameHeader;
	body: Record<string, unknown>;
	raw: Uint8Array;
}

interface DecodeFailure {
	index: number;
	error: string;
}

type SampleMode = "history" | "live" | "none";

let collectedFrames: Frame[] = [];
let decodeFailures: DecodeFailure[] = [];
let collectionAttempted = false;
let collectionTerminationReason = "";
let collectionElapsedMs = 0;
let sampleMode: SampleMode = "none";
let liveWs: WebSocket | null = null;
let liveStartedAt = 0;
let liveFrameIndex = 0;

const FRAME_TARGET = 200;
const COLLECT_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 5000;
const INACTIVITY_TIMEOUT_MS = 1500;
const MIN_FRAMES_BEFORE_DIVERSITY_EXIT = 50;
const LIVE_TAIL_QUIESCE_MS = 750;

function wsUrlFor(pds: string, opts: { cursor?: number } = {}): string {
	const url = new URL(pds);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.pathname = "/xrpc/com.atproto.sync.subscribeRepos";
	url.search = opts.cursor === undefined ? "" : `?cursor=${opts.cursor}`;
	return url.toString();
}

function countHeaderTypes(frames: Frame[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const frame of frames) {
		const key = frame.header.t ?? `op:${frame.header.op}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function commitFrames(): Frame[] {
	return collectedFrames.filter((f) => f.header.t === "#commit");
}

const connect: Check = {
	id: "firehose.connect",
	category: "firehose",
	label: "Connect to firehose WebSocket",
	description:
		"Open wss://<pds>/xrpc/com.atproto.sync.subscribeRepos and verify the upgrade succeeds.",
	requires: ["pds"],
	run: async (ctx): Promise<CheckOutcome> => {
		collectedFrames = [];
		decodeFailures = [];
		collectionAttempted = false;
		collectionTerminationReason = "";
		collectionElapsedMs = 0;
		sampleMode = "none";

		if (!ctx.pds) {
			return { status: "skip", message: "No PDS endpoint" };
		}

		const url = wsUrlFor(ctx.pds, { cursor: 0 });
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { request: { method: "WS", url }, error: String(error) },
			};
		}

		ws.binaryType = "arraybuffer";

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms`));
				}, CONNECT_TIMEOUT_MS);
				ws.addEventListener(
					"open",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
				ws.addEventListener(
					"error",
					() => {
						clearTimeout(timer);
						reject(new Error("WebSocket error before open"));
					},
					{ once: true },
				);
				ws.addEventListener(
					"close",
					(ev) => {
						clearTimeout(timer);
						reject(
							new Error(
								`WebSocket closed before open: code=${ev.code} reason=${ev.reason || "(none)"}`,
							),
						);
					},
					{ once: true },
				);
			});
		} catch (error) {
			try {
				ws.close();
			} catch {
				// ignore
			}
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { request: { method: "WS", url }, error: String(error) },
			};
		}

		const frames: Frame[] = [];
		const failures: DecodeFailure[] = [];
		let index = 0;
		const collectionStartedAt = Date.now();
		let lastFrameAt = collectionStartedAt;
		let sawCommitCreate = false;
		let sawCommitMutate = false;
		let terminationReason = "timeout";

		await new Promise<void>((resolve) => {
			let done = false;
			const finish = (reason: string) => {
				if (done) return;
				done = true;
				terminationReason = reason;
				clearTimeout(deadline);
				clearInterval(inactivity);
				try {
					ws.close(1000, "collected");
				} catch {
					// ignore
				}
				resolve();
			};

			const deadline = setTimeout(() => finish("timeout"), COLLECT_TIMEOUT_MS);

			// Inactivity exit: PDS finished replaying historical events and is now
			// idle on the live tip. No point waiting longer.
			const inactivity = setInterval(() => {
				if (
					frames.length + failures.length > 0 &&
					Date.now() - lastFrameAt > INACTIVITY_TIMEOUT_MS
				) {
					finish("inactivity");
				}
			}, 250);

			ws.addEventListener("message", (event) => {
				const data = event.data;
				if (!(data instanceof ArrayBuffer)) return;
				const bytes = new Uint8Array(data);
				const i = index++;
				lastFrameAt = Date.now();
				try {
					const [header, rest] = decodeFirst(bytes);
					const [body] = decodeFirst(rest);
					const frame: Frame = {
						header: header as FrameHeader,
						body: (body ?? {}) as Record<string, unknown>,
						raw: bytes,
					};
					frames.push(frame);
					if (frame.header.t === "#commit") {
						const ops = (frame.body as { ops?: unknown }).ops;
						if (Array.isArray(ops)) {
							for (const op of ops) {
								const action = (op as { action?: string }).action;
								if (action === "create") sawCommitCreate = true;
								else if (action === "update" || action === "delete")
									sawCommitMutate = true;
							}
						}
					}
				} catch (error) {
					failures.push({
						index: i,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				const total = frames.length + failures.length;
				if (total >= FRAME_TARGET) {
					finish("cap");
				} else if (
					total >= MIN_FRAMES_BEFORE_DIVERSITY_EXIT &&
					sawCommitCreate &&
					sawCommitMutate
				) {
					finish("diversity");
				}
			});
			ws.addEventListener("close", () => finish("server-close"), { once: true });
			ws.addEventListener("error", () => finish("ws-error"), { once: true });
		});

		collectedFrames = frames;
		decodeFailures = failures;
		collectionAttempted = true;
		collectionTerminationReason = terminationReason;
		collectionElapsedMs = Date.now() - collectionStartedAt;
		sampleMode = "history";

		return {
			status: "pass",
			message: `Connected to ${url}`,
			evidence: { request: { method: "WS", url } },
		};
	},
};

const collectFrames: Check = {
	id: "firehose.collect-frames",
	category: "firehose",
	label: "Receive firehose frames",
	description: `Sample from the historical replay (cursor=0): stop at ${FRAME_TARGET} frames, ${COLLECT_TIMEOUT_MS}ms, after ${INACTIVITY_TIMEOUT_MS}ms inactivity, or as soon as the sample includes both creates and updates/deletes (≥${MIN_FRAMES_BEFORE_DIVERSITY_EXIT} frames).`,
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const total = collectedFrames.length + decodeFailures.length;
		const types = countHeaderTypes(collectedFrames);
		if (total === 0) {
			return {
				status: "warn",
				message: `No frames received in ${collectionElapsedMs}ms — relay may be idle (terminated: ${collectionTerminationReason})`,
				evidence: {
					expected: ">=1 frame",
					actual: { frames: 0, terminatedBy: collectionTerminationReason, elapsedMs: collectionElapsedMs },
				},
			};
		}
		return {
			status: "pass",
			message: `Received ${total} frame${total === 1 ? "" : "s"} in ${collectionElapsedMs}ms (terminated: ${collectionTerminationReason})`,
			evidence: {
				actual: {
					frames: total,
					decoded: collectedFrames.length,
					types,
					terminatedBy: collectionTerminationReason,
					elapsedMs: collectionElapsedMs,
				},
			},
		};
	},
};

const frameDecodes: Check = {
	id: "firehose.frame-decodes",
	category: "firehose",
	label: "Frames decode as DAG-CBOR header + body",
	description:
		"Each frame must be two concatenated DAG-CBOR objects with op:1 (event) or op:-1 (error).",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		if (collectedFrames.length === 0 && decodeFailures.length === 0) {
			return { status: "skip", message: "No frames to validate" };
		}
		if (decodeFailures.length > 0) {
			return {
				status: "fail",
				message: `${decodeFailures.length} frame${
					decodeFailures.length === 1 ? "" : "s"
				} failed to decode`,
				evidence: { actual: decodeFailures },
			};
		}
		const badOp = collectedFrames.find(
			(f) => f.header.op !== 1 && f.header.op !== -1,
		);
		if (badOp) {
			return {
				status: "fail",
				message: `Frame header op=${badOp.header.op} is neither 1 nor -1`,
				evidence: { actual: badOp.header },
			};
		}
		return {
			status: "pass",
			message: `All ${collectedFrames.length} frame${
				collectedFrames.length === 1 ? "" : "s"
			} decoded cleanly`,
			evidence: { actual: { types: countHeaderTypes(collectedFrames) } },
		};
	},
};

const commitHasPrevData: Check = {
	id: "firehose.commit-has-prevdata",
	category: "firehose",
	label: "#commit frames include prevData",
	description:
		"Every #commit event must carry the previous MST root CID as prevData (atproto Sync 1.1). Strict on live samples; informational on historical replay since pre-upgrade events are retained in the firehose.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const commits = commitFrames();
		if (commits.length === 0) {
			return { status: "skip", message: "No #commit frames observed" };
		}
		const withPrev = commits.filter((f) => f.body.prevData !== undefined);
		const missing = commits.length - withPrev.length;

		if (missing === 0) {
			return {
				status: "pass",
				message: `All ${commits.length} #commit frame${
					commits.length === 1 ? "" : "s"
				} include prevData`,
			};
		}

		if (sampleMode === "live") {
			const offending = commits.find((f) => f.body.prevData === undefined)!;
			return {
				status: "fail",
				message: `${missing}/${commits.length} live #commit frame${
					commits.length === 1 ? "" : "s"
				} missing prevData — required by atproto Sync 1.1`,
				evidence: {
					expected: "body.prevData present on every #commit",
					actual: {
						header: offending.header,
						bodyKeys: Object.keys(offending.body),
					},
				},
			};
		}

		// History sample: any prevData → pass; none → warn (ambiguous: could be
		// pre-Sync 1.1 PDS, or pre-upgrade events retained in the firehose).
		if (withPrev.length > 0) {
			return {
				status: "pass",
				message: `${withPrev.length}/${commits.length} sampled #commit frames include prevData (rest may predate the Sync 1.1 upgrade)`,
			};
		}
		return {
			status: "warn",
			message: `No #commit frames in the historical sample carry prevData (${commits.length}/${commits.length} missing) — could not confirm Sync 1.1 support. Sign in to run the live write probe, or trigger a fresh write and re-run.`,
			evidence: {
				expected: "body.prevData present on at least one sampled #commit",
				actual: {
					header: commits[0]!.header,
					bodyKeys: Object.keys(commits[0]!.body),
				},
			},
		};
	},
};

const commitBlocksIsValidCar: Check = {
	id: "firehose.commit-blocks-is-car",
	category: "firehose",
	label: "#commit body.blocks parses as a CAR",
	description:
		"The blocks field on a #commit is a CAR slice. It must parse cleanly and contain the commit block referenced by body.commit.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const commits = commitFrames();
		if (commits.length === 0) {
			return { status: "skip", message: "No #commit frames observed" };
		}
		const failures: Array<{ seq: unknown; error: string }> = [];
		let withCommitInBlocks = 0;
		for (const f of commits) {
			const blocks = f.body.blocks;
			// @atcute/cbor wraps CBOR byte strings as BytesWrapper; raw Uint8Array
			// is also valid (e.g. if the firehose used a different decoder).
			let bytes: Uint8Array | undefined;
			if (blocks instanceof Uint8Array) {
				bytes = blocks;
			} else if (isBytes(blocks)) {
				bytes = fromBytes(blocks);
			}
			if (!bytes) {
				failures.push({
					seq: f.body.seq,
					error: `body.blocks is not bytes (got ${typeof blocks})`,
				});
				continue;
			}
			try {
				const reader = await CarReader.fromBytes(bytes);
				const roots = await reader.getRoots();
				if (roots.length === 0) {
					failures.push({
						seq: f.body.seq,
						error: "CAR has no roots",
					});
					continue;
				}
				// commit field on the frame is a CidLinkWrapper (from @atcute/cbor's
				// DAG-CBOR decode). Read `.$link` for the canonical CID string —
				// `.toString()` returns the default "[object Object]".
				const commitCid = f.body.commit;
				const commitCidStr = isCidLink(commitCid)
					? (commitCid as { $link: string }).$link
					: undefined;
				const cidsInCar = new Set<string>();
				for await (const blk of reader.blocks()) {
					cidsInCar.add(blk.cid.toString());
				}
				if (commitCidStr && cidsInCar.has(commitCidStr)) {
					withCommitInBlocks++;
				} else if (commitCidStr) {
					failures.push({
						seq: f.body.seq,
						error: `commit CID ${commitCidStr.slice(0, 24)}… not present in body.blocks CAR`,
					});
				}
			} catch (error) {
				failures.push({
					seq: f.body.seq,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (failures.length > 0) {
			return {
				status: "fail",
				message: `${failures.length}/${commits.length} #commit frame${
					commits.length === 1 ? "" : "s"
				} failed CAR validation`,
				evidence: {
					expected:
						"body.blocks parses as a CAR and contains the commit block",
					error: failures
						.map((f) => `seq=${f.seq}: ${f.error}`)
						.join("\n"),
				},
			};
		}
		return {
			status: "pass",
			message: `All ${commits.length} #commit frame${
				commits.length === 1 ? "" : "s"
			} parse as valid CARs; ${withCommitInBlocks} include the commit block`,
		};
	},
};

const commitDeprecatedTooBig: Check = {
	id: "firehose.commit-deprecated-toobig",
	category: "firehose",
	label: "#commit tooBig field is not set to true",
	description:
		"tooBig is deprecated on #commit frames. Producers should leave it false; consumers ignore it.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const commits = commitFrames();
		if (commits.length === 0) {
			return { status: "skip", message: "No #commit frames observed" };
		}
		const offenders = commits.filter((f) => f.body.tooBig === true);
		if (offenders.length === 0) {
			return {
				status: "pass",
				message: `All ${commits.length} #commit frame${
					commits.length === 1 ? "" : "s"
				} have tooBig=false`,
			};
		}
		return {
			status: "warn",
			message: `${offenders.length}/${commits.length} #commit frame${
				commits.length === 1 ? "" : "s"
			} have tooBig=true (deprecated)`,
			evidence: {
				expected: "tooBig should not be true on any #commit",
				actual: offenders.map((f) => ({ seq: f.body.seq })),
			},
		};
	},
};

const commitDeprecatedBlobs: Check = {
	id: "firehose.commit-deprecated-blobs",
	category: "firehose",
	label: "#commit blobs array is empty",
	description:
		"The blobs array on #commit is deprecated. Producers should emit an empty array.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const commits = commitFrames();
		if (commits.length === 0) {
			return { status: "skip", message: "No #commit frames observed" };
		}
		const offenders = commits.filter(
			(f) => Array.isArray(f.body.blobs) && (f.body.blobs as unknown[]).length > 0,
		);
		if (offenders.length === 0) {
			return {
				status: "pass",
				message: `All ${commits.length} #commit frame${
					commits.length === 1 ? "" : "s"
				} have empty blobs array`,
			};
		}
		return {
			status: "warn",
			message: `${offenders.length}/${commits.length} #commit frame${
				commits.length === 1 ? "" : "s"
			} include legacy blobs entries (deprecated)`,
			evidence: {
				expected: "blobs array should be empty on #commit",
				actual: offenders.map((f) => ({
					seq: f.body.seq,
					blobCount: (f.body.blobs as unknown[]).length,
				})),
			},
		};
	},
};

const commitDeprecatedRebase: Check = {
	id: "firehose.commit-deprecated-rebase",
	category: "firehose",
	label: "#commit rebase field is not set",
	description:
		"rebase on #commit is deprecated; rebases are now signaled via #sync events.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const commits = commitFrames();
		if (commits.length === 0) {
			return { status: "skip", message: "No #commit frames observed" };
		}
		const offenders = commits.filter((f) => f.body.rebase === true);
		if (offenders.length === 0) {
			return {
				status: "pass",
				message: `No #commit frames flagged as rebase`,
			};
		}
		return {
			status: "warn",
			message: `${offenders.length}/${commits.length} #commit frame${
				commits.length === 1 ? "" : "s"
			} carry rebase=true (deprecated — should be a #sync event)`,
			evidence: {
				actual: offenders.map((f) => ({ seq: f.body.seq })),
			},
		};
	},
};

const ACCOUNT_STATUS_VALUES = new Set([
	"takendown",
	"suspended",
	"deleted",
	"deactivated",
]);

const accountEventShape: Check = {
	id: "firehose.account-event-shape",
	category: "firehose",
	label: "#account events carry required fields",
	description:
		"When emitted, #account events require seq, did, time, active. status is optional but must be one of: takendown, suspended, deleted, deactivated.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const events = collectedFrames.filter((f) => f.header.t === "#account");
		if (events.length === 0) {
			return {
				status: "skip",
				message: "No #account frames observed in sample",
			};
		}
		const issues: string[] = [];
		for (const f of events) {
			const body = f.body;
			if (typeof body.seq !== "number" && typeof body.seq !== "bigint")
				issues.push(`#account missing/invalid seq`);
			if (typeof body.did !== "string")
				issues.push(`#account missing/invalid did`);
			if (typeof body.time !== "string")
				issues.push(`#account missing/invalid time`);
			if (typeof body.active !== "boolean")
				issues.push(`#account missing/invalid active`);
			if (
				body.status !== undefined &&
				(typeof body.status !== "string" ||
					!ACCOUNT_STATUS_VALUES.has(body.status as string))
			) {
				issues.push(
					`#account status=${JSON.stringify(body.status)} is not one of ${[...ACCOUNT_STATUS_VALUES].join(", ")}`,
				);
			}
		}
		if (issues.length === 0) {
			return {
				status: "pass",
				message: `${events.length} #account frame${events.length === 1 ? "" : "s"} all conformant`,
			};
		}
		return {
			status: "fail",
			message:
				issues.length === 1 ? issues[0]! : `${issues.length} field issues`,
			evidence: { error: issues.join("\n") },
		};
	},
};

const commitOpsHavePrev: Check = {
	id: "firehose.commit-ops-have-prev",
	category: "firehose",
	label: "#commit update/delete ops include prev",
	description:
		"Per the subscribeRepos lexicon, #repoOp.prev holds the previous record CID and is required for update/delete actions (inductive firehose). Create ops do not carry prev.",
	requires: ["pds"],
	run: async (): Promise<CheckOutcome> => {
		if (!collectionAttempted) {
			return { status: "skip", message: "Firehose was not connected" };
		}
		const commits = commitFrames();
		if (commits.length === 0) {
			return { status: "skip", message: "No #commit frames observed" };
		}
		let updateDeleteOps = 0;
		let missingPrev = 0;
		let firstOffending: { header: FrameHeader; op: unknown } | undefined;
		for (const frame of commits) {
			const ops = frame.body.ops;
			if (!Array.isArray(ops)) continue;
			for (const op of ops) {
				if (!op || typeof op !== "object") continue;
				const action = (op as { action?: unknown }).action;
				if (action !== "update" && action !== "delete") continue;
				updateDeleteOps++;
				if (!Object.prototype.hasOwnProperty.call(op, "prev")) {
					missingPrev++;
					if (!firstOffending) {
						firstOffending = { header: frame.header, op };
					}
				}
			}
		}
		if (updateDeleteOps === 0) {
			return {
				status: "skip",
				message: "No update/delete ops in sampled commits — only creates",
			};
		}
		const withPrev = updateDeleteOps - missingPrev;
		if (missingPrev === 0) {
			return {
				status: "pass",
				message: `All ${updateDeleteOps} update/delete op${updateDeleteOps === 1 ? "" : "s"} carry prev`,
			};
		}
		if (sampleMode === "live") {
			return {
				status: "fail",
				message: `${missingPrev}/${updateDeleteOps} live update/delete op${
					updateDeleteOps === 1 ? "" : "s"
				} missing prev — required for inductive firehose (Sync 1.1)`,
				evidence: {
					expected:
						"every #repoOp with action=update|delete carries prev (CID of prior record state)",
					actual: firstOffending,
				},
			};
		}
		if (withPrev > 0) {
			return {
				status: "pass",
				message: `${withPrev}/${updateDeleteOps} sampled update/delete ops carry prev (rest may predate the Sync 1.1 upgrade)`,
			};
		}
		return {
			status: "warn",
			message: `No sampled update/delete ops carry prev (${missingPrev}/${updateDeleteOps} missing) — could not confirm Sync 1.1 support. Sign in to run the live write probe, or trigger a fresh write and re-run.`,
			evidence: {
				expected:
					"at least one #repoOp with action=update|delete carries prev",
				actual: firstOffending,
			},
		};
	},
};

function eventPresenceCheck(
	id: string,
	label: string,
	description: string,
	eventType: string,
): Check {
	return {
		id,
		category: "firehose",
		label,
		description,
		requires: ["pds"],
		run: async (): Promise<CheckOutcome> => {
			if (!collectionAttempted) {
				return { status: "skip", message: "Firehose was not connected" };
			}
			if (collectedFrames.length === 0) {
				return { status: "skip", message: "No frames to inspect" };
			}
			const matches = collectedFrames.filter((f) => f.header.t === eventType);
			if (matches.length === 0) {
				return {
					status: "warn",
					message: `No ${eventType} frames seen in ${collectedFrames.length} sampled frame${
						collectedFrames.length === 1 ? "" : "s"
					} — absence does not prove non-support`,
					evidence: { actual: countHeaderTypes(collectedFrames) },
				};
			}
			return {
				status: "pass",
				message: `Observed ${matches.length} ${eventType} frame${
					matches.length === 1 ? "" : "s"
				}`,
			};
		},
	};
}

const emitsSyncEvents = eventPresenceCheck(
	"firehose.emits-sync-events",
	"#sync events present",
	"#sync events signal rebases and migrations (atproto Sync 1.1). Absence in a short sample is informational only.",
	"#sync",
);

const emitsAccountEvents = eventPresenceCheck(
	"firehose.emits-account-events",
	"#account events present",
	"#account events are emitted on activation/deactivation state changes (atproto Sync 1.1).",
	"#account",
);

const emitsIdentityEvents = eventPresenceCheck(
	"firehose.emits-identity-events",
	"#identity events present",
	"#identity events are emitted on handle/DID document changes (atproto Sync 1.1).",
	"#identity",
);

const liveListenStart: Check = {
	id: "firehose.live-listen-start",
	category: "firehose",
	label: "Subscribe to firehose (live tail)",
	description:
		"Open subscribeRepos with no cursor before the write probe so fresh #commit events can be sampled. Frames buffer in the background while subsequent write checks run.",
	requires: ["pds", "session"],
	run: async (ctx): Promise<CheckOutcome> => {
		collectedFrames = [];
		decodeFailures = [];
		collectionAttempted = false;
		collectionTerminationReason = "";
		collectionElapsedMs = 0;
		sampleMode = "none";
		liveFrameIndex = 0;

		if (liveWs) {
			try {
				liveWs.close();
			} catch {
				// ignore
			}
			liveWs = null;
		}

		if (!ctx.pds) {
			return { status: "skip", message: "No PDS endpoint" };
		}

		const url = wsUrlFor(ctx.pds);
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (error) {
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { request: { method: "WS", url }, error: String(error) },
			};
		}
		ws.binaryType = "arraybuffer";

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms`));
				}, CONNECT_TIMEOUT_MS);
				ws.addEventListener(
					"open",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
				ws.addEventListener(
					"error",
					() => {
						clearTimeout(timer);
						reject(new Error("WebSocket error before open"));
					},
					{ once: true },
				);
				ws.addEventListener(
					"close",
					(ev) => {
						clearTimeout(timer);
						reject(
							new Error(
								`WebSocket closed before open: code=${ev.code} reason=${ev.reason || "(none)"}`,
							),
						);
					},
					{ once: true },
				);
			});
		} catch (error) {
			try {
				ws.close();
			} catch {
				// ignore
			}
			return {
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
				evidence: { request: { method: "WS", url }, error: String(error) },
			};
		}

		ws.addEventListener("message", (event) => {
			const data = event.data;
			if (!(data instanceof ArrayBuffer)) return;
			const bytes = new Uint8Array(data);
			const i = liveFrameIndex++;
			try {
				const [header, rest] = decodeFirst(bytes);
				const [body] = decodeFirst(rest);
				collectedFrames.push({
					header: header as FrameHeader,
					body: (body ?? {}) as Record<string, unknown>,
					raw: bytes,
				});
			} catch (error) {
				decodeFailures.push({
					index: i,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});

		liveWs = ws;
		liveStartedAt = Date.now();
		sampleMode = "live";

		return {
			status: "pass",
			message: `Subscribed to ${url} — buffering frames during the write probe`,
			evidence: { request: { method: "WS", url } },
		};
	},
};

const liveListenEnd: Check = {
	id: "firehose.live-listen-end",
	category: "firehose",
	label: "Capture live firehose frames",
	description: `After the write probe, give the firehose ${LIVE_TAIL_QUIESCE_MS}ms to deliver any final frames, then close the subscription and run Sync 1.1 validators against the captured sample.`,
	requires: ["pds", "session"],
	run: async (): Promise<CheckOutcome> => {
		if (!liveWs) {
			return { status: "skip", message: "Live listen did not start" };
		}

		await new Promise((resolve) => setTimeout(resolve, LIVE_TAIL_QUIESCE_MS));

		try {
			liveWs.close(1000, "complete");
		} catch {
			// ignore
		}
		liveWs = null;

		collectionElapsedMs = Date.now() - liveStartedAt;
		collectionAttempted = true;
		collectionTerminationReason = "write-probe-complete";

		const total = collectedFrames.length + decodeFailures.length;
		if (total === 0) {
			return {
				status: "warn",
				message: `No frames received during the write probe (${collectionElapsedMs}ms) — Sync 1.1 validators will skip`,
				evidence: {
					actual: { frames: 0, elapsedMs: collectionElapsedMs },
				},
			};
		}
		return {
			status: "pass",
			message: `Captured ${total} live frame${total === 1 ? "" : "s"} in ${collectionElapsedMs}ms`,
			evidence: {
				actual: {
					frames: total,
					decoded: collectedFrames.length,
					types: countHeaderTypes(collectedFrames),
				},
			},
		};
	},
};

// Anonymous flow: history replay via cursor=0. Strict Sync 1.1 checks are
// downgraded to "warn" when no live frames are available (see commitHasPrevData
// / commitOpsHavePrev — they branch on sampleMode).
export const firehoseChecks: Check[] = [
	connect,
	collectFrames,
	frameDecodes,
	commitHasPrevData,
	commitBlocksIsValidCar,
	commitOpsHavePrev,
	commitDeprecatedTooBig,
	commitDeprecatedBlobs,
	commitDeprecatedRebase,
	emitsSyncEvents,
	emitsAccountEvents,
	accountEventShape,
	emitsIdentityEvents,
];

// Live-tail probe: open WS before writes (firehoseLiveStartChecks), let the
// write probe produce events, then close + validate (firehoseLiveEndChecks).
export const firehoseLiveStartChecks: Check[] = [liveListenStart];

export const firehoseLiveEndChecks: Check[] = [
	liveListenEnd,
	frameDecodes,
	commitHasPrevData,
	commitBlocksIsValidCar,
	commitOpsHavePrev,
	commitDeprecatedTooBig,
	commitDeprecatedBlobs,
	commitDeprecatedRebase,
	accountEventShape,
];
