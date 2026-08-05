package com.codexnest.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

final class NotificationEventTracker {

    private final Map<String, String> threadStates = new HashMap<>();
    private final Map<String, String> threadTitles = new HashMap<>();
    private final Map<String, String> attentionThreads = new HashMap<>();
    private long lastObservedAt;
    private long lastRevision = -1;
    private String defaultThreadTitle;
    private String detailsTitle;
    private String untitledThreadTitle;

    NotificationEventTracker(long lastObservedAt) {
        this(lastObservedAt, "Codex task", "Open CodexNest for details", "Untitled");
    }

    NotificationEventTracker(
        long lastObservedAt,
        String defaultThreadTitle,
        String detailsTitle,
        String untitledThreadTitle
    ) {
        this.lastObservedAt = lastObservedAt;
        this.defaultThreadTitle = defaultThreadTitle;
        this.detailsTitle = detailsTitle;
        this.untitledThreadTitle = untitledThreadTitle;
    }

    synchronized void setFallbackTitles(
        String defaultThreadTitle,
        String detailsTitle,
        String untitledThreadTitle
    ) {
        this.defaultThreadTitle = defaultThreadTitle;
        this.detailsTitle = detailsTitle;
        this.untitledThreadTitle = untitledThreadTitle;
    }

    synchronized List<CodexNotification> accept(String serializedFrame) throws Exception {
        List<CodexNotification> notifications = new ArrayList<>();
        JSONObject frame = new JSONObject(serializedFrame);
        String type = frame.optString("type");
        if ("snapshot".equals(type) || "resync".equals(type)) {
            JSONObject snapshot = frame.getJSONObject("snapshot");
            lastRevision = snapshot.has("revision") ? requiredRevision(snapshot) : -1;
            acceptSnapshot(snapshot, notifications);
        } else if ("patch".equals(type)) {
            long revision = requiredRevision(frame);
            if (lastRevision >= 0 && revision <= lastRevision) {
                return notifications;
            }
            if (lastRevision >= 0 && revision != lastRevision + 1) {
                throw new Exception("Projection revision gap");
            }
            acceptEvent(frame.getJSONObject("event"), notifications);
            lastRevision = revision;
        } else if ("replay".equals(type)) {
            JSONArray patches = frame.optJSONArray("patches");
            if (patches == null) return notifications;
            for (int index = 0; index < patches.length(); index += 1) {
                JSONObject patch = patches.optJSONObject(index);
                if (patch == null) continue;
                long revision = requiredRevision(patch);
                if (lastRevision >= 0 && revision <= lastRevision) continue;
                if (lastRevision >= 0 && revision != lastRevision + 1) {
                    throw new Exception("Projection replay gap");
                }
                acceptEvent(patch.getJSONObject("event"), notifications);
                lastRevision = revision;
            }
        }
        return notifications;
    }

    synchronized long lastObservedAt() {
        return lastObservedAt;
    }

    private long requiredRevision(JSONObject value) throws Exception {
        if (!value.has("revision")) throw new Exception("Projection revision is missing");
        long revision = value.getLong("revision");
        if (revision < 0) throw new Exception("Projection revision is invalid");
        return revision;
    }

