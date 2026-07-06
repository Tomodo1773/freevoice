import React from "react";
import ReactDOM from "react-dom/client";
import { installGlobalErrorLogging } from "./globalErrorHandlers";
import { ErrorBoundary } from "./ErrorBoundary";
import App from "./App";
import "@radix-ui/themes/styles.css";
import "./settings.css";

installGlobalErrorLogging("main");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary scope="main">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
