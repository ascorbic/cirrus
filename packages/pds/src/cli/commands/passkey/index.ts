/**
 * Passkey management commands
 */
import { defineCommand } from "citty";
import { addCommand } from "./add.js";
import { listCommand } from "./list.js";
import { removeCommand } from "./remove.js";

export const passkeyCommand = defineCommand({
	meta: {
		name: "passkey",
		description: "Manage passkeys for passwordless authentication",
	},
	subCommands: {
		add: addCommand,
		list: listCommand,
		remove: removeCommand,
	},
});
