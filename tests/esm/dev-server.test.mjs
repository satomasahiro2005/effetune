import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assembleInitialSite,
  createDspLibraryBuildSpec,
  createJekyllBuildSpec,
  createRequestHandler,
  getMimeType,
  getRequestTarget,
  parseGitHubPagesVersion,
  startJekyllWatcher,
  startDevServer
} from '../../scripts/dev-server.mjs';

test('web-only startup serves the working tree without preparing a documentation build', async t => {
  const server = new EventEmitter();
  let handler;
  server.listen = (port, host, ready) => {
    assert.equal(port, 8080);
    assert.equal(host, '127.0.0.1');
    ready();
  };
  server.close = t.mock.fn();
  t.mock.method(http, 'createServer', requestHandler => {
    handler = requestHandler;
    return server;
  });
  t.mock.method(fs, 'rmSync', () => assert.fail('Web-only startup must not reset the site'));
  const signals = new Map();
  t.mock.method(process, 'once', (signal, callback) => {
    signals.set(signal, callback);
    return process;
  });

  const result = await startDevServer(['--web-only', '--port', '8080', '--host=127.0.0.1']);
  assert.equal(result.jekyllProcess, null);
  assert.equal(result.server, server);
  const headers = new Map();
  let body;
  handler({ method: 'GET', url: '/effetune.html' }, {
    setHeader: (name, value) => headers.set(name, value),
    writeHead: status => assert.equal(status, 200),
    end: value => { body = value; }
  });
  assert.match(body, /window\.EFFECTUNE_DEV_SERVER = true;/);
  assert.match(headers.get('Cache-Control'), /no-store/);

  const requestStatus = url => {
    let status;
    handler({ method: 'HEAD', url }, {
      setHeader() {},
      writeHead: value => { status = value; },
      end() {}
    });
    return status;
  };
  for (const asset of [
    '/css/effetune.css',
    '/features/benchmark-score-reference.js',
    '/images/favicon.ico',
    '/js/app.js',
    '/plugins/plugins.txt',
    '/presets/presets.txt',
    '/sw.js',
    '/css/user-data-backup.css'
  ]) {
    assert.equal(requestStatus(asset), 200, asset);
  }
  assert.equal(requestStatus('/AGENTS.md'), 404);
  assert.equal(requestStatus('/.git/config'), 404);
  assert.equal(requestStatus('/tmp/dev/agent-commit-readiness-operations.md'), 404);
  assert.equal(requestStatus('/scripts/dev-server.mjs'), 404);
  signals.get('SIGINT')();
  signals.get('SIGTERM')();
  assert.equal(server.close.mock.callCount(), 1);
});

test('dev server suppresses module caching within the selected serving root', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'effetune-dev-modules-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'dep.js'), 'export default 1;');
  fs.writeFileSync(path.join(root, 'main.js'), [
    "import value from './dep.js';",
    "export { default } from './dep.js';",
    "import('./dep.js');",
    "import('../outside.js');"
  ].join('\n'));
  let body;
  createRequestHandler(root)({ method: 'GET', url: '/main.js' }, {
    setHeader() {},
    writeHead: status => assert.equal(status, 200),
    end: value => { body = value; }
  });
  assert.equal(body.match(/\.\/dep\.js\?dev=\d+/g)?.length, 3);
  assert.match(body, /import\('\.\.\/outside\.js'\)/);
});

test('dev server serves WebAssembly with its standard MIME type', () => {
  assert.equal(getMimeType('plugins/dsp/effetune-dsp.wasm'), 'application/wasm');
  assert.equal(getMimeType('plugins/dsp/unknown.bin'), 'application/octet-stream');
});

test('dev server builds the preview with the production GitHub Pages environment', () => {
  const spec = createJekyllBuildSpec({ PATH: 'test-path' });
  const sourceIndex = spec.args.indexOf('--source');
  const destinationIndex = spec.args.indexOf('--destination');

  assert.equal(spec.command, 'ruby');
  assert.deepEqual(spec.args.slice(0, 5), [
    '-rgithub-pages',
    '-S',
    'jekyll',
    'build',
    '--watch'
  ]);
  assert.equal(spec.args.includes('--incremental'), true);
  assert.equal(
    spec.args[sourceIndex + 1],
    path.resolve(import.meta.dirname, '../..')
  );
  assert.equal(
    spec.args[destinationIndex + 1],
    path.resolve(import.meta.dirname, '../../_site')
  );
  assert.equal(spec.options.env.JEKYLL_ENV, 'production');
  assert.equal(spec.options.env.PATH, 'test-path');
});

test('dev server builds the DSP browser package used by the Pages workflow', () => {
  const environment = { npm_execpath: 'test-npm-cli.js', PATH: 'test-path' };
  const spec = createDspLibraryBuildSpec(environment);
  const npmArgs = [
    '--prefix',
    path.resolve(import.meta.dirname, '../../dsp/bindings/js'),
    'run',
    'build'
  ];

  assert.equal(spec.command, process.platform === 'win32' ? process.execPath : 'npm');
  assert.deepEqual(
    spec.args,
    process.platform === 'win32'
      ? [environment.npm_execpath, ...npmArgs]
      : npmArgs
  );
  assert.equal(spec.options.cwd, path.resolve(import.meta.dirname, '../..'));
  assert.equal(spec.options.env.PATH, 'test-path');
});

test('Jekyll watcher reports every completed build', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const completions = [];
  const watcher = startJekyllWatcher({
    spawnProcess: () => child,
    onBuildComplete: () => completions.push(completions.length + 1)
  });

  child.stdout.emit('data', 'done in 0.1 seconds.');
  assert.equal(await watcher, child);
  child.stderr.emit('data', 'done in 0.2 seconds.');

  assert.deepEqual(completions, [1, 2]);
});

