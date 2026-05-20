#!/bin/bash
# CoreID 数据库 + 上传文件 自动备份脚本
# 备份 coreid 数据库、casdoor 数据库、uploads 文件
# 上传至七牛云存储，本地保留 7 天
#
# 用法：直接执行，或通过 crontab 定时运行
# crontab 示例：0 3 * * * /root/backup-coreid.sh >> /var/log/coreid-backup.log 2>&1

set -euo pipefail

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/tmp/coreid_backup_${DATE}
QINIU_BUCKET="coreid-backup"
QINIU_UPLOAD="/root/qiniu_upload.py"
LOCAL_KEEP_DIR=/root/backups/coreid
LOCAL_KEEP_DAYS=7

mkdir -p "$BACKUP_DIR" "$LOCAL_KEEP_DIR"

echo "$(date) [开始] CoreID 备份"

# ── 1. 备份 CoreID 数据库 ──
echo "$(date) [1/4] 备份 CoreID 数据库..."
docker exec coreid-postgres pg_dump -U coreid coreid | gzip > "${BACKUP_DIR}/coreid_db_${DATE}.sql.gz"

# ── 2. 备份 Casdoor 数据库 ──
echo "$(date) [2/4] 备份 Casdoor 数据库..."
docker exec coreid-postgres pg_dump -U coreid casdoor | gzip > "${BACKUP_DIR}/casdoor_db_${DATE}.sql.gz"

# ── 3. 备份上传文件 ──
echo "$(date) [3/4] 备份上传文件..."
docker run --rm -v coreid_uploads:/data -v "${BACKUP_DIR}:/backup" alpine \
  tar czf "/backup/coreid_uploads_${DATE}.tar.gz" -C /data .

# ── 4. 上传至七牛 ──
echo "$(date) [4/4] 上传至七牛..."
for f in "${BACKUP_DIR}"/*; do
  python3 "$QINIU_UPLOAD" "$f" "$QINIU_BUCKET"
done

# ── 5. 保留本地副本 ──
cp "${BACKUP_DIR}"/* "$LOCAL_KEEP_DIR/"

# ── 6. 清理临时文件和过期本地备份 ──
rm -rf "$BACKUP_DIR"
find "$LOCAL_KEEP_DIR" -type f -mtime +${LOCAL_KEEP_DAYS} -delete

echo "$(date) [完成] CoreID 备份成功"
