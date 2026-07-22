var JOB_DEEP_LINK = /^\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

var FALLBACK_TITLE = 'Servora-Med';
var FALLBACK_BODY = 'Bekleyen işleriniz var.';
var FALLBACK_URL = '/jobs';
var FALLBACK_TAG = 'servora-med-generic';

function parsePayload(data) {
  if (!data) return null;
  var raw;
  try {
    raw = JSON.parse(data.text());
  } catch (_) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== 1) return null;
  var allowed = ['version', 'notificationId', 'title', 'body', 'url'];
  var keys = Object.keys(raw);
  if (keys.length !== allowed.length || !allowed.every(function (k) { return keys.indexOf(k) !== -1; })) return null;
  if (typeof raw.notificationId !== 'string') return null;
  if (typeof raw.title !== 'string' || raw.title.length === 0 || raw.title.length > 120) return null;
  if (typeof raw.body !== 'string' || raw.body.length === 0 || raw.body.length > 240) return null;
  if (typeof raw.url !== 'string') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.notificationId)) return null;
  if (!JOB_DEEP_LINK.test(raw.url)) return null;
  return {
    version: raw.version,
    notificationId: raw.notificationId,
    title: raw.title,
    body: raw.body,
    url: raw.url,
  };
}

function showGenericNotification() {
  return self.registration.showNotification(FALLBACK_TITLE, {
    body: FALLBACK_BODY,
    tag: FALLBACK_TAG,
    icon: '/icons/servora-192.png',
    badge: '/icons/notification-badge.png',
    data: {
      notificationId: null,
      url: FALLBACK_URL,
    },
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  event.waitUntil((async function () {
    var payload = parsePayload(event.data);
    if (!payload) {
      return showGenericNotification();
    }
    return self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.notificationId,
      icon: '/icons/servora-192.png',
      badge: '/icons/notification-badge.png',
      data: {
        notificationId: payload.notificationId,
        url: payload.url,
      },
    });
  })());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil((async function () {
    var targetUrl = event.notification.data && event.notification.data.url;
    var safeUrl = typeof targetUrl === 'string' && JOB_DEEP_LINK.test(targetUrl)
      ? targetUrl
      : FALLBACK_URL;
    var allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    allClients.sort(function (a, b) {
      var aExact = a.url === safeUrl ? 0 : 1;
      var bExact = b.url === safeUrl ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.id.localeCompare(b.id);
    });
    for (var i = 0; i < allClients.length; i++) {
      var client = allClients[i];
      if (client.url === safeUrl) {
        await client.focus();
        return;
      }
    }
    for (var j = 0; j < allClients.length; j++) {
      var otherClient = allClients[j];
      await otherClient.navigate(safeUrl);
      await otherClient.focus();
      return;
    }
    await self.clients.openWindow(safeUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil((async function () {
    var allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (var i = 0; i < allClients.length; i++) {
      allClients[i].postMessage({ type: 'push-subscription-changed' });
    }
  })());
});
