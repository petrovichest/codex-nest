import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { SetupScreen } from "./components/SetupScreen";
import { ConnectionProvider } from "./connection";
import { I18nProvider } from "./i18n";
import { loadConnectionSettings, type ConnectionSettings } from "./storage";
import "./styles.css";

function Root() {
  const [settings, setSettings] = useState<ConnectionSettings | null | undefined>(undefined);
  useEffect(() => {
    void loadConnectionSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  if (settings === undefined) return <div className="splash">CodexNest</div>;
  if (!settings) return <SetupScreen onConnected={setSettings} />;
  return (
    <ConnectionProvider settings={settings}>
      <BrowserRouter>
        <App settings={settings} onDisconnected={() => setSettings(null)} />
      </BrowserRouter>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
);
