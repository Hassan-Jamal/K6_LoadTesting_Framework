# k6 vs JMeter — 1,000 user benchmark

A reproducible head-to-head. Both tools drive an identical local target with a
**known 50 ms response time**, so whatever each one *reports* can be checked
against the truth.

## Result

Measured on Windows 11, 8 logical cores, 15.6 GB RAM.
k6 v2.1.0 · Apache JMeter 5.6.3 · OpenJDK 17.0.18.

| Metric | JMeter 5.6.3 | k6 v2.1.0 | |
| --- | ---: | ---: | --- |
| Peak resident memory | 841.4 MB | 320.5 MB | k6 2.6× less |
| Peak OS threads | 1,037 | 15 | k6 69× fewer |
| CPU seconds consumed | 28.19 | 21.08 | k6 1.34× less |
| Average cores busy | 0.31 | 0.23 | both comfortable |
| Requests completed | 69,027 | 71,343 | equivalent |
| Throughput | 765.3/s | 783.5/s | equivalent |
| Errors | 0% | 0% | both correct |

Reported latency against a target that truly takes **50 ms**:

| | JMeter | k6 |
| --- | ---: | ---: |
| average | 61.7 ms (+11.7) | 56.8 ms (+6.8) |
| p95 | 70 ms | 66.2 ms |
| p99 | 81 ms | 71.5 ms |
| worst case | 206 ms | 107.9 ms |

Both tools were honest — the excess above 50 ms is real elapsed time in the
HTTP client and the OS. k6 is simply the finer instrument, and its tail is much
tighter because it has no garbage collector pausing threads mid-measurement.

## Reproducing it

```bash
# 1. start the target (fixed 50ms latency)
node target.js

# 2. k6 — measure the process while it runs
powershell -File measure.ps1 -ProcessName k6 -Label k6 -OutFile k6.metrics.json &
k6 run --quiet --summary-export k6.summary.json test.k6.js

# 3. JMeter — same profile, same target
powershell -File measure.ps1 -ProcessName java -Label jmeter -OutFile jmeter.metrics.json &
/path/to/apache-jmeter-5.6.3/bin/jmeter -n -t test.jmeter.jmx -l results.jtl
```

Both load profiles are matched: ramp 0 → 1,000 over 30s, hold 60s, one GET plus
1 s think time per iteration.

## Files

| File | What it is |
| --- | --- |
| `target.js` | Node HTTP target with a fixed 50 ms delay — the known truth |
| `test.k6.js` | k6 script: ramping-vus to 1,000 |
| `test.jmeter.jmx` | JMeter plan: 1,000 threads, matched ramp, no listeners |
| `measure.ps1` | Samples RSS / threads / CPU of a process every 500 ms |

Everything needed to repeat the run is here. The raw measurements, dashboard
screenshots and the written-up presentation are kept locally and deliberately
not published — the numbers that matter are in the table above, and anyone can
regenerate the rest by running the harness.

## Read the caveats before quoting this

- **JMeter pre-allocates a 1 GB heap** (`-Xms1g -Xmx1g` default). Part of its
  841 MB is that floor, not per-thread cost.
- **JMeter wrote a 7.4 MB `results.jtl`**; k6 wrote only a summary. That is real
  I/O k6 did not pay for.
- **Generator and target shared one 8-core machine.** Neither was starved, but
  this is not an isolated lab.
- **1,000 users is not where JMeter struggles.** The divergence grows at
  5,000–10,000+, which this does not test and does not claim.
- **One run each.** Repeat runs would tighten the CPU figure especially.

An independently published comparison recorded JMeter at 760 MB against k6 at
256 MB — different hardware, same ratio as ours.

## What this does and doesn't prove

It **does** show that k6 costs less to run and reports slightly tighter numbers,
and that the thread-per-VU architecture is real and visible.

It **does not** show that JMeter is inaccurate or unfit. At 300–500 concurrent
users both tools work correctly, so capacity is not a reason to choose either.
The reasons to prefer k6 are reviewable test code, native CI thresholds, and a
lighter footprint — not this benchmark.
