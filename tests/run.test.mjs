// Contracts of the Worker's scheduled run: when it calls setPresence, and how it keeps and renews the tokens. The
// real handler runs against a local fake of Microsoft's endpoints, so every Graph and token request crosses real HTTP.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLIENT_ID, DROP, FakeKV, Reply, SET_PRESENCE_BODY, SHAPES, cacheEntry, graphError, html, presence, setup, sha256, tokenError,
	tokenOk,
} from "./harness.mjs";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const PRESENCE_ID = SHAPES.presence.id;
const SET_PRESENCE_PATH = `/v1.0/users/${PRESENCE_ID}/presence/setPresence`;
// The five refusal codes of docs/reference.md (Files).
const REFUSALS = ["invalid_grant", "interaction_required", "consent_required", "invalid_client", "unauthorized_client"];
const signedIn = (expiresIn = 3_600_000, at = NOW) => ({
	"refresh-token": "RT-OLD",
	cache: cacheEntry("RT-OLD", "AT-OLD", at + expiresIn),
});

test("inside the schedule run sets presence once with the documented body", async (t) => {
	const { fake, run } = await setup(t, { schedule: "Mon-Fri 09:00-18:00", kv: signedIn() });
	fake.presence = () => presence({ availability: "Busy" });
	await run();
	const [call, ...more] = fake.to("/setPresence");
	assert.equal(more.length, 0);
	assert.deepEqual([call.method, call.path], ["POST", SET_PRESENCE_PATH]);
	assert.deepEqual(call.json, SET_PRESENCE_BODY);
	assert.equal(call.auth, "Bearer AT-OLD");
	assert.deepEqual(fake.requests.map((request) => request.path), ["/v1.0/me/presence", SET_PRESENCE_PATH]);
});

test("out of office makes no setPresence call and other answers do", async (t) => {
	const { fake, run } = await setup(t, { schedule: "Mon-Fri 09:00-18:00", kv: signedIn() });
	const noSettings = presence();
	const body = JSON.parse(noSettings.body);
	delete body.outOfOfficeSettings;
	for (const [label, reply, calls] of [
		["out of office", presence({ outOfOffice: true }), 0],
		["not out of office", presence({ outOfOffice: false }), 1],
		["no outOfOfficeSettings in the answer", Reply.json(200, body), 1],
	]) {
		fake.requests.length = 0;
		fake.presence = () => reply;
		await run();
		assert.equal(fake.to("/setPresence").length, calls, label);
	}
});

test("a schedule that ends while the run waits on Microsoft makes no setPresence call", async (t) => {
	const { fake, run, setClock } = await setup(t, { schedule: "Mon-Fri 09:00-18:00", now: "2026-10-26T17:59:30Z", kv: signedIn(3_600_000, Date.parse("2026-10-26T17:59:30Z")) });
	fake.presence = () => {
		setClock("2026-10-26T18:00:30Z"); // Graph answers after the schedule ended
		return presence();
	};
	await run();
	assert.equal(fake.requests.length, 1);
	assert.equal(fake.requests[0].path, "/v1.0/me/presence");
});

test("outside the schedule the run contacts nobody and does not read the token store", async (t) => {
	const { fake, kv, run } = await setup(t, { schedule: "Mon-Fri 09:00-18:00", now: "2026-10-26T18:00:00Z", kv: signedIn() });
	await run();
	assert.deepEqual(fake.requests, []);
	assert.equal(kv.operations, 0);
});

test("a failed setPresence fails the run", async (t) => {
	const { fake, run } = await setup(t, { kv: signedIn() });
	fake.setPresence = () => graphError(403, "Authorization_RequestDenied");
	await assert.rejects(run(), /^Error: 403 Authorization_RequestDenied/);
});

test("a cache that stays valid for 5 minutes is used without a renewal", async (t) => {
	const { fake, kv, run } = await setup(t);
	for (const [expiresIn, renewals] of [[3_600_000, 0], [400_000, 0], [200_000, 1], [-10_000, 1]]) {
		Object.assign(kv.store, signedIn(expiresIn));
		fake.requests.length = 0;
		await run();
		assert.equal(fake.to("/token").length, renewals, `expires in ${expiresIn} ms`);
		assert.equal(fake.requests.at(-1).auth, renewals ? "Bearer AT-NEW" : "Bearer AT-OLD", `expires in ${expiresIn} ms`);
	}
});

test("an expired, damaged, or foreign cache renews and replaces both stored tokens", async (t) => {
	const { fake, kv, run } = await setup(t);
	const cases = {
		expired: cacheEntry("RT-OLD", "AT-OLD", NOW - 10_000),
		"not json": "{broken",
		"empty text": "",
		"JSON null": "null",
		"a list": "[]",
		"no expiry": JSON.stringify({ hash: sha256("RT-OLD"), token: "AT-OLD" }),
		"expiry is text": JSON.stringify({ hash: sha256("RT-OLD"), token: "AT-OLD", expires: "soon" }),
		"cache of another refresh token": cacheEntry("RT-OTHER", "AT-OTHER", NOW + 3_600_000),
	};
	for (const [label, content] of Object.entries(cases)) {
		kv.store = { "refresh-token": "RT-OLD", cache: content };
		fake.requests.length = 0;
		await run();
		assert.equal(fake.to("/token").length, 1, label);
		const [renewal] = fake.to("/token");
		assert.deepEqual(
			{ grant: renewal.form.grant_type, refresh: renewal.form.refresh_token, client: renewal.form.client_id },
			{ grant: "refresh_token", refresh: "RT-OLD", client: CLIENT_ID },
			label,
		);
		assert.equal(kv.store["refresh-token"], "RT-NEW", label);
		assert.deepEqual(JSON.parse(kv.store.cache), { hash: sha256("RT-NEW"), token: "AT-NEW", expires: NOW + 3599 * 1000 }, label);
		assert.equal(fake.requests.at(-1).auth, "Bearer AT-NEW", label);
	}
});

