# 迁移到阿里云自托管:ECS + OSS(方案 A,备案后直上杭州)

> 现状:Vercel 函数部署在香港(`hkg1`),API 再跨境访问杭州 OSS,`api/oss.js` 里已有 4s 超时 + 重试就是这段链路不稳的证据。
> 目标:备案完成后,Node 进程和 OSS 放在**同一个杭州地域**,前端继续由同机 Nginx/Caddy 反代,彻底去掉跨境往返。

## 0. 当前决策:先备案,通过后再切

- **备案期间**:Vercel 继续跑,域名和 OSS 都不动;现在就可以在阿里云控制台建杭州 ECS、配 RAM 权限、部署测试(用 IP 或 hosts 验证,不切 DNS)。
- **备案通过后**:DNS 一次切到杭州 ECS,OSS 继续用现有杭州桶,**无需搬数据**。
- 若想不备案先过渡,才需要香港 ECS + 香港 OSS(本文件仅作备选,不推荐走这条弯路)。

域名 `youshoubei.cn` 已在阿里云云解析,备案通过后直接改解析即可。

## 1. 阿里云资源准备(全部杭州)

1. 创建 ECS(或轻量应用服务器):
   - **杭州地域**,Ubuntu 22.04/24.04,2C2G 足够。
   - 安全组放行 `22`(SSH)、`80`、`443`;**不要**放行 `3000`。
2. OSS:
   - **沿用现有杭州桶**(`oss-cn-hangzhou`),`data.json` 和 `images/*` 都在里面,不要重建、不要搬桶。
   - 私有读写,图片对象由程序 `putACL` 设为 public-read。
   - 创建 RAM 用户,只授该桶的 `oss:GetObject / oss:PutObject / oss:PutObjectAcl`;生产环境建议改用 ECS RAM 角色。
3. 登录 ECS 安装:
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

环境变量要求(与现在 Vercel 上的值相同,只是运行位置从 Vercel 函数变成杭州 ECS):

| 变量 | 值 |
|---|---|
| OSS_REGION | oss-cn-hangzhou |
| OSS_BUCKET | 现有杭州桶名 |
| OSS_ACCESS_KEY_ID | RAM 用户 AK |
| OSS_ACCESS_KEY_SECRET | RAM 用户 SK |
| OSS_PUBLIC_BASE_URL | `https://图片域名`(可选) |
| ADMIN_TOKEN | 管理口令 |

> 如果某天临时用香港 ECS 过渡,把 `OSS_REGION` 改成 `oss-cn-hongkong` 且换香港桶即可,代码不变。

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

## 4. OSS 数据:备案后直上杭州,无需迁移

- 现在 Vercel 用的就是杭州桶,ECS 部署后继续读同一个桶:**零迁移、零改 URL**。
- 只有走香港过渡路线时才需要新建香港桶并搬数据(不推荐当前走这条路)。

## 4.1 代码更新:GitHub → 阿里云 ECS 自动部署

ECS 本身不提供 Vercel 那种"仓库 push 即发布"能力,但阿里云有对应产品。两个推荐方案:

**方案甲:阿里云云效 Flow(最接近 Vercel 的体验)**
1. 开通阿里云「云效」,进入 Flow 流水线。
2. 代码源选 GitHub,用 OAuth 授权你的 `NOEE-ffun/youshoubei` 仓库,自动配置 webhook。
3. 流水线两步:
   - 构建:选 Node 20,执行 `npm ci --omit=dev && npm test`。
   - 部署:选「主机部署」,把杭州 ECS 加为云效主机组(装云效 agent),执行:
     ```bash
     cd /srv/youshoubei
     git pull --ff-only origin main
     npm ci --omit=dev
     sudo systemctl restart youshoubei
     ```
4. 之后每次 push 到 GitHub `main`,云效自动构建并部署,和 Vercel 用法一致。

**方案乙:GitHub Actions(仓库已托管在 GitHub,配置更少)**
1. 在 ECS 生成部署专用 SSH key,公钥放 `~/.ssh/authorized_keys`。
2. GitHub 仓库 Secrets 存 `SSH_HOST / SSH_USER / SSH_KEY`。
3. 加 `.github/workflows/deploy.yml`,内容为 SSH 到 ECS 后:
   ```bash
   cd /srv/youshoubei && git pull --ff-only origin main && npm ci --omit=dev && sudo systemctl restart youshoubei
   ```

两者都支持 push 自动部署;想要"全阿里云体系"用云效 Flow,想少配置用 GitHub Actions。

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
- [ ] 编辑比分/卡片保存成功(写入杭州 OSS)
- [ ] 卡组图片上传、回显成功
- [ ] 旧图片 URL 可访问
- [ ] `curl https://域名/api/oss.js` 返回 404(源码不外泄)
- [ ] `curl https://域名/.env` 返回 403
- [ ] 手机 4G/5G 打开赛程页速度可接受

## 7. 回滚

1. 阿里云云解析恢复原来的 Vercel 记录:
   - `@` → `CNAME` → `64d8e0292d06f644.vercel-dns-017.com`
   - `www` → `CNAME` → `64d8e0292d06f644.vercel-dns-017.com`
2. Vercel 项目保持原环境变量,回滚即生效(OSS 始终是同一个杭州桶,无需改数据)。
