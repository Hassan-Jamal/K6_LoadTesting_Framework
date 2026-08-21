// k6 side of the comparison. Deliberately plain k6 - not the Load Lab
// framework - so this is a like-for-like test against the JMeter plan:
// ramp to 1000 VUs over 30s, hold 60s, one GET plus 1s think time per iteration.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    compare: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 },
        { duration: '60s', target: 1000 },
      ],
      gracefulRampDown: '5s',
      gracefulStop: '10s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: false,
  noConnectionReuse: false,
};

export default function () {
  const res = http.get('http://127.0.0.1:8099/api');
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(1);
}
