'use strict';

/* api/ 共享工具:JSON 响应与请求体收集。
 * 逐块收集后一次性 concat 再解码:中文等多字节字符跨 chunk 时,
 * 逐块 utf8 解码会产生 U+FFFD 替换符损坏数据。 */

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

/** 收集请求体并限流;超过 maxBytes 返回 null(调用方应答 413),空体返回空 Buffer */
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { sendJson, readBody };
