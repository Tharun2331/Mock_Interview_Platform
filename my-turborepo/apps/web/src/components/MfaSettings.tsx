import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import QRCode from "qrcode";
import {
  fetchMFAPreference,
  setUpTOTP,
  updateMFAPreference,
  verifyTOTPSetup,
} from "aws-amplify/auth";
import { TotpCodeSchema, type TotpCodeInput } from "@repo/shared";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

// Self-service TOTP enrolment, in the Security section of the settings page.
//
// A named state machine rather than a pile of booleans — the frontend skill's
// rule for anything with more than two real conditions. The off/enrolling/on
// split here is the same shape as the interview screen's own state, at a much
// smaller scale: each status renders one unambiguous thing, and nothing here
// is ever "on AND enrolling" at once.
//
// `setUpTOTP` runs against the CURRENT session — the candidate is already
// signed in, so this needs no password and no email code. It is unrelated to
// the sign-in-time TOTP challenge in signin.tsx, which runs before a session
// exists at all and uses `confirmSignIn` instead.
type MfaStatus =
  | { status: "checking" }
  | { status: "off" }
  | { status: "enrolling"; sharedSecret: string; setupUri: string }
  | { status: "on" }
  | { status: "error"; message: string };

// Chunked in groups of 4, the way every authenticator app's own manual-entry
// screen already formats a secret — matching what the candidate is looking at
// on their phone beats a single unbroken string.
function chunkSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(" ");
}

