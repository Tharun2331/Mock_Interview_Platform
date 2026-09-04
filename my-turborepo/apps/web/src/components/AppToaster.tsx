import { useTheme } from "next-themes";
import { Toaster } from "sonner";

// Sonner renders outside the app's own surfaces, so it does not inherit the
// token layer. Handing it the resolved theme is what stops a toast arriving as
// the only light panel on a dark page, or the reverse.
export function AppToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      duration={3000}
      position="top-center"
      theme={resolvedTheme === "light" ? "light" : "dark"}
    />
  );
}
