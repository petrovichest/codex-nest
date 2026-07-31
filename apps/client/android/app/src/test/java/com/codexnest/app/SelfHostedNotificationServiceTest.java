package com.codexnest.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SelfHostedNotificationServiceTest {

    @Test
    public void visibleActiveThreadDoesNotNotify() {
        assertFalse(
            SelfHostedNotificationService.shouldNotifyEvent(true, "active", "active")
        );
        assertTrue(SelfHostedNotificationService.shouldNotifyEvent(true, "active", "other"));
        assertTrue(SelfHostedNotificationService.shouldNotifyEvent(false, "active", "active"));
    }
}
