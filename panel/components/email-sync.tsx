"use client";

import { useActionState, useState } from "react";
import * as A from "@/app/actions/email";
import { SubmitButton } from "./form";
import { Field, FormError, Select } from "./ui";

/** The last step of adding a source: which columns are the email, the name and fields, and the list. */
export function SyncMappingForm({
  brandId,
  project,
  db,
  table,
  columns,
  guess,
  cursorColumn,
  lists,
}: {
  brandId: number;
  project: string;
  db: string;
  table: string;
  columns: string[];
  guess: { email: string | null; name: string | null };
  cursorColumn: string | null;
  lists: { id: number; name: string }[];
}) {
  const [state, run] = useActionState(A.addEmailSync, {} as A.FormState);
  const [email, setEmail] = useState(guess.email ?? "");
  const [fields, setFields] = useState<string[]>([]);
  return (
    <form action={run} className="grid gap-4" data-testid="sync-mapping">
      {Object.entries({ brand: brandId, project, db, table, cursorColumn: cursorColumn ?? "" }).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email column" htmlFor="s-email">
          <Select id="s-email" name="emailColumn" value={email} onChange={(e) => setEmail(e.target.value)} required>
            <option value="">Pick one</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name column" htmlFor="s-name" hint="Optional">
          <Select id="s-name" name="nameColumn" defaultValue={guess.name ?? ""}>
            <option value="">None</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-1.5">
        <p className="text-[13px] font-medium">More columns as contact fields</p>
        <p className="text-[12px] text-muted">Up to 10, like a plan or the date they signed up. Leave out anything private: fields can go into emails.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
          {columns
            .filter((c) => c !== email)
            .map((c) => (
              <label key={c} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  name="fieldColumns"
                  value={c}
                  checked={fields.includes(c)}
                  disabled={!fields.includes(c) && fields.length >= 10}
                  onChange={(e) => setFields(e.target.checked ? [...fields, c] : fields.filter((x) => x !== c))}
                />
                <code className="font-mono text-[12.5px]">{c}</code>
              </label>
            ))}
        </div>
      </div>
      <Field label="Add them to" htmlFor="s-list">
        <Select id="s-list" name="list" defaultValue={lists[0]?.id ?? ""}>
          <option value="">No list: contacts only</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-[12px] text-muted">
        {cursorColumn
          ? `Every 15 minutes it reads the rows added since the last sync (by ${cursorColumn}).`
          : "This table has no single primary key, so every 15 minutes it reads all of it again: contacts already in Email are only updated."}{" "}
        New contacts come in subscribed, through Shield&apos;s address checks. Nobody who unsubscribed or bounced comes back.
      </p>
      <FormError message={state.error} />
      <div>
        <SubmitButton pending="Adding…" className="w-auto">
          Add and sync now
        </SubmitButton>
      </div>
    </form>
  );
}
