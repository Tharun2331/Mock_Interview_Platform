import { Outlet } from "react-router";

import { Header } from "./Header";
import { Footer } from "./Footer";

export function AppShell() {
  return (
    // `h-full` rather than `h-screen`. Both are the viewport here now that the
    // document is locked, but `100vh` counts the horizontal scrollbar's strip
    // as page height, so `h-screen` leaves the shell a few pixels taller than
    // what it is sitting in — enough for the footer to sit just off the bottom.
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
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
