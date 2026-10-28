// Contract: the schedule format of docs/reference.md, in the Worker. workerd runs on the real clock, which these tests
// cannot set, so they build each schedule around the current time instead of the fixed instants of
// tests/schedule-cases.json, which the Python tests decide. No test stores a refresh token: inside the schedule the run
// reads the token store and fails with the upload hint, and outside it the run reads nothing. The runtime's trace of
// each run shows which of the two happened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DAYS, startWorker, zoneAt } from "./harness.mjs";

const CASES = JSON.parse(readFileSync(new URL("./schedule-cases.json", import.meta.url), "utf8"));
const ERROR_TEXT = {
	// docs/reference.md, Errors
	day: "unknown day in SCHEDULE",
	time: "bad time range in SCHEDULE",
	zone: "Invalid time zone specified",
};
const MINUTE = 60_000;
const ZONE = "Asia/Kolkata"; // UTC+05:30, so a schedule read in UTC or in whole hours misses
// A range before and a range after the 40 minutes around noon, on the same day. A test puts the range that holds now
// between the two, so a parser that keeps only the first or only the last one misses it.
const BEFORE = "00:00-01:00";
const AFTER = "23:00-24:00";

// Starts a Worker for each setting, passes them to `use`, and stops every Worker that started.
async function withWorkers(settings, use) {
	const started = await Promise.allSettled(settings.map((setting) => startWorker(setting)));
	const workers = started.filter(({ status }) => status === "fulfilled").map(({ value }) => value);
	try {
		const failed = started.find(({ status }) => status === "rejected");
		if (failed) throw failed.reason;
		return await use(workers);
	} finally {
		await Promise.all(workers.map((worker) => worker.stop()));
	}
}

const runOnce = (setting) => withWorkers([setting], ([worker]) => worker.run());

function assertInside(result) {
	assert.equal(result.ok, false);
	assert.match(result.text, /no refresh-token key in TOKENS/);
	assert.ok(result.calls.includes("kv_get"), `calls: ${result.calls}`);
}

function assertOutside(result) {
	assert.equal(result.ok, true, result.text);
	assert.deepEqual(result.calls, []);
}

// The schedule rules for the instants from `from` to `to` in `zone`, split at midnight.
function rules(zone, from, to) {
	const first = zoneAt(zone, from);
	const last = zoneAt(zone, to);
	if (first.day === last.day) return `${first.day} ${first.time}-${last.time}`;
	const rest = last.time === "00:00" ? "" : `; ${last.day} 00:00-${last.time}`;
	return `${first.day} ${first.time}-24:00${rest}`;
}

