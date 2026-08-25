import { useId, useRef } from "react";
import { FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import { RESUME_LIMITS, formatMegabytes } from "@repo/shared";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MESSAGES, resumeHint, resumeTooLarge } from "@/lib/messages";
import { cn } from "@/lib/utils";

type ResumeFieldProps = {
  file: File | null;
  error: string | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onReject: (message: string) => void;
  onClear: () => void;
};

// Rejects at the boundary, before anything is sent. The server enforces the same
// rules from the same shared constants — this exists so the candidate finds out
// immediately rather than after uploading eight megabytes.
function validate(file: File): string | null {
  const isPdf =
    file.type === RESUME_LIMITS.MIME ||
    file.name.toLowerCase().endsWith(RESUME_LIMITS.EXTENSION);

  if (!isPdf) return MESSAGES.RESUME_NOT_PDF;
  if (file.size === 0) return MESSAGES.RESUME_EMPTY;

  if (file.size > RESUME_LIMITS.MAX_BYTES) {
    return resumeTooLarge(
      formatMegabytes(file.size),
      formatMegabytes(RESUME_LIMITS.MAX_BYTES)
    );
  }

  return null;
}

export function ResumeField({
  file,
  error,
  disabled,
  onSelect,
  onReject,
  onClear,
}: ResumeFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const fileId = useId();

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // Reset so re-picking the same file after a rejection still fires onChange.
    event.target.value = "";

    if (chosen === undefined) return;

    const problem = validate(chosen);
    if (problem !== null) {
      onReject(problem);
      return;
    }
    onSelect(chosen);
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={fileId}>{MESSAGES.RESUME_LABEL}</Label>

      {/* Kept in the accessibility tree rather than display:none, so it stays
          reachable by keyboard and by assistive tech that drives file pickers. */}
      <input
        ref={inputRef}
        id={fileId}
        type="file"
        accept={`${RESUME_LIMITS.MIME},${RESUME_LIMITS.EXTENSION}`}
        className="sr-only"
        disabled={disabled}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
        onChange={handleChange}
      />

      {file === null ? (
        <Button
          type="button"
          variant="outline"
          className="w-full cursor-pointer justify-start font-normal"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <PaperclipIcon className="size-4" />
          {MESSAGES.RESUME_CHOOSE}
        </Button>
      ) : (
        <div
          className={cn(
            "flex items-center gap-3 rounded-md border px-3 py-2",
            error !== null && "border-destructive"
          )}
        >
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />

          <div className="min-w-0 flex-1">
            {/* truncate + min-w-0 so a long filename cannot push the controls
                off screen at 375px. */}
            <p className="truncate text-sm" title={file.name}>
              {file.name}
            </p>
            {/* Tabular numerals so the size does not shimmer between renders. */}
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatMegabytes(file.size)}
            </p>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {MESSAGES.RESUME_REPLACE}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="cursor-pointer"
            disabled={disabled}
            aria-label={MESSAGES.RESUME_REMOVE}
            onClick={onClear}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      )}

      {error !== null ? (
        // Icon as well as colour — colour alone is not a channel.
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-sm text-destructive"
        >
          <XIcon className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {resumeHint(formatMegabytes(RESUME_LIMITS.MAX_BYTES))}
        </p>
      )}
    </div>
  );
}
