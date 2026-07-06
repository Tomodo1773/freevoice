import React from "react";
import ReactDOM from "react-dom/client";
import { installGlobalErrorLogging } from "./globalErrorHandlers";
import { ErrorBoundary } from "./ErrorBoundary";
import Overlay from "./Overlay";
import "./app.css";

installGlobalErrorLogging("overlay");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary scope="overlay">
      <Overlay />
    </ErrorBoundary>
  </React.StrictMode>
);