// A zone where the hour is now `hour`, so a test can keep its ranges away from midnight. The sign in these names is
// reversed: Etc/GMT-5 is UTC+05:00.
function zoneWhere(hour) {
	let offset = hour - new Date().getUTCHours();
	if (offset < -12) offset += 24;
	if (offset > 14) offset -= 24;
	return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

// Returns a zone where it is now between 12:00 and 13:00, today's name there, and the 40 minutes around now.
function aroundNoon() {
	const zone = zoneWhere(12);
	const now = Date.now();
	const today = zoneAt(zone, now).day;
	const [start, end] = [zoneAt(zone, now - 20 * MINUTE).time, zoneAt(zone, now + 20 * MINUTE).time];
	return { zone, today, start, end, around: `${start}-${end}` };
}

test("a range includes its start minute and excludes its end minute, read in TIME_ZONE", async () => {
	// The runs land in the minute that starts at `at`, so no minute ends between the schedule and the run. That is this
	// minute while at least 20 seconds of it are left for the Workers to start and run, and the next minute otherwise.
	let at = Math.floor(Date.now() / MINUTE) * MINUTE;
	if (Date.now() - at > 40_000) at += MINUTE;
	// A range that ends at 00:00 is written as 24:00 on the day before, which an end read as inclusive never matches
	// either, so the test takes the next minute.
	if (zoneAt(ZONE, at).time === "00:00") at += MINUTE;
	const settings = [
		{ schedule: rules(ZONE, at, at + 20 * MINUTE), zone: ZONE },
		{ schedule: rules(ZONE, at - 20 * MINUTE, at), zone: ZONE },
	];
	const [starting, ending] = await withWorkers(settings, async (workers) => {
		const wait = at + 100 - Date.now();
		if (wait > 0) await sleep(wait);
		const results = await Promise.all(workers.map((worker) => worker.run()));
		assert.ok(Date.now() < at + MINUTE, "the minute ended before the runs did");
		return results;
	});
	assertInside(starting);
	assertOutside(ending);
});

test("a day other than today is outside the schedule", async () => {
	const today = DAYS.indexOf(zoneAt(ZONE, Date.now()).day);
	assertOutside(await runOnce({ schedule: `${DAYS[(today + 3) % 7]} 00:00-24:00`, zone: ZONE }));
});

test("without TIME_ZONE the Worker reads the schedule in UTC", async () => {
	const now = Date.now();
	assertInside(await runOnce({ schedule: rules("UTC", now - 20 * MINUTE, now + 20 * MINUTE), zone: "" }));
});

test("rules for the same day add their ranges", async () => {
	const { zone, today, around } = aroundNoon();
	assertInside(await runOnce({ schedule: `${today} ${BEFORE}; ${today} ${around}; ${today} ${AFTER}`, zone }));
});

test("a comma joins time ranges", async () => {
	const { zone, today, around } = aroundNoon();
	assertInside(await runOnce({ schedule: `${today} ${BEFORE}, ${around}, ${AFTER}`, zone }));
});

test("a comma joins days", async () => {
	const { zone, today, around } = aroundNoon();
	const [first, last] = [3, 5].map((ahead) => DAYS[(DAYS.indexOf(today) + ahead) % 7]);
	assertInside(await runOnce({ schedule: `${first},${today},${last} ${around}`, zone }));
});

test("a day range wraps past Sunday", async () => {
	const { zone, today, around } = aroundNoon();
	// A range that starts after the day it ends on, with today after its first day.
	const range = { Sat: "Sun-Sat", Sun: "Sat-Mon" }[today] ?? `Sat-${today}`;
	assertInside(await runOnce({ schedule: `${range} ${around}`, zone }));
});

test("blanks around rules and inside a time range, and empty rules, are skipped", async () => {
	const { zone, today, start, end } = aroundNoon();
	assertInside(await runOnce({ schedule: ` ;;\n\t${today}  ${start} - ${end} ;\r\n;`, zone }));
});

test("a schedule of blanks is never inside, and an empty one means Mon-Fri 09:00-18:00", async () => {
	const noon = zoneWhere(12);
	const weekday = !["Sat", "Sun"].includes(zoneAt(noon, Date.now()).day);
	const settings = [
		{ schedule: " \n", zone: noon },
		{ schedule: "", zone: noon },
		{ schedule: "", zone: zoneWhere(3) },
	];
	const [blanks, empty, night] = await withWorkers(settings, (workers) => Promise.all(workers.map((worker) => worker.run())));
	assertOutside(blanks);
	// On a weekend, noon is outside the empty schedule too.
	(weekday ? assertInside : assertOutside)(empty);
	assertOutside(night);
});

test("invalid schedules and zones are refused by the guard that owns them, before any read", { concurrency: 5 }, async (t) => {
	// Each case starts its own Worker, so the subtests run 5 at a time. Node 22 cancels a subtest that is not awaited.
	await Promise.all(
		CASES.invalid.map(({ name, schedule, zone = "UTC", error }) =>
			t.test(name, async () => {
				const result = await runOnce({ schedule, zone });
				assert.equal(result.ok, false);
				assert.ok(result.text.includes(ERROR_TEXT[error]), result.text);
				assert.deepEqual(result.calls, []);
			}),
		),
	);
});
