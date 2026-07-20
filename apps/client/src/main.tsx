import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { SetupScreen } from "./components/SetupScreen";
import { ConnectionProvider } from "./connection";
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
    <Root />
  </StrictMode>,
);
