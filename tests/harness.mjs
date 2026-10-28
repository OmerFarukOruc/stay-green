// Shared helpers for the Worker tests. Each test runs the Worker in `wrangler dev`, the local Workers runtime that
// the deploy guide installs, with the real worker/wrangler.jsonc and a local Workers KV namespace. The Worker calls
// the real Microsoft endpoints. The tests never sign in: the tokens they store are made up, so Microsoft refuses them,
// and the tests check what the Worker does with Microsoft's real answers.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MADE_UP_REFRESH_TOKEN = "made-up-refresh-token-for-the-stay-green-tests";
export const MADE_UP_ACCESS_TOKEN = "made-up-access-token-for-the-stay-green-tests";
export const ALWAYS = "Mon-Sun 00:00-24:00";
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const WORKER_DIR = fileURLToPath(new URL("../worker/", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Starts the Worker with SCHEDULE and TIME_ZONE set as on Cloudflare. stop() ends it and removes its KV data.
export async function startWorker({ schedule = ALWAYS, zone = "UTC" } = {}) {
	const persist = mkdtempSync(join(tmpdir(), "stay-green-worker-"));
	const child = spawn(
		WRANGLER,
		// Port 0 lets the system pick free ports for the server and DevTools when it binds them, so Workers that start
		// at the same time never collide.
		["dev", "--test-scheduled", "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0", "--persist-to", persist,
			"--var", `SCHEDULE:${schedule}`, "--var", `TIME_ZONE:${zone}`],
		{ cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
	);
	let output = "";
	child.stdout.on("data", (data) => (output += data));
	child.stderr.on("data", (data) => (output += data));
	const exited = new Promise((resolve) => child.on("exit", resolve));
	async function stop() {
		child.kill();
		await exited;
		rmSync(persist, { recursive: true, force: true });
	}
	const deadline = Date.now() + 60_000;
	let ready;
	while (!(ready = output.match(/Ready on http:\/\/127\.0\.0\.1:(\d+)/))) {
		if (child.exitCode !== null || Date.now() > deadline) {
			await stop();
			throw new Error(`wrangler dev did not start:\n${output}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const base = `http://127.0.0.1:${ready[1]}`;
	// The local explorer API of wrangler dev, which answers like the Cloudflare API for Workers KV.
	const value = (key) => `${base}/cdn-cgi/local/explorer/api/storage/kv/namespaces/TOKENS/values/${encodeURIComponent(key)}`;
	const kv = {
		async get(key) {
			const response = await fetch(value(key));
			if (response.status === 404) return null;
			if (!response.ok) throw new Error(`KV get ${key}: ${response.status}`);
			return response.text();
		},
		async put(key, text) {
			const response = await fetch(value(key), { method: "PUT", body: text });
			if (!response.ok) throw new Error(`KV put ${key}: ${response.status}`);
		},
		async delete(key) {
			const response = await fetch(value(key), { method: "DELETE" });
			if (!response.ok) throw new Error(`KV delete ${key}: ${response.status}`);
		},
		async clear() {
			for (const key of ["refresh-token", "cache"]) await this.delete(key);
		},
	};
	// One cron event, as Cloudflare sends every 4 minutes. A run that throws answers 500 with the error.
	async function run() {
		const response = await fetch(`${base}/__scheduled?cron=*/4+*+*+*+*`);
		return { ok: response.ok, text: await response.text() };
	}
	return { kv, run, stop };
}

// The weekday and the time in a zone, from the system's time zone data rather than the ICU data that the Worker uses.
export function zoneNow(zone, offsetMinutes = 0) {
	const result = spawnSync("date", ["-d", `${offsetMinutes} minutes`, "+%a %H:%M"], { env: { ...process.env, TZ: zone, LC_ALL: "C" }, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	const [day, time] = result.stdout.trim().split(" ");
	return { day, time };
}
