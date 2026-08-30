'use strict';
/* 短信验证码服务:限速(120s/日限/尝试上限)、过期、dev 后门、真通道禁用后门 */
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

  console.log('✓ sms-api: 7 组行为通过');
})().catch((e) => { console.error(e); process.exit(1); });
