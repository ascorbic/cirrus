#!/usr/bin/env node

import { defineCommand, runMain } from "citty";

const main = defineCommand({
	meta: {
		name: "pds",
		version: "0.0.0",
		description: "AT Protocol PDS on Cloudflare Workers",
	},
	subCommands: {
		init: () => import("./commands/init.js").then((m) => m.default),
		secret: () => import("./commands/secret/index.js").then((m) => m.default),
	},
});

runMain(main);
