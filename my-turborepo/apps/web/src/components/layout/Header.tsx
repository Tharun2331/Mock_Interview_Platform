import { signOut } from "aws-amplify/auth";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { LogOutIcon } from "lucide-react";

import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

// App chrome, and deliberately quiet. Everything below this bar is a system
// state a candidate is reading under time pressure, so the header's job is to
// stay out of the way and hold its hairline.
export function Header() {
  const navigate = useNavigate();

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate("/signup", { replace: true });
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.SIGN_OUT_FAILED));
    }
  };

  return (
    <header className="flex h-14 w-full shrink-0 items-center justify-between border-b border-hairline bg-background/80 px-4 backdrop-blur-sm sm:px-6">
      <BrandMark />
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          className="cursor-pointer text-ink-subtle hover:text-ink"
          onClick={handleSignOut}
        >
          <LogOutIcon aria-hidden className="size-4" />
          {MESSAGES.SIGN_OUT}
        </Button>
      </div>
    </header>
  );
}
