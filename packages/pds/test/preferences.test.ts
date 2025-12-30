import { describe, it, expect } from "vitest";
import { env, worker } from "./helpers";

describe("Preferences", () => {
	describe("getPreferences", () => {
		it("returns empty preferences by default", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.getPreferences", {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as { preferences: unknown[] };
			expect(body.preferences).toEqual([]);
		});

		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.getPreferences"),
				env,
			);

			expect(response.status).toBe(401);
		});
	});

	describe("putPreferences", () => {
		it("persists preferences", async () => {
			const preferences = [
				{
					$type: "app.bsky.actor.defs#adultContentPref",
					enabled: true,
				},
				{
					$type: "app.bsky.actor.defs#contentLabelPref",
					label: "nsfw",
					visibility: "warn",
				},
			];

			// Put preferences
			const putResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({ preferences }),
				}),
				env,
			);

			expect(putResponse.status).toBe(200);

			// Get preferences to verify persistence
			const getResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.getPreferences", {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);

			expect(getResponse.status).toBe(200);
			const body = (await getResponse.json()) as { preferences: unknown[] };
			expect(body.preferences).toEqual(preferences);
		});

		it("updates existing preferences", async () => {
			const initialPreferences = [
				{
					$type: "app.bsky.actor.defs#adultContentPref",
					enabled: false,
				},
			];

			const updatedPreferences = [
				{
					$type: "app.bsky.actor.defs#adultContentPref",
					enabled: true,
				},
				{
					$type: "app.bsky.actor.defs#threadViewPref",
					sort: "oldest",
				},
			];

			// Set initial preferences
			await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({ preferences: initialPreferences }),
				}),
				env,
			);

			// Update preferences
			await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({ preferences: updatedPreferences }),
				}),
				env,
			);

			// Verify updated preferences
			const getResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.getPreferences", {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);

			const body = (await getResponse.json()) as { preferences: unknown[] };
			expect(body.preferences).toEqual(updatedPreferences);
		});

		it("handles complex preference types", async () => {
			const preferences = [
				{
					$type: "app.bsky.actor.defs#savedFeedsPrefV2",
					items: [
						{
							id: "feed1",
							type: "feed",
							value: "at://did:web:example.com/app.bsky.feed.generator/feed1",
							pinned: true,
						},
						{
							id: "feed2",
							type: "timeline",
							value: "timeline",
							pinned: false,
						},
					],
				},
				{
					$type: "app.bsky.actor.defs#mutedWordsPref",
					items: [
						{
							value: "spam",
							targets: ["content", "tag"],
							actorTarget: "all",
						},
					],
				},
				{
					$type: "app.bsky.actor.defs#labelersPref",
					labelers: [
						{
							did: "did:web:labeler.example.com",
						},
					],
				},
			];

			// Put complex preferences
			await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({ preferences }),
				}),
				env,
			);

			// Verify persistence
			const getResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.getPreferences", {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);

			const body = (await getResponse.json()) as { preferences: unknown[] };
			expect(body.preferences).toEqual(preferences);
		});

		it("requires authentication", async () => {
			const response = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ preferences: [] }),
				}),
				env,
			);

			expect(response.status).toBe(401);
		});

		it("handles empty preferences array", async () => {
			// Set some preferences first
			await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({
						preferences: [
							{
								$type: "app.bsky.actor.defs#adultContentPref",
								enabled: true,
							},
						],
					}),
				}),
				env,
			);

			// Clear preferences with empty array
			await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.putPreferences", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
					body: JSON.stringify({ preferences: [] }),
				}),
				env,
			);

			// Verify preferences are cleared
			const getResponse = await worker.fetch(
				new Request("http://pds.test/xrpc/app.bsky.actor.getPreferences", {
					headers: {
						Authorization: `Bearer ${env.AUTH_TOKEN}`,
					},
				}),
				env,
			);

			const body = (await getResponse.json()) as { preferences: unknown[] };
			expect(body.preferences).toEqual([]);
		});
	});
});
