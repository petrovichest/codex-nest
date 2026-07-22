package com.codexnest.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    static final String EXTRA_THREAD_ID = "com.codexnest.app.THREAD_ID";
    private static final String CAPACITOR_PREFERENCES = "CapacitorStorage";
    private static final String PENDING_THREAD_KEY = "codexnest.pendingThreadId";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SelfHostedNotificationsPlugin.class);
        storePendingThread(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        storePendingThread(intent);
        super.onNewIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        SelfHostedNotificationService.setAppVisible(true);
    }

    @Override
    protected void onStop() {
        SelfHostedNotificationService.setAppVisible(false);
        super.onStop();
    }

    private void storePendingThread(Intent intent) {
        if (intent == null) return;
        String threadId = intent.getStringExtra(EXTRA_THREAD_ID);
        if (threadId == null || threadId.isBlank()) return;
        SharedPreferences preferences = getSharedPreferences(CAPACITOR_PREFERENCES, Context.MODE_PRIVATE);
        preferences.edit().putString(PENDING_THREAD_KEY, threadId).apply();
    }

    static void clearPendingThread(Context context) {
        context
            .getSharedPreferences(CAPACITOR_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .remove(PENDING_THREAD_KEY)
            .apply();
    }
}
