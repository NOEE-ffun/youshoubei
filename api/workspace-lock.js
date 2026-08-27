'use strict';

/* data.json 读-改-写互斥(单实例进程内):
 * /api/me/classlinks、/api/me/signup、/api/me/player、管理端 /api/data PUT
 * 都是"读整个 workspace → 改一处 → 整体写回"。OSS 往返期间(百毫秒级)
 * 两个请求交错 = 后写者用它读到的旧快照覆盖前写者,前者的提交静默丢失。
 * 这里用 promise 链把各端点的 读→写 段串行化,彻底消除交错窗口。
 * 局限:仅本进程有效;若将来多实例部署需换分布式锁(OSS 条件写/ETag)。 */

let chain = Promise.resolve();

function withWorkspaceLock(fn) {
  const run = chain.then(fn, fn);
  /* 链尾吞错:单个请求失败不断链;错误经 run 原样抛给调用方 */
  chain = run.then(() => {}, () => {});
  return run;
}

module.exports = { withWorkspaceLock };
