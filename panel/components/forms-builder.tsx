"use client";

// The form builder: the fields in order (click one for its settings; up, down,
// copy, delete), a field's settings with its logic, the form's design and
// thank-you screen, and the real page as a preview, reloaded after each save.
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, ExternalLinkIcon, GitBranchIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useActionState, useEffect, useMemo, useState } from "react";
import { saveForm, type FormState } from "@/app/actions/forms";
import { FIELD_LABELS, type Field, type FieldType, type Op, type Schema } from "@/lib/form-schema";
import type { Form } from "@/lib/forms";
import { SubmitButton } from "./form";
import { Icon } from "./icon";
import { Button, buttonClass, Field as Labeled, FormError, Input, Select, cx } from "./ui";

const GROUPS: [string, FieldType[]][] = [
  ["Text", ["short_text", "long_text", "email", "number", "url", "phone", "date"]],
  ["Choices", ["choice", "multi", "dropdown", "yes_no", "rating", "scale"]],
  ["More", ["file", "statement", "hidden", "page_break"]],
];
const OPS: [Op, string][] = [
  ["is", "is"],
  ["is_not", "isn't"],
  ["contains", "contains"],
  ["answered", "is answered"],
  ["not_answered", "isn't answered"],
  ["gt", "is more than"],
  ["lt", "is less than"],
];
const ANSWERLESS: FieldType[] = ["statement", "page_break"];
const area = "w-full border border-border bg-field px-2.5 py-2 outline-none focus:border-accent";

function newField(type: FieldType, taken: Set<string>): Field {
  let id = "";
  do id = `q${Math.random().toString(36).slice(2, 6)}`;
  while (taken.has(id));
  return {
    id,
    type,
    label: type === "page_break" ? "" : type === "statement" ? "A few words before the next questions" : FIELD_LABELS[type],
    help: "",
    required: false,
    placeholder: "",
    options: ["choice", "multi", "dropdown"].includes(type) ? ["First choice", "Second choice"] : [],
    min: null,
    max: type === "rating" ? 5 : null,
    maxLength: null,
    param: type === "hidden" ? "ref" : "",
    accept: "",
    showIf: null,
  };
}