test("a Graph 401 drops the cached token so the next run renews", async (t) => {
	const { fake, kv, run } = await setup(t, { kv: signedIn() });
	fake.presence = () => graphError(401);
	await assert.rejects(run(), /^Error: 401 InvalidAuthenticationToken/);
	assert.deepEqual(kv.keys(), ["refresh-token"]);
	assert.equal(kv.store["refresh-token"], "RT-OLD");
	fake.presence = () => presence();
	fake.requests.length = 0;
	await run();
	assert.equal(fake.to("/token").length, 1);
	assert.equal(fake.to("/setPresence")[0].auth, "Bearer AT-NEW");
});

test("each refused renewal is marked and the next run does not contact Microsoft", async (t) => {
	const { fake, kv, run } = await setup(t);
	for (const code of REFUSALS) {
		kv.store = { "refresh-token": "RT-OLD" };
		fake.token = () => tokenError(code);
		fake.requests.length = 0;
		await assert.rejects(run(), (thrown) => thrown.message.startsWith(`400 ${code}: `), code);
		assert.ok(kv.store.cache, `${code} leaves a mark`);
		assert.equal(JSON.parse(kv.store.cache).hash, sha256("RT-OLD"), code);
		assert.match(JSON.parse(kv.store.cache).rejected, new RegExp(`^400 ${code}: `), code);
		assert.equal(kv.store["refresh-token"], "RT-OLD", code);
		fake.requests.length = 0;
		await assert.rejects(run(), /the sign-in was rejected earlier/, code);
		assert.deepEqual(fake.requests, [], code);
	}
});

test("a new refresh token upload ignores the mark of an earlier refusal", async (t) => {
	const { fake, kv, run } = await setup(t);
	kv.store = { "refresh-token": "RT-OLD" };
	fake.token = () => tokenError("invalid_grant");
	await assert.rejects(run(), /invalid_grant/);
	kv.store["refresh-token"] = "RT-UPLOADED\n";
	fake.token = () => tokenOk();
	fake.requests.length = 0;
	await run();
	assert.equal(fake.to("/token").length, 1);
	assert.equal(fake.to("/token")[0].form.refresh_token, "RT-UPLOADED");
	assert.equal(fake.to("/setPresence").length, 1);
});

test("a failure that may pass fails that run and marks nothing", async (t) => {
	const { fake, kv, run } = await setup(t);
	const transient = {
		"connection dropped": DROP,
		429: tokenError("temporarily_unavailable", 429),
		500: tokenError("server_error", 500),
		503: tokenError("temporarily_unavailable", 503),
		"400 with a code outside the five": tokenError("invalid_request"),
		"400 invalid_scope": tokenError("invalid_scope"),
		"403 page of a proxy": html(403),
		"408 page": html(408),
		"502 page": html(502),
		"200 page": html(200),
		"200 null": Reply.json(200, null),
		"200 list": Reply.json(200, []),
		"200 string": Reply.json(200, "token"),
		"400 object without error": Reply.json(400, { error_description: "something" }),
		"400 with a list as error": Reply.json(400, { error: ["invalid_grant"] }),
		"400 null": Reply.json(400, null),
		"502 page cut short": new Reply(502, "<html>bad", { contentType: "text/html", declaredLength: 200 }),
	};
	for (const [label, reply] of Object.entries(transient)) {
		kv.store = { "refresh-token": "RT-OLD" };
		fake.token = () => reply;
		await assert.rejects(run(), label);
		assert.deepEqual(kv.keys(), ["refresh-token"], label);
		assert.equal(kv.store["refresh-token"], "RT-OLD", label);
		fake.token = () => tokenOk();
		fake.requests.length = 0;
		await run();
		assert.equal(fake.to("/token").length, 1, label);
	}
});

test("Graph errors other than 401 keep the cache and mark nothing", async (t) => {
	const { fake, kv, run } = await setup(t);
	for (const [status, code] of [[403, "Authorization_RequestDenied"], [404, "ResourceNotFound"], [500, "generalException"]]) {
		kv.store = signedIn();
		fake.presence = () => graphError(status, code);
		fake.requests.length = 0;
		await assert.rejects(run(), (thrown) => thrown.message.startsWith(`${status} ${code}`), `${status}`);
		assert.deepEqual(kv.keys(), ["cache", "refresh-token"], `${status}`);
		assert.deepEqual(fake.to("/token"), [], `${status}`);
	}
});
