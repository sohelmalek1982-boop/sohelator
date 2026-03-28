self.addEventListener("push", (event) => {
  let data = { title: "SOHELATOR", body: "New scanner alert" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    try {
      data = { title: "SOHELATOR", body: event.data.text() };
    } catch {
      /* keep default */
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "SOHELATOR", {
      body: data.body || "",
      icon: "/icon.png",
      badge: "/icon.png",
      data: data,
      actions: [
        { action: "view", title: "📊 View Setup" },
        { action: "dismiss", title: "Dismiss" },
      ],
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "view" || !event.action) {
    event.waitUntil(clients.openWindow("/"));
  }
});
