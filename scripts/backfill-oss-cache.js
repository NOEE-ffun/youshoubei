'use strict';

/* 一次性回填脚本:为存量 OSS 图片对象补 Cache-Control 元数据。
 * 用法:OSS_REGION=... OSS_BUCKET=... OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=... \
 *      node scripts/backfill-oss-cache.js [前缀,默认 images/]
 * 同名 copy + REPLACE 会清空原有元数据,因此 Content-Type 要先 head 出来一并重写;
 * copy 后 ACL 可能回落为私有,逐个重设公共读。 */
const OSS = require('ali-oss');

async function main() {
  const prefix = process.argv[2] || 'images/';
  const missing = ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    console.error('缺少环境变量: ' + missing.join(', '));
    process.exit(1);
  }
  const client = new OSS({
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    secure: true
  });

  let marker;
  let count = 0;
  do {
    const result = await client.list({ prefix, 'max-keys': 100, marker });
    for (const obj of result.objects || []) {
      if (obj.name.endsWith('/')) continue;
      const head = await client.head(obj.name);
      await client.copy(obj.name, obj.name, {
        headers: {
          'Content-Type': head.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'x-oss-metadata-directive': 'REPLACE'
        }
      });
      await client.putACL(obj.name, 'public-read');
      count += 1;
      console.log('done:', obj.name);
    }
    marker = result.nextMarker;
  } while (marker);
  console.log('完成,共处理 ' + count + ' 个对象');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
