import { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { PreInterviewBody, PreInterviewResponse } from "@repo/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import { MESSAGES } from "@/lib/messages";

// The server rejects an unverifiable token with 401. That is a session problem,
// not a bad GitHub URL, so it gets its own message rather than the generic one.
function isUnauthorized(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

export function Form() {
  const navigate = useNavigate();
  const [gitHub, setGitHub] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    // Validated with the same schema the server enforces, so a bad URL is
    // rejected here with the exact message the server would have returned.
    const validated = PreInterviewBody.safeParse({ gitHub: gitHub.trim() });
    if (!validated.success) {
      toast.warning(
        validated.error.issues[0]?.message ?? MESSAGES.FORM_GITHUB_REQUIRED
      );
      return;
    }

    setIsSubmitting(true);
    try {
      // `api` attaches the Cognito access token; a bare axios call here would
      // always 401 against the server's AuthMiddleware.
      const response = await api.post("/api/v1/pre-interview", validated.data);

      const parsed = PreInterviewResponse.safeParse(response.data);
      if (!parsed.success) {
        toast.error(MESSAGES.FORM_UNEXPECTED_RESPONSE);
        return;
      }

      // Hand the scraped repos to the interview screen via router state, the
      // same in-memory channel the sign-up flow uses. Nothing is persisted yet.
      navigate("/interview", { state: { repos: parsed.data.repos } });
    } catch (error) {
      toast.error(
        isUnauthorized(error)
          ? MESSAGES.FORM_SESSION_EXPIRED
          : MESSAGES.FORM_FAILED
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{MESSAGES.FORM_TITLE}</CardTitle>
          <CardDescription>{MESSAGES.FORM_DESCRIPTION}</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="github">{MESSAGES.FORM_GITHUB_LABEL}</Label>
          <Input
            id="github"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder={MESSAGES.FORM_GITHUB_PLACEHOLDER}
            value={gitHub}
            disabled={isSubmitting}
            onChange={(e) => setGitHub(e.target.value)}
          />
        </CardContent>

        <CardFooter className="mt-6">
          <Button
            className="w-full cursor-pointer"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? MESSAGES.FORM_SUBMIT_PENDING : MESSAGES.FORM_SUBMIT}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
