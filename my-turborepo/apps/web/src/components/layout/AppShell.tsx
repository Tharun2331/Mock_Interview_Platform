import { Outlet } from "react-router";
import { Header } from "./Header";
import { Footer } from "./Footer";

export function AppShell() {
  return (
    <div className="flex h-screen w-screen flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