test('dev assembly refreshes every staged DSP output after Jekyll rebuilds', async t => {
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effetune-dev-assembly-'));
  t.after(() => fs.rmSync(siteRoot, { force: true, recursive: true }));
  const events = [];
  let rebuild;

  await assembleInitialSite({
    siteRoot,
    buildPackage: async () => {
      events.push('package');
    },
    startJekyll: async ({ onBuildComplete }) => {
      assert.deepEqual(events, ['package']);
      events.push('jekyll');
      fs.mkdirSync(path.join(siteRoot, 'dsp'), { recursive: true });
      fs.writeFileSync(path.join(siteRoot, 'dsp', 'index.html'), 'DSP guide');
      onBuildComplete();
      rebuild = () => {
        events.push('jekyll-rebuild');
        fs.rmSync(path.join(siteRoot, 'dsp', 'demo'), { force: true, recursive: true });
        fs.rmSync(path.join(siteRoot, 'dsp', 'schemas'), { force: true, recursive: true });
        fs.rmSync(path.join(siteRoot, 'dsp', 'catalog'), { force: true, recursive: true });
        fs.rmSync(path.join(siteRoot, 'dsp', 'llms.txt'), { force: true });
        fs.rmSync(path.join(siteRoot, 'dsp', 'site-manifest.json'), { force: true });
        fs.writeFileSync(path.join(siteRoot, 'dsp', 'index.html'), 'Updated DSP guide');
        onBuildComplete();
      };
      return { kill() {} };
    },
    stageSite: (guidePath, outputRoot) => {
      assert.equal(guidePath, path.join(siteRoot, 'dsp', 'index.html'));
      assert.equal(outputRoot, path.join(siteRoot, 'dsp'));
      const guide = fs.readFileSync(guidePath, 'utf8');
      events.push(`stage:${guide}`);
      fs.mkdirSync(path.join(outputRoot, 'demo'), { recursive: true });
      fs.mkdirSync(path.join(outputRoot, 'schemas'), { recursive: true });
      fs.mkdirSync(path.join(outputRoot, 'catalog'), { recursive: true });
      fs.writeFileSync(path.join(outputRoot, 'demo', 'index.html'), 'DSP demo');
      fs.writeFileSync(path.join(outputRoot, 'schemas', 'chain-v1.json'), '{}');
      fs.writeFileSync(path.join(outputRoot, 'catalog', 'effects-v1.json'), '[]');
      fs.writeFileSync(path.join(outputRoot, 'llms.txt'), 'DSP index');
      fs.writeFileSync(
        path.join(outputRoot, 'site-manifest.json'),
        JSON.stringify({ guide })
      );
    }
  });

  assert.deepEqual(events, ['package', 'jekyll', 'stage:DSP guide']);
  assert.deepEqual(getRequestTarget('/dsp/', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'index.html')
  });
  assert.deepEqual(getRequestTarget('/dsp/demo/', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'demo', 'index.html')
  });
  assert.deepEqual(getRequestTarget('/dsp/schemas/chain-v1.json', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'schemas', 'chain-v1.json')
  });
  assert.deepEqual(getRequestTarget('/dsp/catalog/effects-v1.json', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'catalog', 'effects-v1.json')
  });
  assert.deepEqual(getRequestTarget('/dsp/llms.txt', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'llms.txt')
  });

  rebuild();

  assert.deepEqual(events, [
    'package',
    'jekyll',
    'stage:DSP guide',
    'jekyll-rebuild',
    'stage:Updated DSP guide'
  ]);
  assert.deepEqual(getRequestTarget('/dsp/demo/', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'demo', 'index.html')
  });
  assert.deepEqual(getRequestTarget('/dsp/schemas/chain-v1.json', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'schemas', 'chain-v1.json')
  });
  assert.deepEqual(getRequestTarget('/dsp/catalog/effects-v1.json', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'catalog', 'effects-v1.json')
  });
  assert.deepEqual(getRequestTarget('/dsp/llms.txt', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'llms.txt')
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(siteRoot, 'dsp', 'site-manifest.json'), 'utf8')),
    { guide: 'Updated DSP guide' }
  );
});

test('dev server requires the GitHub Pages version used by the Pages workflow', () => {
  assert.equal(parseGitHubPagesVersion('github-pages 232'), '232');
  assert.equal(parseGitHubPagesVersion('github-pages 232\nJekyll 3.10.0'), '232');
  assert.equal(parseGitHubPagesVersion('jekyll 3.10.0'), null);
});

test('dev server serves only files generated in the Jekyll destination', t => {
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effetune-dev-site-'));
  t.after(() => fs.rmSync(siteRoot, { force: true, recursive: true }));

  fs.mkdirSync(path.join(siteRoot, 'dsp'));
  fs.writeFileSync(path.join(siteRoot, 'index.html'), 'home');
  fs.writeFileSync(path.join(siteRoot, 'dsp', 'index.html'), 'dsp');

  assert.deepEqual(getRequestTarget('/', siteRoot), {
    filePath: path.join(siteRoot, 'index.html')
  });
  assert.deepEqual(getRequestTarget('/dsp/', siteRoot), {
    filePath: path.join(siteRoot, 'dsp', 'index.html')
  });
  assert.deepEqual(getRequestTarget('/missing/', siteRoot), { status: 404 });
  assert.deepEqual(getRequestTarget('/..%2Foutside.html', siteRoot), { status: 403 });
});

test('dev server contains no duplicate Jekyll layout renderer', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../scripts/dev-server.mjs'),
    'utf8'
  );

  assert.doesNotMatch(source, /render(?:Home|Default|Dsp)Layout/);
  assert.doesNotMatch(source, /renderMarkdownPage/);
});
