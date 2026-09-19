import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "./i18n";
import { Root } from "./Root";
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./styles.css";
import "./styles/chat.css";
import "./styles/typography.css";
import { initializeTypography } from "./typography";

initializeTypography();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </StrictMode>,
);