function FieldSettings({ field, earlier, onChange }: { field: Field; earlier: Field[]; onChange: (f: Field) => void }) {
  const set = (patch: Partial<Field>) => onChange({ ...field, ...patch });
  const target = earlier.find((f) => f.id === field.showIf?.field);
  const answers = ["text", "short_text", "long_text", "email", "url", "phone", "date", "number", "choice", "multi", "dropdown", "yes_no", "rating", "scale"];
  return (
    <div className="grid gap-3" data-testid="field-settings">
      <Labeled label="Kind" htmlFor="fs-type">
        <Select id="fs-type" value={field.type} onChange={(e) => set({ type: e.target.value as FieldType, options: ["choice", "multi", "dropdown"].includes(e.target.value) && !field.options.length ? ["First choice", "Second choice"] : field.options, max: e.target.value === "rating" ? 5 : field.max })}>
          {GROUPS.map(([g, types]) => (
            <optgroup key={g} label={g}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {FIELD_LABELS[t]}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Labeled>
      {field.type !== "page_break" && (
        <>
          <Labeled label={field.type === "statement" ? "Heading" : "Question"} htmlFor="fs-label">
            <Input id="fs-label" value={field.label} onChange={(e) => set({ label: e.target.value })} />
          </Labeled>
          <Labeled label="Description" htmlFor="fs-help" hint="Optional, under the question">
            <textarea id="fs-help" rows={2} value={field.help} onChange={(e) => set({ help: e.target.value })} className={area} />
          </Labeled>
        </>
      )}
      {["short_text", "long_text", "email", "number", "url", "phone", "dropdown"].includes(field.type) && (
        <Labeled label="Placeholder" htmlFor="fs-ph">
          <Input id="fs-ph" value={field.placeholder} onChange={(e) => set({ placeholder: e.target.value })} />
        </Labeled>
      )}
      {["choice", "multi", "dropdown"].includes(field.type) && (
        <Labeled label="Choices" htmlFor="fs-opts" hint="One per line">
          <textarea id="fs-opts" rows={5} value={field.options.join("\n")} onChange={(e) => set({ options: e.target.value.split("\n") })} onBlur={() => set({ options: field.options.map((o) => o.trim()).filter(Boolean) })} className={cx(area, "font-mono text-[12.5px]")} />
        </Labeled>
      )}
      {field.type === "rating" && (
        <Labeled label="Stars" htmlFor="fs-stars">
          <Select id="fs-stars" value={String(field.max ?? 5)} onChange={(e) => set({ max: Number(e.target.value) })}>
            <option value="5">5</option>
            <option value="10">10</option>
          </Select>
        </Labeled>
      )}
      {(field.type === "number" || field.type === "scale") && (
        <div className="grid grid-cols-2 gap-2">
          <Labeled label="At least" htmlFor="fs-min">
            <Input id="fs-min" type="number" value={field.min ?? ""} placeholder={field.type === "scale" ? "0" : ""} onChange={(e) => set({ min: e.target.value === "" ? null : Number(e.target.value) })} />
          </Labeled>
          <Labeled label="At most" htmlFor="fs-max">
            <Input id="fs-max" type="number" value={field.max ?? ""} placeholder={field.type === "scale" ? "10" : ""} onChange={(e) => set({ max: e.target.value === "" ? null : Number(e.target.value) })} />
          </Labeled>
        </div>
      )}
      {(field.type === "short_text" || field.type === "long_text") && (
        <Labeled label="Longest answer" htmlFor="fs-len" hint="Characters; empty for no limit of your own">
          <Input id="fs-len" type="number" min={1} value={field.maxLength ?? ""} onChange={(e) => set({ maxLength: e.target.value === "" ? null : Number(e.target.value) })} />
        </Labeled>
      )}
      {field.type === "hidden" && (
        <Labeled label="From the link's" htmlFor="fs-param" hint="?ref=newsletter fills it with newsletter">
          <Input id="fs-param" value={field.param} onChange={(e) => set({ param: e.target.value.replace(/[^\w-]/g, "") })} spellCheck={false} />
        </Labeled>
      )}
      {field.type === "file" && (
        <Labeled label="Kinds of files" htmlFor="fs-accept" hint="Like .pdf, image/*; empty for any (10 MB at most)">
          <Input id="fs-accept" value={field.accept} onChange={(e) => set({ accept: e.target.value })} spellCheck={false} />
        </Labeled>
      )}
      {!ANSWERLESS.includes(field.type) && field.type !== "hidden" && (
        <label className="flex items-center gap-2.5 text-[13px]">
          <input type="checkbox" checked={field.required} onChange={(e) => set({ required: e.target.checked })} className="size-4 accent-accent" /> Required
        </label>
      )}
      {field.type !== "page_break" && (
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="flex items-center gap-2.5 text-[13px]">
            <input type="checkbox" checked={!!field.showIf} disabled={!earlier.length} onChange={(e) => set({ showIf: e.target.checked ? { field: earlier.at(-1)!.id, op: "is", value: "" } : null })} className="size-4 accent-accent" data-testid="logic-toggle" />
            Show only when an earlier answer…
          </label>
          {field.showIf && (
            <div className="grid gap-2">
              <Select aria-label="Which answer" value={field.showIf.field} onChange={(e) => set({ showIf: { ...field.showIf!, field: e.target.value } })}>
                {earlier.filter((f) => answers.includes(f.type) || f.type === "hidden").map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label || f.id}
                  </option>
                ))}
              </Select>
              <Select aria-label="Condition" value={field.showIf.op} onChange={(e) => set({ showIf: { ...field.showIf!, op: e.target.value as Op } })}>
                {OPS.map(([op, label]) => (
                  <option key={op} value={op}>
                    {label}
                  </option>
                ))}
              </Select>
              {!["answered", "not_answered"].includes(field.showIf.op) &&
                (target && ["choice", "multi", "dropdown", "yes_no"].includes(target.type) ? (
                  <Select aria-label="Value" value={field.showIf.value} onChange={(e) => set({ showIf: { ...field.showIf!, value: e.target.value } })}>
                    <option value="">Choose…</option>
                    {(target.type === "yes_no" ? ["yes", "no"] : target.options).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input aria-label="Value" value={field.showIf.value} onChange={(e) => set({ showIf: { ...field.showIf!, value: e.target.value } })} placeholder="Value" />
                ))}
            </div>
          )}
        </div>
      )}
      <Labeled label="Field id" htmlFor="fs-id" hint="In the CSV, webhooks, and links that fill it in (?email=…)">
        <Input id="fs-id" value={field.id} onChange={(e) => set({ id: e.target.value.replace(/[^\w-]/g, "").slice(0, 40) })} spellCheck={false} className="font-mono text-[12.5px]" />
      </Labeled>
    </div>
  );
}

function DesignSettings({ schema, setSchema }: { schema: Schema; setSchema: (s: Schema) => void }) {
  const set = (patch: Partial<Schema>) => setSchema({ ...schema, ...patch });
  return (
    <div className="grid gap-3" data-testid="design-settings">
      <Labeled label="Description" htmlFor="ds-desc" hint="Under the title">
        <textarea id="ds-desc" rows={3} value={schema.description} onChange={(e) => set({ description: e.target.value })} className={area} />
      </Labeled>
      <Labeled label="Layout" htmlFor="ds-layout">
        <Select id="ds-layout" value={schema.layout} onChange={(e) => set({ layout: e.target.value as Schema["layout"] })}>
          <option value="classic">Classic: the questions on a page (page breaks for steps)</option>
          <option value="conversational">Conversational: one question at a time</option>
        </Select>
      </Labeled>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Color" htmlFor="ds-accent">
          <div className="flex items-center gap-2">
            <input type="color" value={schema.theme.accent} onChange={(e) => set({ theme: { ...schema.theme, accent: e.target.value } })} className="h-[39px] w-12 cursor-pointer border border-border bg-field" aria-label="Pick a color" />
            <Input id="ds-accent" value={schema.theme.accent} onChange={(e) => set({ theme: { ...schema.theme, accent: e.target.value } })} className="font-mono" />
          </div>
        </Labeled>
        <Labeled label="Mode" htmlFor="ds-mode">
          <Select id="ds-mode" value={schema.theme.mode} onChange={(e) => set({ theme: { ...schema.theme, mode: e.target.value as "light" | "dark" } })}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </Labeled>
      </div>
      <Labeled label="Logo" htmlFor="ds-logo" hint="An image's link, https://…">
        <Input id="ds-logo" value={schema.theme.logo} onChange={(e) => set({ theme: { ...schema.theme, logo: e.target.value } })} />
      </Labeled>
      <Labeled label="Button" htmlFor="ds-button">
        <Input id="ds-button" value={schema.button} onChange={(e) => set({ button: e.target.value })} />
      </Labeled>
      <div className="grid gap-3 border-t border-border pt-3">
        <b className="text-[13px]">After sending</b>
        <Labeled label="Title" htmlFor="ds-thanks">
          <Input id="ds-thanks" value={schema.thanks.title} onChange={(e) => set({ thanks: { ...schema.thanks, title: e.target.value } })} />
        </Labeled>
        <Labeled label="Message" htmlFor="ds-msg">
          <textarea id="ds-msg" rows={3} value={schema.thanks.message} onChange={(e) => set({ thanks: { ...schema.thanks, message: e.target.value } })} className={area} />
        </Labeled>
        <Labeled label="Or go to a page" htmlFor="ds-redirect" hint="https://… instead of the message">
          <Input id="ds-redirect" value={schema.thanks.redirect} onChange={(e) => set({ thanks: { ...schema.thanks, redirect: e.target.value } })} />
        </Labeled>
      </div>
    </div>
  );
}

/** What Forms said was wrong, by the question it's about: fields[2].options → question 3. */
function problem(state: FormState, fields: Field[]): { message: string; index: number | null } | null {
  if (!state.error) return null;
  const m = /^fields\[(\d+)\]/.exec(state.field ?? "");
  if (!m) return { message: state.error, index: null };
  const i = Number(m[1]);
  const f = fields[i];
  return { message: `Question ${i + 1}${f?.label ? ` (${f.label})` : ""}: ${state.error}.`, index: i };
}

export function FormBuilder({ form, publicUrl, preview }: { form: Form; publicUrl: string; preview: string }) {
  const [state, run] = useActionState(saveForm, {} as FormState);
  const [title, setTitle] = useState(form.title);
  const [schema, setSchema] = useState<Schema>(form.schema);
  const [selected, setSelected] = useState<string | null>(form.schema.fields[0]?.id ?? null);
  const [panel, setPanel] = useState<"field" | "design">("field");
  const [adding, setAdding] = useState<FieldType>("short_text");
  const [reload, setReload] = useState(0);
  const fields = schema.fields;
  const wrong = problem(state, fields);
  useEffect(() => {
    if (state.saved) setReload((n) => n + 1);
    // Straight to the question that needs fixing.
    if (wrong?.index !== null && wrong?.index !== undefined && fields[wrong.index]) {
      setSelected(fields[wrong.index]!.id);
      setPanel("field");
    }
    // Only when an answer comes back, not as the fields change.
  }, [state]);
  const index = fields.findIndex((f) => f.id === selected);
  const field = index >= 0 ? fields[index]! : null;
  const setFields = (next: Field[]) => setSchema({ ...schema, fields: next });
  const change = (i: number, f: Field) => {
    const old = fields[i]!;
    // A renamed id renames the conditions that point at it.
    setFields(fields.map((x, j) => (j === i ? f : x.showIf?.field === old.id && old.id !== f.id ? { ...x, showIf: { ...x.showIf, field: f.id } } : x)));
    if (old.id !== f.id) setSelected(f.id);
  };
  const move = (i: number, d: number) => {
    const next = [...fields];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setFields(next);
  };
  const add = () => {
    const f = newField(adding, new Set(fields.map((x) => x.id)));
    const at = index >= 0 ? index + 1 : fields.length;
    setFields([...fields.slice(0, at), f, ...fields.slice(at)]);
    setSelected(f.id);
    setPanel("field");
  };
  const json = useMemo(() => JSON.stringify(schema), [schema]);
  const pageUrl = `${publicUrl}/f/${form.slug}`;
  return (
    <form action={run} className="grid grid-cols-[minmax(0,1fr)] gap-3.5" data-testid="form-builder">
      <input type="hidden" name="id" value={form.id} />
      <input type="hidden" name="schema" value={json} />
      <section className="border border-border bg-card p-3.5">
        <Labeled
          label="Title"
          htmlFor="fb-title"
          wide
          action={
            <>
              <a href={pageUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary")}>
                <Icon icon={ExternalLinkIcon} size={14} /> Open the form
              </a>
              <SubmitButton pending="Saving…" className="w-auto">
                Save
              </SubmitButton>
            </>
          }
        >
          <Input id="fb-title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Labeled>
      </section>
      <FormError message={wrong?.message} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="border border-border bg-card">
          <div className="flex items-center justify-between px-3.5 pb-2.5 pt-3.5">
            <h2 className="text-[14px] font-bold">Questions</h2>
            <span className="text-[12px] text-muted">{fields.filter((f) => !ANSWERLESS.includes(f.type)).length} questions</span>
          </div>
          {fields.length === 0 && <p className="border-t border-border px-3.5 py-6 text-center text-muted">No questions yet: add the first below.</p>}
          {fields.map((f, i) => (
            <div
              key={`${f.id}-${i}`}
              role="button"
              tabIndex={0}
              onClick={() => (setSelected(f.id), setPanel("field"))}
              onKeyDown={(e) => e.key === "Enter" && (setSelected(f.id), setPanel("field"))}
              className={cx("group flex items-center gap-2.5 border-t border-border px-3.5 py-2.5 text-[13px] transition-colors", selected === f.id && panel === "field" ? "bg-selected" : "hover:bg-hover", f.type === "page_break" && "bg-well")}
              data-testid="builder-field"
            >
              <span className="grid size-6 shrink-0 place-items-center bg-well text-[11px] tabular-nums text-muted">{f.type === "page_break" ? "—" : i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {f.type === "page_break" ? "Page break" : f.label || <span className="text-dim">Untitled</span>}
                  {f.required && <span className="text-accent"> *</span>}
                </span>
                <span className="block truncate text-[12px] text-muted">
                  {FIELD_LABELS[f.type]}
                  {f.showIf ? " · shown by logic" : ""}
                </span>
              </span>
              {f.showIf && <Icon icon={GitBranchIcon} size={13} className="text-tile-blue" />}
              <span className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                {[
                  [ArrowUpIcon, "Up", i === 0, () => move(i, -1)],
                  [ArrowDownIcon, "Down", i === fields.length - 1, () => move(i, 1)],
                  [CopyIcon, "Copy", false, () => setFields([...fields.slice(0, i + 1), { ...f, id: newField(f.type, new Set(fields.map((x) => x.id))).id, showIf: f.showIf }, ...fields.slice(i + 1)])],
                  [TrashIcon, "Delete", false, () => setFields(fields.filter((_, j) => j !== i).map((x) => (x.showIf?.field === f.id ? { ...x, showIf: null } : x)))],
                ].map(([icon, label, disabled, onClick]) => (
                  <button
                    key={label as string}
                    type="button"
                    aria-label={label as string}
                    title={label as string}
                    disabled={disabled as boolean}
                    onClick={(e) => (e.stopPropagation(), (onClick as () => void)())}
                    className="grid size-7 place-items-center text-muted hover:bg-card hover:text-foreground disabled:opacity-30"
                  >
                    <Icon icon={icon as typeof ArrowUpIcon} size={13} />
                  </button>
                ))}
              </span>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-3">
            <div className="w-full sm:w-[220px]">
              <Select aria-label="Kind of question" value={adding} onChange={(e) => setAdding(e.target.value as FieldType)} data-testid="add-kind">
                {GROUPS.map(([g, types]) => (
                  <optgroup key={g} label={g}>
                    {types.map((t) => (
                      <option key={t} value={t}>
                        {FIELD_LABELS[t]}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <Button type="button" variant="secondary" onClick={add} data-testid="add-field">
              <Icon icon={PlusIcon} size={13} /> Add {index >= 0 ? "after the selected one" : "a question"}
            </Button>
          </div>
        </section>
        <section className="border border-border bg-card xl:sticky xl:top-[22px]">
          <div className="flex gap-0.5 border-b border-border p-[3px]">
            {(["field", "design"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPanel(p)} className={cx("flex-1 py-[6px] text-[13px] transition-colors", panel === p ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}>
                {p === "field" ? "Question" : "Design"}
              </button>
            ))}
          </div>
          <div className="p-3.5">
            {panel === "design" ? (
              <DesignSettings schema={schema} setSchema={setSchema} />
            ) : field ? (
              <FieldSettings field={field} earlier={fields.slice(0, index).filter((f) => !ANSWERLESS.includes(f.type))} onChange={(f) => change(index, f)} />
            ) : (
              <p className="text-muted">Pick a question to change it.</p>
            )}
          </div>
        </section>
      </div>
      <section className="border border-border bg-card">
        <div className="flex items-center justify-between px-3.5 pb-2.5 pt-3.5">
          <h2 className="text-[14px] font-bold">Preview</h2>
          <span className="text-[12px] text-muted">As saved, and nothing sent from it is kept: save to see changes</span>
        </div>
        <iframe key={reload} title="Preview" src={`${pageUrl}?preview=${encodeURIComponent(preview)}`} className={cx("h-[680px] w-full border-t border-border", form.schema.theme.mode === "dark" ? "bg-[#0f0f10]" : "bg-[#f7f7f8]")} data-testid="form-preview" />
      </section>
    </form>
  );
}
