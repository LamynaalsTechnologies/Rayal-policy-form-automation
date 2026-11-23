"use strict";

/**
 * [timing] lines: where a run's time goes, measured with a monotonic clock (performance.now).
 *
 * Always on (no .env switch - the owner's working agreement), a handful of lines per run, never throws and never
 * changes what the automation does: the browser commands, waits and sleeps return exactly what they returned before
 * (same values, same errors, same promise types).
 *
 * A line carries only ids and numbers: insurer, part, the queue job _id, the first 8 characters of the run id, step
 * names, milliseconds and counts, and on/off facts about how a browser was started. Never a customer name, phone,
 * address, policy / proposal / vehicle number, login, password, URL or cookie.
 *
 * Read them on the server with:   pm2 logs <app> --lines 5000 --nostream | grep -F '[timing]'
 *
 *   event=browser-open  one per browser: start time, headless or not, window size, chromedriver file or Selenium Manager
 *   event=step          one per run step (proposal / kyc / payment): where the step's wall time went
 *   event=end           one per run: the same split for the whole run, loopLate* = how late Node's event loop ran
 *                       (0 = never; a big number = the whole process was frozen that long), and windows = how many
 *                       run windows were open when this one opened (this one included: 1 = it ran alone)
 *   event=db-connect    a new database connection that took more than 200 ms
 *   event=recorder      job video: capture mode, frames Chrome sent vs frames kept, still-page top-ups
 *   event=recorder-encode  ffmpeg time for the video and how many runs were going during it
 *
 * The split of a step's wall time:
 *   sleepMs        fixed pauses (driver.sleep)
 *   waitMs         waiting for the page to reach a state (driver.wait), including the commands it polls with
 *   cmdMs / cmds   browser commands outside waits (click, type, find, read ...): count and total
 *   otherMs        the rest: our own code, the database, uploads, captcha reading ...
 *   top            the commands that took longest in total: name:count/totalMs/p50Ms/p90Ms
 *   sleepTop       WHERE the fixed pauses are: file:line:count/totalMs, biggest first
 *   cmdTop         WHERE the browser commands come from: file:line:count/totalMs (a polling loop shows up here)
 * A slow command p50 (tens of ms is normal) means the browser itself is slow on this machine; a big sleepMs means our
 * own fixed pauses; a big waitMs means waiting for the portal page.
 */

const path = require("path");
const { performance, monitorEventLoopDelay } = require("perf_hooks");

const PREFIX = "[timing]";
const SLOW_DB_CONNECT_MS = 200;
const MAX_SAMPLES = 5000; // per command name and bucket: keeps memory bounded on a long run
const MAX_RUNS = 300;
const TOP_COMMANDS = 6;
const TOP_SITES = 6;
const MAX_SITES = 400; // per bucket: a run never has more distinct call sites than this
const PROJECT_ROOT = path.resolve(__dirname, "..");
// Frames that are never "the caller": this file and the per-run wrappers stacked on the driver.
const NOT_A_CALLER = new Set([__filename, path.join(__dirname, "holdStop.js"), path.join(__dirname, "stallWatch.js")]);
// A run that never reaches its end (process killed) stops sampling the event loop after this long.
const LOOP_HISTOGRAM_MAX_MS = 3 * 60 * 60 * 1000;
// Node records the gap between its sampling ticks (about this long when idle); the lines show the lateness beyond it.
const LOOP_RESOLUTION_MS = 20;

let clock = () => performance.now();
const round = (value) => Math.round(value);

const runs = new Map(); // runId (or "job:<jobId>") -> run state
const runOfDriver = new WeakMap(); // driver -> run state
const runOfJob = new Map(); // job _id -> run state (database connects find their run through it)
const browserStartMs = new WeakMap(); // driver -> ms its launcher took

function safe(fn) {
    try {
        return fn();
    } catch {
        return undefined;
    }
}

