package com.codexnest.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

public class SelfHostedNotificationService extends Service {

    private static final String SERVICE_CHANNEL = "codexnest_connection";
    private static final String EVENT_CHANNEL = "codexnest_events";
    private static final int SERVICE_NOTIFICATION_ID = 41;
    private static final String STATE_PREFERENCES = "CodexNestNotifications";
    private static final String LAST_OBSERVED_AT = "lastObservedAt";
    private static volatile boolean appVisible;
    private static volatile SelfHostedNotificationService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reconnect = this::connect;
    private OkHttpClient client;
    private WebSocket socket;
    private NotificationEventTracker tracker;
    private int retry;
    private boolean stopping;

    static void setAppVisible(boolean visible) {
        appVisible = visible;
        SelfHostedNotificationService current = instance;
        if (current != null) current.handler.post(current::handleVisibilityChange);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannels();
        long lastObservedAt = getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
            .getLong(LAST_OBSERVED_AT, 0);
        tracker = new NotificationEventTracker(lastObservedAt);
        client = new OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build();
        startAsForeground(statusNotification("Подключение…"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopping = false;
        handler.removeCallbacks(reconnect);
        handleVisibilityChange();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        if (instance == this) instance = null;
        handler.removeCallbacks(reconnect);
        WebSocket current = socket;
        socket = null;
        if (current != null) current.close(1000, "Service stopped");
        if (client != null) {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
        super.onDestroy();
    }

    private void connect() {
        if (stopping || appVisible) return;
        SecureConnectionSettings.Value settings = SecureConnectionSettings.read(this);
        if (settings == null) {
            updateStatus("Откройте приложение для настройки");
            stopSelf();
            return;
        }

        WebSocket previous = socket;
        socket = null;
        if (previous != null) previous.cancel();
        HttpUrl base = HttpUrl.parse(settings.baseUrl);
        if (base == null) {
            scheduleReconnect();
            return;
        }
        HttpUrl webSocketUrl = base.newBuilder()
            .encodedPath("/api/v1/events")
            .query(null)
            .fragment(null)
            .build();
        Request request = new Request.Builder()
            .url(webSocketUrl)
            .header("Origin", "http://localhost")
            .build();
        updateStatus("Подключение…");
        socket = client.newWebSocket(request, new Listener(settings.token));
    }

    private void handleVisibilityChange() {
        handler.removeCallbacks(reconnect);
        if (appVisible) {
            WebSocket current = socket;
            socket = null;
            if (current != null) current.cancel();
            updateStatus("Приложение открыто");
        } else {
            connect();
        }
    }

    private void scheduleReconnect() {
        if (stopping || appVisible) return;
        updateStatus("Нет связи, переподключение…");
        long[] delays = { 1_000, 2_000, 4_000, 8_000, 15_000, 30_000 };
        long delay = delays[Math.min(retry, delays.length - 1)];
        retry += 1;
        handler.removeCallbacks(reconnect);
        handler.postDelayed(reconnect, delay);
    }

    private final class Listener extends WebSocketListener {

        private final String token;

        Listener(String token) {
            this.token = token;
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            if (webSocket != socket) return;
            try {
                JSONObject authentication = new JSONObject();
                authentication.put("type", "authenticate");
                authentication.put("token", token);
                webSocket.send(authentication.toString());
                updateStatus("Авторизация…");
            } catch (Exception error) {
                webSocket.close(1008, "Authentication failed");
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            if (webSocket != socket) return;
            try {
                JSONObject frame = new JSONObject(text);
                if ("snapshot".equals(frame.optString("type"))) {
                    retry = 0;
                    updateStatus("Подключено");
                }
                List<CodexNotification> notifications = tracker.accept(text);
                getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE)
                    .edit()
                    .putLong(LAST_OBSERVED_AT, tracker.lastObservedAt())
                    .apply();
                if (!appVisible) {
                    for (CodexNotification notification : notifications) notifyEvent(notification);
                }
            } catch (Exception ignored) {
                webSocket.close(1003, "Malformed frame");
            }
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (webSocket != socket) return;
            socket = null;
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable error, Response response) {
            if (webSocket != socket) return;
            socket = null;
            scheduleReconnect();
        }
    }

    private void notifyEvent(CodexNotification event) {
        String title;
        if (event.kind == CodexNotification.Kind.COMPLETED) {
            title = "Задача завершена";
        } else if (event.kind == CodexNotification.Kind.FAILED) {
            title = "Задача завершилась с ошибкой";
        } else {
            title = "Codex ждёт решения";
        }

        Intent intent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (event.threadId != null) intent.putExtra(MainActivity.EXTRA_THREAD_ID, event.threadId);
        int requestCode = (event.kind.name() + ":" + event.threadId).hashCode();
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification notification = new NotificationCompat.Builder(this, EVENT_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(event.threadTitle)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build();
        int notificationId = 1_000 + Math.abs(requestCode % 1_000_000);
        NotificationManagerCompat.from(this).notify(notificationId, notification);
    }

    private Notification statusNotification(String status) {
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("CodexNest")
            .setContentText(status)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void updateStatus(String status) {
        NotificationManagerCompat.from(this).notify(SERVICE_NOTIFICATION_ID, statusNotification(status));
    }

    private void startAsForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            );
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification);
        }
    }

    private void createChannels() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel service = new NotificationChannel(
            SERVICE_CHANNEL,
            "Подключение CodexNest",
            NotificationManager.IMPORTANCE_LOW
        );
        service.setDescription("Постоянное подключение к домашнему серверу");
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel events = new NotificationChannel(
            EVENT_CHANNEL,
            "События CodexNest",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        events.setDescription("Завершение задач и запросы решения");
        manager.createNotificationChannel(events);
    }
}
