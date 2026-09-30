export const manifest = { id: 'demo.base', version: '1.0.0', apiVersion: '1.0.0', provides: ['service.demo'] };
export function activate(ctx, config) {
  ctx.provideService('service.demo', { greet: () => `${config.greeting ?? 'hi'} from base`, configFrozen: () => Object.isFrozen(config) });
}
