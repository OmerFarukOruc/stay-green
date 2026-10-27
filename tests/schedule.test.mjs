// Contract: the schedule format of docs/reference.md. tests/schedule-cases.json is read by the Python tests too.
// The Worker decides through its real scheduled handler: inside the schedule it reads the presence from Microsoft,
// outside it makes no request, and a schedule it rejects throws before any request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { FakeKV, FakeMicrosoft, fire, freshWorker, sha256 } from "./harness.mjs";

const CASES = JSON.parse(readFileSync(new URL("./schedule-cases.json", import.meta.url), "utf8"));
const ERROR_TEXT = {
	// docs/reference.md, Errors
	day: "unknown day in SCHEDULE",
	time: "bad time range in SCHEDULE",
	zone: "Invalid time zone specified",
};

const fake = new FakeMicrosoft();
before(() => fake.start());
after(() => fake.close());

async function decide(t, { schedule, zone }, instant) {
	t.mock.timers.setTime(Date.parse(instant));
	fake.requests.length = 0;
	const worker = await freshWorker();
	const kv = new FakeKV({
		"refresh-token": "RT-OLD",
		cache: JSON.stringify({ hash: sha256("RT-OLD"), token: "AT-OLD", expires: Date.parse(instant) + 3_600_000 }),
	});
	await fire(worker, { TOKENS: kv, SCHEDULE: schedule, TIME_ZONE: zone });
	return fake.to("/me/presence").length === 1;
}

test("valid schedules decide each instant", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	t.mock.method(globalThis, "fetch", fake.fetchToFake());
	t.mock.method(console, "log", () => {});
	for (const { name, at, ...setting } of CASES.valid) {
		for (const [instant, expected] of at) {
			// A schedule is parsed once per module, so each instant gets its own copy of the Worker.
			assert.equal(await decide(t, setting, instant), expected, `${name} at ${instant}`);
		}
	}
});

test("invalid schedules and zones are refused by the guard that owns them, before any request", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-26T10:00:00Z") });
	t.mock.method(globalThis, "fetch", fake.fetchToFake());
	t.mock.method(console, "log", () => {});
	for (const { name, schedule, zone = "UTC", error } of CASES.invalid) {
		fake.requests.length = 0;
		const worker = await freshWorker();
		await assert.rejects(
			fire(worker, { TOKENS: new FakeKV({ "refresh-token": "RT-OLD" }), SCHEDULE: schedule, TIME_ZONE: zone }),
			(thrown) => thrown.message.includes(ERROR_TEXT[error]),
			name,
		);
		assert.deepEqual(fake.requests, [], name);
	}
});
