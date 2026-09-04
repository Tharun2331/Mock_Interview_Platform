import { Outlet } from "react-router";

import { Header } from "./Header";
import { Footer } from "./Footer";

export function AppShell() {
  return (
    <div className="flex h-screen w-full flex-col bg-background">
      <Header />
      {/* min-h-0 so the interview screen's transcript can own the scroll inside
          a fixed frame. Without it the flex child refuses to shrink and the
          whole document scrolls instead, which pushes the stop control off the
          bottom of the screen exactly when someone needs it. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
