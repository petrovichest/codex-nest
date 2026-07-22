package com.codexnest.app;

final class CodexNotification {

    enum Kind {
        COMPLETED,
        FAILED,
        ATTENTION,
    }

    final Kind kind;
    final String threadId;
    final String threadTitle;

    CodexNotification(Kind kind, String threadId, String threadTitle) {
        this.kind = kind;
        this.threadId = threadId;
        this.threadTitle = threadTitle;
    }
}
