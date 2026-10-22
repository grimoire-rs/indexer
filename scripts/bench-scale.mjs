#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// V-19 scale benchmark, a manual and release gate (not part of `task check`):
//   node scripts/bench-scale.mjs --entries 20000 [--work <dir>] [--latency-ms <n>] [--json]
// Inflates the dev index to N entries, then runs the shipped CLI: cold `enrich`,
// `build`, warm `enrich`, `build`, with scripts/lib/fake-grim.mjs as `grim`.
// Pass: calls <= 3/entry cold and 2.5 warm, no file over 16 MiB (P-10), build in 15 min, and
// each leg inside the NFR-1 stage sum (enrich projected at the measured per-call latency).
// Each step also prints its peak RSS; that is reported, not judged.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { inflate } from "./lib/inflate.mjs";
import { NFR1, stageSum } from "./lib/stage-sum.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(repo, "test/fixtures/dev");
const CLI = path.join(repo, "dist/cli/index.js");
const FAKE_GRIM = path.join(repo, "scripts/lib/fake-grim.mjs");
const CLOCK_SHIFT = path.join(repo, "scripts/lib/clock-shift.mjs");
const RSS_REPORT = path.join(repo, "scripts/lib/rss-report.mjs");

const MAX_CALLS = { cold: 3, warm: 2.5 };
const MAX_FILE = 16 * 1024 * 1024;
const IN_FLIGHT = 8;
const WINDOW_MS = 3_600_000; // sync.revalidate, default
const EXIT_USAGE = 64;

const { values } = parseArgs({
  options: {
    entries: { type: "string" },
    work: { type: "string", default: path.join(repo, ".bench") },
    "latency-ms": { type: "string", default: "0" },
    json: { type: "boolean", default: false },
  },
});
const target = Number(values.entries);
const latencyMs = Number(values["latency-ms"]);
if (!Number.isInteger(target) || target < 1 || !Number.isFinite(latencyMs) || latencyMs < 0) {
  console.error("usage: node scripts/bench-scale.mjs --entries <N> [--work <dir>] [--latency-ms <n>] [--json]");
  process.exit(EXIT_USAGE);
}

// Everything lives in <work>/run, the only directory this script ever deletes.
const run = path.join(path.resolve(values.work), "run");
const root = path.join(run, "root");
const site = path.join(run, "site");
const callLog = path.join(run, "calls.log");
const state = path.join(root, ".grim-index-state");

const exec = promisify(execFile);
const log = (line) => console.error(`bench: ${line}`);
const minutes = (ms) => ms / 60_000;
const fixed = (n, digits = 1) => n.toFixed(digits);

// `dist/` is stale once any source file is newer than the compiled CLI.
async function ensureBuilt() {
  const built = fs.existsSync(CLI) ? fs.statSync(CLI).mtimeMs : 0;
  const files = fs.readdirSync(path.join(repo, "src"), { recursive: true, withFileTypes: true });
  const newest = Math.max(...files.filter((e) => e.isFile()).map((e) => fs.statSync(path.join(e.parentPath, e.name)).mtimeMs));
  if (built >= newest) return;
  log("dist/ is stale, running npm run build");
  await exec("npm", ["run", "build"], { cwd: repo, maxBuffer: 1 << 26 });
}

