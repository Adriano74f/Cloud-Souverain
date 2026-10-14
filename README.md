# Cloud Souverain : Nextcloud + portail web

Alternative souveraine à Google Drive : stockage de fichiers privé, sans limite, hébergé sur notre propre infrastructure.
Projet : Adriano · Alexandra · Berk.

```
cloud-souverain/
├── site/                     # Site vitrine statique (GitHub Pages)
│   ├── index.html            # Page de présentation + bouton « Se connecter »
│   ├── fichiers.html         # Page « Mes fichiers » (client WebDAV dans le navigateur)
│   └── assets/
│       ├── js/config.js      # ← adresse du serveur cloud à renseigner
│       ├── js/main.js, files.js
│       ├── css/style.css, app.css
│       └── favicon.svg       # (icônes SVG intégrées dans chaque page)
├── infra/                    # Stack Docker (VM Ubuntu en production, Docker Desktop en local)
│   ├── docker-compose.yml    # nginx · nextcloud · cron · mariadb · redis · certs
│   ├── docker-compose.nas.yml# Surcharge prod : données sur le NAS Synology (NFS)
│   ├── .env.example          # Modèle des secrets (copier en .env, jamais versionné)
│   ├── nginx/templates/      # Reverse proxy TLS + CORS pour le site vitrine
│   ├── nextcloud/post-installation/  # 2FA TOTP, cron, réglages au 1er démarrage
│   └── scripts/              # Certificat auto-signé, sauvegarde quotidienne
└── .github/workflows/pages.yml  # Déploiement automatique du site
```

## Architecture

```
Navigateur ──► GitHub Pages (site vitrine, statique)
    │
    │  « Se connecter »  /  page « Mes fichiers » (WebDAV + CORS)
    ▼
FortiGate (HTTPS 443 seulement, NAT) ──► Nginx (TLS) ──► Nextcloud ──► MariaDB / Redis
                                                              │
                                                              └── NFS (2049) ──► NAS Synology
```

Le site est **100 % statique** et ne contient aucun secret. La liaison avec le stockage passe de deux façons :
1. **Se connecter** : redirection vers l'interface Nextcloud (`<cloudUrl>/login`).
2. **Mes fichiers** : la page parle directement à l'API WebDAV de Nextcloud depuis le navigateur. Nginx autorise uniquement l'origine du site (variable `SITE_ORIGIN`) grâce aux en-têtes CORS.

---

## 1. Lancer le serveur cloud en local (Docker)

Prérequis : [Docker Desktop](https://www.docker.com/products/docker-desktop/) sous Windows (avec WSL 2), ou Docker Engine sous Ubuntu.

```bash
cd infra
cp .env.example .env        # puis éditer .env : mots de passe, SITE_ORIGIN, NC_DOMAIN
docker compose up -d
docker compose logs -f nextcloud   # attendre « Nextcloud was successfully installed »
```

- Ouvrir **https://localhost**, accepter le certificat auto-signé, puis se connecter avec `NEXTCLOUD_ADMIN_USER` et `NEXTCLOUD_ADMIN_PASSWORD`.
- Si le port 443 est déjà pris : mettre `HTTPS_PORT=8443` dans `.env`, puis utiliser `https://localhost:8443`.
- Le premier démarrage prend 1 à 3 minutes (installation de Nextcloud).

Commandes utiles :

```bash
docker compose ps                                          # état des services
docker compose exec -u www-data nextcloud php occ status   # état de Nextcloud
docker compose exec -u www-data nextcloud php occ user:add alice   # créer un utilisateur
docker compose down                                        # arrêt (les données restent dans les volumes)
```

### Production (VM Ubuntu + NAS)

1. Sur le NAS Synology, créer un dossier partagé et autoriser la VM en NFS (lecture/écriture).
2. Dans `.env` : renseigner `NC_DOMAIN`, `NAS_IP` et `NAS_EXPORT`.
3. Lancer :
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.nas.yml up -d
   ```
4. Sur le FortiGate : NAT du port 443 vers la VM. Réserver SSH et DSM au LAN d'administration.
5. Avec un domaine public, remplacer `infra/nginx/certs/cloud.crt` et `cloud.key` par un certificat Let's Encrypt.
6. Sauvegarde quotidienne : `crontab -e`, puis ajouter `0 2 * * * cd /opt/cloud-souverain/infra && ./scripts/backup.sh`

## 2. Tester le site en local

- **Aperçu rapide** : double-cliquer sur `site/index.html`.
- **Test complet** (nécessaire pour « Mes fichiers ») : dans VS Code, installer l'extension **Live Server**, faire un clic droit sur `site/index.html`, puis choisir « Open with Live Server » (adresse `http://127.0.0.1:5500`). Avec Python, `python -m http.server 8000` dans `site/` fait aussi l'affaire.

Nginx autorise déjà les origines `localhost` et `127.0.0.1`, quel que soit le port. La page « Mes fichiers » fonctionne donc en local avec le serveur Docker.

## 3. Publier sur GitHub Pages

1. Créer un dépôt GitHub **public**, puis pousser ce dossier :
   ```bash
   git init
   git add .
   git commit -m "Site vitrine + infrastructure Nextcloud"
   git branch -M main
   git remote add origin https://github.com/<compte>/<depot>.git
   git push -u origin main
   ```
2. Sur GitHub : **Settings › Pages › Source = GitHub Actions**. Le workflow publie `site/` à chaque push.
3. Cocher **Enforce HTTPS**. Pour un domaine personnalisé (`www.<domaine>`), le renseigner dans Settings › Pages.
4. Dans `site/assets/js/config.js`, renseigner `cloudUrl`. Dans `infra/.env`, mettre `SITE_ORIGIN=https://<compte>.github.io`, puis lancer `docker compose up -d nginx`.

## 4. Utiliser la page « Mes fichiers »

1. Se connecter une fois à Nextcloud et accepter le certificat s'il est auto-signé.
2. Dans Nextcloud : **Paramètres › Sécurité › Créer un mot de passe d'application**. Ce mot de passe est obligatoire si la 2FA est activée.
3. Sur `fichiers.html` : saisir l'adresse du serveur, l'identifiant et ce mot de passe.

Fonctions disponibles : parcourir les dossiers, envoyer des fichiers (glisser-déposer, barre de progression), télécharger, renommer, supprimer (vers la corbeille), créer un dossier, rechercher, afficher l'espace utilisé.
Les identifiants sont gardés dans `sessionStorage` et effacés à la fermeture de l'onglet.

> Si le site public (github.io) appelle un serveur sur une IP privée, Chrome peut demander l'autorisation d'« accéder aux appareils du réseau local ». Il faut l'accepter.

## Sécurité : rappels

- Ne jamais committer `infra/.env` ni `infra/nginx/certs/*` (déjà exclus par `.gitignore`).
- `config.js` est public : n'y mettre qu'une URL.
- 2FA TOTP et protection anti-force brute sont activées automatiquement au premier démarrage.
- Seul le port 443 est publié par Docker (service `nginx`).
