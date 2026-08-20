'use strict';
/** Canonical load-shape presets, shared by the CLI and the web UI. */

const PRESETS = [
  {
    key: 'smoke',
    name: 'Smoke',
    hint: '1 VU, 30s',
    description: 'Does it work at all? Run this before anything else.',
    // Deliberately constant rather than ramping: a 0->1 ramp over 30s only
    // reaches one user at the very end and sends almost no traffic.
    profile: { executor: 'constant-vus', vus: 1, duration: '30s' },
  },
  {
    key: 'average',
    name: 'Average load',
    hint: '20 VUs, 5 min',
    description: 'Normal expected traffic, held long enough to be meaningful.',
    profile: {
      executor: 'ramping-vus',
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  {
    key: 'stress',
    name: 'Stress',
    hint: 'up to 200 VUs',
    description: 'Push past normal load to find where latency degrades.',
    profile: {
      executor: 'ramping-vus',
      stages: [
        { duration: '2m', target: 50 },
        { duration: '3m', target: 100 },
        { duration: '3m', target: 200 },
        { duration: '2m', target: 0 },
      ],
    },
  },
  {
    key: 'spike',
    name: 'Spike',
    hint: '0 to 300 in 20s',
    description: 'A sudden surge, to check autoscaling and queueing behaviour.',
    profile: {
      executor: 'ramping-vus',
      stages: [
        { duration: '20s', target: 300 },
        { duration: '1m', target: 300 },
        { duration: '20s', target: 0 },
      ],
    },
  },
  {
    key: 'soak',
    name: 'Soak',
    hint: '30 VUs, 1 hour',
    description: 'Sustained load that exposes memory leaks and connection exhaustion.',
    profile: {
      executor: 'ramping-vus',
      stages: [
        { duration: '3m', target: 30 },
        { duration: '54m', target: 30 },
        { duration: '3m', target: 0 },
      ],
    },
  },
  {
    key: 'breakpoint',
    name: 'Breakpoint',
    hint: 'ramp req/s until it breaks',
    description: 'Ramps throughput rather than users, to find maximum capacity.',
    profile: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '2m', target: 300 },
        { duration: '2m', target: 600 },
        { duration: '2m', target: 1000 },
      ],
    },
  },
];

function getPreset(key) {
  return PRESETS.find((p) => p.key === String(key || '').toLowerCase()) || null;
}

module.exports = { PRESETS, getPreset };
