importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCVN3jsDqQAAaniP9IXurWXSnsX0Xk3aWE",
  authDomain: "helvetia-tools.firebaseapp.com",
  projectId: "helvetia-tools",
  storageBucket: "helvetia-tools.firebasestorage.app",
  messagingSenderId: "125008868109",
  appId: "1:125008868109:web:4687d2b05b94701ecf7644"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Notification reçue :", payload);
  const notificationTitle = (payload.notification && payload.notification.title) || "VigieSwiss";
  const notificationOptions = {
    body: (payload.notification && payload.notification.body) || "Nouvelle notification",
    icon: "/helvetia-tools-v2/launchericon-192x192.png",
    badge: "/helvetia-tools-v2/launchericon-192x192.png",
    data: payload.data || {}
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});
