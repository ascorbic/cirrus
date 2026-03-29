/**
 * App password management commands
 */
import { defineCommand } from "citty";
import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { revokeCommand } from "./revoke.js";

export const appPasswordCommand = defineCommand({
	meta: {
		name: "app-password",
		description: "Manage app passwords for third-party client access",
	},
	subCommands: {
		create: createCommand,
		list: listCommand,
		revoke: revokeCommand,
	},
});
