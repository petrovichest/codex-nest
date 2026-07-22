self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadId = event.notification.data?.threadId;
  const path = threadId ? `/threads/${encodeURIComponent(threadId)}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const client = windowClients.find(
        (candidate) => new URL(candidate.url).origin === self.location.origin,
      );
      if (client) return client.navigate(path).then(() => client.focus());
      return self.clients.openWindow(path);
    }),
  );
});
