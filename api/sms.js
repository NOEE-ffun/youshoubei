'use strict';

const crypto = require('node:crypto');

/* 短信验证码服务(内存,单实例——多实例前需外置,记入设计文档遗留):
 *   issue(phone, ip)  限速前置检查 → sender 发送
 *   verify(phone, code) dev 后门直验 / 注入 verifier 平台校验 / 存储码哈希比对(限尝试)
 * 参数:120s 重发间隔、5 分钟有效、同手机日 10 条、同 IP 日 20 条、每码验 5 次。
 *
 * 通道为阿里云号码认证服务的「短信认证服务」(dypns,官方签名/模板,无需自有签名):
 * 平台生成验证码(templateParam 的 ##code## 占位符由平台替换,本地无法注入自定义码),
 * 服务端经 CheckSmsVerifyCode 校验——故真通道走 provider-verify 模式(createSmsService
 * 注入 options.verifier 时启用):本地不再存码哈希,store 退化为发送记录(过期/尝试计数),
 * 限速/日限/尝试次数逻辑与本地模式完全同构;每次 check 失败计一次,超 5 次删记录
 * (平台码随之作废,须重新获取)。未注入 verifier 时保持本地生成+本地校验(注入测试用)。
 * dev 后门 AUTH_DEV_SMS_CODE(单码或 phone:code 列表):显式配置即最高优先——本地 .env
 * 配齐真通道签名/模板也不顶掉它(e2e/开发链路依赖);生产硬闸:NODE_ENV=production 时
 * 一律无后门(systemd 已设该值,即使误配 AUTH_DEV_SMS_CODE 也不开门)。
 * 真发联调方法:临时注释掉 AUTH_DEV_SMS_CODE 再调发送(2026-08-31 交接修正)。 */

const DEFAULTS = {
  resendMs: 120 * 1000,
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
  phoneDaily: 10,
  ipDaily: 20,
  dayMs: 24 * 60 * 60 * 1000
};

/* 后门 env 语义:未配置=无后门;NODE_ENV=production=硬关(先于一切);
 * 显式 AUTH_DEV_SMS_CODE 优先于真通道 env 判断(签名/模板齐全也拦不住它)。 */
function envDevCode(phone) {
  if (!process.env.AUTH_DEV_SMS_CODE) return null;
  if (process.env.NODE_ENV === 'production') return null;
  const raw = String(process.env.AUTH_DEV_SMS_CODE).split(',').map((s) => s.trim()).filter(Boolean);
  let any = null;
  for (const item of raw) {
    const [p, c] = item.includes(':') ? item.split(':') : [null, item];
    if (c && phone === p) return c;
    if (c && !p) any = c;
  }
  return any;
}

/* dypnsapi 2.0.0 的 Client 继承 @alicloud/openapi-core 默认导出,构造器收
 * $OpenApiUtil.Config(client.d.ts 可证;勿用 dysmsapi 时代的 openapi-client——已随其卸载)。
 * endpoint 按包内 client 构造器核实:productId 'dypnsapi' 走 central 规则解析为
 * dypnsapi.aliyuncs.com,此处显式钉死防地域规则漂移 */
function dypnsClient() {
  const Dypnsapi = require('@alicloud/dypnsapi20170525');
  const OpenApi = require('@alicloud/openapi-core');
  const config = new OpenApi.$OpenApiUtil.Config({
    accessKeyId: process.env.SMS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET
  });
  config.endpoint = 'dypnsapi.aliyuncs.com';
  return new Dypnsapi.default(config);
}

/* 阿里云真发送器:lazy require,未装 SDK/未配 env 不阻断进程启动。
 * code 入参仅为维持 sender(phone, code) 契约(注入测试用)——dypns 平台生成码,不采用本地码 */
async function realSender(phone) {
  if (!process.env.SMS_SIGN_NAME || !process.env.SMS_TEMPLATE_CODE) {
    return { ok: false, error: '短信通道未配置(SMS_SIGN_NAME / SMS_TEMPLATE_CODE)' };
  }
  try {
    const Dypnsapi = require('@alicloud/dypnsapi20170525');
    const resp = await dypnsClient().sendSmsVerifyCode(new Dypnsapi.SendSmsVerifyCodeRequest({
      phoneNumber: phone,
      signName: process.env.SMS_SIGN_NAME,
      templateCode: process.env.SMS_TEMPLATE_CODE,
      templateParam: JSON.stringify({ code: '##code##' }),
      codeLength: 6,        /* 平台生成 6 位码(4-8 可选),对齐本地模式口径 */
      codeType: 1,          /* 纯数字 */
      validTime: 300,       /* 平台侧 5 分钟有效,同本地 ttlMs */
      interval: 60,         /* 平台侧重发间隔(秒),本地 120s 更严先拦 */
      duplicatePolicy: 1    /* 重发覆盖旧码,与本地 store.set 同构 */
    }));
    /* SDK 对业务性失败返回 HTTP 200 + body.code≠'OK' 且不抛异常,必须显式判码;
     * 该路径依赖真通道,无单测,语义在此注明 */
    if (resp.body && resp.body.code === 'OK') return { ok: true };
    return { ok: false, error: '短信发送失败:' + ((resp.body && (resp.body.message || resp.body.code)) || '未知') };
  } catch (error) {
    return { ok: false, error: '短信发送失败:' + (error.message || error.code || error) };
  }
}

