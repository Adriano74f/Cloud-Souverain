#!/bin/sh
# Exécuté une seule fois, juste après l'installation de Nextcloud.
set -e
OCC="php /var/www/html/occ"

# Authentification à deux facteurs (TOTP)
$OCC app:install twofactor_totp || $OCC app:enable twofactor_totp || true

# Tâches de fond via le conteneur cron
$OCC background:cron

# Réglages recommandés
$OCC config:system:set default_phone_region --value="FR"
$OCC config:system:set maintenance_window_start --type=integer --value=1
$OCC config:system:set auth.bruteforce.protection.enabled --type=boolean --value=true
$OCC db:add-missing-indices || true

echo "Durcissement post-installation appliqué."
