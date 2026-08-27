import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ZodType } from "zod";
import { config } from "./config";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

const baseClient = new DynamoDBClient({ region: config.awsRegion });

// The Document client, not the raw one. It marshals plain JavaScript values to
// and from AttributeValue shapes, so nothing above this line ever writes
// `{ S: "..." }` by hand.
export const dynamoClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // An attribute the application never set should be absent, not present and
    // undefined — `attribute_not_exists` conditions and the Zod schemas both
    // read absence as "not written yet".
    removeUndefinedValues: true,
    // Empty strings are legal in DynamoDB and mean something different from
    // absent: a transcript of "" is a turn where the candidate said nothing,
    // which the Evaluator should see rather than have silently dropped.
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    // DynamoDB numbers are arbitrary precision; JavaScript numbers are not.
    // Every number in the item shapes is a small integer or a 0-10 score, so
    // plain numbers are safe and far easier to work with than BigInt.
    wrapNumbers: false,
  },
});

// Checked at point of use rather than at boot, matching lib/s3.ts. Only the
// persistence path needs the table, and failing startup over it would take
// down auth and /plan too.
export function requireTable(): string {
  if (config.sessionsTable.length === 0) {
    // Set SESSIONS_TABLE from `terraform output sessions_table_name`.
    throw new ServiceError(MESSAGES.SESSIONS_TABLE_UNSET);
  }
  return config.sessionsTable;
}

// Validate on the way out, per data-model.md §4. An item written by an older
// deploy may not match the current shape, and failing here — where the error
// can name the key and the field — beats an `undefined` surfacing three layers
// up in the Evaluator with no clue where it came from.
export function parseItem<T>(
  schema: ZodType<T>,
  item: Record<string, unknown> | undefined,
  context: string
): T {
  if (item === undefined) {
    throw new ServiceError(`${MESSAGES.SESSION_ITEM_MISSING} (${context})`);
  }

  const parsed = schema.safeParse(item);
  if (!parsed.success) {
    throw new ServiceError(
      `${MESSAGES.SESSION_ITEM_INVALID} (${context}) — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return parsed.data;
}
