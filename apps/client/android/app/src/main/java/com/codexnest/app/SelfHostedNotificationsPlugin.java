package com.codexnest.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "SelfHostedNotifications",
    permissions = @Permission(
        strings = { Manifest.permission.POST_NOTIFICATIONS },
        alias = SelfHostedNotificationsPlugin.NOTIFICATIONS
    )
)
public class SelfHostedNotificationsPlugin extends Plugin {

    static final String NOTIFICATIONS = "receive";

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolveGranted(call);
        } else {
            super.checkPermissions(call);
        }
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED
        ) {
            resolveGranted(call);
        } else {
            requestPermissionForAlias(NOTIFICATIONS, call, "permissionsCallback");
        }
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        checkPermissions(call);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!SecureConnectionSettings.isStored(getContext())) {
            call.reject("Connection settings are unavailable");
            return;
        }
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED
        ) {
            call.reject("Notification permission is not granted");
            return;
        }
        ContextCompat.startForegroundService(
            getContext(),
            new Intent(getContext(), SelfHostedNotificationService.class)
        );
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), SelfHostedNotificationService.class));
        call.resolve();
    }

    @PluginMethod
    public void setLanguage(PluginCall call) {
        String language = call.getString("language");
        if (!"en".equals(language) && !"ru".equals(language)) {
            call.reject("Unsupported language");
            return;
        }
        SelfHostedNotificationService.setUiLanguage(getContext(), language);
        call.resolve();
    }

    @PluginMethod
    public void acknowledgeThread(PluginCall call) {
        String threadId = call.getString("threadId");
        if (threadId == null || threadId.isBlank()) {
            call.reject("Thread id is required");
            return;
        }
        MainActivity.acknowledgePendingThread(getContext(), threadId);
        call.resolve();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String threadId = intent.getStringExtra(MainActivity.EXTRA_THREAD_ID);
        if (threadId == null || threadId.isBlank()) return;
        JSObject event = new JSObject();
        event.put("threadId", threadId);
        notifyListeners("notificationActionPerformed", event, true);
    }

    private void resolveGranted(PluginCall call) {
        JSObject result = new JSObject();
        result.put(NOTIFICATIONS, "granted");
        call.resolve(result);
    }
}