/* 平台验码器:CheckSmsVerifyCode 收 phoneNumber+verifyCode,verifyResult=PASS 即通过。
 * 仅真通道发送成功后才有本地记录可走到此处,AK 缺失等异常由 catch 兜底为校验失败(fail-closed) */
async function realVerifier(phone, code) {
  try {
    const Dypnsapi = require('@alicloud/dypnsapi20170525');
    const resp = await dypnsClient().checkSmsVerifyCode(new Dypnsapi.CheckSmsVerifyCodeRequest({
      phoneNumber: phone,
      verifyCode: String(code)
    }));
    if (resp.body && resp.body.code === 'OK' && resp.body.model && resp.body.model.verifyResult === 'PASS') {
      return { ok: true };
    }
    return { ok: false, error: '验证码错误' };
  } catch (error) {
    return { ok: false, error: '验证码校验失败:' + (error.message || error.code || error) };
  }
}

function createSmsService(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const sender = typeof o.sender === 'function' ? o.sender : realSender;
  const verifier = typeof o.verifier === 'function' ? o.verifier : null;
  const devResolver = typeof o.devResolver === 'function' ? o.devResolver : envDevCode;
  const secret = crypto.randomBytes(32); /* 进程内盐:码哈希不可逆推(仅本地校验模式使用) */

  const store = new Map();     /* phone -> {hash, exp, attempts};provider 模式无 hash=发送记录 */
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
    /* 日限检查要在计数前判越界(第 11 条拒);day 为 UTC epoch 天——北京 8 点切日,
     * 反滥用语义下可接受,不引入时区复杂度;非当日陈旧记录直接忽略,由 dayKey 在成功路径重置 */
    const day = Math.floor(now() / o.dayMs);
    const pk = 'p:' + phone;
    const prevDay = daily.get(pk);
    if (prevDay && prevDay.day === day && prevDay.count >= o.phoneDaily) return { ok: false, error: '该手机号今日发送次数已达上限' };
    const ik = 'i:' + ip;
    const prevIp = daily.get(ik);
    if (prevIp && prevIp.day === day && prevIp.count >= o.ipDaily) return { ok: false, error: '该 IP 今日发送次数已达上限' };

    if (devResolver(phone)) {
      dayKey('p', phone); dayKey('i', ip); lastSent.set(phone, now());
      return { ok: true, dev: true };
    }
    /* 本地码仅维持 sender 契约:provider 模式下平台另生成码,本地码不落存储 */
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const sent = await sender(phone, code);
    if (!sent.ok) return { ok: false, error: sent.error || '短信发送失败' };
    dayKey('p', phone); dayKey('i', ip);
    lastSent.set(phone, now());
    store.set(phone, verifier
      ? { exp: now() + o.ttlMs, attempts: 0 }
      : { hash: hash(phone, code), exp: now() + o.ttlMs, attempts: 0 });
    return { ok: true };
  }

  async function verify(phone, code) {
    const dev = devResolver(phone);
    if (dev) {
      return String(code) === dev ? { ok: true } : { ok: false, error: '验证码错误' };
    }
    const rec = store.get(phone);
    if (!rec) return { ok: false, error: '请先获取验证码' };
    if (now() > rec.exp) { store.delete(phone); return { ok: false, error: '验证码已过期,请重新获取' }; }
    if (rec.attempts >= o.maxAttempts) { store.delete(phone); return { ok: false, error: '尝试次数过多,请重新获取' }; }
    if (verifier) {
      const res = await verifier(phone, code);
      if (res && res.ok) {
        store.delete(phone);
        return { ok: true };
      }
      rec.attempts += 1;
      if (rec.attempts >= o.maxAttempts) store.delete(phone);
      return { ok: false, error: (res && res.error) || '验证码错误' };
    }
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

module.exports = { createSmsService, realVerifier, dypnsClient };
