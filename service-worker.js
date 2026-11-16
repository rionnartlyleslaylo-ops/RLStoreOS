"use strict";

const CACHE_NAME = "rlstoreos-shell-v9";
const APP_SHELL = [
  "./index.html",
  "./style.css",
  "./supabase-config.js",
  "./supabase-client.js",
  "./app.js",
  "./manifest.json",
  "./assets/logo.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith("rlstoreos-shell-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).catch(error => {
        if (request.mode === "navigate") {
          return caches.match("./index.html").then(shell => shell || Promise.reject(error));
        }
        return Promise.reject(error);
      });
    })
  );
});
