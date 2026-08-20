// Copies Chart.js out of node_modules so the UI and the standalone HTML
// reports work with zero network access.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(root, 'public', 'vendor');
const dest = path.join(destDir, 'chart.umd.js');

try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('[vendor] chart.js ->', path.relative(root, dest));
} catch (err) {
  console.warn('[vendor] could not copy chart.js:', err.message);
}
