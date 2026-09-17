import { describe, expect, it } from "bun:test";
import { aliasedProjection } from "../../lib/evaluations";

// The reserved-word trap, and the third time this file has fallen into it.
//
// `depth` took down the completion query. `role` took down the history page the
// moment a projection was added — from a list where `type` was aliased because
// it looked reserved and the rest were assumed safe. Both failed as a hard
// request error, not as a missing attribute, so the page returned nothing at
// all.
//
// aws-sdk-client-mock does NOT validate expressions against DynamoDB's reserved
// word list, so a test asserting "the request contained X" cannot catch a bare
// name — the mock accepts it happily and real DynamoDB rejects it. These tests
// assert the STRUCTURE instead: that nothing unaliased can ever reach the
// expression, whatever the field list contains.

describe("aliasedProjection", () => {
  it("aliases every name, not the ones that look reserved", () => {
    const { ProjectionExpression } = aliasedProjection([
      "sessionId",
      "role",
      "type",
    ]);

    expect(ProjectionExpression).toBe("#sessionId, #role, #type");
  });

  it("maps every placeholder back to its attribute", () => {
    const { ExpressionAttributeNames } = aliasedProjection(["role", "overallScore"]);

    expect(ExpressionAttributeNames).toEqual({
      "#role": "role",
      "#overallScore": "overallScore",
    });
  });

  // The invariant, stated as a property rather than as a list of names. A field
  // added to a projection later cannot escape it.
  it("leaves no bare attribute name in the expression", () => {
    const fields = [
      "type",
      "sessionId",
      "completedAt",
      "role",
      "overallScore",
      "topStrength",
      "topWeakness",
      "questionCount",
    ];

    const { ProjectionExpression } = aliasedProjection(fields);

    for (const token of ProjectionExpression.split(",").map((part) => part.trim())) {
      expect(token.startsWith("#")).toBe(true);
    }
  });

  // A sample of DynamoDB's several hundred reserved words. None of them may
  // appear bare, and none of them is special-cased — they survive because
  // everything is aliased.
  it.each(["role", "name", "status", "count", "timestamp", "depth", "type", "size"])(
    "aliases the reserved word %s",
    (reserved) => {
      const { ProjectionExpression, ExpressionAttributeNames } = aliasedProjection([
        reserved,
      ]);

      expect(ProjectionExpression).toBe(`#${reserved}`);
      expect(ExpressionAttributeNames[`#${reserved}`]).toBe(reserved);
    }
  );

  it("declares a placeholder for every name it uses", () => {
    const { ProjectionExpression, ExpressionAttributeNames } = aliasedProjection([
      "role",
      "type",
      "questionCount",
    ]);

    // An expression referencing a placeholder with no declaration is the other
    // way this request fails, and it fails at runtime rather than at compile.
    for (const token of ProjectionExpression.split(",").map((part) => part.trim())) {
      expect(ExpressionAttributeNames).toHaveProperty(token);
    }
  });

  it("returns an empty expression for an empty field list", () => {
    const { ProjectionExpression, ExpressionAttributeNames } = aliasedProjection([]);

    expect(ProjectionExpression).toBe("");
    expect(ExpressionAttributeNames).toEqual({});
  });
});
