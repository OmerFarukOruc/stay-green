// Contract: the schedule format of docs/reference.md, in the Worker. workerd runs on the real clock, so these tests
// build each schedule around the current time instead of the fixed instants of tests/schedule-cases.json, which the
// Python tests decide. Inside the schedule the Worker renews the made-up refresh token and Microsoft refuses it, which
// leaves a refusal mark in KV; outside the schedule the run touches nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DAYS, MADE_UP_REFRESH_TOKEN, startWorker, zoneNow } from "./harness.mjs";

const CASES = JSON.parse(readFileSync(new URL("./schedule-cases.json", import.meta.url), "utf8"));
const ERROR_TEXT = {
	// docs/reference.md, Errors
	day: "unknown day in SCHEDULE",
	time: "bad time range in SCHEDULE",
	zone: "Invalid time zone specified",
};

// One run of a Worker started with this schedule. It reports whether the run reached Microsoft.
async function runOnce(setting) {
	const worker = await startWorker(setting);
	try {
		await worker.kv.put("refresh-token", MADE_UP_REFRESH_TOKEN);
		const result = await worker.run();
		return { ...result, contacted: (await worker.kv.get("cache")) !== null };
	} finally {
		await worker.stop();
	}
}

// The schedule rules for the minutes from `from` to `to`, counted from now in `zone`, split at midnight.
function rules(zone, from, to) {
	const first = zoneNow(zone, from);
	const last = zoneNow(zone, to);
	if (first.day === last.day) return `${first.day} ${first.time}-${last.time}`;
	const rest = last.time === "00:00" ? "" : `; ${last.day} 00:00-${last.time}`;
	return `${first.day} ${first.time}-24:00${rest}`;
}

const ZONE = "Asia/Kolkata"; // UTC+05:30, so a schedule read in UTC or in whole hours misses

test("a range includes its start minute, read in TIME_ZONE", async () => {
	const result = await runOnce({ schedule: rules(ZONE, 0, 20), zone: ZONE });
	assert.match(result.text, /400 invalid_grant/);
	assert.equal(result.contacted, true);
});

test("a range excludes its end minute", async () => {
	const result = await runOnce({ schedule: rules(ZONE, -20, 0), zone: ZONE });
	assert.equal(result.ok, true, result.text);
	assert.equal(result.contacted, false);
});

test("a day other than today is outside the schedule", async () => {
	const today = DAYS.indexOf(zoneNow(ZONE).day);
	const result = await runOnce({ schedule: `${DAYS[(today + 3) % 7]} 00:00-24:00`, zone: ZONE });
	assert.equal(result.ok, true, result.text);
	assert.equal(result.contacted, false);
});

test("without TIME_ZONE the Worker reads the schedule in UTC", async () => {
	const result = await runOnce({ schedule: rules("UTC", 0, 20), zone: "" });
	assert.match(result.text, /400 invalid_grant/);
	assert.equal(result.contacted, true);
});

test("invalid schedules and zones are refused by the guard that owns them, before any request", { concurrency: 5 }, async (t) => {
	for (const { name, schedule, zone = "UTC", error } of CASES.invalid) {
		t.test(name, async () => {
			const result = await runOnce({ schedule, zone });
			assert.equal(result.ok, false);
			assert.ok(result.text.includes(ERROR_TEXT[error]), result.text);
			assert.equal(result.contacted, false);
		});
	}
});
