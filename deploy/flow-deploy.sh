#!/usr/bin/env bash
# 云效 Flow「主机部署」步骤脚本:在 ECS 上把已克隆的仓库更新到 main,重启服务并做健康检查。
# 要求:
#   - 首次部署已按 deploy/README.md 克隆到 /srv/youshoubei
#   - systemd 服务名 youshoubei 已启动
#   - 云效 agent 执行用户对 systemctl 有免密 sudo 权限,或直接以 root 运行
# 可用环境变量覆盖:APP_DIR / BRANCH / HEALTH_URL / RESTART_CMD

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/youshoubei}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
RESTART_CMD="${RESTART_CMD:-sudo systemctl restart youshoubei}"

cd "$APP_DIR"

echo "[flow-deploy] fetch origin/${BRANCH}"
git fetch origin "$BRANCH" --prune

if git diff --quiet && git diff --cached --quiet; then
  echo "[flow-deploy] working tree clean"
else
  echo "[flow-deploy] working tree dirty, abort (protect manual fixes)" >&2
  git status --short >&2
  exit 1
fi

if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/${BRANCH}")" ]; then
  echo "[flow-deploy] already at latest commit"
else
  echo "[flow-deploy] fast-forward to origin/${BRANCH}"
  git merge --ff-only "origin/${BRANCH}"
fi

echo "[flow-deploy] npm ci --omit=dev"
npm ci --omit=dev

echo "[flow-deploy] restart service"
$RESTART_CMD

echo "[flow-deploy] health check ${HEALTH_URL}"
for i in $(seq 1 15); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "[flow-deploy] deploy ok"
    exit 0
  fi
  sleep 1
done

echo "[flow-deploy] health check failed" >&2
exit 1
