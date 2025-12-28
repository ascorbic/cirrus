/**
 * Secret management commands
 */
import { defineCommand } from "citty";
import { jwtCommand } from "./jwt.js";
import { passwordCommand } from "./password.js";
import { keyCommand } from "./key.js";

export const secretCommand = defineCommand({
	meta: {
		name: "secret",
		description: "Manage PDS secrets",
	},
	subCommands: {
		jwt: jwtCommand,
		password: passwordCommand,
		key: keyCommand,
	},
});
