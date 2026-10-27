'use strict';
// Comparison report only. This helper never creates bootstrap evidence or approves provenance.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tree } = require('./bootstrap-core.cjs');
const config = require('./bootstrap-config.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fileHash(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('Expected ordinary artifact metadata file');
  return hash(fs.readFileSync(file));
}
function distManifest(root) {
  tree(root); // Apply the same file/symlink/environment safety rules before collecting records.
  const records = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { records.push(['dir', relative]); visit(file); }
      else if (stat.isFile()) records.push(['file', relative, stat.size, fileHash(file)]);
      else throw Error('Artifact changed while collecting manifest');
    }
  }
  visit(root);
  if (hash(JSON.stringify(records)) !== tree(root)) throw Error('Artifact changed while collecting manifest');
  return records;
}
function compareHashes(actual, expected) {
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key,
    !Object.hasOwn(expected, key) || (expected[key] !== null && !/^[0-9a-f]{64}$/.test(expected[key])) ? 'UNVERIFIED' : value === expected[key] ? 'MATCH' : 'MISMATCH']));
}
function compareManifests(production, rebuilt) {
  const left = new Map(production.map(record => [record[1], record]));
  const right = new Map(rebuilt.map(record => [record[1], record]));
  return {
    onlyInProduction: [...left.keys()].filter(file => !right.has(file)).sort(),
    onlyInBuild: [...right.keys()].filter(file => !left.has(file)).sort(),
    changed: [...left.keys()].filter(file => right.has(file) && JSON.stringify(left.get(file)) !== JSON.stringify(right.get(file))).sort(),
  };
}
function report(root, context, expected, productionManifest = null) {
  if (!['backend', 'frontend'].includes(context.app)) throw Error('Unknown application');
  if (!/^[0-9a-f]{40}$/.test(context.sourceSha) || context.sourceSha !== context.expectedSourceSha) throw Error('Pinned source revision mismatch');
  root = fs.realpathSync(root);
  if (root === '/var/www' || root.startsWith('/var/www/')) throw Error('Use an isolated build checkout');
  const dist = path.join(root, 'dist');
  const hashes = {
    distHash: tree(dist),
    modulesHash: context.app === 'backend' ? tree(path.join(root, 'node_modules'), true) : null,
    packageHash: context.app === 'backend' ? fileHash(path.join(root, 'package.json')) : null,
    lockHash: context.app === 'backend' ? fileHash(path.join(root, 'package-lock.json')) : null,
  };
  const manifest = distManifest(dist);
  if (hash(JSON.stringify(manifest)) !== hashes.distHash) throw Error('Artifact changed while collecting report');
  const comparisons = compareHashes(hashes, expected);
  if (productionManifest && (productionManifest.distHash !== expected.distHash || hash(JSON.stringify(productionManifest.records)) !== expected.distHash)) throw Error('Production manifest digest mismatch');
  const distDifferences = productionManifest ? compareManifests(productionManifest.records, manifest) : null;
  const blockers = ['Original build toolchain, flags and configuration are not independently verified'];
  for (const [key, result] of Object.entries(comparisons)) if (result !== 'MATCH') blockers.push(key + ': ' + result);
  return {
    schema: 1, purpose: 'isolated-build-comparison', app: context.app,
    sourceSha: context.sourceSha, reviewed: false, provenanceStatus: 'BLOCKED',
    originalBuildConfiguration: 'UNVERIFIED',
    comparisonStatus: Object.values(comparisons).every(value => value === 'MATCH') ? 'MATCH' : 'MISMATCH',
    toolchain: { platform: context.platform ?? null, arch: context.arch ?? null, kernel: context.kernel ?? null,
      node: context.nodeVersion ?? null, npm: context.npmVersion ?? null },
    commands: ['npm ci --include=dev', 'npm run build'],
    nonsecretBuildConfiguration: context.app === 'frontend' ? { VITE_API_BASE_URL: context.apiBaseUrl ?? null } : {},
    expectedHashes: expected, hashes, comparisons, blockers, distManifest: manifest, distDifferences,
    historicalAssetProvenance: distDifferences?.onlyInProduction.length ? 'REQUIRED_FOR_EACH_PRODUCTION_ONLY_RECORD' : 'NOT_ESTABLISHED',
  };
}
const observed = {
  backend: {
    distHash: '80a19572e5f1def889327768a8e4a005bfd14069f17d6c1403ba40b7efebe4b4',
    modulesHash: '5ce1d6f9af1c4aef1b137841f228316c3ed3af358c45501c8679d42b16aea64f',
    packageHash: '07b0cd20cfdbd0d95c96386b97a4102074e1d1ac046b264fbfc969c1ac164a43',
    lockHash: '821fa821a2f350974d20f88f04d5c94e5f4605c902204aa17c7ad98d0ac35616',
  },
  frontend: { distHash: '161dd82b465231a9b0592acc916cc25ab12a4a0b6150406820728b4ac6d3fa8b', modulesHash: null, packageHash: null, lockHash: null },
};
module.exports = { report, compareHashes, distManifest, compareManifests };
if (require.main === module) {
  try {
    if (process.platform !== 'linux' || process.argv.length !== 3) throw Error('Run in an isolated Linux source checkout');
    const root = fs.realpathSync(process.argv[2]);
    const sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8', cwd: root }).trim();
    if (process.versions.node !== '24.18.1' || npmVersion !== '11.16.0') throw Error('Investigation toolchain mismatch');
    const productionManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/deployment/production-dist-manifest.json'), 'utf8'));
    console.log(JSON.stringify(report(root, {
      app: config.app, sourceSha, expectedSourceSha: config.baselineSha,
      platform: process.platform, arch: process.arch, kernel: os.release(),
      nodeVersion: process.versions.node, npmVersion, apiBaseUrl: process.env.VITE_API_BASE_URL,
    }, observed[config.app], productionManifest), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
