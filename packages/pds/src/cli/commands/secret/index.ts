import { defineCommand } from "citty";

export default defineCommand({
	meta: {
		name: "secret",
		description: "Manage PDS secrets",
	},
	subCommands: {
		jwt: () => import("./jwt.js").then((m) => m.default),
		password: () => import("./password.js").then((m) => m.default),
		key: () => import("./key.js").then((m) => m.default),
	},
});
