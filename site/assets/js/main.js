(function () {
  "use strict";
  var cfg = window.CLOUD_CONFIG || {};

  // Liens "Se connecter" -> page de connexion Nextcloud
  document.querySelectorAll("[data-login]").forEach(function (a) {
    a.href = (cfg.cloudUrl || "#") + "/login";
  });
  if (cfg.brand) {
    document.querySelectorAll("[data-brand]").forEach(function (el) { el.textContent = cfg.brand; });
  }
  if (cfg.contactEmail) {
    document.querySelectorAll("[data-contact]").forEach(function (el) { el.textContent = cfg.contactEmail; });
  }
  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  // Barre de navigation : fond au défilement + menu mobile
  var nav = document.getElementById("nav");
  var toggle = document.getElementById("nav-toggle");
  function onScroll() { nav.classList.toggle("is-scrolled", window.scrollY > 10); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.querySelectorAll("#nav-links a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Apparition progressive des blocs
  var items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add("is-visible"); });
  }
})();