// One token per value, so every line stays machine-readable.
function clean(value) {
    return String(value).replace(/\s+/g, "_").replace(/=/g, ":");
}

function format(fields) {
    return Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${clean(value)}`)
        .join(" ");
}

function emit(fields) {
    try {
        console.log(`${PREFIX} ${format(fields)}`);
    } catch {
        /* a log line must never break a run */
    }
}

/** Same outcome as `promise` (value or error), plus `done()` once it settles. A new promise, so an error nobody
 *  handles is still reported as unhandled exactly as before. */
function mirror(promise, done) {
    if (!promise || typeof promise.then !== "function") {
        safe(done);
        return promise;
    }
    return promise.then(
        (value) => {
            safe(done);
            return value;
        },
        (error) => {
            safe(done);
            throw error;
        }
    );
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * "file.js:line" (relative to the project) of the first frame in OUR code that led here, or "?". Only the file name
 * and the line number - nothing from the call's arguments.
 */
function callSite() {
    const limit = Error.stackTraceLimit;
    try {
        Error.stackTraceLimit = 30;
        const stack = String(new Error().stack || "");
        for (const line of stack.split("\n").slice(1)) {
            const m = line.match(/\(?(\/[^():]+):(\d+):\d+\)?\s*$/);
            if (!m) continue;
            const file = m[1];
            if (file.includes(`${path.sep}node_modules${path.sep}`) || NOT_A_CALLER.has(file)) continue;
            return `${path.relative(PROJECT_ROOT, file)}:${m[2]}`;
        }
        return "?";
    } catch {
        return "?";
    } finally {
        Error.stackTraceLimit = limit;
    }
}

function newBucket() {
    return {
        sleepMs: 0,
        sleeps: 0,
        waitMs: 0,
        waits: 0,
        cmdMs: 0,
        cmds: 0,
        cmdInWaitMs: 0,
        dbMs: 0,
        dbConnects: 0,
        byName: new Map(),
        sleepSites: new Map(),
        cmdSites: new Map(),
    };
}

function addSite(sites, site, ms) {
    let entry = sites.get(site);
    if (!entry) {
        if (sites.size >= MAX_SITES) return;
        entry = { n: 0, total: 0 };
        sites.set(site, entry);
    }
    entry.n += 1;
    entry.total += ms;
}

function topSites(sites) {
    return [...sites.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, TOP_SITES)
        .map(([site, e]) => `${site}:${e.n}/${round(e.total)}`)
        .join(",");
}

function addCommand(bucket, name, ms, inWait) {
    if (inWait) bucket.cmdInWaitMs += ms;
    else {
        bucket.cmdMs += ms;
        bucket.cmds += 1;
    }
    let entry = bucket.byName.get(name);
    if (!entry) {
        entry = { n: 0, total: 0, samples: [] };
        bucket.byName.set(name, entry);
    }
    entry.n += 1;
    entry.total += ms;
    if (entry.samples.length < MAX_SAMPLES) entry.samples.push(ms);
}

function topCommands(bucket) {
    return [...bucket.byName.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, TOP_COMMANDS)
        .map(([name, e]) => {
            const s = [...e.samples].sort((x, y) => x - y);
            return `${name}:${e.n}/${round(e.total)}/${round(percentile(s, 50))}/${round(percentile(s, 90))}`;
        })
        .join(",");
}

function split(bucket, wallMs) {
    return {
        wallMs: round(wallMs),
        sleepMs: round(bucket.sleepMs),
        sleeps: bucket.sleeps,
        waitMs: round(bucket.waitMs),
        waits: bucket.waits,
        cmdMs: round(bucket.cmdMs),
        cmds: bucket.cmds,
        otherMs: round(Math.max(0, wallMs - bucket.sleepMs - bucket.waitMs - bucket.cmdMs)),
        dbConnects: bucket.dbConnects || undefined,
        dbConnectMs: bucket.dbConnects ? round(bucket.dbMs) : undefined,
    };
}

function startLoopHistogram() {
    try {
        const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
        histogram.enable();
        const stop = setTimeout(() => safe(() => histogram.disable()), LOOP_HISTOGRAM_MAX_MS);
        if (stop.unref) stop.unref();
        return { histogram, stop };
    } catch {
        return null;
    }
}

function stopLoopHistogram(state) {
    const loop = state.loop;
    state.loop = null;
    if (!loop) return {};
    return (
        safe(() => {
            clearTimeout(loop.stop);
            loop.histogram.disable();
            // 0 = the loop was never late; 187 = it was blocked for about 200 ms
            const late = (ns) => Math.max(0, round(ns / 1e6 - LOOP_RESOLUTION_MS));
            return {
                loopLateP50Ms: late(loop.histogram.percentile(50)),
                loopLateP99Ms: late(loop.histogram.percentile(99)),
                loopLateMaxMs: late(loop.histogram.max),
            };
        }) || {}
    );
}

function activeRuns({ exceptRunId } = {}) {
    let n = 0;
    for (const state of runs.values()) {
        if (state.attached && !state.ended && state.runId !== exceptRunId) n += 1;
    }
    return n;
}

function baseOf(state) {
    return { run: state.run8, company: state.company, part: state.part, job: state.jobId };
}

function newRunState({ runId, jobId, company, part }) {
    const t = clock();
    return {
        runId: runId || null,
        run8: runId ? String(runId).slice(0, 8) : undefined,
        jobId: jobId || undefined,
        company: company ? String(company).toLowerCase() : undefined,
        part: part ? String(part) : undefined,
        t0: t,
        attached: false,
        attachT0: null,
        stepT0: null,
        windows: undefined,
        waitDepth: 0,
        total: newBucket(),
        step: newBucket(),
        loop: null,
        browserStartMs: undefined,
        ended: false,
    };
}

function forget(key, state) {
    runs.delete(key);
    if (state && state.jobId && runOfJob.get(state.jobId) === state) runOfJob.delete(state.jobId);
    if (state) stopLoopHistogram(state);
}

function remember(key, state) {
    runs.set(key, state);
    while (runs.size > MAX_RUNS) {
        const [oldKey, oldState] = runs.entries().next().value;
        forget(oldKey, oldState);
    }
}

/** A run started (lib/runHistory.js startRun): its insurer and part, so the lines can say which one it is. */
function noteRun(runId, { company, part, jobId } = {}) {
    safe(() => {
        if (!runId) return;
        const key = String(runId);
        if (runs.has(key)) return;
        remember(key, newRunState({ runId: key, jobId: jobId ? String(jobId) : undefined, company, part }));
    });
}

/** The run's browser is open and armed (lib/holdStop.js armLiveHold). Links the driver to the run; changes nothing on it. */
function attach(driver, data) {
    safe(() => {
        if (!driver || !data) return;
        const runId = data._runId ? String(data._runId) : null;
        const jobId = data._jobId ? String(data._jobId) : null;
        if (!runId && !jobId) return;
        const key = runId || `job:${jobId}`;
        let state = runs.get(key);
        if (!state) {
            state = newRunState({ runId, jobId, part: data._partKey });
            remember(key, state);
        }
        if (!state.jobId && jobId) state.jobId = jobId;
        if (!state.part && data._partKey) state.part = String(data._partKey);
        if (!state.attached) {
            state.attached = true;
            state.attachT0 = clock();
            state.stepT0 = state.attachT0;
            state.windows = activeRuns();
            state.loop = startLoopHistogram();
        }
        runOfDriver.set(driver, state);
        if (state.jobId) runOfJob.set(state.jobId, state);
        const startMs = browserStartMs.get(driver);
        if (startMs !== undefined) state.browserStartMs = startMs;
    });
}

function stateOfData(data) {
    if (!data) return null;
    const key = data._runId ? String(data._runId) : data._jobId ? `job:${data._jobId}` : null;
    return key ? runs.get(key) || null : null;
}

/** A step of the run ended (lib/runHistory.js markRunStep). */
function stepDone(data, stage, status) {
    safe(() => {
        const state = stateOfData(data);
        if (!state || !state.attached || state.ended) return;
        const t = clock();
        emit({
            event: "step",
            ...baseOf(state),
            step: stage,
            status,
            ...split(state.step, t - state.stepT0),
            top: topCommands(state.step),
            sleepTop: topSites(state.step.sleepSites),
            cmdTop: topSites(state.step.cmdSites),
        });
        state.step = newBucket();
        state.stepT0 = t;
    });
}

/** The run ended (lib/runHistory.js runEndUpdate). */
function runEnded(runId, outcome) {
    safe(() => {
        if (!runId) return;
        const key = String(runId);
        const state = runs.get(key);
        if (!state) return;
        const loopFields = stopLoopHistogram(state); // read before forget(), which also switches it off
        forget(key, state);
        if (state.ended) return;
        state.ended = true;
        if (!state.attached) return; // no browser (an API-only part): nothing measured
        const t = clock();
        emit({
            event: "end",
            ...baseOf(state),
            outcome,
            totalMs: round(t - state.t0),
            ...split(state.total, t - state.attachT0),
            windows: state.windows,
            browserStartMs: state.browserStartMs,
            ...loopFields,
            top: topCommands(state.total),
            sleepTop: topSites(state.total.sleepSites),
            cmdTop: topSites(state.total.cmdSites),
        });
    });
}

// ---------------------------------------------------------------- browser commands, waits, sleeps

function record(state, fn) {
    safe(() => {
        fn(state.total);
        fn(state.step);
    });
}

/**
 * Time every command / wait / sleep of a driver that belongs to a run. Installed ONCE on selenium's WebDriver class
 * (server.js), so the per-run wrappers of lib/stallWatch.js and lib/holdStop.js stay exactly as they are and a driver
 * never gets an own property from here. A driver that belongs to no run passes straight through.
 */
function installDriverTiming(WebDriverClass, { WebElementPromise } = {}) {
    const proto = WebDriverClass && WebDriverClass.prototype;
    if (!proto || typeof proto.execute !== "function" || proto.__stepTimingInstalled) return false;
    const originalExecute = proto.execute;
    const originalSleep = proto.sleep;
    const originalWait = proto.wait;

    proto.execute = function timedExecute(command, ...rest) {
        const state = runOfDriver.get(this);
        if (!state || state.ended) return originalExecute.call(this, command, ...rest);
        const t = clock();
        const inWait = state.waitDepth > 0;
        const name = safe(() => (command && typeof command.getName === "function" ? String(command.getName()) : "")) || "command";
        const site = callSite();
        return mirror(originalExecute.call(this, command, ...rest), () => {
            const ms = clock() - t;
            record(state, (bucket) => {
                addCommand(bucket, name, ms, inWait);
                addSite(bucket.cmdSites, site, ms);
            });
        });
    };

    if (typeof originalSleep === "function") {
        proto.sleep = function timedSleep(ms) {
            const state = runOfDriver.get(this);
            if (!state || state.ended) return originalSleep.call(this, ms);
            const t = clock();
            const site = callSite();
            return mirror(originalSleep.call(this, ms), () => {
                const slept = clock() - t;
                record(state, (bucket) => {
                    bucket.sleepMs += slept;
                    bucket.sleeps += 1;
                    addSite(bucket.sleepSites, site, slept);
                });
            });
        };
    }

    if (typeof originalWait === "function") {
        proto.wait = function timedWait(...args) {
            const state = runOfDriver.get(this);
            if (!state || state.ended) return originalWait.apply(this, args);
            const t = clock();
            state.waitDepth += 1;
            let result;
            try {
                result = originalWait.apply(this, args);
            } catch (error) {
                state.waitDepth = Math.max(0, state.waitDepth - 1);
                throw error;
            }
            const mirrored = mirror(result, () => {
                state.waitDepth = Math.max(0, state.waitDepth - 1);
                record(state, (bucket) => {
                    bucket.waitMs += clock() - t;
                    bucket.waits += 1;
                });
            });
            // until.elementLocated & co. give back an element promise (.click() can be chained on it): keep that type.
            if (WebElementPromise && result instanceof WebElementPromise) return new WebElementPromise(this, mirrored);
            return mirrored;
        };
    }

    Object.defineProperty(proto, "__stepTimingInstalled", { value: true });
    return true;
}

/**
 * Time new database connections. Installed ONCE on the MongoClient class (server.js). currentKey() gives the job the
 * code is running for (lib/stallWatch.js keeps it per job), so a run's line can count its own connects.
 */
function installDbConnectTiming(MongoClientClass, { currentKey } = {}) {
    const proto = MongoClientClass && MongoClientClass.prototype;
    if (!proto || typeof proto.connect !== "function" || proto.__stepTimingInstalled) return false;
    const originalConnect = proto.connect;
    proto.connect = function timedConnect(...args) {
        const t = clock();
        const jobKey = safe(() => (currentKey ? currentKey() : null));
        const site = callSite();
        return mirror(originalConnect.apply(this, args), () => {
            const ms = clock() - t;
            const state = jobKey ? runOfJob.get(String(jobKey)) : null;
            if (state && !state.ended) {
                record(state, (bucket) => {
                    bucket.dbMs += ms;
                    bucket.dbConnects += 1;
                });
            }
            if (ms > SLOW_DB_CONNECT_MS) emit({ event: "db-connect", ms: round(ms), site, ...(state ? baseOf(state) : {}) });
        });
    };
    Object.defineProperty(proto, "__stepTimingInstalled", { value: true });
    return true;
}

// ---------------------------------------------------------------- browser start

function argsOf(options) {
    try {
        const caps = options && options.CAPABILITY_KEY ? options.get(options.CAPABILITY_KEY) : null;
        const args = (caps && caps.args) || (options && options.options_ && options.options_.args) || [];
        return Array.isArray(args) ? args.map(String) : [];
    } catch {
        return [];
    }
}

// How a browser was started, as on/off facts only.
function describeArgs(args) {
    const has = (pattern) => args.some((arg) => pattern.test(arg));
    const size = args.filter((arg) => arg.startsWith("--window-size=")).pop();
    return {
        headless: has(/^--headless/) ? "yes" : "no",
        window: size ? size.slice("--window-size=".length).replace(",", "x") : "default",
        gpu: has(/^--disable-gpu$/) ? "off" : "on",
    };
}

/** One line per browser start. startedAt = clock() taken when the launcher began. driverPath = the chromedriver file, or null (Selenium Manager). */
function browserOpened(driver, { flow, startedAt, options, driverPath } = {}) {
    safe(() => {
        const ms = typeof startedAt === "number" ? round(clock() - startedAt) : undefined;
        if (driver && ms !== undefined) browserStartMs.set(driver, ms);
        emit({
            event: "browser-open",
            flow,
            startMs: ms,
            ...describeArgs(argsOf(options)),
            driver: driverPath ? path.basename(String(driverPath)) : "selenium-manager",
        });
    });
}

module.exports = {
    emit,
    clock: () => clock(),
    noteRun,
    attach,
    stepDone,
    runEnded,
    activeRuns,
    installDriverTiming,
    installDbConnectTiming,
    browserOpened,
    // tests only
    _format: format,
    _describeArgs: describeArgs,
    _setClock(fn) {
        clock = fn || (() => performance.now());
    },
    _reset() {
        for (const [key, state] of [...runs.entries()]) forget(key, state);
        runOfJob.clear();
    },
};
