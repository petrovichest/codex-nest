package com.codexnest.app;

import android.content.Context;
import android.content.res.Configuration;
import java.util.Locale;

final class LocalizedResources {

    private LocalizedResources() {}

    static String getString(Context context, String language, int resourceId) {
        Configuration configuration = new Configuration(context.getResources().getConfiguration());
        configuration.setLocale(Locale.forLanguageTag("ru".equals(language) ? "ru" : "en"));
        return context
            .createConfigurationContext(configuration)
            .getResources()
            .getString(resourceId);
    }
}
