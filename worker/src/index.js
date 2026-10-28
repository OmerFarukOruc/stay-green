// Keeps a Microsoft Teams status Available from a Cloudflare Worker, with the same Graph calls as
// `stay-green run`. docs/how-it-works.md explains the presence session and the 4-minute schedule.
// The cron fires every 4 minutes around the clock, and the code skips every run outside SCHEDULE in
// TIME_ZONE, so a daylight saving change needs no edit. SCHEDULE has the format of STAY_GREEN_SCHEDULE in
// ../stay-green: "Mon-Thu 09:00-12:30,13:30-18:00; Fri 09:00-15:00". A range ends before its end time.
// The TOKENS namespace holds two keys:
//   refresh-token  the refresh token; you upload the first one and each renewal replaces it
//   cache          {hash, token, expires} or {hash, rejected}: the access token, or the error of a rejected
//                  renewal, for the refresh token whose SHA-256 is hash. A new upload changes the hash, so
//                  the Worker ignores the old entry.

const CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const AUTHORITY = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
const SCOPE = "offline_access https://graph.microsoft.com/Presence.ReadWrite";
const GRAPH = "https://graph.microsoft.com/v1.0";
// Graph ends the session this long after the last call, so a few missed runs only fade the status.
const SESSION = "PT15M";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Error codes of the sign-in service that only a new sign-in fixes. Any other failure, such as throttling,
// a server error, a network error, or a proxy's error page, fails only that run, and the next run tries again.
const SIGN_IN_AGAIN = ["invalid_grant", "interaction_required", "consent_required", "invalid_client", "unauthorized_client"];

class RequestError extends Error {
	constructor(status, code, reason) {
		super(code ? `${status} ${code}: ${reason}` : `${status}: the answer has no error code`);
		this.status = status;
		this.code = code;
	}
}

async function request(url, { token, form, payload }) {
	const headers = token ? { Authorization: `Bearer ${token}` } : {};
	let body;
	if (form) {
		body = new URLSearchParams(form);
	} else if (payload) {
		body = JSON.stringify(payload);
		headers["Content-Type"] = "application/json";
	}
	let response;
	try {
		response = await fetch(url, {
			method: body ? "POST" : "GET",
			headers,
			body,
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		throw new RequestError(0, "unreachable", error.message);
	}
	const text = await response.text();
	let answer;
	try {
		answer = text ? JSON.parse(text) : {};
	} catch {}
	const object = answer && typeof answer === "object" && !Array.isArray(answer);
	if (response.ok) {
		if (!object) {
			throw new RequestError(0, "not-json", "the answer is not a JSON object");
		}
		return answer;
	}
	const detail = object ? answer : {};
	// Graph nests its error in an object; the sign-in endpoint sends a code and a description.
	const err = detail.error;
	let [code, reason] = err && typeof err === "object" ? [err.code, err.message] : [err, detail.error_description];
	code = typeof code === "string" ? code : undefined;
	reason = typeof reason === "string" ? reason : "";
	throw new RequestError(response.status, code, reason.split("\n")[0]);
}

// Like Python's str.partition: the text before the first sep, and the text after it or "".
function partition(text, sep) {
	const at = text.indexOf(sep);
	return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + sep.length)];
}

