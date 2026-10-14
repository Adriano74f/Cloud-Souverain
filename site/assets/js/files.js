/*
 * Page "Mes fichiers" : client WebDAV minimal pour Nextcloud.
 * Le navigateur parle directement au serveur (CORS autorisé par Nginx) :
 *   - OCS    /ocs/v2.php/cloud/user           -> profil + quota
 *   - WebDAV /remote.php/dav/files/<user>/... -> liste, envoi, téléchargement, renommage, déplacement, suppression
 * Les identifiants restent dans sessionStorage (effacés à la fermeture de l'onglet).
 */
(function () {
  "use strict";

  var cfg = window.CLOUD_CONFIG || {};
  var ICONS = "#";
  var SESSION_KEY = "cs-session";

  var session = null;   // { server, login, pass, userId, displayName }
  var items = [];       // contenu du dossier courant
  var currentPath = "/";

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- utilitaires

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function icon(name) { return '<svg><use href="' + ICONS + name + '"/></svg>'; }

  function formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return "—";
    if (bytes < 1024) return bytes + " o";
    var units = ["Ko", "Mo", "Go", "To", "Po"], i = -1;
    do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
    return bytes.toLocaleString("fr-FR", { maximumFractionDigits: bytes < 10 ? 1 : 0 }) + " " + units[i];
  }

  var dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  function formatDate(d) { return d && !isNaN(d) ? dateFmt.format(d) : "—"; }

  function fileKind(name, isDir) {
    if (isDir) return { cls: "folder", icon: "i-folder" };
    var ext = (name.split(".").pop() || "").toLowerCase();
    if (/^(png|jpe?g|gif|webp|svg|bmp|heic|tiff?)$/.test(ext)) return { cls: "img", icon: "i-image" };
    if (/^(mp4|mov|avi|mkv|webm|m4v)$/.test(ext)) return { cls: "vid", icon: "i-video" };
    if (/^(mp3|wav|flac|ogg|m4a|aac)$/.test(ext)) return { cls: "vid", icon: "i-music" };
    if (ext === "pdf") return { cls: "pdf", icon: "i-file-text" };
    if (/^(docx?|odt|txt|md|rtf|xlsx?|ods|csv|pptx?|odp)$/.test(ext)) return { cls: "doc", icon: "i-file-text" };
    if (/^(zip|rar|7z|tar|gz|bz2|xz|iso)$/.test(ext)) return { cls: "file", icon: "i-archive" };
    return { cls: "file", icon: "i-file" };
  }

  function joinPath(dir, name) { return (dir.replace(/\/$/, "") + "/" + name); }

  function toast(msg, isError) {
    var el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(function () { el.remove(); }, isError ? 6000 : 3500);
  }

  // ---------------------------------------------------------------- API Nextcloud

  function authHeader(login, pass) {
    var bytes = new TextEncoder().encode(login + ":" + pass);
    var bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return "Basic " + btoa(bin);
  }

  function davRoot() { return session.server + "/remote.php/dav/files/" + encodeURIComponent(session.userId); }

  function davUrl(path) {
    return davRoot() + path.split("/").map(encodeURIComponent).join("/");
  }

  function request(method, url, opts) {
    opts = opts || {};
    var headers = Object.assign({ Authorization: authHeader(session.login, session.pass) }, opts.headers || {});
    return fetch(url, { method: method, headers: headers, body: opts.body, credentials: "omit", cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { logout(); throw new Error("Session expirée ou identifiants invalides."); }
        if (!res.ok && res.status !== 207) {
          var err = new Error(httpMessage(res.status));
          err.status = res.status;
          throw err;
        }
        return res;
      });
  }

  function httpMessage(status) {
    switch (status) {
      case 403: return "Action non autorisée.";
      case 404: return "Élément introuvable.";
      case 405: return "Un élément portant ce nom existe déjà.";
      case 409: return "Conflit : le dossier parent n'existe pas.";
      case 412: return "Un élément portant ce nom existe déjà.";
      case 423: return "Fichier verrouillé, réessayez plus tard.";
      case 507: return "Espace de stockage insuffisant sur le serveur.";
      default:  return "Erreur du serveur (" + status + ").";
    }
  }

  function fetchProfile(server, login, pass) {
    return fetch(server + "/ocs/v2.php/cloud/user?format=json", {
      headers: { Authorization: authHeader(login, pass), "OCS-APIRequest": "true", Accept: "application/json" },
      credentials: "omit",
      cache: "no-store"
    }).then(function (res) {
      if (res.status === 401) throw new Error("Identifiant ou mot de passe incorrect.");
      if (!res.ok) throw new Error("Le serveur a répondu avec l'erreur " + res.status + ".");
      return res.json();
    }).then(function (json) { return json.ocs.data; });
  }

  var PROPFIND_BODY =
    '<?xml version="1.0"?>' +
    '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>' +
    "<d:getlastmodified/><d:getcontentlength/><d:resourcetype/><oc:size/>" +
    "</d:prop></d:propfind>";

  function listFolder(path) {
    return request("PROPFIND", davUrl(path.replace(/\/?$/, "/")), {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY
    }).then(function (res) { return res.text(); })
      .then(function (xml) { return parseMultistatus(xml, path); });
  }

  function parseMultistatus(xml, folderPath) {
    var doc = new DOMParser().parseFromString(xml, "application/xml");
    var DAV = "DAV:", OC = "http://owncloud.org/ns";
    var rootPath = new URL(davRoot()).pathname;
    var rootDecoded = decodeURIComponent(rootPath).replace(/\/$/, "");
    var self = folderPath.replace(/\/$/, "");
    var out = [];

    Array.prototype.forEach.call(doc.getElementsByTagNameNS(DAV, "response"), function (r) {
      var href = r.getElementsByTagNameNS(DAV, "href")[0].textContent;
      var full = decodeURIComponent(new URL(href, session.server).pathname).replace(/\/$/, "");
      var rel = full.slice(rootDecoded.length) || "";
      if (rel === self) return; // le dossier lui-même

      var text = function (ns, tag) { var n = r.getElementsByTagNameNS(ns, tag)[0]; return n ? n.textContent : null; };
      var isDir = r.getElementsByTagNameNS(DAV, "collection").length > 0;
      var size = isDir ? text(OC, "size") : text(DAV, "getcontentlength");
      var mod = text(DAV, "getlastmodified");

      out.push({
        name: rel.split("/").pop(),
        path: rel,
        isDir: isDir,
        size: size != null ? Number(size) : null,
        modified: mod ? new Date(mod) : null
      });
    });

    return out.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "fr", { numeric: true, sensitivity: "base" });
    });
  }

  // ---------------------------------------------------------------- session

  function saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* stockage indisponible */ }
  }

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }

  function logout() {
    session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("f-pass").value = "";
  }

  function normalizeServer(url) {
    url = url.trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    return url;
  }

  function showLoginError(html) {
    var box = $("login-error");
    box.innerHTML = html;
    box.hidden = !html;
  }

  function onLogin(e) {
    e.preventDefault();
    var server = normalizeServer($("f-server").value);
    var login = $("f-user").value.trim();
    var pass = $("f-pass").value;
    if (!server || !login || !pass) { showLoginError("Merci de remplir tous les champs."); return; }

    var btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "Connexion…";
    showLoginError("");

    fetchProfile(server, login, pass)
      .then(function (data) {
        session = { server: server, login: login, pass: pass, userId: data.id, displayName: data.displayname || data.id };
        saveSession();
        startApp(data);
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          showLoginError(
            "Impossible de joindre le serveur. Vérifiez qu'il est démarré, puis " +
            '<a href="' + esc(server) + '/login" target="_blank" rel="noopener">ouvrez-le dans un nouvel onglet</a> ' +
            "pour accepter son certificat, et réessayez."
          );
        } else {
          showLoginError(esc(err.message));
        }
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "Se connecter";
      });
  }

  function startApp(profile) {
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("user-name").textContent = session.displayName;
    $("avatar").textContent = (session.displayName || "?").trim().charAt(0).toUpperCase();
    document.querySelectorAll("[data-open-nc]").forEach(function (a) {
      a.href = session.server + a.getAttribute("data-open-nc");
    });
    if (profile) renderQuota(profile.quota);
    else refreshQuota();
    navigate();
  }

  function refreshQuota() {
    fetchProfile(session.server, session.login, session.pass)
      .then(function (p) { renderQuota(p.quota); })
      .catch(function () { /* non bloquant */ });
  }

  function renderQuota(q) {
    if (!q) return;
    $("quota-used").textContent = formatSize(q.used || 0);
    var limited = q.quota > 0;
    $("quota-total").textContent = limited ? "sur " + formatSize(q.quota) : "Espace illimité";
    var pct = limited ? Math.min(100, q.relative || 0) : 4;
    $("quota-bar").style.width = Math.max(2, pct) + "%";
  }

  // ---------------------------------------------------------------- navigation & rendu

  function pathFromHash() {
    var raw = location.hash.replace(/^#/, "") || "/";
    try { raw = decodeURIComponent(raw); } catch (e) { raw = "/"; }
    raw = "/" + raw.split("/").filter(function (s) { return s && s !== "." && s !== ".."; }).join("/");
    return raw;
  }

  function hashFor(path) { return "#" + path.split("/").map(encodeURIComponent).join("/"); }

  function navigate() {
    if (!session) return;
    currentPath = pathFromHash();
    $("search").value = "";
    renderCrumbs();
    setState("loading");
    $("file-rows").innerHTML = "";
    listFolder(currentPath)
      .then(function (list) { items = list; renderList(); })
      .catch(function (err) {
        items = [];
        $("file-rows").innerHTML = "";
        if (err instanceof TypeError) setState("error", "Connexion au serveur perdue.");
        else if (err.status === 404) { toast("Ce dossier n'existe plus.", true); location.hash = "#/"; }
        else setState("error", err.message);
      });
  }

  function reload() {
    return listFolder(currentPath).then(function (list) { items = list; renderList(); });
  }

  function renderCrumbs() {
    var parts = currentPath.split("/").filter(Boolean);
    var html = parts.length ? '<a href="#/" data-path="/">Tous les fichiers</a>' : '<span class="current">Tous les fichiers</span>';
    var acc = "";
    parts.forEach(function (p, i) {
      acc += "/" + p;
      html += '<span class="sep">/</span>';
      html += i === parts.length - 1
        ? '<span class="current" title="' + esc(p) + '">' + esc(p) + "</span>"
        : '<a href="' + esc(hashFor(acc)) + '" data-path="' + esc(acc) + '">' + esc(p) + "</a>";
    });
    $("crumbs").innerHTML = html;
  }

  function setState(kind, msg) {
    var box = $("state");
    if (!kind) { box.hidden = true; return; }
    box.hidden = false;
    if (kind === "loading") box.innerHTML = '<div class="spinner"></div>Chargement…';
    else if (kind === "empty") box.innerHTML = icon("i-folder") + "<b>Ce dossier est vide</b>Glissez-déposez des fichiers ou cliquez sur « Envoyer ».";
    else if (kind === "nomatch") box.innerHTML = icon("i-search") + "<b>Aucun résultat</b>Aucun élément ne correspond à votre recherche.";
    else box.innerHTML = icon("i-cloud") + "<b>Une erreur est survenue</b>" + esc(msg || "");
  }

  function renderList() {
    var q = $("search").value.trim().toLowerCase();
    var shown = items.filter(function (it) { return !q || it.name.toLowerCase().indexOf(q) !== -1; });

    $("file-rows").innerHTML = shown.map(function (it) {
      var k = fileKind(it.name, it.isDir);
      var idx = items.indexOf(it);
      return '<tr draggable="true" data-i="' + idx + '">' +
        '<td><div class="name-cell"><span class="ficon ' + k.cls + '">' + icon(k.icon) + "</span>" +
          '<button data-act="open" data-i="' + idx + '" title="' + esc(it.name) + '">' + esc(it.name) + "</button></div></td>" +
        '<td class="meta">' + (it.isDir ? (it.size != null ? formatSize(it.size) : "—") : formatSize(it.size)) + "</td>" +
        '<td class="meta">' + formatDate(it.modified) + "</td>" +
        '<td><div class="row-actions">' +
          (it.isDir ? "" : '<button class="icon-btn" data-act="download" data-i="' + idx + '" title="Télécharger" aria-label="Télécharger ' + esc(it.name) + '">' + icon("i-download") + "</button>") +
          '<button class="icon-btn" data-act="rename" data-i="' + idx + '" title="Renommer" aria-label="Renommer ' + esc(it.name) + '">' + icon("i-edit") + "</button>" +
          '<button class="icon-btn" data-act="move" data-i="' + idx + '" title="Déplacer" aria-label="Déplacer ' + esc(it.name) + '">' + icon("i-move") + "</button>" +
          '<button class="icon-btn danger" data-act="delete" data-i="' + idx + '" title="Supprimer" aria-label="Supprimer ' + esc(it.name) + '">' + icon("i-trash") + "</button>" +
        "</div></td>" +
      "</tr>";
    }).join("");

    if (!items.length) setState("empty");
    else if (!shown.length) setState("nomatch");
    else setState(null);
  }

  // ---------------------------------------------------------------- actions

  function onRowClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var it = items[Number(btn.getAttribute("data-i"))];
    if (!it) return;
    var act = btn.getAttribute("data-act");
    if (act === "open") it.isDir ? (location.hash = hashFor(it.path)) : download(it);
    else if (act === "download") download(it);
    else if (act === "rename") rename(it);
    else if (act === "move") openMovePicker(it);
    else if (act === "delete") remove(it);
  }

  function download(it) {
    toast("Téléchargement de « " + it.name + " »…");
    request("GET", davUrl(it.path))
      .then(function (res) { return res.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = it.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      })
      .catch(function (err) { toast(err.message || "Téléchargement impossible.", true); });
  }

  function validName(name) {
    return name && !/[\/\\]/.test(name) && name !== "." && name !== "..";
  }

  function exists(name) {
    return items.some(function (it) { return it.name.toLowerCase() === name.toLowerCase(); });
  }

  function rename(it) {
    openModal({ title: "Renommer", input: it.name, ok: "Renommer" }).then(function (name) {
      if (name == null) return;
      name = name.trim();
      if (name === it.name) return;
      if (!validName(name)) return toast("Nom invalide.", true);
      if (exists(name)) return toast("Un élément portant ce nom existe déjà.", true);
      var dest = joinPath(currentPath, name);
      request("MOVE", davUrl(it.path), { headers: { Destination: davUrl(dest), Overwrite: "F" } })
        .then(function () { toast("Élément renommé."); return reload(); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  function remove(it) {
    openModal({
      title: "Supprimer « " + it.name + " » ?",
      text: it.isDir ? "Le dossier et tout son contenu seront placés dans la corbeille." : "Le fichier sera placé dans la corbeille.",
      ok: "Supprimer",
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      request("DELETE", davUrl(it.path))
        .then(function () { toast("Élément supprimé."); refreshQuota(); return reload(); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  function mkdir() {
    openModal({ title: "Nouveau dossier", input: "", placeholder: "Nom du dossier", ok: "Créer" }).then(function (name) {
      if (name == null) return;
      name = name.trim();
      if (!validName(name)) return toast("Nom invalide.", true);
      if (exists(name)) return toast("Un élément portant ce nom existe déjà.", true);
      request("MKCOL", davUrl(joinPath(currentPath, name)))
        .then(function () { toast("Dossier créé."); return reload(); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  // ---------------------------------------------------------------- déplacement

  function parentDir(path) { return path.replace(/\/[^\/]*$/, "") || "/"; }

  function folderLabel(path) { return path === "/" ? "Tous les fichiers" : path.split("/").pop(); }

  // Vrai si "dir" est le dossier "it" lui-même ou l'un de ses sous-dossiers
  function isInside(dir, it) { return it.isDir && (dir === it.path || dir.indexOf(it.path + "/") === 0); }

  function moveItem(it, destDir) {
    if (destDir === parentDir(it.path)) return toast("L'élément est déjà dans ce dossier.");
    if (isInside(destDir, it)) return toast("Impossible de déplacer un dossier dans lui-même.", true);
    request("MOVE", davUrl(it.path), { headers: { Destination: davUrl(joinPath(destDir, it.name)), Overwrite: "F" } })
      .then(function () { toast("« " + it.name + " » déplacé vers « " + folderLabel(destDir) + " »."); return reload(); })
      .catch(function (err) {
        toast(err.status === 412 ? "« " + it.name + " » existe déjà dans le dossier de destination." : err.message, true);
      });
  }

  // Fenêtre de choix du dossier de destination
  var picker = null; // { item, path, folders }

  function openMovePicker(it) {
    picker = { item: it, path: currentPath, folders: [] };
    $("move-title").textContent = "Déplacer « " + it.name + " »";
    $("move-modal").hidden = false;
    loadPicker(currentPath);
    setTimeout(function () { $("move-cancel").focus(); }, 0);
  }

  function closeMovePicker() {
    picker = null;
    $("move-modal").hidden = true;
  }

  function loadPicker(path) {
    var p = picker;
    p.path = path;
    p.folders = [];
    renderPickerCrumbs();
    $("move-ok").disabled = path === parentDir(p.item.path) || isInside(path, p.item);
    $("move-list").innerHTML = '<li class="move-state"><div class="spinner"></div></li>';
    listFolder(path)
      .then(function (list) {
        if (picker !== p || p.path !== path) return; // l'utilisateur a changé de dossier entre-temps
        p.folders = list.filter(function (f) { return f.isDir; });
        renderPickerList();
      })
      .catch(function (err) {
        if (picker !== p || p.path !== path) return;
        $("move-list").innerHTML = '<li class="move-state">' + esc(err.message || "Chargement impossible.") + "</li>";
      });
  }

  function renderPickerCrumbs() {
    var acc = "";
    var html = '<button type="button" data-path="/">Tous les fichiers</button>';
    picker.path.split("/").filter(Boolean).forEach(function (p) {
      acc += "/" + p;
      html += '<span class="sep">/</span><button type="button" data-path="' + esc(acc) + '">' + esc(p) + "</button>";
    });
    $("move-crumbs").innerHTML = html;
  }

  function renderPickerList() {
    if (!picker.folders.length) {
      $("move-list").innerHTML = '<li class="move-state">Aucun sous-dossier</li>';
      return;
    }
    $("move-list").innerHTML = picker.folders.map(function (f, i) {
      var self = f.path === picker.item.path;
      return '<li><button type="button" data-i="' + i + '"' + (self ? " disabled" : "") + ">" +
        icon("i-folder") + "<span>" + esc(f.name) + "</span></button></li>";
    }).join("");
  }

  // Glisser-déposer d'une ligne sur un dossier de la liste ou du fil d'Ariane
  var dragIndex = null;

  function dropTargetFrom(e) {
    if (dragIndex == null) return null;
    var el = e.target.closest && e.target.closest("#file-rows tr[data-i], #crumbs a[data-path]");
    if (!el) return null;
    var it = items[dragIndex], path;
    if (el.hasAttribute("data-path")) {
      path = el.getAttribute("data-path");
    } else {
      var target = items[Number(el.getAttribute("data-i"))];
      if (!target || !target.isDir || target === it) return null;
      path = target.path;
    }
    if (path === parentDir(it.path) || isInside(path, it)) return null;
    return { el: el, path: path };
  }

  function clearDropTargets() {
    document.querySelectorAll(".drop-target, .dragging").forEach(function (el) {
      el.classList.remove("drop-target", "dragging");
    });
  }

  function setupRowDrag() {
    $("file-rows").addEventListener("dragstart", function (e) {
      var tr = e.target.closest && e.target.closest("tr[data-i]");
      if (!tr) return;
      dragIndex = Number(tr.getAttribute("data-i"));
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", items[dragIndex].name); // requis par Firefox
      tr.classList.add("dragging");
    });
    document.addEventListener("dragend", function () { dragIndex = null; clearDropTargets(); });

    [$("file-rows"), $("crumbs")].forEach(function (zone) {
      zone.addEventListener("dragover", function (e) {
        var t = dropTargetFrom(e);
        if (!t) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!t.el.classList.contains("drop-target")) {
          document.querySelectorAll(".drop-target").forEach(function (el) { el.classList.remove("drop-target"); });
          t.el.classList.add("drop-target");
        }
      });
      zone.addEventListener("dragleave", function (e) {
        var el = e.target.closest && e.target.closest(".drop-target");
        if (el && !el.contains(e.relatedTarget)) el.classList.remove("drop-target");
      });
      zone.addEventListener("drop", function (e) {
        var t = dropTargetFrom(e);
        if (!t) return;
        e.preventDefault();
        var it = items[dragIndex];
        dragIndex = null;
        clearDropTargets();
        moveItem(it, t.path);
      });
    });
  }

  // ---------------------------------------------------------------- envoi de fichiers

  var queue = [];
  var uploading = false;

  function uniqueName(name, taken) {
    if (!taken(name)) return name;
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : "";
    for (var n = 1; ; n++) {
      var candidate = base + " (" + n + ")" + ext;
      if (!taken(candidate)) return candidate;
    }
  }

  function enqueue(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var pending = queue.map(function (j) { return j.name.toLowerCase(); });
    var taken = function (n) { return exists(n) || pending.indexOf(n.toLowerCase()) !== -1; };

    $("uploads").hidden = false;
    files.forEach(function (file) {
      var name = uniqueName(file.name, taken);
      pending.push(name.toLowerCase());
      var li = document.createElement("li");
      li.innerHTML = '<div class="up-row"><span></span><span>En attente</span></div><div class="up-bar"><span></span></div>';
      li.querySelector(".up-row span").textContent = name;
      $("uploads-list").appendChild(li);
      queue.push({ file: file, name: name, dir: currentPath, li: li });
    });
    updateUploadTitle();
    if (!uploading) nextUpload();
  }

  function updateUploadTitle() {
    var left = queue.length + (uploading ? 1 : 0);
    $("uploads-title").textContent = left ? "Envoi en cours (" + left + ")" : "Envois terminés";
  }

  function nextUpload() {
    var job = queue.shift();
    if (!job) {
      uploading = false;
      updateUploadTitle();
      refreshQuota();
      return;
    }
    uploading = true;
    updateUploadTitle();

    var status = job.li.querySelector(".up-row span:last-child");
    var bar = job.li.querySelector(".up-bar span");
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", davUrl(joinPath(job.dir, job.name)));
    xhr.setRequestHeader("Authorization", authHeader(session.login, session.pass));
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = pct + "%";
      status.textContent = pct + " %";
    };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        job.li.classList.add("done");
        bar.style.width = "100%";
        status.textContent = formatSize(job.file.size);
        if (job.dir === currentPath) reload().catch(function () {});
      } else {
        job.li.classList.add("error");
        status.textContent = xhr.status === 401 ? "Non autorisé" : httpMessage(xhr.status);
      }
      nextUpload();
    };
    xhr.onerror = function () {
      job.li.classList.add("error");
      status.textContent = "Échec réseau";
      nextUpload();
    };
    status.textContent = "0 %";
    xhr.send(job.file);
  }

  function setupDragDrop() {
    var zone = $("drop-zone"), overlay = $("drop-overlay"), depth = 0;
    var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") !== -1; };

    zone.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
    zone.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
    zone.addEventListener("dragleave", function () { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
    zone.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      var dropped = [];
      var list = e.dataTransfer.items;
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        var entry = list && list[i] && list[i].webkitGetAsEntry ? list[i].webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) { toast("Les dossiers ne peuvent pas être déposés ici : utilisez l'interface Nextcloud.", true); continue; }
        dropped.push(e.dataTransfer.files[i]);
      }
      enqueue(dropped);
    });
  }

  // ---------------------------------------------------------------- fenêtre modale

  var modalResolve = null;

  function openModal(opts) {
    $("modal-title").textContent = opts.title;
    $("modal-text").textContent = opts.text || "";
    var input = $("modal-input");
    input.hidden = opts.input == null;
    input.value = opts.input || "";
    input.placeholder = opts.placeholder || "";
    var ok = $("modal-ok");
    ok.textContent = opts.ok || "Valider";
    ok.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");
    $("modal").hidden = false;

    setTimeout(function () {
      if (!input.hidden) {
        input.focus();
        var dot = input.value.lastIndexOf(".");
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      } else {
        ok.focus();
      }
    }, 0);

    return new Promise(function (resolve) {
      modalResolve = function (confirmed) {
        $("modal").hidden = true;
        modalResolve = null;
        if (!confirmed) resolve(null);
        else resolve(opts.input == null ? true : input.value);
      };
    });
  }

  // ---------------------------------------------------------------- initialisation

  function init() {
    if (cfg.brand) document.querySelectorAll("[data-brand]").forEach(function (el) { el.textContent = cfg.brand; });
    document.querySelectorAll("[data-login]").forEach(function (a) { a.href = (cfg.cloudUrl || "#") + "/login"; });
    $("f-server").value = cfg.cloudUrl || "";

    $("login-form").addEventListener("submit", onLogin);
    $("logout").addEventListener("click", logout);
    $("file-rows").addEventListener("click", onRowClick);
    $("search").addEventListener("input", renderList);
    $("btn-mkdir").addEventListener("click", mkdir);
    $("btn-upload").addEventListener("click", function () { $("file-input").click(); });
    $("file-input").addEventListener("change", function (e) { enqueue(e.target.files); e.target.value = ""; });
    $("uploads-close").addEventListener("click", function () {
      if (uploading) return toast("Des envois sont encore en cours.");
      $("uploads").hidden = true;
      $("uploads-list").innerHTML = "";
    });

    $("modal-form").addEventListener("submit", function (e) { e.preventDefault(); if (modalResolve) modalResolve(true); });
    $("modal-cancel").addEventListener("click", function () { if (modalResolve) modalResolve(false); });
    $("modal").addEventListener("click", function (e) { if (e.target === $("modal") && modalResolve) modalResolve(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (modalResolve) modalResolve(false);
      else if (picker) closeMovePicker();
    });

    $("move-crumbs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-path]");
      if (b && picker) loadPicker(b.getAttribute("data-path"));
    });
    $("move-list").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-i]");
      if (b && !b.disabled && picker) loadPicker(picker.folders[Number(b.getAttribute("data-i"))].path);
    });
    $("move-ok").addEventListener("click", function () {
      if (!picker) return;
      var it = picker.item, dest = picker.path;
      closeMovePicker();
      moveItem(it, dest);
    });
    $("move-cancel").addEventListener("click", closeMovePicker);
    $("move-modal").addEventListener("click", function (e) { if (e.target === $("move-modal")) closeMovePicker(); });

    window.addEventListener("hashchange", navigate);
    window.addEventListener("beforeunload", function (e) { if (uploading) { e.preventDefault(); e.returnValue = ""; } });
    setupDragDrop();
    setupRowDrag();

    var saved = loadSession();
    if (saved && saved.server && saved.userId) {
      session = saved;
      startApp(null);
    }
  }

  init();
})();
