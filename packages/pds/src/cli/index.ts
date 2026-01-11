#!/usr/bin/env node
/**
 * PDS CLI - Setup and management for AT Protocol PDS on Cloudflare Workers
 */
import { defineCommand, runMain } from "citty";
import { secretCommand } from "./commands/secret/index.js";
import { passkeyCommand } from "./commands/passkey/index.js";
import { initCommand } from "./commands/init.js";
import { migrateCommand } from "./commands/migrate.js";
import { migrateTokenCommand } from "./commands/migrate-token.js";
import { identityCommand } from "./commands/identity.js";
import { activateCommand } from "./commands/activate.js";
import { deactivateCommand } from "./commands/deactivate.js";
import { statusCommand } from "./commands/status.js";
import { emitIdentityCommand } from "./commands/emit-identity.js";

const main = defineCommand({
	meta: {
		name: "pds",
		version: "0.0.0",
		description: "AT Protocol PDS setup and management CLI",
	},
	subCommands: {
		init: initCommand,
		secret: secretCommand,
		passkey: passkeyCommand,
		migrate: migrateCommand,
		"migrate-token": migrateTokenCommand,
		identity: identityCommand,
		activate: activateCommand,
		deactivate: deactivateCommand,
		status: statusCommand,
		"emit-identity": emitIdentityCommand,
	},
});

runMain(main);
