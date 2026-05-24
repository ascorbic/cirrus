// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
	site: "https://cirrus.cloud",

	integrations: [
		starlight({
			title: "Cirrus",
			description:
				"The lightest PDS in the Atmosphere. A single-user AT Protocol Personal Data Server that runs on a Cloudflare Worker.",
			logo: {
				src: "./src/assets/cloud.svg",
				alt: "",
			},
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/ascorbic/cirrus",
				},
			],
			editLink: {
				baseUrl: "https://github.com/ascorbic/cirrus/edit/main/docs/",
			},
			sidebar: [
				{
					label: "Start here",
					items: [
						{ label: "Welcome", slug: "index" },
						{ label: "Why run a PDS", slug: "start/why" },
						{ label: "Prerequisites", slug: "start/prerequisites" },
						{ label: "Quick start", slug: "start/quick-start" },
						{ label: "First login", slug: "start/first-login" },
					],
				},
				{
					label: "Concepts",
					items: [
						{
							label: "The AT Protocol in 5 minutes",
							slug: "concepts/atproto",
						},
						{ label: "How Cirrus is built", slug: "concepts/architecture" },
						{
							label: "Identity and your signing key",
							slug: "concepts/identity",
						},
						{ label: "Authentication methods", slug: "concepts/auth" },
						{ label: "The firehose", slug: "concepts/firehose" },
						{ label: "Data placement", slug: "concepts/data-placement" },
						{ label: "Costs and limits", slug: "concepts/costs-and-limits" },
					],
				},
				{
					label: "Guides",
					items: [
						{
							label: "Migrate from Bluesky",
							slug: "guides/migrate-from-bluesky",
						},
						{
							label: "Migrate to another PDS",
							slug: "guides/migrate-to-another-pds",
						},
						{ label: "Choose a handle", slug: "guides/choose-a-handle" },
						{
							label: "Back up your signing key",
							slug: "guides/back-up-signing-key",
						},
						{ label: "Sign in to Bluesky", slug: "guides/sign-in-to-bluesky" },
						{
							label: "Set up passkey login",
							slug: "guides/passkey-login",
						},
						{
							label: "Create an app password",
							slug: "guides/app-password",
						},
						{ label: "Update a deployed PDS", slug: "guides/update" },
						{
							label: "Troubleshoot common errors",
							slug: "guides/troubleshoot",
						},
					],
				},
				{
					label: "Operate",
					items: [
						{ label: "Deploy checklist", slug: "operate/deploy-checklist" },
						{ label: "Monitor your PDS", slug: "operate/monitor" },
						{
							label: "Manage secrets and rotate keys",
							slug: "operate/secrets",
						},
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "pds CLI", slug: "reference/pds-cli" },
						{ label: "create-pds CLI", slug: "reference/create-pds-cli" },
						{
							label: "Environment variables",
							slug: "reference/environment-variables",
						},
						{ label: "wrangler.jsonc", slug: "reference/wrangler-config" },
						{
							label: "Implemented endpoints",
							slug: "reference/endpoints",
						},
						{ label: "OAuth 2.1 surface", slug: "reference/oauth" },
						{ label: "Glossary", slug: "reference/glossary" },
					],
				},
				{
					label: "Project",
					items: [
						{ label: "Status and roadmap", slug: "project/status" },
						{ label: "Contributing", slug: "project/contributing" },
					],
				},
			],
		}),
	],
});
