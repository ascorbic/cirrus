/**
 * Spec URLs per check ID. Links to the most authoritative source — usually a
 * lexicon JSON for XRPC endpoint checks, or a section of atproto.com/specs
 * (or the relevant RFC) for behavioral checks. `.validates` siblings inherit
 * the parent's URL.
 */

const LEX = "https://github.com/bluesky-social/atproto/blob/main/lexicons";
const SPECS = "https://atproto.com/specs";
const RFC = "https://www.rfc-editor.org/rfc";

const MAP: Record<string, string> = {
	// identity
	"identity.parse-input": `${SPECS}/handle`,
	"identity.resolve-handle": `${SPECS}/handle#handle-resolution`,
	"identity.fetch-did-document": `${SPECS}/did`,
	"identity.extract-pds": `${SPECS}/account`,
	"identity.pds-resolve-handle": `${LEX}/com/atproto/identity/resolveHandle.json`,
	"identity.pds-resolve-did": `${LEX}/com/atproto/identity/resolveDid.json`,
	"identity.pds-resolve-identity": `${LEX}/com/atproto/identity/resolveIdentity.json`,

	// server
	"server.health":
		"https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/index.ts",
	"server.describe-server": `${LEX}/com/atproto/server/describeServer.json`,
	"server.list-repos": `${LEX}/com/atproto/sync/listRepos.json`,

	// repo-read
	"repo-read.describe-repo": `${LEX}/com/atproto/repo/describeRepo.json`,
	"repo-read.list-collections": `${LEX}/com/atproto/repo/describeRepo.json`,
	"repo-read.list-records": `${LEX}/com/atproto/repo/listRecords.json`,
	"repo-read.get-record": `${LEX}/com/atproto/repo/getRecord.json`,
	"repo-read.list-records-cursor": `${LEX}/com/atproto/repo/listRecords.json`,
	"repo-read.get-repo-car": `${LEX}/com/atproto/sync/getRepo.json`,
	"repo-read.get-repo-car.validates": "https://ipld.io/specs/transport/car/carv1/",

	// sync
	"sync.get-latest-commit": `${LEX}/com/atproto/sync/getLatestCommit.json`,
	"sync.get-repo-status": `${LEX}/com/atproto/sync/getRepoStatus.json`,
	"sync.get-blocks": `${LEX}/com/atproto/sync/getBlocks.json`,
	"sync.list-repos-by-collection": `${LEX}/com/atproto/sync/listReposByCollection.json`,

	// blobs
	"blobs.list-blobs": `${LEX}/com/atproto/sync/listBlobs.json`,
	"blobs.get-blob": `${LEX}/com/atproto/sync/getBlob.json`,

	// firehose
	"firehose.connect": `${SPECS}/sync`,
	"firehose.collect-frames": `${SPECS}/sync`,
	"firehose.frame-decodes": `${SPECS}/sync`,
	"firehose.commit-has-prevdata": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.commit-blocks-is-car": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.commit-ops-have-prev": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.commit-deprecated-toobig": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.commit-deprecated-blobs": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.commit-deprecated-rebase": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.emits-sync-events": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.emits-account-events": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.account-event-shape": `${LEX}/com/atproto/sync/subscribeRepos.json`,
	"firehose.emits-identity-events": `${LEX}/com/atproto/sync/subscribeRepos.json`,

	// oauth discovery
	"oauth.protected-resource-responds": `${RFC}/rfc9728`,
	"oauth.protected-resource-validates": `${RFC}/rfc9728`,
	"oauth.auth-server-responds": `${RFC}/rfc8414`,
	"oauth.auth-server-validates": `${RFC}/rfc8414`,
	"oauth.jwks-responds": `${RFC}/rfc7517`,
	"oauth.jwks-validates": `${RFC}/rfc7517`,
	"oauth-discovery.scope-atproto": `${SPECS}/oauth#scopes`,
	"oauth-discovery.scope-transition-generic": `${SPECS}/oauth#scopes`,
	"oauth-discovery.scope-resource-buckets": `${SPECS}/permission`,
	"oauth-discovery.scope-permission-sets": `${SPECS}/permission#permission-sets`,

	// account
	"account.get-session": `${LEX}/com/atproto/server/getSession.json`,
	"account.check-account-status": `${LEX}/com/atproto/server/checkAccountStatus.json`,
	"account.list-app-passwords": `${LEX}/com/atproto/server/listAppPasswords.json`,
	"account.get-account-invite-codes": `${LEX}/com/atproto/server/getAccountInviteCodes.json`,
	"account.get-service-auth": `${LEX}/com/atproto/server/getServiceAuth.json`,
	"account.get-recommended-did-credentials": `${LEX}/com/atproto/identity/getRecommendedDidCredentials.json`,

	// repo-write
	"repo-write.create-record": `${LEX}/com/atproto/repo/createRecord.json`,
	"repo-write.get-created-record": `${LEX}/com/atproto/repo/getRecord.json`,
	"repo-write.list-includes-created": `${LEX}/com/atproto/repo/listRecords.json`,
	"repo-write.apply-writes": `${LEX}/com/atproto/repo/applyWrites.json`,
	"repo-write.delete-record": `${LEX}/com/atproto/repo/deleteRecord.json`,
	"repo-write.deleted-record-404": `${LEX}/com/atproto/repo/listRecords.json`,
	"repo-write.upload-blob": `${LEX}/com/atproto/repo/uploadBlob.json`,
	"repo-write.reference-blob-in-record": `${LEX}/com/atproto/repo/createRecord.json`,
	"repo-write.cleanup": `${LEX}/com/atproto/repo/deleteRecord.json`,

	// OAuth flow steps
	"flow.resolve-target": `${SPECS}/handle#handle-resolution`,
	"flow.discover-protected-resource": `${RFC}/rfc9728`,
	"flow.discover-auth-server": `${RFC}/rfc8414`,
	"flow.validate-auth-server-metadata": `${RFC}/rfc8414`,
	"flow.atproto-conformance": `${SPECS}/oauth`,
	"flow.select-scope": `${SPECS}/oauth#scopes`,
	"flow.generate-pkce": `${RFC}/rfc7636`,
	"flow.generate-dpop-key": `${RFC}/rfc9449`,
	"flow.send-par": `${RFC}/rfc9126`,
	"flow.par-response-shape": `${RFC}/rfc9126`,
	"flow.par-rejects-unregistered-redirect-uri": `${RFC}/rfc6749#section-3.1.2.4`,
	"flow.par-rejects-invalid-include":
		"https://github.com/bluesky-social/atproto/discussions/4013",
	"flow.par-accepts-advertised-include":
		"https://github.com/bluesky-social/atproto/discussions/4013",
	"flow.par-accepts-known-permission-set":
		"https://github.com/bluesky-social/atproto/discussions/4013",
	"flow.build-authorization-url": `${RFC}/rfc6749#section-4.1`,
	"flow.callback-params-present": `${RFC}/rfc6749#section-4.1.2`,
	"flow.iss-matches": `${RFC}/rfc9207`,
	"flow.state-matches": `${RFC}/rfc6749#section-10.12`,
	"flow.exchange-code": `${RFC}/rfc6749#section-4.1.3`,
	"flow.token-response-shape": `${RFC}/rfc6749#section-5.1`,
	"flow.scope-echoed": `${RFC}/rfc6749#section-3.3`,
	"flow.use-access-token": `${RFC}/rfc9449#section-7`,
	"flow.session-did-matches": `${LEX}/com/atproto/server/getSession.json`,
	"flow.boundary-write-in-scope": `${SPECS}/oauth#scopes`,
	"flow.boundary-write-out-of-scope": `${RFC}/rfc6750#section-3.1`,
	"flow.boundary-cleanup": `${LEX}/com/atproto/repo/deleteRecord.json`,
	"flow.refresh-token": `${RFC}/rfc6749#section-6`,
	"flow.use-refreshed-token": `${RFC}/rfc9449#section-7`,
	"flow.revoke-token": `${RFC}/rfc7009`,
	"flow.revoked-token-rejected": `${RFC}/rfc7009#section-2.2`,
};

export function specUrlFor(checkId: string): string | undefined {
	if (MAP[checkId]) return MAP[checkId];
	// `.validates` siblings inherit from their parent
	if (checkId.endsWith(".validates")) {
		const parent = checkId.slice(0, -".validates".length);
		if (MAP[parent]) return MAP[parent];
	}
	return undefined;
}
