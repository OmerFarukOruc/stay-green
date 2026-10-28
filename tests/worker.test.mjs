// Contracts of the Worker's scheduled run that the real Microsoft endpoints show without a sign-in: how the Worker
// keeps, renews, and drops the tokens in Workers KV. All tests share one Worker with a schedule that is always on,
// and each starts from an empty namespace.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { MADE_UP_ACCESS_TOKEN, MADE_UP_REFRESH_TOKEN, sha256, startWorker } from "./harness.mjs";

describe("the Worker with an always-on schedule", () => {
	let worker;
	before(async () => {
		worker = await startWorker();
	});
	after(() => worker?.stop());
	beforeEach(async () => {
		await worker.kv.clear();
	});

	const cacheFor = (seconds) =>
		JSON.stringify({ hash: sha256(MADE_UP_REFRESH_TOKEN), token: MADE_UP_ACCESS_TOKEN, expires: Date.now() + seconds * 1000 });
	const mark = async () => JSON.parse((await worker.kv.get("cache")) ?? "{}");

	test("a refresh token that Microsoft refuses is marked and not sent again", async () => {
		await worker.kv.put("refresh-token", MADE_UP_REFRESH_TOKEN);
		const first = await worker.run();
		assert.equal(first.ok, false);
		assert.match(first.text, /400 invalid_grant: AADSTS/);
		const stored = await worker.kv.get("cache");
		assert.equal(JSON.parse(stored).hash, sha256(MADE_UP_REFRESH_TOKEN));
		assert.match(JSON.parse(stored).rejected, /invalid_grant/);

		const second = await worker.run();
		assert.match(second.text, /the sign-in was rejected earlier \(400 invalid_grant/);
		// Each answer from Microsoft carries a new trace ID, so a second request would have changed the mark.
		assert.equal(await worker.kv.get("cache"), stored);
	});

	test("a new upload is sent to Microsoft even though the old token was refused", async () => {
		await worker.kv.put("refresh-token", MADE_UP_REFRESH_TOKEN);
		await worker.run();
		const upload = `${MADE_UP_REFRESH_TOKEN}-uploaded-again`;
		await worker.kv.put("refresh-token", upload);
		const result = await worker.run();
		assert.match(result.text, /400 invalid_grant: AADSTS/);
		assert.equal((await mark()).hash, sha256(upload));
	});

	test("a cached access token is used until 5 minutes before it expires", async () => {
		// Graph refuses the made-up access token with 401, and the sign-in service refuses the refresh token, so the
		// answer shows which of the two the run sent.
		for (const [seconds, renews] of [[400, false], [200, true]]) {
			await worker.kv.put("refresh-token", MADE_UP_REFRESH_TOKEN);
			await worker.kv.put("cache", cacheFor(seconds));
			const result = await worker.run();
			assert.match(result.text, renews ? /400 invalid_grant/ : /401 InvalidAuthenticationToken/, `${seconds} s left`);
			assert.equal(Boolean((await mark()).rejected), renews, `${seconds} s left`);
		}
	});

	test("Graph refusing the cached access token drops it, so the next run renews", async () => {
		await worker.kv.put("refresh-token", MADE_UP_REFRESH_TOKEN);
		await worker.kv.put("cache", cacheFor(3600));
		const refused = await worker.run();
		assert.match(refused.text, /401 InvalidAuthenticationToken/);
		assert.equal(await worker.kv.get("cache"), null);

		const renewed = await worker.run();
		assert.match(renewed.text, /400 invalid_grant/);
		assert.match((await mark()).rejected, /invalid_grant/);
	});

	test("a damaged cache entry, or one for another refresh token, leads to a renewal", async () => {
		const another = JSON.stringify({ hash: sha256("another refresh token"), token: MADE_UP_ACCESS_TOKEN, expires: Date.now() + 3_600_000 });
		for (const text of ["", "{not json", "[]", "null", '{"token": "x"}', another]) {
			await worker.kv.put("refresh-token", MADE_UP_REFRESH_TOKEN);
			await worker.kv.put("cache", text);
			const result = await worker.run();
			assert.match(result.text, /400 invalid_grant/, JSON.stringify(text));
			assert.equal((await mark()).hash, sha256(MADE_UP_REFRESH_TOKEN), JSON.stringify(text));
		}
	});

	test("without an uploaded refresh token the run fails with the upload hint", async () => {
		const result = await worker.run();
		assert.equal(result.ok, false);
		assert.match(result.text, /no refresh-token key in TOKENS; docs\/how-to-run-on-cloudflare-workers\.md shows the upload/);
		assert.equal(await worker.kv.get("cache"), null);
	});
});