    private void acceptSnapshot(JSONObject snapshot, List<CodexNotification> notifications) {
        long cutoff = lastObservedAt;
        boolean firstConnection = cutoff == 0;
        long newest = cutoff;
        threadStates.clear();
        threadTitles.clear();
        attentionThreads.clear();
        List<JSONObject> missedThreads = new ArrayList<>();
        List<CodexNotification> missedAttention = new ArrayList<>();

        JSONArray threads = snapshot.optJSONArray("threads");
        if (threads != null) {
            for (int index = 0; index < threads.length(); index += 1) {
                JSONObject thread = threads.optJSONObject(index);
                if (thread == null) continue;
                String id = thread.optString("id");
                String state = thread.optString("state");
                String title = thread.optString("title", defaultThreadTitle);
                long updatedAt = thread.optLong("updatedAt", 0);
                threadStates.put(id, state);
                threadTitles.put(id, title);
                newest = Math.max(newest, updatedAt);
                if (
                    !firstConnection &&
                    updatedAt > cutoff &&
                    (thread.optBoolean("unread", false) || "needsAttention".equals(state))
                ) {
                    missedThreads.add(thread);
                }
            }
        }

        JSONArray attention = snapshot.optJSONArray("attention");
        if (attention != null) {
            for (int index = 0; index < attention.length(); index += 1) {
                JSONObject request = attention.optJSONObject(index);
                if (request == null) continue;
                String id = request.optString("id");
                String threadId = nullableString(request, "threadId");
                attentionThreads.put(id, threadId);
                long createdAt = request.optLong("createdAt", 0);
                newest = Math.max(newest, createdAt);
                if (!firstConnection && createdAt > cutoff) {
                    missedAttention.add(
                        new CodexNotification(
                            CodexNotification.Kind.ATTENTION,
                            threadId,
                            titleFor(threadId)
                        )
                    );
                }
            }
        }
        for (JSONObject thread : missedThreads) {
            addStateNotification(
                notifications,
                thread.optString("state"),
                thread.optString("id"),
                thread.optString("title", defaultThreadTitle),
                thread.optInt("queuedMessageCount", 0)
            );
        }
        notifications.addAll(missedAttention);
        lastObservedAt = newest;
    }

    private void acceptEvent(JSONObject event, List<CodexNotification> notifications)
        throws Exception {
        String type = event.optString("type");
        if ("projection.replaced".equals(type)) {
            acceptSnapshot(event.getJSONObject("snapshot"), notifications);
        } else if ("thread.upserted".equals(type)) {
            JSONObject thread = event.getJSONObject("thread");
            String id = thread.optString("id");
            String state = thread.optString("state");
            String title = thread.optString("title", defaultThreadTitle);
            String previous = threadStates.put(id, state);
            threadTitles.put(id, title);
            if (!state.equals(previous)) {
                addStateNotification(
                    notifications,
                    state,
                    id,
                    title,
                    thread.optInt("queuedMessageCount", 0)
                );
            }
            lastObservedAt = Math.max(lastObservedAt, thread.optLong("updatedAt", 0));
        } else if ("thread.removed".equals(type)) {
            String id = event.optString("threadId");
            threadStates.remove(id);
            threadTitles.remove(id);
        } else if ("attention.upserted".equals(type)) {
            JSONObject request = event.getJSONObject("attention");
            String id = request.optString("id");
            if (!attentionThreads.containsKey(id)) {
                String threadId = nullableString(request, "threadId");
                attentionThreads.put(id, threadId);
                if (threadId == null || !"needsAttention".equals(threadStates.get(threadId))) {
                    notifications.add(
                        new CodexNotification(
                            CodexNotification.Kind.ATTENTION,
                            threadId,
                            titleFor(threadId)
                        )
                    );
                }
            }
            lastObservedAt = Math.max(lastObservedAt, request.optLong("createdAt", 0));
        } else if ("attention.removed".equals(type)) {
            attentionThreads.remove(event.optString("attentionId"));
        }
    }

    private void addStateNotification(
        List<CodexNotification> notifications,
        String state,
        String threadId,
        String title,
        int queuedMessageCount
    ) {
        if ("completed".equals(state) && queuedMessageCount == 0) {
            notifications.add(
                new CodexNotification(
                    CodexNotification.Kind.COMPLETED,
                    threadId,
                    displayTitle(title)
                )
            );
        } else if ("failed".equals(state) && queuedMessageCount == 0) {
            notifications.add(
                new CodexNotification(CodexNotification.Kind.FAILED, threadId, displayTitle(title))
            );
        } else if ("needsAttention".equals(state) && !attentionThreads.containsValue(threadId)) {
            notifications.add(
                new CodexNotification(
                    CodexNotification.Kind.ATTENTION,
                    threadId,
                    displayTitle(title)
                )
            );
        }
    }

    private String titleFor(String threadId) {
        if (threadId == null) return detailsTitle;
        return displayTitle(threadTitles.getOrDefault(threadId, defaultThreadTitle));
    }

    private String displayTitle(String title) {
        return "Без названия".equals(title) || "Untitled".equals(title)
            ? untitledThreadTitle
            : title;
    }

    private static String nullableString(JSONObject object, String key) {
        return object.isNull(key) ? null : object.optString(key, null);
    }
}
