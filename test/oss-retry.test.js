'use strict';

/* api/oss.js 重试逻辑的行为测试(不联网):网络类错误重试后成功,
 * 非网络错误(404/NoSuchKey)立即抛出不重试。 */

const assert = require('node:assert');
const { withRetry, isRetriable } = require('../api/oss');

function netError(message) {
  const error = new Error(message || 'connect ETIMEDOUT 1.2.3.4:443');
  error.code = 'ETIMEDOUT';
  return error;
}

async function main() {
  /* 1. 前两次网络超时,第三次成功 → 返回结果且共调用 3 次 */
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw netError();
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);

  /* 2. 一直网络超时 → 抛出并注明已重试 */
  let callsAllFail = 0;
  await assert.rejects(
    () => withRetry(async () => {
      callsAllFail += 1;
      throw netError();
    }),
    /已重试 2 次仍失败/
  );
  assert.strictEqual(callsAllFail, 3);

  /* 3. 非网络错误(NoSuchKey/404)不重试,原样抛出 */
  let callsNoRetry = 0;
  await assert.rejects(
    () => withRetry(async () => {
      callsNoRetry += 1;
      const error = new Error('NoSuchKey');
      error.code = 'NoSuchKey';
      error.status = 404;
      throw error;
    }),
    /NoSuchKey/
  );
  assert.strictEqual(callsNoRetry, 1);

  /* 4. 可重试判定 */
  assert.strictEqual(isRetriable(netError()), true);
  assert.strictEqual(isRetriable(Object.assign(new Error('server error'), { status: 502 })), true);
  const notFound = new Error('not found');
  notFound.status = 404;
  assert.strictEqual(isRetriable(notFound), false);
  assert.strictEqual(isRetriable(new Error('OSS 配置不完整')), false);

  console.log('oss-retry 全部 4 组测试通过 ✓');
}

main().catch((error) => {
  console.error('oss-retry 测试失败:', error);
  process.exit(1);
});