export function MfaSettings() {
  const [state, setState] = useState<MfaStatus>({ status: "checking" });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<TotpCodeInput>({
    resolver: zodResolver(TotpCodeSchema),
    mode: "onTouched",
  });

  const load = async (): Promise<void> => {
    setState({ status: "checking" });
    try {
      const { preferred } = await fetchMFAPreference();
      setState({ status: preferred === "TOTP" ? "on" : "off" });
    } catch (error) {
      setState({
        status: "error",
        message: errorMessage(error, MESSAGES.MFA_LOAD_FAILED),
      });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Regenerated whenever the pending setup's URI changes, and cleared the
  // moment enrolment is no longer the active state — a stale QR code sitting
  // around after cancelling would point at a setup that no longer exists.
  useEffect(() => {
    if (state.status !== "enrolling") {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(state.setupUri)
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        // The manual key still works without a scannable code, so a failure
        // here degrades the screen rather than blocking it.
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  const startEnrolling = async (): Promise<void> => {
    try {
      const details = await setUpTOTP();
      reset();
      setState({
        status: "enrolling",
        sharedSecret: details.sharedSecret,
        // MESSAGES.APP_NAME is the issuer shown in the authenticator app —
        // never a model or AWS service name, per the frontend skill's naming
        // rule, though that rule is about the interview loop rather than
        // this screen. No account name is passed: Cognito's own default is
        // the sign-in email, which is the label already on the candidate's
        // password manager entry for this account.
        setupUri: details.getSetupUri(MESSAGES.APP_NAME).toString(),
      });
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.MFA_START_FAILED));
    }
  };

  const onVerify = handleSubmit(async ({ code }) => {
    try {
      await verifyTOTPSetup({ code });
      // The write that actually turns it on. verifyTOTPSetup alone registers
      // the device but leaves the account still checking only a password —
      // this is the step an incomplete enrolment would be missing.
      await updateMFAPreference({ totp: "PREFERRED" });
      setState({ status: "on" });
      toast.success(MESSAGES.MFA_ENABLED);
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.AUTH_CODE_INVALID));
    }
  });

  const onDisable = async (): Promise<void> => {
    setDisabling(true);
    try {
      await updateMFAPreference({ totp: "DISABLED" });
      setState({ status: "off" });
      setDisableOpen(false);
      toast.success(MESSAGES.MFA_DISABLED);
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.MFA_LOAD_FAILED));
    } finally {
      setDisabling(false);
    }
  };

  if (state.status === "checking") {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        {MESSAGES.MFA_CHECKING}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">{state.message}</p>
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={() => void load()}
        >
          {MESSAGES.RETRY}
        </Button>
      </div>
    );
  }

  if (state.status === "on") {
    return (
      <div className="flex flex-col items-start gap-3">
        <div>
          <p className="text-sm font-medium text-ink">
            {MESSAGES.MFA_ON_TITLE}
          </p>
          <p className="text-xs text-ink-subtle">{MESSAGES.MFA_ON_BODY}</p>
        </div>

        <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="cursor-pointer">
              {MESSAGES.MFA_DISABLE}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{MESSAGES.MFA_DISABLE_TITLE}</AlertDialogTitle>
              <AlertDialogDescription>
                {MESSAGES.MFA_DISABLE_BODY}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={disabling}>
                {MESSAGES.MFA_DISABLE_CANCEL}
              </AlertDialogCancel>
              {/* Not AlertDialogAction: that closes on click, which would tear
                  the dialog down mid-request with no sign anything was
                  happening — the same reasoning DeleteAccount documents. */}
              <Button
                variant="destructive"
                className="cursor-pointer"
                disabled={disabling}
                onClick={() => void onDisable()}
              >
                {disabling ? MESSAGES.LOADING : MESSAGES.MFA_DISABLE_CONFIRM}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  if (state.status === "off") {
    return (
      <div className="flex flex-col items-start gap-3">
        <div>
          <p className="text-sm font-medium text-ink">
            {MESSAGES.MFA_OFF_TITLE}
          </p>
          <p className="text-xs text-ink-subtle">{MESSAGES.MFA_OFF_BODY}</p>
        </div>
        <Button className="cursor-pointer" onClick={() => void startEnrolling()}>
          {MESSAGES.MFA_ENABLE}
        </Button>
      </div>
    );
  }

  // state.status === "enrolling"
  return (
    <div className="flex flex-col gap-4 rounded-md border border-hairline p-4">
      <p className="text-sm font-medium text-ink">{MESSAGES.MFA_SETUP_TITLE}</p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        {qrDataUrl !== null ? (
          <img
            src={qrDataUrl}
            // Named for what a screen reader user does next — scanning is not
            // an option for them, so the alt text points straight at the
            // fallback that is.
            alt={MESSAGES.MFA_SETUP_MANUAL_LABEL}
            className="size-36 shrink-0 rounded-md border border-hairline bg-white p-2"
          />
        ) : (
          // Reserves the QR code's footprint rather than leaving a jump when
          // it resolves — the frontend skill's rule against a spinner where
          // streamed content will land applies just as well to this async image.
          <div
            aria-hidden
            className="size-36 shrink-0 animate-pulse rounded-md border border-hairline bg-surface-2 motion-reduce:animate-none"
          />
        )}

        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-subtle">{MESSAGES.MFA_SETUP_SCAN}</p>
          <div>
            <p className="text-xs text-ink-subtle">
              {MESSAGES.MFA_SETUP_MANUAL_LABEL}
            </p>
            <p className="select-all break-all font-mono text-sm text-ink">
              {chunkSecret(state.sharedSecret)}
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={onVerify} noValidate className="flex flex-col gap-3">
        <FieldGroup>
          <Field data-invalid={!!errors.code}>
            <FieldLabel htmlFor="mfa-code">
              {MESSAGES.MFA_SETUP_CODE_LABEL}
            </FieldLabel>
            <Input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={MESSAGES.CONFIRM_CODE_PLACEHOLDER}
              aria-invalid={!!errors.code}
              {...register("code")}
            />
            <FieldError errors={errors.code ? [errors.code] : undefined} />
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" className="cursor-pointer" disabled={isSubmitting}>
            {isSubmitting
              ? MESSAGES.MFA_SETUP_VERIFY_PENDING
              : MESSAGES.MFA_SETUP_VERIFY}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="cursor-pointer text-ink-subtle hover:text-ink"
            disabled={isSubmitting}
            onClick={() => setState({ status: "off" })}
          >
            {MESSAGES.MFA_SETUP_CANCEL}
          </Button>
        </div>
      </form>
    </div>
  );
}
