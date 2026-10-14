#!/bin/sh
# Sauvegarde quotidienne : base MariaDB + configuration Nextcloud.
# Les fichiers utilisateurs sont sauvegardés côté NAS (Hyper Backup / snapshots).
# Cron conseillé sur la VM :  0 2 * * * cd /opt/cloud-souverain/infra && ./scripts/backup.sh
set -e
cd "$(dirname "$0")/.."
. ./.env

STAMP=$(date +%Y-%m-%d_%H%M)
DEST="${BACKUP_DIR:-./backups}/$STAMP"
mkdir -p "$DEST"

docker compose exec -T -u www-data nextcloud php occ maintenance:mode --on
trap 'docker compose exec -T -u www-data nextcloud php occ maintenance:mode --off' EXIT

docker compose exec -T db sh -c 'exec mariadb-dump --single-transaction -u root -p"$MARIADB_ROOT_PASSWORD" nextcloud' \
  | gzip > "$DEST/nextcloud-db.sql.gz"

docker compose cp nextcloud:/var/www/html/config "$DEST/config"
cp docker-compose*.yml "$DEST/"
cp -r nginx/templates "$DEST/nginx-templates"

# Rotation : conserver 14 jours
find "${BACKUP_DIR:-./backups}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +

echo "Sauvegarde terminée : $DEST"
