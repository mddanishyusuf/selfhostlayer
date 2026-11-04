import { describe, expect, it } from "vitest";
import { fieldName, pagingColumn } from "./email-sync";

describe("pagingColumn", () => {
  it("pages by a single primary key column, never by SQLite's hidden rowid or a composite key", () => {
    expect(pagingColumn({ columns: ["id", "email"], rows: [], total: 0, truncated: false, ms: 1, key: { columns: ["id"], rows: [] } })).toBe("id");
    expect(pagingColumn({ columns: ["email"], rows: [], total: 0, truncated: false, ms: 1, key: { columns: ["rowid"], rows: [] } })).toBeNull();
    expect(pagingColumn({ columns: ["a", "b"], rows: [], total: 0, truncated: false, ms: 1, key: { columns: ["a", "b"], rows: [] } })).toBeNull();
    // A view has no key, but its schema may still say which column is the primary key.
    expect(pagingColumn({ columns: ["uid", "email"], rows: [], total: 0, truncated: false, ms: 1, schema: [{ name: "uid", type: "INTEGER", nullable: false, pk: true }] })).toBe("uid");
    expect(pagingColumn(undefined)).toBeNull();
  });
});

describe("fieldName", () => {
  it("turns a column's name into a contact field's", () => {
    expect(fieldName("SignupDate")).toBe("signupdate");
    expect(fieldName("plan name")).toBe("plan_name");
    expect(fieldName("2fa")).toBe("f_2fa");
    expect(fieldName("—")).toBe("field");
  });
});
