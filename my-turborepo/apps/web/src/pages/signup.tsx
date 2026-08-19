import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { signUp, signIn, signInWithRedirect } from "aws-amplify/auth";
import { SignupSchema, type SignupInput } from "@repo/shared";


import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { GoogleIcon } from "@/components/GoogleIcon";
import { errorMessage, isAlreadyAuthenticated } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

// The confirm page sends a corrected address back here so the user does not have
// to retype it. Only the email travels — the password is entered fresh.
function prefilledEmail(state: unknown): string {
  if (
    typeof state === "object" &&
    state !== null &&
    "email" in state &&
    typeof state.email === "string"
  ) {
    return state.email;
  }
  return "";
}

export function Signup() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(SignupSchema),
    mode: "onTouched",
    defaultValues: { email: prefilledEmail(state) },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { nextStep } = await signUp({
        username: values.email,
        password: values.password,
        // Cognito holds the pending session, so the confirm page can complete
        // sign-in by calling autoSignIn() — no password needs to travel there.
        options: {
          userAttributes: { email: values.email },
          autoSignIn: true,
        },
      });

      if (nextStep.signUpStep === "CONFIRM_SIGN_UP") {
        toast.info(MESSAGES.AUTH_CODE_SENT);
        // Only the email is handed over, and only via in-memory router state.
        // The password is deliberately NOT passed — history state is readable
        // by any script for the lifetime of the session.
        navigate("/confirm", { state: { email: values.email } });
        return;
      }

      if (nextStep.signUpStep === "DONE") {
        await signIn({ username: values.email, password: values.password });
        navigate("/form");
      }
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.AUTH_SIGNUP_FAILED));
    }
  });

  // Kicks off the Cognito hosted-UI redirect to Google. On return, the browser
  // lands on /callback where Amplify finishes the token exchange.
  async function handleGoogle() {
    try {
      await signInWithRedirect({ provider: "Google" });
    } catch (error) {
      // A session already exists (e.g. another tab signed in). Nothing is
      // wrong — send the user where the redirect would have taken them.
      if (isAlreadyAuthenticated(error)) {
        navigate("/form", { replace: true });
        return;
      }
      toast.error(errorMessage(error, MESSAGES.AUTH_GOOGLE_FAILED));
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{MESSAGES.SIGNUP_TITLE}</CardTitle>
          <CardDescription>{MESSAGES.SIGNUP_DESCRIPTION}</CardDescription>
        </CardHeader>

        <CardContent>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogle}
          >
            <GoogleIcon className="size-4" />
            {MESSAGES.CONTINUE_WITH_GOOGLE}
          </Button>

          <div className="mt-6 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">
              {MESSAGES.SIGNUP_DIVIDER}
            </span>
            <Separator className="flex-1" />
          </div>
        </CardContent>

        <form onSubmit={onSubmit} noValidate>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="email">
                  {MESSAGES.FIELD_EMAIL_LABEL}
                </FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder={MESSAGES.FIELD_EMAIL_PLACEHOLDER}
                  aria-invalid={!!errors.email}
                  {...register("email")}
                />
                <FieldError errors={errors.email ? [errors.email] : undefined} />
              </Field>

              <Field data-invalid={!!errors.password}>
                <FieldLabel htmlFor="password">
                  {MESSAGES.FIELD_PASSWORD_LABEL}
                </FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={MESSAGES.FIELD_PASSWORD_PLACEHOLDER}
                  aria-invalid={!!errors.password}
                  {...register("password")}
                />
                <FieldDescription>
                  {MESSAGES.SIGNUP_PASSWORD_HINT}
                </FieldDescription>
                <FieldError
                  errors={errors.password ? [errors.password] : undefined}
                />
              </Field>

              <Field data-invalid={!!errors.confirmPassword}>
                <FieldLabel htmlFor="confirmPassword">
                  {MESSAGES.SIGNUP_CONFIRM_PASSWORD_LABEL}
                </FieldLabel>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  placeholder={MESSAGES.FIELD_PASSWORD_PLACEHOLDER}
                  aria-invalid={!!errors.confirmPassword}
                  {...register("confirmPassword")}
                />
                <FieldError
                  errors={
                    errors.confirmPassword ? [errors.confirmPassword] : undefined
                  }
                />
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting
                ? MESSAGES.SIGNUP_SUBMIT_PENDING
                : MESSAGES.SIGNUP_SUBMIT}
            </Button>
            <p className="text-muted-foreground text-sm">
              {MESSAGES.SIGNUP_HAS_ACCOUNT}{" "}
              <Link to="/signin" className="text-primary underline-offset-4 hover:underline">
                {MESSAGES.SIGNUP_SIGNIN_LINK}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
