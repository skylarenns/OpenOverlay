import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles/app.css";
import "./styles/swiss.css";
import "./styles/workspace.css";
import "./styles/navigation.css";
import "./styles/church.css";

const isOutputRoute = /^\/overlay(?:-test)?\/[^/]+\/?$/.test(window.location.pathname);
const Root = isOutputRoute
  ? lazy(async () => {
      const { OverlayPage } = await import("./OverlayPage");
      return { default: () => <OverlayPage test={window.location.pathname.startsWith("/overlay-test/")} /> };
    })
  : lazy(async () => {
      const { App } = await import("./App");
      return { default: App };
    });
const router = createBrowserRouter([
  {
    path: isOutputRoute ? (window.location.pathname.startsWith("/overlay-test/") ? "/overlay-test/:overlayId" : "/overlay/:overlayId") : "*",
    element: (
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    )
  }
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
