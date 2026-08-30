'use strict';

const crypto = require('node:crypto');

/* 短信验证码服务(内存,单实例——多实例前需外置,记入设计文档遗留):
 *   issue(phone, ip)  限速前置检查 → 生成 6 位码 → sender 发送
 *   verify(phone, code) dev 后门直验 / 存储码哈希比对(限尝试)
 * 参数:120s 重发间隔、5 分钟有效、同手机日 10 条、同 IP 日 20 条、每码验 5 次。
 * dev 后门 AUTH_DEV_SMS_CODE(单码或 phone:code 列表)仅在真通道 env
 * (SMS_SIGN_NAME+SMS_TEMPLATE_CODE)不齐全时启用——生产配置齐即自动关死。 */

const DEFAULTS = {
  resendMs: 120 * 1000,
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
  phoneDaily: 10,
  ipDaily: 20,
  dayMs: 24 * 60 * 60 * 1000
};

function envDevCode(phone) {
  if (process.env.SMS_SIGN_NAME && process.env.SMS_TEMPLATE_CODE) return null;
  const raw = String(process.env.AUTH_DEV_SMS_CODE || '').split(',').map((s) => s.trim()).filter(Boolean);
  let any = null;
  for (const item of raw) {
    const [p, c] = item.includes(':') ? item.split(':') : [null, item];
    if (c && phone === p) return c;
    if (c && !p) any = c;
  }
  return any;
}

/* 阿里云真发送器:lazy require,未装 SDK/未配 env 不阻断进程启动 */
async function realSender(phone, code) {
  if (!process.env.SMS_SIGN_NAME || !process.env.SMS_TEMPLATE_CODE) {
    return { ok: false, error: '短信通道未配置(SMS_SIGN_NAME / SMS_TEMPLATE_CODE)' };
  }
  try {
    const Dysmsapi = require('@alicloud/dysmsapi20170525');
    const OpenApi = require('@alicloud/openapi-client');
    const config = new OpenApi.Config({
      accessKeyId: process.env.SMS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET
    });
    config.endpoint = 'dysmsapi.aliyuncs.com';
    const client = new Dysmsapi.default(config);
    await client.sendSms(new Dysmsapi.SendSmsRequest({
      phoneNumbers: phone,
      signName: process.env.SMS_SIGN_NAME,
      templateCode: process.env.SMS_TEMPLATE_CODE,
      templateParam: JSON.stringify({ code: String(code) })
    }));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: '短信发送失败:' + (error.message || error.code || error) };
  }
}

function createSmsService(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const sender = typeof o.sender === 'function' ? o.sender : realSender;
  const devResolver = typeof o.devResolver === 'function' ? o.devResolver : envDevCode;
  const secret = crypto.randomBytes(32); /* 进程内盐:码哈希不可逆推 */

  const store = new Map();     /* phone -> {hash, exp, attempts} */
  const lastSent = new Map();  /* phone -> ts */
  const daily = new Map();     /* 'p:phone'/'i:ip' -> {day, count} */

  function dayKey(prefix, key) {
    const t = now();
    const day = Math.floor(t / o.dayMs);
    const k = prefix + ':' + key;
    const rec = daily.get(k);
    if (!rec || rec.day !== day) { daily.set(k, { day, count: 1 }); return 1; }
    rec.count += 1;
    return rec.count;
  }

  function hash(phone, code) {
    return crypto.createHmac('sha256', secret).update(phone + '|' + code).digest();
  }

  async function issue(phone, ip) {
    const prev = lastSent.get(phone);
    if (prev && now() - prev < o.resendMs) {
      return { ok: false, error: '发送过于频繁,请 ' + Math.ceil((o.resendMs - (now() - prev)) / 1000) + ' 秒后再试', wait: Math.ceil((o.resendMs - (now() - prev)) / 1000) };
    }
    /* 日限检查要在计数前判越界(第 11 条拒) */
    const pk = 'p:' + phone;
    const prevDay = daily.get(pk);
    if (prevDay && prevDay.count >= o.phoneDaily) return { ok: false, error: '该手机号今日发送次数已达上限' };
    const ik = 'i:' + ip;
    const prevIp = daily.get(ik);
    if (prevIp && prevIp.count >= o.ipDaily) return { ok: false, error: '该 IP 今日发送次数已达上限' };

    if (devResolver(phone)) {
      dayKey('p', phone); dayKey('i', ip); lastSent.set(phone, now());
      return { ok: true, dev: true };
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const sent = await sender(phone, code);
    if (!sent.ok) return { ok: false, error: sent.error || '短信发送失败' };
    dayKey('p', phone); dayKey('i', ip);
    lastSent.set(phone, now());
    store.set(phone, { hash: hash(phone, code), exp: now() + o.ttlMs, attempts: 0 });
    return { ok: true };
  }

  function verify(phone, code) {
    const dev = devResolver(phone);
    if (dev) {
      return String(code) === dev ? { ok: true } : { ok: false, error: '验证码错误' };
    }
    const rec = store.get(phone);
    if (!rec) return { ok: false, error: '请先获取验证码' };
    if (now() > rec.exp) { store.delete(phone); return { ok: false, error: '验证码已过期,请重新获取' }; }
    if (rec.attempts >= o.maxAttempts) { store.delete(phone); return { ok: false, error: '尝试次数过多,请重新获取' }; }
    const a = Buffer.from(hash(phone, code));
    if (a.length === rec.hash.length && crypto.timingSafeEqual(a, rec.hash)) {
      store.delete(phone);
      return { ok: true };
    }
    rec.attempts += 1;
    if (rec.attempts >= o.maxAttempts) store.delete(phone);
    return { ok: false, error: '验证码错误' };
  }

  return { issue, verify };
}

module.exports = { createSmsService };
