# 迁移到阿里云自托管:ECS + OSS(方案 A)

> 现状:Vercel 函数部署在香港(`hkg1`),API 再跨境访问杭州 OSS,`api/oss.js` 里已有 4s 超时 + 重试就是这段链路不稳的证据。
> 目标:Node 进程和 OSS 放在**同一个阿里云地域**,前端继续由同机 Nginx/Caddy 反代,彻底去掉跨境往返。

## 0. 备案状态决定地域

- **未备案(当前状态)**:自定义域名不能绑到大陆 ECS / 大陆 CDN / 大陆 OSS 静态网站。先用 **阿里云香港 ECS + 香港 OSS**,不需要 ICP 备案,可立即切换。
- **备案完成后**:把 ECS/OSS 换成杭州,代码不变,只改地域环境变量和 DNS 指向即可。

域名 `youshoubei.cn` 已在阿里云云解析,两种地域的 DNS 操作相同。

## 1. 阿里云资源准备

1. 创建 ECS(或轻量应用服务器):
   - 未备案过渡:**香港地域**,Ubuntu 22.04/24.04,2C2G 足够。
   - 备案后正式:**杭州地域**,规格相同。
2. 安全组放行 `22`(SSH)、`80`、`443`;**不要**放行 `3000`。
3. OSS:
   - 推荐与 ECS 同地域新建桶(香港:`oss-cn-hongkong`;杭州:`oss-cn-hangzhou`)。
   - 私有读写,图片对象由程序 `putACL` 设为 public-read。
   - 创建 RAM 用户,只授该桶的 `oss:GetObject / oss:PutObject / oss:PutObjectAcl`;生产环境建议改用 ECS RAM 角色。
4. 登录 ECS 安装:
   ```bash
   sudo apt update
   sudo apt install -y nginx nodejs npm git
   node -v   # 需要 18+,推荐 20+
   ```

## 2. 部署应用

```bash
sudo mkdir -p /srv
sudo chown "$USER" /srv
cd /srv
git clone https://github.com/NOEE-ffun/youshoubei.git
cd youshoubei
npm ci --omit=dev
```

环境变量二选一:
- 简单方式:`cp .env.example .env` 填好后直接 `npm start`(server.js 会读 `.env`)。
- 生产方式:用 systemd `EnvironmentFile`(模板见 `deploy/youshoubei.service`),不把 `.env` 留在仓库目录。

环境变量要求(所有值都是阿里云 OSS 的信息,不再有 Vercel 变量):

| 变量 | 未备案过渡(香港) | 备案后(杭州) |
|---|---|---|
| OSS_REGION | oss-cn-hongkong | oss-cn-hangzhou |
| OSS_BUCKET | 香港桶名 | 杭州桶名 |
| OSS_ACCESS_KEY_ID | RAM 用户 AK | RAM 用户 AK |
| OSS_ACCESS_KEY_SECRET | RAM 用户 SK | RAM 用户 SK |
| OSS_PUBLIC_BASE_URL | `https://图片域名`(可选) | `https://图片域名`(可选) |
| ADMIN_TOKEN | 管理口令 | 管理口令 |

## 3. 启动与反代

systemd(推荐):
```bash
sudo cp deploy/youshoubei.service /etc/systemd/system/
# 修改 service 里的 User/WorkingDirectory/node 路径,EnvironmentFile 指向你的 env 文件
sudo systemctl daemon-reload
sudo systemctl enable --now youshoubei
curl http://127.0.0.1:3000/api/health
```

Nginx(模板见 `deploy/nginx.conf.example`)或 Caddy(`deploy/Caddyfile.example`):
```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/youshoubei
sudo ln -s /etc/nginx/sites-available/youshoubei /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Nginx 证书可用 `certbot --nginx -d youshoubei.cn -d www.youshoubei.cn`;Caddy 会自动签发。

## 4. 迁移 OSS 数据(如果从杭州桶换到香港桶)

1. 安装 ossutil,配置 RAM AK。
2. 整桶迁移(旧桶里的私有 `data.json` 和 `images/*` 都搬):
   ```bash
   ossutil cp -r oss://旧桶/ oss://新桶/ --update
   ```
3. 如果 `data.json` 里存的是旧桶图片 URL,需要把 URL 前缀替换成新桶/CDN 前缀:
   ```bash
   ossutil cp oss://新桶/data.json ./data.json -f
   node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('data.json','utf8'));const walk=o=>{for(const k in o){if(typeof o[k]==='string')o[k]=o[k].replaceAll('https://旧桶.oss-cn-hangzhou.aliyuncs.com/','https://新桶.oss-cn-hongkong.aliyuncs.com/');else if(o[k]&&typeof o[k]==='object')walk(o[k]);}};walk(j);fs.writeFileSync('data.json',JSON.stringify(j));"
   ossutil cp ./data.json oss://新桶/data.json -f
   ```
4. 之后把环境变量 `OSS_REGION/OSS_BUCKET/OSS_PUBLIC_BASE_URL` 指向新桶。

## 5. DNS 切换(阿里云云解析)

当前 DNS 状态(截至迁移前):
- 裸域/`www` 都指向 Vercel(`64d8e0292d06f644.vercel-dns-017.com`)。
- 需要改成:
  - `@` → `A` → ECS 公网 IP
  - `www` → `A` → ECS 公网 IP(或 CNAME 到 `youshoubei.cn`)

**先在 DNS 切换前用 hosts 或 curl 验证 ECS 已可用:**
```bash
curl --resolve youshoubei.cn:443:ECS公网IP https://youshoubei.cn/api/health
curl --resolve youshoubei.cn:443:ECS公网IP https://youshoubei.cn/
```

确认 HTTPS、页面、编辑保存、图片上传都正常后,再到云解析改记录,TTL 先设 60 秒。Vercel 项目保留 1 周作为回滚点,稳定后删除。

## 6. 验收清单

- [ ] `/api/health` 返回 `{"ok":true}`
- [ ] 首页、赛程页、静态 JS/CSS 正常
- [ ] 云端模式能读到已有比赛
- [ ] 管理口令登录成功
- [ ] 编辑比分/卡片保存成功(写入新 OSS)
- [ ] 卡组图片上传、回显成功
- [ ] 旧图片 URL 可访问
- [ ] `curl https://域名/api/oss.js` 返回 404(源码不外泄)
- [ ] `curl https://域名/.env` 返回 403
- [ ] 手机 4G/5G 打开赛程页速度可接受

## 7. 回滚

1. 阿里云云解析恢复原来的 Vercel 记录:
   - `@` → `CNAME` → `64d8e0292d06f644.vercel-dns-017.com`
   - `www` → `CNAME` → `64d8e0292d06f644.vercel-dns-017.com`
2. Vercel 项目保持原环境变量,回滚即生效。
3. 数据若已切到新桶,把 Vercel 环境变量改回旧桶即可。
