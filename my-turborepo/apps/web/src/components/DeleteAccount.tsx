import { useState } from "react";
import { useNavigate } from "react-router";
import { signOut } from "aws-amplify/auth";
import { toast } from "sonner";
import { Trash2Icon } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteAccount } from "@/lib/profileApi";
import { transportMessage } from "@/lib/httpErrors";
import { MESSAGES } from "@/lib/messages";

// Account erasure, from the one screen that owns the candidate's material.
//
// Type-to-confirm rather than a plain OK button. This is irreversible and
// server-side: the resume, every interview and its transcript, and the sign-in
// itself are all gone, with no undo and no support path to restore them. A
// button that deletes an account on one click is a button someone eventually
// presses by accident, and the cost of that mistake is unbounded.
//
// The list below is not decoration either. "Delete your account" is vague
// enough that people assume it means the login and not four months of practice
// transcripts, so it says exactly what goes.
export function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);

  const canDelete =
    confirmation.trim().toLowerCase() === MESSAGES.DELETE_CONFIRM_WORD &&
    !deleting;

  const handleDelete = async () => {
    setDeleting(true);

    try {
      await deleteAccount();
    } catch (error) {
      setDeleting(false);
      // The erasure is resumable by design — the profile keeps its `deleting`
      // marker and every step is idempotent — so the honest instruction is to
      // try again rather than to contact anyone.
      toast.error(transportMessage(error, MESSAGES.DELETE_FAILED));
      return;
    }

    // The Cognito user is gone by the time this resolves, so the tokens in this
    // browser now authenticate nobody. signOut is still worth attempting to
    // clear local storage, but it is expected to fail against a deleted user —
    // and a failure here must not read as a failed deletion, which succeeded.
    try {
      await signOut();
    } catch {
      // Deliberately swallowed. See above.
    }

    onDeleted();
    setOpen(false);
    toast.success(MESSAGES.DELETE_DONE);
    navigate("/signup", { replace: true });
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-destructive/30 px-4 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{MESSAGES.DELETE_SECTION_TITLE}</h2>
        <p className="text-xs leading-relaxed text-ink-subtle">
          {MESSAGES.DELETE_SECTION_BODY}
        </p>
      </div>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // Cleared on every close so reopening never starts with the
          // confirmation already satisfied from a previous, abandoned attempt.
          if (!next) setConfirmation("");
          if (!deleting) setOpen(next);
        }}
      >
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            className="w-full cursor-pointer sm:w-auto sm:self-start"
          >
            <Trash2Icon aria-hidden className="size-4" />
            {MESSAGES.DELETE_OPEN}
          </Button>
        </AlertDialogTrigger>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{MESSAGES.DELETE_TITLE}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3">
                <p>{MESSAGES.DELETE_BODY}</p>
                {/* Named individually. A single sentence saying "all your data"
                    is the kind of thing people skim past. */}
                <ul className="list-disc space-y-1 pl-5">
                  {MESSAGES.DELETE_ITEMS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p className="text-ink">{MESSAGES.DELETE_IRREVERSIBLE}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-confirm">
              {MESSAGES.DELETE_CONFIRM_LABEL}
            </Label>
            <Input
              id="delete-confirm"
              value={confirmation}
              disabled={deleting}
              autoComplete="off"
              // The one field where autocapitalise actively fights the user:
              // a phone would offer "Delete" against a lowercase check.
              autoCapitalize="none"
              spellCheck={false}
              placeholder={MESSAGES.DELETE_CONFIRM_WORD}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {MESSAGES.DELETE_CANCEL}
            </AlertDialogCancel>
            {/* Not an AlertDialogAction: that closes the dialog on click, which
                would tear this down mid-request and leave the candidate on a
                profile page with no indication anything was happening. The
                dialog closes when the deletion actually finishes. */}
            <Button
              variant="destructive"
              className="cursor-pointer"
              disabled={!canDelete}
              onClick={handleDelete}
            >
              {deleting ? MESSAGES.DELETE_PENDING : MESSAGES.DELETE_CONFIRM}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
