import { signOut } from "aws-amplify/auth";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

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
    <header className="flex h-14 w-full shrink-0 items-center justify-between border-b bg-background px-4 sm:px-6">
      <span className="text-sm font-semibold tracking-tight cursor-pointer">
        {MESSAGES.APP_NAME}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="cursor-pointer"
        onClick={handleSignOut}
      >
        <LogOutIcon />
        {MESSAGES.SIGN_OUT}
      </Button>
    </header>
  );
}
