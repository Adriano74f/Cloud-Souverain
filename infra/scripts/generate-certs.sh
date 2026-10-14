#!/bin/sh
# Génère un certificat TLS auto-signé si aucun certificat n'est présent.
# Pour un vrai domaine public, remplacer cloud.crt / cloud.key par un certificat Let's Encrypt.
set -e

if [ -f /certs/cloud.crt ] && [ -f /certs/cloud.key ]; then
  echo "Certificat existant conservé."
  exit 0
fi

apk add --no-cache openssl >/dev/null

if echo "$NC_DOMAIN" | grep -Eq '^[0-9.]+$'; then
  SAN="IP:$NC_DOMAIN,DNS:localhost,IP:127.0.0.1"
else
  SAN="DNS:$NC_DOMAIN,DNS:localhost,IP:127.0.0.1"
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout /certs/cloud.key -out /certs/cloud.crt \
  -subj "/CN=$NC_DOMAIN/O=Cloud Souverain" \
  -addext "subjectAltName=$SAN"

chmod 600 /certs/cloud.key
echo "Certificat auto-signé généré pour $NC_DOMAIN."
