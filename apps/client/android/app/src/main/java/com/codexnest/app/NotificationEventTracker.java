package com.codexnest.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class NotificationEventTracker {

    private final Map<String, String> threadStates = new HashMap<>();
    private final Map<String, String> threadTitles = new HashMap<>();
    private final Set<String> attentionIds = new HashSet<>();
    private long lastObservedAt;

    NotificationEventTracker(long lastObservedAt) {
        this.lastObservedAt = lastObservedAt;
    }

    synchronized List<CodexNotification> accept(String serializedFrame) throws Exception {
        List<CodexNotification> notifications = new ArrayList<>();
        JSONObject frame = new JSONObject(serializedFrame);
        String type = frame.optString("type");
        if ("snapshot".equals(type)) {
            acceptSnapshot(frame.getJSONObject("snapshot"), notifications);
        } else if ("event".equals(type)) {
            acceptEvent(frame.getJSONObject("event"), notifications);
        }
        return notifications;
    }

    synchronized long lastObservedAt() {
        return lastObservedAt;
    }

    private void acceptSnapshot(JSONObject snapshot, List<CodexNotification> notifications) {
        long cutoff = lastObservedAt;
        boolean firstConnection = cutoff == 0;
        long newest = cutoff;
        threadStates.clear();
        threadTitles.clear();
        attentionIds.clear();

        JSONArray threads = snapshot.optJSONArray("threads");
        if (threads != null) {
            for (int index = 0; index < threads.length(); index += 1) {
                JSONObject thread = threads.optJSONObject(index);
                if (thread == null) continue;
                String id = thread.optString("id");
                String state = thread.optString("state");
                String title = thread.optString("title", "Задача Codex");
                long updatedAt = thread.optLong("updatedAt", 0);
                threadStates.put(id, state);
                threadTitles.put(id, title);
                newest = Math.max(newest, updatedAt);
                if (
                    !firstConnection &&
                    updatedAt > cutoff &&
                    thread.optBoolean("unread", false)
                ) {
                    addTerminalNotification(notifications, state, id, title);
                }
            }
        }

        JSONArray attention = snapshot.optJSONArray("attention");
        if (attention != null) {
            for (int index = 0; index < attention.length(); index += 1) {
                JSONObject request = attention.optJSONObject(index);
                if (request == null) continue;
                String id = request.optString("id");
                attentionIds.add(id);
                long createdAt = request.optLong("createdAt", 0);
                newest = Math.max(newest, createdAt);
                if (!firstConnection && createdAt > cutoff) {
                    String threadId = nullableString(request, "threadId");
                    notifications.add(
                        new CodexNotification(
                            CodexNotification.Kind.ATTENTION,
                            threadId,
                            titleFor(threadId)
                        )
                    );
                }
            }
        }
        lastObservedAt = newest;
    }

    private void acceptEvent(JSONObject event, List<CodexNotification> notifications)
        throws Exception {
        String type = event.optString("type");
        if ("thread.upserted".equals(type)) {
            JSONObject thread = event.getJSONObject("thread");
            String id = thread.optString("id");
            String state = thread.optString("state");
            String title = thread.optString("title", "Задача Codex");
            String previous = threadStates.put(id, state);
            threadTitles.put(id, title);
            if (!state.equals(previous)) addTerminalNotification(notifications, state, id, title);
            lastObservedAt = Math.max(lastObservedAt, thread.optLong("updatedAt", 0));
        } else if ("thread.removed".equals(type)) {
            String id = event.optString("threadId");
            threadStates.remove(id);
            threadTitles.remove(id);
        } else if ("attention.upserted".equals(type)) {
            JSONObject request = event.getJSONObject("attention");
            String id = request.optString("id");
            if (attentionIds.add(id)) {
                String threadId = nullableString(request, "threadId");
                notifications.add(
                    new CodexNotification(
                        CodexNotification.Kind.ATTENTION,
                        threadId,
                        titleFor(threadId)
                    )
                );
            }
            lastObservedAt = Math.max(lastObservedAt, request.optLong("createdAt", 0));
        } else if ("attention.removed".equals(type)) {
            attentionIds.remove(event.optString("attentionId"));
        }
    }

    private void addTerminalNotification(
        List<CodexNotification> notifications,
        String state,
        String threadId,
        String title
    ) {
        if ("completed".equals(state)) {
            notifications.add(
                new CodexNotification(CodexNotification.Kind.COMPLETED, threadId, title)
            );
        } else if ("failed".equals(state)) {
            notifications.add(new CodexNotification(CodexNotification.Kind.FAILED, threadId, title));
        }
    }

    private String titleFor(String threadId) {
        if (threadId == null) return "Откройте CodexNest для подробностей";
        return threadTitles.getOrDefault(threadId, "Задача Codex");
    }

    private static String nullableString(JSONObject object, String key) {
        return object.isNull(key) ? null : object.optString(key, null);
    }
}
