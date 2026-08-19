import { Navigate, Outlet } from "react-router";
import { useAuthStatus } from "@/lib/auth";
import { MESSAGES } from "@/lib/messages";

export function RequireAuth() {
  const status = useAuthStatus();

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/signin" replace />;
  }

  return <Outlet />;
}
