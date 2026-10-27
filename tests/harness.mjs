// Shared helpers for the Worker tests: the real Worker module, a fake of Microsoft's endpoints on local HTTP, and a
// Workers KV namespace in memory. Nothing here talks to a real Microsoft or Cloudflare service.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const raw = JSON.parse(readFileSync(new URL("./microsoft-shapes.json", import.meta.url), "utf8"));
const strip = (object) => Object.fromEntries(Object.entries(object).filter(([key]) => !key.startsWith("_")));
export const SHAPES = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith("_")).map(([key, body]) => [key, strip(body)]));
export const CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"; // docs/reference.md, Requests to Microsoft
export const SET_PRESENCE_BODY = {
	// docs/reference.md, The setPresence request body is
	sessionId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
	availability: "Available",
	activity: "Available",
	expirationDuration: "PT15M",
};

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export class Reply {
	constructor(status, body, { contentType, declaredLength, drop } = {}) {
		Object.assign(this, { status, body, contentType, declaredLength, drop });
	}
	static json(status, value) {
		return new Reply(status, JSON.stringify(value), { contentType: "application/json" });
	}
	static text(status, text, contentType = "text/html") {
		return new Reply(status, text, { contentType });
	}
}
export const DROP = new Reply(0, "", { drop: true }); // the server closes the connection without an answer
export const html = (status) => Reply.text(status, "<html><body>Gateway page</body></html>");

export function tokenOk({ access = "AT-NEW", refresh = "RT-NEW", expiresIn } = {}) {
	return Reply.json(200, { ...SHAPES.tokenSuccess, access_token: access, refresh_token: refresh, ...(expiresIn ? { expires_in: expiresIn } : {}) });
}
export const tokenError = (code, status = 400) => Reply.json(status, { ...SHAPES.tokenError, error: code });
export function graphError(status, code = "InvalidAuthenticationToken") {
	const body = structuredClone(SHAPES.graphError);
	body.error.code = code;
	return Reply.json(status, body);
}
export function presence({ outOfOffice = false, availability = "Away", ...extra } = {}) {
	const body = structuredClone(SHAPES.presence);
	body.availability = availability;
	body.outOfOfficeSettings.isOutOfOffice = outOfOffice;
	return Reply.json(200, { ...body, ...extra });
}

export class FakeMicrosoft {
	requests = [];
	token = () => tokenOk();
	presence = () => presence();
	setPresence = () => Reply.text(200, "", "text/plain");

	async start() {
		this.server = http.createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const text = Buffer.concat(chunks).toString();
			const path = req.url.split("?")[0];
			const request = { method: req.method, path, auth: req.headers.authorization, text };
			if ((req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
				request.form = Object.fromEntries(new URLSearchParams(text));
			} else if (text) {
				request.json = JSON.parse(text);
			}
			this.requests.push(request);
			let reply;
			if (path === "/organizations/oauth2/v2.0/token") reply = await this.token(request);
			else if (path === "/v1.0/me/presence") reply = await this.presence(request);
			else if (path.startsWith("/v1.0/users/") && path.endsWith("/presence/setPresence")) reply = await this.setPresence(request);
			else reply = Reply.json(404, SHAPES.graphError);
			if (reply.drop) {
				req.socket.destroy();
				return;
			}
			const length = reply.declaredLength ?? Buffer.byteLength(reply.body);
			res.writeHead(reply.status, { "Content-Type": reply.contentType, "Content-Length": length });
			res.write(reply.body);
			if (reply.declaredLength) req.socket.destroy(); // an answer cut short: fewer bytes than declared
			else res.end();
		});
		await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.base = `http://127.0.0.1:${this.server.address().port}`;
	}

	async close() {
		this.server.closeAllConnections();
		await new Promise((resolve) => this.server.close(resolve));
	}

	// The Worker calls the real hosts. This sends those calls to the fake, with the same path, over real HTTP.
	fetchToFake() {
		const realFetch = globalThis.fetch;
		return (url, init) => {
			const target = new URL(url);
			const hosts = ["login.microsoftonline.com", "graph.microsoft.com"];
			if (!hosts.includes(target.host)) throw new Error(`the Worker called an unexpected host: ${target.host}`);
			return realFetch(this.base + target.pathname + target.search, init);
		};
	}

	to(pathEnd) {
		return this.requests.filter((request) => request.path.endsWith(pathEnd));
	}
}

// Workers KV in memory. get(key, "json") throws on a value that is not JSON, as KV does.
// https://developers.cloudflare.com/kv/api/read-key-value-pairs/
export class FakeKV {
	constructor(initial = {}) {
		this.store = { ...initial };
		this.operations = 0;
	}
	async get(key, type) {
		this.operations++;
		const value = this.store[key];
		if (value === undefined) return null;
		return type === "json" ? JSON.parse(value) : value;
	}
	async put(key, value) {
		this.operations++;
		this.store[key] = value;
	}
	async delete(key) {
		this.operations++;
		delete this.store[key];
	}
	keys() {
		return Object.keys(this.store).sort();
	}
}

// The Worker keeps its parsed schedule and clock per module, as one Cloudflare isolate does. A query string makes
// Node load a new copy of the same file.
let copies = 0;
export async function freshWorker() {
	return (await import(new URL(`../worker/src/index.js?copy=${++copies}`, import.meta.url).href)).default;
}

export async function fire(worker, env) {
	await worker.scheduled({ noRetry() {} }, env);
}

// A Worker under test: the fake Microsoft behind the global fetch, a KV namespace, and a clock fixed at `now`.
export async function setup(t, { schedule = "Mon-Sun 00:00-24:00", zone = "UTC", now = "2026-10-26T10:00:00Z", kv = {} } = {}) {
	const fake = new FakeMicrosoft();
	await fake.start();
	t.after(() => fake.close());
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
	t.mock.method(globalThis, "fetch", fake.fetchToFake());
	t.mock.method(console, "log", () => {});
	const worker = await freshWorker();
	const store = new FakeKV(kv);
	const env = { TOKENS: store, SCHEDULE: schedule, TIME_ZONE: zone };
	return { fake, kv: store, env, run: () => fire(worker, env), setClock: (iso) => t.mock.timers.setTime(Date.parse(iso)) };
}

// A cache entry for a refresh token, as the Worker stores it (docs/reference.md, Worker settings).
export const cacheEntry = (refresh, token, expires) => JSON.stringify({ hash: sha256(refresh), token, expires });
