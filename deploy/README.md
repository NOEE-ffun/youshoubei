# 迁移到阿里云自托管:ECS + OSS(方案 A,备案后直上杭州)

> 现状:Vercel 函数部署在香港(`hkg1`),API 再跨境访问杭州 OSS,`api/oss.js` 里已有 4s 超时 + 重试就是这段链路不稳的证据。
> 目标:备案完成后,Node 进程和 OSS 放在**同一个杭州地域**,前端继续由同机 Nginx/Caddy 反代,彻底去掉跨境往返。

## 0. 当前决策:先备案,通过后再切

- **备案期间**:按管局要求暂停 `youshoubei.cn` / `www` 的解析,网站对外停用;OSS 数据和 Vercel 项目都不动。
- **备案通过后**:DNS 一次切到杭州 ECS,OSS 继续用现有杭州桶,**无需搬数据**。
- 若想不备案先过渡,才需要香港 ECS + 香港 OSS(本文件仅作备选,不推荐走这条弯路)。

域名 `youshoubei.cn` 已在阿里云云解析,备案通过后直接改解析即可。

### 0.1 备案期间如何暂停解析(不注销域名、不停云解析服务)

1. 阿里云云解析先记录当前两条记录,再把 TTL 降到 60 秒:
   - `@` → A → `216.198.79.1`(Vercel)
   - `www` → CNAME → `64d8e0292d06f644.vercel-dns-017.com`
2. 等 10 分钟让旧 TTL(600 秒)缓存过期。
3. 在云解析控制台把这两条记录**暂停或删除**(不要注销域名、不要停用整个云解析服务)。
4. 验证全国 DNS 已不可达:
   ```bash
   dig @223.5.5.5 youshoubei.cn A
   dig @223.5.5.5 www.youshoubei.cn A
   ```
   预期:没有 A/CNAME 答案(或 NXDOMAIN)。
5. 再提交备案。备案通过后,在云解析恢复两条记录并指向杭州 ECS IP。

> 赛事期间确实需要访问:可在 Vercel 控制台找到项目的 `xxx.vercel.app` 默认域名,把临时链接发给少数工作人员使用(备案停的是 `youshoubei.cn` 这个域名)。是否允许这样过渡请以阿里云备案专员口径为准;最稳妥是备案期间完全停服。

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

### 4.0 海报板块需要的一次性 OSS CORS 配置

海报页会把云端选手头像/称号图片读入 Canvas 生成 PNG。为避免跨域污染,需在 OSS 桶开启 CORS:
- 允许来源:`https://www.youshoubei.cn`(本地调试再加 `http://localhost:*`)
- 允许方法:`GET`
- 允许 Headers:`*`
- 暴露 Headers:`ETag`
- 缓存时间:600 秒

### 4.0.1 OBS 舞台环境变量

`POSTER_STAGE_TTL_DAYS=7`:管理员生成 OBS 短链的有效天数,过期后舞台页返回 404。可改 30 或更长;不填默认 7 天。

## 4.1 代码更新:GitHub → 云效 Flow → 杭州 ECS(已选定)

> 云效 Flow 只负责 CI/CD,不存网站数据;它的免费额度限制的是构建时长,和网站运行/OSS 存储无关。额度见云效控制台,个人项目通常够用;就算构建额度用完,仍可手动到 ECS 执行 `deploy/flow-deploy.sh` 更新。

### 一次性配置(阿里云控制台)

1. 开通云效:进入 [云效 DevOps](https://devops.aliyun.com/),创建企业/工作空间,进入 **Flow**。
2. 新建流水线:
   - 选「空模板」或「代码源触发」模板。
   - 代码源 → 添加代码源 → **GitHub**,OAuth 授权你的账号,选择 `NOEE-ffun/youshoubei` 仓库,默认分支 `main`,开启 **push 触发(Webhook)**。
3. 阶段一「构建」(Node 20 构建环境):
   ```bash
   npm ci --omit=dev
   npm test
   ```
   这一步是质量闸门:测试不过,不会进入部署。
4. 阶段二「主机部署」:
   - 先在 Flow 左侧「主机组」新建主机组,把杭州 ECS 加进去(控制台会给一段 agent 安装命令,在 ECS 上执行)。
   - 主机组执行用户推荐 `root`,或用普通用户并给 `systemctl` 免密 sudo。
   - 添加「主机部署」任务,选择该主机组,部署脚本填:
     ```bash
     cd /srv/youshoubei && bash deploy/flow-deploy.sh
     ```
   - 脚本内容见仓库 `deploy/flow-deploy.sh`:更新到 `main`、`npm ci`、重启 `youshoubei`、健康检查。
5. 保存并手动运行一次流水线,日志里看到 `[flow-deploy] deploy ok` 即通。

之后每次 push 到 GitHub `main`,云效都会自动构建并部署到杭州 ECS,使用体验与 Vercel 一致。

> 备选:如果以后不想用云效,仓库已托管在 GitHub,也可以改走 GitHub Actions(配置见前几版说明)。当前按已选方案使用云效 Flow。

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
