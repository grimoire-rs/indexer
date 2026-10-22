// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The interaction trace needs a Chrome only to produce a measurement. Judging
 * one (`evaluateBudgets`), reading the command line and the exit code all run
 * here without a browser, including the planted-breach control: a `--budget`
 * run over a measurement that exceeds it must exit 1, or the gate in
 * `task quality:web` could never go red.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error -- a plain .mjs script, no declaration file
import { describeBreach, evaluateBudgets, loadBudgets, main, parseCli, serve } from "../../scripts/quality-interaction.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "quality-interaction.mjs");
const SHIPPED_BUDGETS = path.join(ROOT, "scripts", "lib", "interaction-budgets.json");

const step = (over: Record<string, number | boolean> = {}) => ({
  longTaskCount: 1,
  longTaskTotalMs: 80,
  longTaskMaxMs: 80,
  domNodes: 2000,
  ...over,
});
const measurement = (scroll = step()) => ({ v: 1, throttle: 4, steps: { load: step(), scroll, sort: step(), search: step() } });

let work: string;
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "quality-interaction-"));
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const write = (name: string, value: unknown) => {
  const file = path.join(work, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

describe("evaluateBudgets", () => {
  it("returns nothing for a measurement inside every budget, and at the limit itself", () => {
    expect(evaluateBudgets(measurement(), { scroll: { longTaskMaxMs: 80, domNodes: 2000 }, sort: { longTaskCount: 1 } })).toEqual([]);
  });

  it("names each breach with its step, metric, value and limit, in budget order", () => {
    const breaches = evaluateBudgets(measurement(step({ longTaskMaxMs: 300, domNodes: 9000 })), {
      scroll: { longTaskMaxMs: 150, domNodes: 4000, longTaskCount: 5 },
      search: { domNodes: 1000 },
    });
    expect(breaches).toEqual([
      { step: "scroll", metric: "longTaskMaxMs", actual: 300, limit: 150 },
      { step: "scroll", metric: "domNodes", actual: 9000, limit: 4000 },
      { step: "search", metric: "domNodes", actual: 2000, limit: 1000 },
    ]);
  });

  it("treats a budgeted step or metric the measurement lacks as a breach, never a pass", () => {
    const breaches = evaluateBudgets({ v: 1, steps: { scroll: { domNodes: 5 } } }, { scroll: { longTaskCount: 3 }, sort: { domNodes: 9 } });
    expect(breaches).toEqual([
      { step: "scroll", metric: "longTaskCount", actual: null, limit: 3 },
      { step: "sort", metric: "domNodes", actual: null, limit: 9 },
    ]);
    expect(evaluateBudgets({}, { scroll: { domNodes: 1 } })).toHaveLength(1);
  });

  it("judges nothing when there is no budget", () => {
    expect(evaluateBudgets(measurement(), {})).toEqual([]);
  });

  it("breaches a scroll that stopped short of the end, with no budget needed, and not one that finished", () => {
    const stopped = measurement(step({ rendered: 4176, shown: 20_009, reachedEnd: false }));
    const breaches = evaluateBudgets(stopped, {});
    expect(breaches).toEqual([{ step: "scroll", metric: "reachedEnd", actual: 4176, limit: 20_009 }]);
    expect(describeBreach(breaches[0])).toBe("scroll: stopped at 4176 of 20009 results, before the end of the list");
    expect(evaluateBudgets(measurement(step({ rendered: 225, shown: 225, reachedEnd: true })), {})).toEqual([]);
  });
});

describe("shipped budgets", () => {
  it("parse as a budget, hold for a typical run and trip when the scroll grows the page tenfold", async () => {
    const budgets = await loadBudgets(SHIPPED_BUDGETS);
    expect(Object.keys(budgets).sort()).toEqual(["scroll", "search", "sort"]);
    expect(evaluateBudgets(measurement(step({ domNodes: 8349, longTaskCount: 8 })), budgets)).toEqual([]);
    expect(evaluateBudgets(measurement(step({ domNodes: 83_490 })), budgets).map((b: { step: string; metric: string }) => `${b.step}.${b.metric}`)).toContain(
      "scroll.domNodes",
    );
  });
});

describe("parseCli", () => {
  it("accepts a site with --report or --budget, and a saved measurement with --budget", () => {
    expect(parseCli(["--site", "s", "--report"])).toMatchObject({ site: "s", report: true });
    expect(parseCli(["--site", "s", "--budget", "{}"])).toMatchObject({ site: "s", budget: "{}" });
    expect(parseCli(["--from", "m.json", "--budget", "{}"])).toMatchObject({ from: "m.json" });
  });

  it.each([
    ["no mode", ["--site", "s"]],
    ["both modes", ["--site", "s", "--report", "--budget", "{}"]],
    ["no source", ["--report"]],
    ["both sources", ["--site", "s", "--from", "m.json", "--report"]],
    ["an unknown flag", ["--site", "s", "--report", "--nope"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseCli(argv)).toThrow();
  });
});

describe("loadBudgets", () => {
  it("ignores a \"//\" note key, which the shipped file uses for its table", async () => {
    expect(await loadBudgets(JSON.stringify({ "//": ["note"], sort: { domNodes: 10 } }))).toEqual({ sort: { domNodes: 10 } });
  });

  it("reads inline JSON and a file alike", async () => {
    const inline = { sort: { domNodes: 10 } };
    expect(await loadBudgets(JSON.stringify(inline))).toEqual(inline);
    expect(await loadBudgets(write("budget.json", inline))).toEqual(inline);
  });

  it.each([
    ["not JSON", "{nope"],
    ["an unknown step", '{"checkout":{"domNodes":1}}'],
    ["an unknown metric", '{"scroll":{"fps":1}}'],
    ["a non-numeric limit", '{"scroll":{"domNodes":"1"}}'],
    ["a missing file", path.join("no", "such", "budget.json")],
  ])("rejects %s", async (_name, spec) => {
    await expect(loadBudgets(spec)).rejects.toThrow();
  });
});

describe("main, with the browser replaced", () => {
  const run = async (argv: string[], measured = measurement()) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { measure: async () => measured, out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("--report prints the measurement and exits 0 whatever it holds", async () => {
    const { code, out, err } = await run(["--site", "s", "--report"], measurement(step({ domNodes: 10_000_000 })));
    expect(code).toBe(0);
    expect(JSON.parse(out).steps.scroll.domNodes).toBe(10_000_000);
    expect(err).toBe("");
  });

  it("--budget exits 1 and prints each breach when a step is over", async () => {
    const { code, err } = await run(["--site", "s", "--budget", '{"scroll":{"domNodes":1000,"longTaskMaxMs":10}}']);
    expect(code).toBe(1);
    expect(err).toContain("scroll.domNodes: 2000 exceeds the budget of 1000");
    expect(err).toContain("scroll.longTaskMaxMs: 80 exceeds the budget of 10");
  });

  it("--budget exits 0 when every step holds", async () => {
    expect((await run(["--site", "s", "--budget", '{"scroll":{"domNodes":5000}}'])).code).toBe(0);
  });

  it("--report warns on a scroll that stopped short but still exits 0; --budget fails on it", async () => {
    const stopped = measurement(step({ rendered: 4176, shown: 20_009, reachedEnd: false }));
    const report = await run(["--site", "s", "--report"], stopped);
    expect(report.code).toBe(0);
    expect(report.err).toContain("scroll: stopped at 4176 of 20009 results");
    const budget = await run(["--site", "s", "--budget", '{"scroll":{"domNodes":99999}}'], stopped);
    expect(budget.code).toBe(1);
    expect(budget.err).toContain("scroll: stopped at 4176 of 20009 results");
  });

  it("exits 64 on a usage error and 1 when the run itself fails", async () => {
    expect((await run(["--site", "s"])).code).toBe(64);
    const failing = await main(["--site", "s", "--report"], {
      measure: async () => {
        throw new Error("no chrome");
      },
      out: () => {},
      err: () => {},
    });
    expect(failing).toBe(1);
  });
});

describe("serve", () => {
  let server: import("node:http").Server;
  let base: string;
  beforeAll(async () => {
    const site = path.join(work, "site");
    fs.mkdirSync(path.join(site, "c", "f"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<p>home</p>");
    fs.writeFileSync(path.join(site, "c", "f", "abc.json.gz"), Buffer.from([0x1f, 0x8b, 8, 0]));
    server = await serve(site);
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("serves a directory as its index.html and a .json.gz as gzip bytes with no content encoding", async () => {
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const blob = await fetch(`${base}/c/f/abc.json.gz`);
    expect(blob.headers.get("content-type")).toBe("application/gzip");
    expect(blob.headers.get("content-encoding")).toBeNull();
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0x1f, 0x8b, 8, 0]);
  });

  it("answers a malformed percent escape with 400 and keeps serving", async () => {
    expect((await fetch(`${base}/%`)).status).toBe(400);
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  // An encoded slash survives URL parsing and decodes to `/../`; `fetch` would also tidy a plain `..` away.
  const rawStatus = (target: string) =>
    new Promise<number>((done, fail) => {
      http.get(base, { path: target }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).on("error", fail);
    });

  it("answers a missing file, and a path that climbs out of the site, with 404", async () => {
    expect((await fetch(`${base}/nope.html`)).status).toBe(404);
    // A file that exists one level above the site, so only the guard can refuse it.
    fs.writeFileSync(path.join(work, "secret.txt"), "secret");
    expect(await rawStatus("/..%2fsecret.txt")).toBe(404);
  });
});

// The planted-breach control, through the real process and its real exit code.
describe("scripts/quality-interaction.mjs as a process", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });

  it("exits 1 on a planted breach and 0 on its twin, over the same saved measurement", () => {
    const saved = write("saved.json", measurement(step({ domNodes: 9000 })));
    const planted = cli("--from", saved, "--budget", '{"scroll":{"domNodes":4000}}');
    expect(planted.status, planted.stderr).toBe(1);
    expect(planted.stderr).toContain("scroll.domNodes: 9000 exceeds the budget of 4000");

    const twin = cli("--from", saved, "--budget", '{"scroll":{"domNodes":20000}}');
    expect(twin.status, twin.stderr).toBe(0);
  });

  it("exits 64 without a mode and for an unreadable saved measurement", () => {
    expect(cli("--from", "whatever.json").status).toBe(64);
    expect(cli("--from", path.join(work, "missing.json"), "--budget", "{}").status).toBe(64);
  });
});
