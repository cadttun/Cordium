import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCode } from './fixtures/errors.mjs';
import { CordiumHost } from '../src/index.mjs';
import { listenerCount } from './fixtures/inspect.mjs';

function makeHost() {
  const host = new CordiumHost();
  host.declareServiceContracts({
    'service.demo': { access: 'public' },
    'service.other': { access: 'public' }
  });
  return host;
}

function registerProvider(host, id = 'plugin.provider') {
  host.registerPlugin({
    id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.demo']
  }, {
    async activate(ctx) {
      ctx.provideService('service.demo', { read: () => id });
    }
  });
}

test('watchService is a narrow, lifecycle-bound view of service changes', async () => {
  const host = makeHost();
  const changes = [];
  let staleCtx = null;

  host.registerPlugin({
    id: 'plugin.watcher',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      staleCtx = ctx;
      ctx.watchService('service.demo', change => changes.push(change));
      ctx.watchService('service.other', () => {
        throw new Error('service.other must not reach the demo watcher');
      });
    }
  });

  await host.boot();
  registerProvider(host);
  await host.activatePlugin('plugin.provider');

  assert.deepEqual(changes, [{
    name: 'service.demo',
    providerId: 'plugin.provider',
    scopeKey: null,
    action: 'registered',
    epoch: 1
  }]);
  assert.equal(Object.isFrozen(changes[0]), true, 'change metadata must be immutable');

  await host.deactivatePlugin('plugin.provider');
  assert.deepEqual(changes.at(-1), {
    name: 'service.demo',
    providerId: 'plugin.provider',
    scopeKey: null,
    action: 'unregistered',
    epoch: 1
  });

  await host.activatePlugin('plugin.provider');
  assert.equal(changes.at(-1).action, 'registered');
  assert.equal(changes.at(-1).epoch, 2, 're-registration must publish a new provider epoch');

  await host.deactivatePlugin('plugin.watcher');
  assert.throws(
    () => staleCtx.watchService('service.demo', () => {}),
    hasCode('scope_disposed'),
    'a disposed plugin must not create a new service watcher'
  );

  const countAfterWatcherStop = changes.length;
  await host.deactivatePlugin('plugin.provider');
  assert.equal(changes.length, countAfterWatcherStop, 'stopped watchers must be removed automatically');
});

test('watchService rejects undeclared services before creating a subscription', async () => {
  const host = makeHost();
  let ctxRef = null;
  host.registerPlugin({
    id: 'plugin.watcher',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      ctxRef = ctx;
    }
  });
  await host.boot();

  assert.throws(
    () => ctxRef.watchService('service.missing', () => {}),
    hasCode('undeclared_service', /Service 'service\.missing' is not declared by host/)
  );
  assert.equal(listenerCount(host, 'internal/service'), 0);
});

test('watchService follows the host-injected scope without accepting a caller scope label', async () => {
  const host = makeHost();
  const changes = [];
  host.registerPlugin({
    id: 'plugin.watcher',
    version: '1.0.0',
    apiVersion: '1.0.0'
  }, {
    async activate(ctx) {
      ctx.scoped('agent:a').watchService('service.demo', change => changes.push(change));
    }
  });
  await host.boot();

  host.registerPlugin({
    id: 'plugin.scoped-provider',
    version: '1.0.0',
    apiVersion: '1.0.0',
    provides: ['service.demo']
  }, {
    async activate(ctx) {
      ctx.scoped('agent:a').provideService('service.demo', { read: () => 'scoped' });
    }
  });
  await host.activatePlugin('plugin.scoped-provider');

  assert.deepEqual(changes, [{
    name: 'service.demo',
    providerId: 'plugin.scoped-provider',
    scopeKey: 'agent:a',
    action: 'registered',
    epoch: 1
  }]);
});
