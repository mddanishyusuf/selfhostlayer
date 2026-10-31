// A form's questions as Forms keeps them (catalog/forms/src/schema.ts), with
// nothing of the server's: the builder in the browser uses it too.

export type FieldType = "short_text" | "long_text" | "email" | "number" | "url" | "phone" | "choice" | "multi" | "dropdown" | "yes_no" | "rating" | "scale" | "date" | "file" | "statement" | "hidden" | "page_break";
export type Op = "is" | "is_not" | "contains" | "answered" | "not_answered" | "gt" | "lt";

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  placeholder: string;
  options: string[];
  min: number | null;
  max: number | null;
  maxLength: number | null;
  param: string;
  accept: string;
  showIf: { field: string; op: Op; value: string } | null;
}

export interface Schema {
  description: string;
  layout: "classic" | "conversational";
  theme: { accent: string; mode: "light" | "dark"; logo: string };
  button: string;
  thanks: { title: string; message: string; redirect: string };
  fields: Field[];
}

/** An answer as text. */
export const answerText = (a: unknown): string => (Array.isArray(a) ? a.join(", ") : a === undefined || a === null ? "" : String(a));

export const FIELD_LABELS: Record<FieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  email: "Email",
  number: "Number",
  url: "Link",
  phone: "Phone",
  choice: "One choice",
  multi: "Several choices",
  dropdown: "Dropdown",
  yes_no: "Yes or no",
  rating: "Rating",
  scale: "Scale (0 to 10)",
  date: "Date",
  file: "File upload",
  statement: "Text (no answer)",
  hidden: "Hidden (from the link)",
  page_break: "Page break",
};
