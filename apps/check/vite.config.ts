import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
	plugins: [solid(), tailwind()],
	server: {
		host: "127.0.0.1",
	},
});
