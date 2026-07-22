package com.codexnest.app;

import static org.junit.Assert.assertEquals;

import java.util.List;
import org.junit.Test;

public class NotificationEventTrackerTest {

    @Test
    public void initialSnapshotDoesNotNotifyForOldThreads() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"title\":\"Old\",\"state\":\"completed\",\"unread\":true,\"updatedAt\":200}],\"attention\":[]}}"
        );
        assertEquals(0, notifications.size());
        assertEquals(200, tracker.lastObservedAt());
    }

    @Test
    public void terminalTransitionNotifiesOnce() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> first = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"title\":\"Task\",\"state\":\"completed\",\"updatedAt\":200}}}"
        );
        List<CodexNotification> duplicate = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"title\":\"Task\",\"state\":\"completed\",\"updatedAt\":201}}}"
        );
        assertEquals(1, first.size());
        assertEquals(CodexNotification.Kind.COMPLETED, first.get(0).kind);
        assertEquals(0, duplicate.size());
    }

    @Test
    public void needsAttentionTransitionNotifiesOnce() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> first = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"title\":\"Task\",\"state\":\"needsAttention\",\"updatedAt\":200}}}"
        );
        List<CodexNotification> duplicate = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"title\":\"Task\",\"state\":\"needsAttention\",\"updatedAt\":201}}}"
        );
        assertEquals(1, first.size());
        assertEquals(CodexNotification.Kind.ATTENTION, first.get(0).kind);
        assertEquals(0, duplicate.size());
    }

    @Test
    public void explicitAttentionDoesNotDuplicateNeedsAttentionState() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(0);
        tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"title\":\"Task\",\"state\":\"running\",\"unread\":false,\"updatedAt\":100}],\"attention\":[]}}"
        );
        List<CodexNotification> request = tracker.accept(
            "{\"type\":\"event\",\"sequence\":2,\"event\":{\"type\":\"attention.upserted\",\"attention\":{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":200}}}"
        );
        List<CodexNotification> state = tracker.accept(
            "{\"type\":\"event\",\"sequence\":3,\"event\":{\"type\":\"thread.upserted\",\"thread\":{\"id\":\"one\",\"title\":\"Task\",\"state\":\"needsAttention\",\"updatedAt\":201}}}"
        );
        assertEquals(1, request.size());
        assertEquals(0, state.size());
    }

    @Test
    public void reconnectSnapshotDeliversMissedUnreadOutcomeAndAttention() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(100);
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"title\":\"Task\",\"state\":\"failed\",\"unread\":true,\"updatedAt\":200}],\"attention\":[{\"id\":\"attention-1\",\"threadId\":\"one\",\"createdAt\":210}]}}"
        );
        assertEquals(2, notifications.size());
        assertEquals(CodexNotification.Kind.FAILED, notifications.get(0).kind);
        assertEquals(CodexNotification.Kind.ATTENTION, notifications.get(1).kind);
        assertEquals(210, tracker.lastObservedAt());
    }

    @Test
    public void reconnectSnapshotDeliversMissedNeedsAttentionState() throws Exception {
        NotificationEventTracker tracker = new NotificationEventTracker(100);
        List<CodexNotification> notifications = tracker.accept(
            "{\"type\":\"snapshot\",\"snapshot\":{\"threads\":[{\"id\":\"one\",\"title\":\"Task\",\"state\":\"needsAttention\",\"unread\":false,\"updatedAt\":200}],\"attention\":[]}}"
        );
        assertEquals(1, notifications.size());
        assertEquals(CodexNotification.Kind.ATTENTION, notifications.get(0).kind);
    }
}
