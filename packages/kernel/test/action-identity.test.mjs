/**
 * @file packages/kernel/test/action-identity.test.mjs
 * @description Action 归属判据的门禁 —— 【身份只能由宿主注入，不能由调用方自报】
 *
 * ── 缺陷背景（实测可复现）────────────────────────────────────────────
 * 曾有一个上层应用的 action 处理器这样写审计：
 *
 *     handler: async (payload) => {
 *       ctx.log('info', `Item submitted by plugin '${payload.pluginId}'`);
 *     }
 *
 * 而 `payload.pluginId` 是**调用方自己填**的。实测：一个插件把它填成别人的名字，
 * 审计日志就把该插件的**行为**记到了**别人**头上（日志甚至自相矛盾 ——
 * 前缀是宿主注入的 `[plugin.honest]`，正文却写 `submitted by plugin 'plugin.victim'`）。
 *
 * ★★ 而真身份【一直就在】：`dispatchAction` 调用处理器时传的是
 *    `entry.handler(payload, { callerPluginId, action })` —— 第二个参数由宿主闭包注入。
 *
 * ── 这是同一形状缺陷的【第三处】───────────────────────────────────────
 *   ① `ctx.on` 的 `scopeLabel`（可自报 ⇒ 能旁听别人的事件）
 *   ② `ctx.scope` 的 `ownerId`（可写 ⇒ 能借刀注销别人的服务）
 *   ③ 本条：payload 里的身份字段（可自报 ⇒ 审计可被投毒）
 *   ⇒ **归属判据一旦取自调用方可控的输入，它就只是一句自述，不是事实。**
 *
 * ★ 外部依据（一级来源）：
 *   · **CWE-290 Authentication Bypass by Spoofing** —— *"authentication schemes trust
 *     client-provided information that can be easily spoofed … information that the
 *     client controls and can modify"*。
 *   · **AWS confused deputy 的治法** —— *"The `ExternalId` value must be controlled by
 *     Example Corp, **not its customers**. This is why you get it from Example Corp and
 *     you don't come up with it on your own."* ⇒ **标识必须由信任方签发。**
 *   · **Proofpoint（真实在用的攻击）** —— OAuth 的 `client_id` 被自报并**写进审计日志**，
 *     于是 *"detections … may miss this activity entirely"* —— 与本案同形。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CordiumHost } from '../src/index.mjs';

// ═══════════════════ ① 行为门禁：真身份来自宿主，不来自 payload ═══════════════════

test('★ Action 处理器的第二参数必须带【宿主注入的真身份】', async () => {
  const host = new CordiumHost();
  host.declareServiceContracts({});
  let seen = null;

  host.registerPlugin(
    { id: 'plugin.owner', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        ctx.registerAction('demo.act', {
          handler: async (payload, meta) => {
            seen = { payload, meta };
            return 'ok';
          }
        });
      }
    }
  );
  await host.boot();

  await host.dispatchAction('plugin.owner', 'demo.act', { hello: 1 });
  assert.equal(seen.meta.callerPluginId, 'plugin.owner', 'meta.callerPluginId 必须是宿主认定的调用方');
  assert.equal(seen.meta.action, 'demo.act');
});

test('★★ payload 里伪造的身份字段【不得】能顶替真身份（本缺陷的判别性门禁）', async () => {
  const host = new CordiumHost();
  const lines = [];

  host.registerPlugin(
    { id: 'plugin.honest', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        // ★ 正确的写法：审计归属一律取 meta.callerPluginId
        ctx.registerAction('demo.submit', {
          handler: async (payload, meta) => {
            lines.push(`submitted by plugin '${meta.callerPluginId}'`);
            return { ok: true, payload };
          }
        });
      }
    }
  );
  await host.boot();

  // 调用方是 plugin.honest，却在载荷里自报成 plugin.victim
  await host.dispatchAction('plugin.honest', 'demo.submit', {
    item: { id: 'p-x' },
    pluginId: 'plugin.victim'
  });

  assert.deepEqual(lines, ["submitted by plugin 'plugin.honest'"],
    '★ 审计归属必须是宿主认定的调用方 —— 载荷里的 pluginId 只是普通数据，不是归属依据');
  assert.ok(!lines.join().includes('plugin.victim'),
    '★ 伪造的自报身份绝不能出现在归属里（这就是 CWE-290 的形态）');
});

test('★ 换一个调用方，归属必须跟着换（防止「写死成第一个调用方」也能过）', async () => {
  const host = new CordiumHost();
  const lines = [];

  host.registerPlugin(
    { id: 'plugin.a', version: '1.0.0', apiVersion: '1.0.0' },
    {
      async activate(ctx) {
        ctx.registerAction('demo.act', {
          handler: async (payload, meta) => { lines.push(meta.callerPluginId); return 'ok'; }
        });
      }
    }
  );
  await host.boot();
  host.registerPlugin({ id: 'plugin.b', version: '1.0.0', apiVersion: '1.0.0' }, { async activate() {} });
  await host.activatePlugin('plugin.b');

  await host.dispatchAction('plugin.a', 'demo.act', {});
  await host.dispatchAction('plugin.b', 'demo.act', {});
  assert.deepEqual(lines, ['plugin.a', 'plugin.b'], '归属必须逐调用方如实反映');
});

// 「生产代码里不得从 payload 读取身份字段」是对上层应用全仓调用约定的源码扫描，属上层应用自己的仓库级门禁，
//   不在内核测试里。
