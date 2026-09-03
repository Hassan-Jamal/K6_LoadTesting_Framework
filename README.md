# k6 Load Lab

Run any **Postman collection** as a **k6 load test** — from the terminal or from
a local web console. k6 does the load generation; the interface is plain HTML/JS
you can change however you like.

- **Terminal** — drop `postman_collection.json` in a folder, run one command, get an HTML report
- **Web console** — a local UI in your browser: import, shape the ramp, watch it live
- **CI-ready** — exits non-zero when a threshold breaks
- **Nothing hosted** — everything runs on your machine, no account, no telemetry

```
  00:42/05:00   VUs   20   rps   118   p95   241ms   err   0.0%   4,910 reqs
```

---
## Setup

Three short commands. You need **Node.js 18+** (`node -v`; get it from <https://nodejs.org>).

```bash
npm install -g k6-load-lab   # 1. install
k6lab setup                  # 2. fetch the k6 binary
k6lab ui                     # 3. open the console at http://localhost:4300
```

`k6lab setup` looks for an existing k6 first. If there isn't one it downloads
the official binary from grafana/k6 into `~/.k6lab/bin` — your machine is not
touched anywhere else, and nothing is installed system-wide.

Prefer not to install globally? `npx k6-load-lab setup` then `npx k6-load-lab ui`
works the same way.

<details>
<summary>Installing k6 yourself instead</summary>

`k6lab setup` is optional — any k6 on your `PATH` is used as-is.

| Platform | Command |
| --- | --- |
| Windows | `winget install k6 --source winget` |
| Windows (Chocolatey) | `choco install k6` |
| Windows (Scoop) | `scoop install k6` |
| macOS | `brew install k6` |
| Debian / Ubuntu | see <https://grafana.com/docs/k6/latest/set-up/install-k6/> |
| Any | download from <https://github.com/grafana/k6/releases>, unzip, put it on your `PATH` |

Anything from **v0.50** upward works; this is built and tested against **v2.x**.
Got k6 somewhere off the `PATH`? Point at it: `K6_PATH="C:\tools\k6.exe" k6lab ui`

</details>

<details>
<summary>Running from a clone instead of npm</summary>

```bash
git clone https://github.com/Hassan-Jamal/K6_LoadTesting_Framework.git
cd K6_LoadTesting_Framework
npm install
npm link          # makes `k6lab` available in any folder
```

`npm link` needs no admin rights on Windows or macOS. If you would rather not
link it, call it by path:
`node /path/to/K6_LoadTesting_Framework/bin/k6lab.js run`

</details>

### Check the setup

```bash
k6lab doctor
```

```
Environment
────────────────────────────────────────────────────────────
  ✓  node                  v20.11.0
  ✓  k6                    k6 v2.2.0
  ✓  web console assets    chart.js 4.5.1

  Ready to run.
```

`doctor` is the first thing to run whenever something misbehaves — it checks
Node, k6, the UI assets, and whether the current folder has a usable collection.

### Try it

```bash
k6lab run examples/sample_postman_collection.json --base-url https://test.k6.io --safe --preset smoke --yes
```

Runs a smoke test against the public k6 test site and writes a report. If that
works, the install is good. From a clone, `npm run demo` does the same thing.

---

## Using it

### Terminal

Put your `postman_collection.json` in any folder and run:

```bash
cd C:\projects\my-api

k6lab run --base-url https://api.mycompany.com --token eyJhbGc... --safe --open
```

```
k6 Load Lab
────────────────────────────────────────────────────────────
  collection   postman_collection.json  (14 endpoints)
  k6           k6 v2.1.0
  shape        ramping-vus  1m→20 VUs, 3m→20 VUs, 1m→0 VUs
  selected     9 of 14 requests

Running
────────────────────────────────────────────────────────────
  00:42/05:00   VUs   20   rps   118   p95   241ms   err   0.0%   4,910 reqs

Result
────────────────────────────────────────────────────────────
  PASSED   my-api · ran 05:00
  ...threshold table, per-endpoint breakdown, failures, report path
```

The report lands in `./k6lab-runs/<run-id>/report.html`, right next to the
collection. `--open` opens it in your browser.

### Web console

```bash
k6lab ui
```

Opens **http://localhost:4300**. Four tabs:

1. **Requests** — drop a collection in, or add a single endpoint by hand. Set the
   expected status, weight and per-endpoint SLA. Fill in `{{variables}}`.
2. **Load profile** — pick a preset or build stages by hand; the ramp preview
   redraws as you type. Set the thresholds that decide pass/fail.
3. **Live** — VUs and requests/sec on a dual axis, latency percentiles, error
   rate, status mix, per-endpoint table, failures, k6's log. Stop gracefully.
4. **Reports** — every past run, with its report, k6's own dashboard, and the
   exact script that ran.

The UI reads and writes the same `./k6lab-runs/` folder as the CLI, so runs
started either way appear in both.

---

## Commands

| Command | What it does |
| --- | --- |
| `k6lab run [collection.json]` | run a load test and write a report |
| `k6lab ui [--port 4300]` | open the web console |
| `k6lab init` | write a `k6lab.config.json` template here |
| `k6lab doctor` | check this machine and folder are ready |
| `k6lab list` | list previous runs in this folder |
| `k6lab report [run-id]` | open a run's HTML report (newest by default) |
| `k6lab presets` | show the built-in load shapes |
| `k6lab help` | full flag reference |

With no collection named, it looks for `postman_collection.json`,
`collection.json`, or a single `*postman*.json` in the current folder.

### Key flags

```
TARGET      --base-url <url>   --token <jwt>   --var name=value   --environment <file>
SHAPE       --preset smoke|average|stress|spike|soak|breakpoint
            --stages 30s:20,3m:20,1m:0        --vus <n>   --duration <5m>
            --executor <name>  --rate <n>     --rps <n>   --think 0.5-1.5
FILTER      --safe             --only-methods GET,POST    --include <regex>   --exclude <regex>
PASS/FAIL   --p95 <ms>         --p99 <ms>     --error-rate <pct>   --check-rate <pct>
OUTPUT      --open             --quiet        --dry-run   --print-script   --yes
```

---

## Config file

So you are not retyping flags. `k6lab init`, edit, then `k6lab run` alone is
enough. Flags always win over the file.

```json
{
  "collection": "postman_collection.json",
  "name": "My API - average load",
  "baseUrl": "https://api.mycompany.com",
  "variables": {
    "token": "eyJhbGciOi...",
    "id": "an-existing-record-id"
  },
  "preset": "average",
  "safe": true,
  "flow": "sequence",
  "think": [0.5, 1.5],
  "thresholds": { "p95": 800, "errorRate": 1, "checkRate": 99 }
}
```

**Do not commit real tokens.** Keep them out of the config and pass
`--token "$API_TOKEN"` from an environment variable instead.

---

## What it does with a collection

**Auth** — collection-, folder- and request-level auth is inherited correctly.
Bearer, Basic, API key and OAuth2 access tokens are all translated. Set the token
once with `--token`.

**Path placeholders** — Postman writes these as `:id` with values in
`url.variable`. A filled-in value is used as-is; an **empty one becomes `{{id}}`**,
so `GET /orders/:id` turns into `GET {{baseUrl}}/orders/{{id}}` and you supply it
once with `--var id=abc123`. Forget, and the run is refused rather than silently
load-testing your 404 handler.

**Pre-flight checks** — before k6 starts, it refuses to run when a variable is
empty or still holds a template value like `PASTE_YOUR_BEARER_TOKEN_HERE`.

**Write and delete endpoints** — a load test calls every selected endpoint
thousands of times. `DELETE /orders/{id}` in a collection is a real hazard, so
those are listed and confirmed before starting. `--safe` keeps only
GET/HEAD/OPTIONS; `--exclude '<regex>'` drops specific ones. The **Safe mode**
button does the same in the UI.

**Token capture** — a Postman test script like
`pm.environment.set("token", pm.response.json().access)` is carried into the k6
script: the value is extracted at runtime and reused by later requests in the
same iteration, so login-then-use-the-token journeys work under load.

**Bodies and folders** — raw/JSON, urlencoded, form-data and GraphQL bodies are
translated; nested folders are kept as labels. Schema v2.0 and v2.1, with or
without a UTF-8 BOM.

---

## What each run leaves behind

```
k6lab-runs/2026-08-20T07-02-35-323Z-ihju/
├── report.html          self-contained report: charts, SLAs, endpoints, errors
├── k6-dashboard.html    k6's own native dashboard export
├── script.js            the generated k6 script - re-run with `k6 run script.js`
├── result.json          full time series + breakdown, for your own tooling
├── summary.json         k6's end-of-test summary (exact percentiles)
└── meta.json            the requests and profile that produced this run
```

`report.html` has Chart.js inlined, so it opens offline and emails as one file.
Every run is reproducible without this tool: `k6 run script.js`.

---

## Load shapes

| Preset | Shape | Use it for |
| --- | --- | --- |
| `smoke` | 1 VU, 30s | does it work at all — run this first |
| `average` | 20 VUs, 5 min | normal expected traffic |
| `stress` | up to 200 VUs | find where latency starts degrading |
| `spike` | 0→300 in 20s | sudden surge, autoscaling behaviour |
| `soak` | 30 VUs, 1 hour | memory leaks, connection exhaustion |
| `breakpoint` | ramps req/s to 1000 | maximum capacity |

Or define it yourself: `--stages 2m:50,5m:200,2m:0`.

Executors: `ramping-vus`, `constant-vus`, `ramping-arrival-rate` /
`constant-arrival-rate` (ramp *throughput* regardless of how slow the system
gets — the right choice for capacity work), `shared-iterations`,
`per-vu-iterations`.

---

## Recipes

```bash
# 1. Is it wired up correctly? Read-only, one user, 30 seconds.
k6lab run --preset smoke --safe --base-url https://api.acme.com --token eyJ...

# 2. Normal load, strict SLA, open the report at the end
k6lab run --preset average --safe --p95 500 --error-rate 0.5 --open

# 3. Only the chat endpoints, nothing destructive
k6lab run --include chat --exclude 'DELETE|reject' --preset stress

# 4. Find the throughput ceiling
k6lab run --preset breakpoint --safe

# 5. Hold 200 requests/second for 10 minutes regardless of latency
k6lab run --executor constant-arrival-rate --rate 200 --duration 10m --max-vus 400

# 6. In CI - no prompts, quiet, non-zero exit if an SLA breaks
k6lab run --preset average --safe --yes --quiet --p95 800

# 7. See the k6 script without running anything
k6lab run --print-script > loadtest.js
```

A ready-to-copy GitHub Actions job is in
[`.github/workflows/loadtest.yml`](.github/workflows/loadtest.yml).

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `K6_PATH` | `k6` | path to the k6 binary |
| `K6LAB_DATA` | `./k6lab-runs` | where runs are written |
| `PORT` | `4300` | web console port |
| `K6_DASHBOARD_PORT` | `5665` | k6's own live dashboard |
| `K6_API_PORT` | `6565` | k6's REST control port |
| `K6LAB_OPEN` | `1` | `0` stops the browser opening |
| `NO_COLOR` | – | disable terminal colour |

---

## How it works

```
  terminal ──┐
             ├──▶ spec.js ──▶ generator.js ──▶ script.js ──▶ k6 (child process)
  web UI ────┘   collection      k6 script                        │
                 + config                                          │ JSON metrics on stdout
                                                                   ▼
                                                            runner.js folds them
                                                            into 1s buckets
                                                                   │
                                              ┌────────────────────┴────────────────┐
                                              ▼                                      ▼
                                    WebSocket → live charts              report.html + result.json
```

The generated k6 script is a normal, readable k6 file. Nothing about a run
depends on this tool once it exists.

```
bin/k6lab.js        the CLI
server/
  postman.js        Postman collection -> normalised requests
  spec.js           collection + config -> runnable spec, plus pre-flight checks
  generator.js      spec -> k6 script
  runner.js         spawns k6, folds its metric stream into per-second ticks
  report.js         run -> self-contained HTML report
  presets.js        load shapes shared by the CLI and the UI
  store.js          the run catalogue on disk
  index.js          HTTP API + WebSocket feed for the web console
public/             the web console (vanilla JS, Chart.js served from node_modules)
examples/           a sample collection and config to try against
```

### Customising the UI

`public/` is plain HTML, CSS and one JS file — no build step, no framework.
Edit `public/styles.css` for the look, `public/index.html` for layout,
`public/app.js` for behaviour, then refresh the browser. `server/report.js`
holds the standalone report template.

---

## Things worth knowing

- **One test at a time.** Concurrent runs would distort each other's numbers, so
  a second run is rejected while one is active.
- **Ctrl+C stops gracefully** — k6 is asked to end the test so the summary and
  reports are still written. A second Ctrl+C kills it outright.
- **No live pause or VU scaling.** k6 v2 removed the `externally-controlled`
  executor and rejects live VU changes, so the ramp is whatever your stages say.
- **form-data file uploads are skipped** — k6 needs a real local fixture file,
  so those fields are dropped rather than sent empty.
- **Live percentiles are sampled** (a 5,000-value reservoir per endpoint) to keep
  memory flat on long runs. The final report numbers come from k6's own summary
  export and are exact.
- **Run it from the machine that should generate the load.** Everything binds to
  localhost, and one machine's CPU is usually the first bottleneck at high RPS.
- **Only load-test systems you are allowed to load-test.** Sustained traffic
  against someone else's API is indistinguishable from an attack.

---

## Licence

MIT — see [LICENSE](LICENSE).
