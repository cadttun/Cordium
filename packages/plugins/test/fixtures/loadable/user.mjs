export default {
  manifest: { id: 'demo.user', version: '1.0.0', apiVersion: '1.0.0', dependencies: { 'demo.base': '^1.0.0' } },
  activate(ctx) { globalThis.__cordiumLoaderSeen = ctx.getService('service.demo').greet(); }
};
