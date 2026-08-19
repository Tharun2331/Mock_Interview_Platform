import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { signIn, signInWithRedirect } from "aws-amplify/auth";
import { SigninSchema, type SignInInput } from "@repo/shared";

import {
  Field,
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

export function SignIn() {
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(SigninSchema),
    mode: "onTouched",
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { nextStep } = await signIn({
        username: values.email,
        password: values.password,
      });

      // Account exists but the email was never verified — send the user
      // through the same confirmation flow as sign-up.
      if (nextStep.signInStep === "CONFIRM_SIGN_UP") {
        toast.info(MESSAGES.AUTH_NOT_CONFIRMED);
        // Email only — the password stays out of history state. Confirming from
        // this path ends at /signin rather than auto-signing in, because no
        // autoSignIn flow was started here.
        navigate("/confirm", { state: { email: values.email } });
        return;
      }

      if (nextStep.signInStep === "DONE") {
        navigate("/form");
      }
    } catch (error) {
      if (isAlreadyAuthenticated(error)) {
        navigate("/form");
        return;
      }
      toast.error(errorMessage(error, MESSAGES.AUTH_SIGNIN_FAILED));
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
          <CardTitle>{MESSAGES.SIGNIN_TITLE}</CardTitle>
          <CardDescription>{MESSAGES.SIGNIN_DESCRIPTION}</CardDescription>
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
              {MESSAGES.SIGNIN_DIVIDER}
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
                  autoComplete="current-password"
                  placeholder={MESSAGES.FIELD_PASSWORD_PLACEHOLDER}
                  aria-invalid={!!errors.password}
                  {...register("password")}
                />
                <FieldError
                  errors={errors.password ? [errors.password] : undefined}
                />
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting
                ? MESSAGES.SIGNIN_SUBMIT_PENDING
                : MESSAGES.SIGNIN_SUBMIT}
            </Button>
            <p className="text-muted-foreground text-sm">
              {MESSAGES.SIGNIN_NO_ACCOUNT}{" "}
              <Link to="/signup" className="text-primary underline-offset-4 hover:underline">
                {MESSAGES.SIGNIN_SIGNUP_LINK}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
