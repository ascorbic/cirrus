import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";

export const handleResolver = new CompositeHandleResolver({
	strategy: "race",
	methods: {
		dns: new DohJsonHandleResolver({
			dohUrl: "https://mozilla.cloudflare-dns.com/dns-query",
		}),
		http: new WellKnownHandleResolver(),
	},
});

export const didDocResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver({ apiUrl: "https://plc.directory" }),
		web: new WebDidDocumentResolver(),
	},
});

export const actorResolver = new LocalActorResolver({
	handleResolver,
	didDocumentResolver: didDocResolver,
});