// Reads SCHEDULE into the time ranges of each weekday, Monday first.
function parseSchedule(text) {
	const ranges = DAYS.map(() => []);
	// Only spaces, tabs, and line breaks count as blanks, the same as in ../stay-green.
	for (const rule of text.split(";").map((part) => part.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")).filter(Boolean)) {
		const [days, times] = partition(rule, " ");
		const spans = times.replaceAll(" ", "").split(",").map(timeRange);
		for (const span of days.split(",")) {
			for (const day of dayRange(span)) {
				ranges[day].push(...spans);
			}
		}
	}
	return ranges;
}

// Mon-Fri, Sat, or a range across the weekend such as Fri-Mon.
function dayRange(span) {
	const [first, last] = partition(span, "-");
	if (!DAYS.includes(first) || !DAYS.includes(last || first)) {
		throw new Error(`unknown day in SCHEDULE: "${span}"`);
	}
	const day = DAYS.indexOf(first);
	const stop = DAYS.indexOf(last || first);
	return Array.from({ length: ((stop - day + 7) % 7) + 1 }, (_, step) => (day + step) % 7);
}

// Times compare as text, so each one needs two-digit hours and minutes. 24:00 can end a range.
const HHMM = "([01][0-9]|2[0-3]):[0-5][0-9]";
const START = new RegExp(`^${HHMM}$`);
const END = new RegExp(`^(${HHMM}|24:00)$`);

function timeRange(span) {
	const [start, end] = partition(span, "-");
	if (!(START.test(start) && END.test(end) && start < end)) {
		throw new Error(`bad time range in SCHEDULE: "${span}"`);
	}
	return [start, end];
}

// One formatter and one parsed schedule per isolate, because building them costs more CPU time than
// using them.
let clock;
let schedule;

function scheduled(env) {
	clock ??= new Intl.DateTimeFormat("en-US", {
		// Without TIME_ZONE, the Workers runtime uses UTC.
		timeZone: env.TIME_ZONE || undefined,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	schedule ??= parseSchedule(env.SCHEDULE || "Mon-Fri 09:00-18:00");
	const part = Object.fromEntries(clock.formatToParts(new Date()).map(({ type, value }) => [type, value]));
	const current = `${part.hour}:${part.minute}`;
	return schedule[DAYS.indexOf(part.weekday)].some(([start, end]) => start <= current && current < end);
}

async function sha256(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function accessToken(kv) {
	const refresh = (await kv.get("refresh-token"))?.trim();
	if (!refresh) {
		throw new Error("no refresh-token key in TOKENS; docs/how-to-run-on-cloudflare-workers.md shows the upload");
	}
	const hash = await sha256(refresh);
	let cache;
	try {
		cache = await kv.get("cache", "json");
	} catch {} // A damaged entry counts as no entry, and the renewal below replaces it.
	if (cache?.hash === hash) {
		// Renew 5 minutes early, so a token never expires between this check and the Graph calls.
		if (cache.expires > Date.now() + 300_000) {
			return cache.token;
		}
		// Each renewal is a sign-in in your organization's logs, so a rejected sign-in is not retried every run.
		if (cache.rejected) {
			throw new Error(`the sign-in was rejected earlier (${cache.rejected}); sign in again and upload the new token`);
		}
	}
	let tokens;
	try {
		tokens = await request(`${AUTHORITY}/token`, {
			form: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh, scope: SCOPE },
		});
	} catch (error) {
		if (SIGN_IN_AGAIN.includes(error.code)) {
			await kv.put("cache", JSON.stringify({ hash, rejected: error.message }));
		}
		throw error;
	}
	// Each renewal returns a new refresh token. A refresh token expires after 90 days without use.
	await kv.put("refresh-token", tokens.refresh_token);
	await kv.put(
		"cache",
		JSON.stringify({
			hash: await sha256(tokens.refresh_token),
			token: tokens.access_token,
			expires: Date.now() + tokens.expires_in * 1000,
		}),
	);
	return tokens.access_token;
}

async function graph(env, path, payload) {
	try {
		return await request(`${GRAPH}${path}`, { token: await accessToken(env.TOKENS), payload });
	} catch (error) {
		// Graph rejected the access token, such as after a revocation, so the next run renews it.
		if (error.status === 401) {
			await env.TOKENS.delete("cache");
		}
		throw error;
	}
}

async function run(env) {
	if (!scheduled(env)) {
		return;
	}
	const presence = await graph(env, "/me/presence");
	if (presence.outOfOfficeSettings?.isOutOfOffice) {
		console.log(`out of office; left the status at ${presence.availability}`);
		return;
	}
	// A run that started late must not stretch the schedule.
	if (!scheduled(env)) {
		console.log(`the schedule ended during this run; left the status at ${presence.availability}`);
		return;
	}
	await graph(env, `/users/${presence.id}/presence/setPresence`, {
		sessionId: CLIENT_ID,
		availability: "Available",
		activity: "Available",
		expirationDuration: SESSION,
	});
	console.log(`marked Available; the status was ${presence.availability}`);
}

export default {
	async scheduled(controller, env) {
		try {
			await run(env);
		} catch (error) {
			// The next run, 4 minutes later, is the retry.
			controller.noRetry();
			throw error;
		}
	},
};
