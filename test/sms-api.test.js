'use strict';
/* 短信验证码服务:限速(120s/日限/尝试上限)、过期、dev 后门、真通道禁用后门;
 * 本地模式(注入 sender:本地生成+哈希校验)与 provider-verify 模式(注入 verifier:
 * dypns 平台生成码+CheckSmsVerifyCode 服务端校验,本地存储退化为发送记录)双覆盖 */
const assert = require('node:assert');
const { createSmsService } = require('../api/sms');

function mkSvc(patch) {
  let t = 1_000_000;
  const sent = [];
  return {
    sent,
    svc: createSmsService(Object.assign({
      now: () => t,
      sender: async (phone, code) => { sent.push([phone, code]); return { ok: true }; },
      devResolver: () => null
    }, patch)),
    tick: (ms) => { t += ms; }
  };
}

(async () => {
  const { svc, tick, sent } = mkSvc();
  const P = '13900000000', IP = '1.1.1.1';

  /* 正常发码→验证 */
  let r = await svc.issue(P, IP);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sent.length, 1);
  const code = sent[0][1];
  assert.match(code, /^\d{6}$/);
  assert.strictEqual((await svc.verify(P, code)).ok, true);

  /* 120s 内重发被拒,带剩余秒 */
  r = await svc.issue(P, IP);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /过于频繁/);
  assert.ok(r.wait > 100 && r.wait <= 120);

  /* 过期:5 分钟后 verify 失败 */
  tick(121_000);
  await svc.issue(P, IP); /* 重发成功 */
  tick(5 * 60_000 + 1_000);
  assert.strictEqual((await svc.verify(P, sent[sent.length - 1][1])).ok, false);

  /* 尝试上限:每码 5 次 */
  tick(121_000);
  await svc.issue(P, IP);
  const c2 = sent[sent.length - 1][1];
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await svc.verify(P, '000000')).ok, false);
  }
  assert.strictEqual((await svc.verify(P, c2)).ok, false); /* 已耗尽,正码也拒 */

  /* 同手机日限 10 条 */
  const { svc: s3, tick: t3 } = mkSvc();
  for (let i = 0; i < 10; i++) { assert.strictEqual((await s3.issue(P, IP)).ok, true); t3(121_000); }
  const r3 = await s3.issue(P, IP);
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /今日/);

  /* 同 IP 日限 20 条(跨手机) */
  const { svc: s4, tick: t4 } = mkSvc();
  for (let i = 0; i < 20; i++) {
    assert.strictEqual((await s4.issue('1390000' + String(1000 + i).padStart(4, '0'), IP)).ok, true);
    t4(121_000);
  }
  const r4 = await s4.issue('13900009999', IP);
  assert.strictEqual(r4.ok, false);
  assert.match(r4.error, /IP/);

  /* 跨日重置:手机日限命中后次日恢复(UTC epoch 天界,北京 8 点切日) */
  const { svc: s7, tick: t7 } = mkSvc();
  for (let i = 0; i < 10; i++) { assert.strictEqual((await s7.issue(P, IP)).ok, true); t7(121_000); }
  assert.match((await s7.issue(P, IP)).error, /今日/); /* 当日已满 */
  t7(24 * 60 * 60 * 1000 + 121_000); /* 跨过 24h 日界 */
  for (let i = 0; i < 10; i++) { assert.strictEqual((await s7.issue(P, IP)).ok, true); t7(121_000); } /* 次日恢复 */
  assert.match((await s7.issue(P, IP)).error, /今日/); /* 新一天同样限 10 条 */

  /* 跨日重置:IP 日限同构 */
  const { svc: s8, tick: t8 } = mkSvc();
  for (let i = 0; i < 20; i++) {
    assert.strictEqual((await s8.issue('1390000' + String(1000 + i).padStart(4, '0'), IP)).ok, true);
    t8(121_000);
  }
  assert.match((await s8.issue('13900009999', IP)).error, /IP/); /* 当日已满 */
  t8(24 * 60 * 60 * 1000 + 121_000);
  const r8 = await s8.issue('13900009999', IP);
  assert.strictEqual(r8.ok, true); /* 次日恢复 */

  /* dev 后门:免 issue 直接验,标记 dev */
  const { svc: s5 } = mkSvc({ devResolver: () => '000000' });
  assert.strictEqual((await s5.verify('13800000000', '000000')).ok, true);
  assert.strictEqual((await s5.verify('13800000000', '111111')).ok, false);
  const r5 = await s5.issue('13800000000', IP);
  assert.strictEqual(r5.ok, true);
  assert.strictEqual(r5.dev, true);

  /* 真发送失败透传 */
  const { svc: s6 } = mkSvc({ sender: async () => ({ ok: false, error: '供应商限流' }) });
  const r6 = await s6.issue('13700000000', '2.2.2.2');
  assert.strictEqual(r6.ok, false);
  assert.match(r6.error, /供应商限流/);

  /* ---- provider-verify 模式(dypns 真通道形态):平台生成码,本地只存发送记录 ---- */
  /* 通过码是平台侧的 '999999',本地 sender 收到的 code 不参与校验 */
  const checks = [];
  const { svc: pv } = mkSvc({
    verifier: async (phone, code) => { checks.push([phone, code]); return String(code) === '999999' ? { ok: true } : { ok: false, error: '验证码错误' }; }
  });
  const PV = '13600000000';
  assert.strictEqual((await pv.issue(PV, IP)).ok, true);
  assert.strictEqual((await pv.verify(PV, '999999')).ok, true); /* 平台码通过,本地码不参与 */
  assert.strictEqual(checks.length, 1);
  assert.strictEqual(checks[0][0], PV);
  assert.strictEqual(checks[0][1], '999999'); /* verifier 收到的是用户提交码,非本地生成码 */

  /* 尝试上限映射:每次 check 失败计一次,5 次后记录作废,正码也拒(须重新获取) */
  const { svc: pv2 } = mkSvc({
    verifier: async () => ({ ok: false, error: '验证码错误' })
  });
  await pv2.issue(PV, IP);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await pv2.verify(PV, '999999')).ok, false);
  }
  assert.match((await pv2.verify(PV, '999999')).error, /请先获取验证码/); /* 记录已删 */

  /* 4 次失败后第 5 次通过仍有效(未越限) */
  const { svc: pv3 } = mkSvc({
    verifier: async (phone, code) => ({ ok: String(code) === '888888', error: '验证码错误' })
  });
  await pv3.issue(PV, IP);
  for (let i = 0; i < 4; i++) {
    assert.strictEqual((await pv3.verify(PV, '000000')).ok, false);
  }
  assert.strictEqual((await pv3.verify(PV, '888888')).ok, true);

  /* 过期语义在 provider 模式同构:平台码 5 分钟有效,过期后本地记录先拦 */
  const { svc: pv4, tick: pvt4 } = mkSvc({
    verifier: async () => ({ ok: true })
  });
  await pv4.issue(PV, IP);
  pvt4(5 * 60 * 1000 + 1_000);
  assert.match((await pv4.verify(PV, '999999')).error, /已过期/);

  /* verifier 异常/错误信息透传(如 AK 缺失),fail-closed */
  const { svc: pv5 } = mkSvc({
    verifier: async () => ({ ok: false, error: '验证码校验失败:mock' })
  });
  await pv5.issue(PV, IP);
  assert.match((await pv5.verify(PV, '123123')).error, /校验失败:mock/);

  /* dev 后门优先级不变:provider 模式下 devResolver 命中仍免 verifier 直验 */
  const { svc: pv6 } = mkSvc({
    devResolver: () => '000000',
    verifier: async () => { throw new Error('verifier 不应被调用'); }
  });
  assert.strictEqual((await pv6.verify('13500000000', '000000')).ok, true);
  const rpv6 = await pv6.issue('13500000000', IP);
  assert.strictEqual(rpv6.dev, true);

  console.log('✓ sms-api: 本地模式 + provider-verify 模式全组行为通过');
})().catch((e) => { console.error(e); process.exit(1); });