/** Serves the build's output over loopback, so `enrich` finds the previous deploy's root and plane. */
function serveSite() {
  const server = http.createServer((req, res) => {
    const file = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname));
    fs.readFile(file, (err, bytes) => {
      if (err || !file.startsWith(site + path.sep)) return res.writeHead(404).end();
      res.writeHead(200).end(bytes);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** One CLI step, timed, with the CLI process's peak RSS. */
async function step(name, args, env = {}) {
  log(name);
  const rssFile = path.join(run, "rss.txt");
  fs.rmSync(rssFile, { force: true });
  const started = performance.now();
  try {
    // `--import` as an exec argument, not NODE_OPTIONS: the fake `grim` children must not report.
    await exec(process.execPath, ["--import", pathToFileURL(RSS_REPORT).href, CLI, ...args], {
      cwd: root,
      env: { ...process.env, BENCH_RSS_FILE: rssFile, ...env },
      maxBuffer: 1 << 28,
    });
  } catch (err) {
    throw new Error(`${name} failed (exit ${err.code}):\n${String(err.stderr ?? err.message).slice(-2000)}`);
  }
  return { name, ms: performance.now() - started, rssMiB: Number(fs.readFileSync(rssFile, "utf8")) / 1024 };
}

const callsLogged = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").split("\n").length - 1 : 0);
const handoff = () => JSON.parse(fs.readFileSync(path.join(state, "out/handoff.json"), "utf8"));

/** `enrich` once; the counters come from the call log and from the hand-off, to be compared. */
async function enrichRun(name, entries, env) {
  const before = callsLogged();
  const timed = await step(name, ["enrich", root, "--grim", FAKE_GRIM], {
    FAKE_GRIM_LOG: callLog,
    FAKE_GRIM_LATENCY_MS: String(latencyMs),
    ...env,
  });
  const counted = callsLogged() - before;
  const { counters } = handoff();
  return { ...timed, counted, counters, perEntry: counted / entries };
}

/** Files over the cap that are not exempt, and the largest that is not. */
function scan(dir, exempt) {
  const out = { files: 0, over: [], largest: { rel: "", size: 0 } };
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, file).split(path.sep).join("/");
    const size = fs.statSync(file).size;
    out.files++;
    if (exempt(rel)) continue;
    if (size > MAX_FILE) out.over.push(`${rel} (${size} bytes)`);
    if (size > out.largest.size) out.largest = { rel, size };
  }
  return out;
}

// P-10 exempts all.json, stats.json, their .gz siblings and c/f blobs. The store
// holds the first two by digest, and a retained c/f blob is `<digest>.json.gz`;
// the search file is exempt wherever it lands.
const SITE_EXEMPT = /^((all|stats|search[^/]*)\.json(\.gz)?|c\/f\/.*)$/;
function p10() {
  const digest = (name) => createHash("sha256").update(fs.readFileSync(path.join(site, name))).digest("hex");
  const digests = new Set(["all.json", "stats.json"].filter((n) => fs.existsSync(path.join(site, n))).map(digest));
  return {
    state: scan(state, (rel) => digests.has(path.basename(rel).replace(/\.json\.gz$/, ""))),
    site: scan(site, (rel) => SITE_EXEMPT.test(rel)),
  };
}

async function main() {
  await ensureBuilt();
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  fs.cpSync(FIXTURE, root, { recursive: true });
  // The fixture's marketplace export is one grim call whatever N is.
  for (const f of ["marketplace.toml", "marketplace.lock"]) fs.rmSync(path.join(root, f), { force: true });

  log(`inflating to ${target} entries`);
  await inflate(root, target);
  // A cold start has no sidecars: the first `enrich` makes every one.
  fs.rmSync(path.join(root, "enrich"), { recursive: true, force: true });
  const entries = fs.readdirSync(path.join(root, "index"), { recursive: true }).filter((f) => f.endsWith("metadata.json")).length;

  const server = await serveSite();
  const configFile = path.join(root, "index.config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, site: `http://127.0.0.1:${server.address().port}` }));

  const outDir = ["--out-dir", site];
  const steps = [];
  try {
    const cold = await enrichRun("cold enrich", entries, {});
    const buildCold = await step("build", ["build", root, ...outDir]);
    steps.push(cold, buildCold);
    // A fresh checkout has no sidecars; the warm run restores them from the plane.
    fs.rmSync(path.join(root, "enrich"), { recursive: true, force: true });
    const warm = await enrichRun("warm enrich", entries, {
      BENCH_CLOCK_SHIFT_MS: String(WINDOW_MS),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(CLOCK_SHIFT)}`,
    });
    steps.push(warm);
    const buildWarm = await step("build (warm)", ["build", root, ...outDir]);
    steps.push(buildWarm);
    return report(entries, { cold, warm, buildCold, buildWarm }, steps, p10());
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function report(entries, runs, steps, files) {
  const { cold, warm, buildCold, buildWarm } = runs;
  const slowestBuild = Math.max(buildCold.ms, buildWarm.ms);
  const check = (name, ok, detail) => ({ name, ok, detail });
  // The enrich stage at the measured per-call latency, as NFR-1 sums it.
  const projectMin = (r) => minutes((r.counted * Math.max(r.counters.probe_ms_p50, r.counters.deep_ms_p50)) / IN_FLIGHT);
  const leg = (name, enrich, build) => {
    const enrichMin = projectMin(enrich);
    const { sum, ok } = stageSum(enrichMin, minutes(build.ms));
    const parts = `${NFR1.cacheMin} cache + ${fixed(enrichMin)} enrich (slot ${NFR1.enrichMin}) + ${NFR1.stageMin} staging + ${fixed(minutes(build.ms))} build (slot ${NFR1.buildMin})`;
    return { ...check(`${name} enrich and build within the NFR-1 stage sum (${NFR1.totalMin} min)`, ok, `${parts} = ${fixed(sum)} min`), sum, enrichMin };
  };
  const legs = { cold: leg("cold", cold, buildCold), warm: leg("warm", warm, buildWarm) };
  const checks = [
    check(`cold calls <= ${MAX_CALLS.cold}/entry`, cold.perEntry <= MAX_CALLS.cold, `${fixed(cold.perEntry, 2)}/entry (${cold.counted} calls)`),
    check(`warm calls <= ${MAX_CALLS.warm}/entry`, warm.perEntry <= MAX_CALLS.warm, `${fixed(warm.perEntry, 2)}/entry (${warm.counted} calls)`),
    check("call log matches the hand-off", cold.counted === cold.counters.calls && warm.counted === warm.counters.calls, `cold ${cold.counted}/${cold.counters.calls}, warm ${warm.counted}/${warm.counters.calls}`),
    check("enrich finished inside its budget", cold.counters.enrich === "complete" && warm.counters.enrich === "complete", `cold ${cold.counters.enrich}, warm ${warm.counters.enrich}`),
    check("no state file over 16 MiB", files.state.over.length === 0, `${files.state.files} files, largest ${files.state.largest.size} bytes${files.state.over.length ? `; over: ${files.state.over.join(", ")}` : ""}`),
    check("no site file over 16 MiB", files.site.over.length === 0, `${files.site.files} files, largest ${files.site.largest.size} bytes${files.site.over.length ? `; over: ${files.site.over.join(", ")}` : ""}`),
    check(`build within ${NFR1.buildMin} min`, minutes(slowestBuild) <= NFR1.buildMin, `slowest ${fixed(minutes(slowestBuild))} min`),
    ...Object.values(legs).map(({ name, ok, detail }) => ({ name, ok, detail })),
  ];
  return {
    v: 1,
    entries,
    latency_ms: latencyMs,
    steps: steps.map((s) => ({ name: s.name, seconds: Number(fixed(s.ms / 1000, 2)), peak_rss_mib: Math.round(s.rssMiB) })),
    calls: { cold: cold.counted, warm: warm.counted, cold_handoff: cold.counters.calls, warm_handoff: warm.counters.calls },
    projected_enrich_min: { cold: Number(fixed(legs.cold.enrichMin)), warm: Number(fixed(legs.warm.enrichMin)), budget: NFR1.enrichMin },
    stage_sum_min: { cold: Number(fixed(legs.cold.sum)), warm: Number(fixed(legs.warm.sum)), budget: NFR1.totalMin },
    checks,
    ok: checks.every((c) => c.ok),
  };
}

function print(r) {
  const lines = [`V-19 scale benchmark: ${r.entries} entries, fake grim latency ${r.latency_ms} ms`, ""];
  for (const s of r.steps) lines.push(`  ${s.name.padEnd(14)} ${fixed(s.seconds, 1).padStart(9)} s   peak RSS ${String(s.peak_rss_mib).padStart(5)} MiB`);
  lines.push("", ...r.checks.map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`), "");
  lines.push(
    `  NFR-1 stage sum, enrich projected at the measured per-call latency (${IN_FLIGHT} in flight): cold ${r.stage_sum_min.cold} min, warm ${r.stage_sum_min.warm} min, against ${r.stage_sum_min.budget}.`,
    "  A local run has no registry latency, so the projection is only as slow as the fake grim:",
    "  pass --latency-ms <n> to project the latency of a real registry.",
    "",
    r.ok ? "RESULT: PASS" : "RESULT: FAIL",
  );
  return lines.join("\n");
}

try {
  const result = await main();
  // --json keeps stdout to the one machine-readable line; the summary moves to stderr.
  if (values.json) console.error(print(result));
  console.log(values.json ? JSON.stringify(result) : print(result));
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
