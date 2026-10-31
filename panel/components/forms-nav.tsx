"use client";

// Forms' own sidebar, beside the panel's (shrunk to its icons): the form
// picker at the top, then the form's pages. On phones it's a picker and a row
// of tabs above the page.
import { BookTextIcon, ChartNoAxesColumnIcon, CheckIcon, ChevronsUpDownIcon, InboxIcon, LayoutGridIcon, PencilRulerIcon, PlusIcon, PuzzleIcon, SettingsIcon, Share2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { NewFormDialog } from "./forms-forms";
import { Icon, type IconSvgElement } from "./icon";
import { Dropdown, MENU_ITEM } from "./menu";
import { cx } from "./ui";

export interface NavForm {
  id: number;
  title: string;
  responses: number;
  open: boolean;
}

const SECTIONS: { path: string; label: string; icon: IconSvgElement }[] = [
  { path: "", label: "Build", icon: PencilRulerIcon },
  { path: "/share", label: "Share", icon: Share2Icon },
  { path: "/responses", label: "Responses", icon: InboxIcon },
  { path: "/insights", label: "Insights", icon: ChartNoAxesColumnIcon },
  { path: "/settings", label: "Settings", icon: SettingsIcon },
];

const ITEM = "flex w-full cursor-pointer select-none items-center gap-[9px] px-[9px] py-1.5 text-left text-foreground transition-colors duration-150 hover:bg-card";
const ICON = "grid w-[15px] shrink-0 place-items-center opacity-75";

/** The section after /forms/<id>: the first part of the rest of the path. */
function useSection(form: number): string {
  const pathname = usePathname();
  const rest = pathname.slice(`/forms/${form}`.length);
  const first = rest.match(/^\/[^/]+/)?.[0] ?? "";
  return SECTIONS.some((s) => s.path === first) ? first : "";
}

function FormPicker({ forms, current, wide }: { forms: NavForm[]; current: NavForm; wide?: boolean }) {
  const router = useRouter();
  const section = useSection(current.id);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Dropdown
        label="Pick a form"
        align="left"
        width={wide ? 260 : 240}
        buttonClassName="flex w-full items-center gap-2 p-2 text-left transition-colors duration-150 hover:bg-card"
        trigger={
          <>
            <span className="grid size-7 shrink-0 place-items-center bg-icon-tile text-[13px] font-black uppercase text-icon-tile-fg">{current.title.slice(0, 1)}</span>
            <span className="grid min-w-0 flex-1 leading-tight">
              <b className="truncate font-bold" data-testid="form-picker">
                {current.title}
              </b>
              <span className="truncate text-[11.5px] text-muted">Forms</span>
            </span>
            <span className="text-muted">
              <Icon icon={ChevronsUpDownIcon} size={14} />
            </span>
          </>
        }
      >
        {(close) => (
          <>
            <div className="max-h-[320px] overflow-y-auto">
              {forms.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    close();
                    router.push(`/forms/${f.id}${section}`);
                  }}
                >
                  <span className="grid w-4 shrink-0 place-items-center">{f.id === current.id && <Icon icon={CheckIcon} size={14} />}</span>
                  <span className={cx("min-w-0 flex-1 truncate", !f.open && "text-muted")}>{f.title}</span>
                  <span className="text-[12px] tabular-nums text-dim" title="Responses">
                    {f.responses.toLocaleString("en")}
                  </span>
                </button>
              ))}
            </div>
            <div className="my-1 h-px bg-border" />
            <Link href="/forms" role="menuitem" className={MENU_ITEM} onClick={close}>
              <span className="grid w-4 shrink-0 place-items-center">
                <Icon icon={LayoutGridIcon} size={14} />
              </span>
              All forms
            </Link>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setAdding(true);
              }}
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <Icon icon={PlusIcon} size={14} />
              </span>
              New form
            </button>
          </>
        )}
      </Dropdown>
      {adding && <NewFormDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export function FormsNav({ forms, current, manage, version }: { forms: NavForm[]; current: NavForm; manage: string; version: string | null }) {
  const section = useSection(current.id);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[208px] shrink-0 self-start border-r border-sidebar-line bg-sidebar md:block">
      <div className="flex h-full flex-col overflow-y-auto px-2 py-2.5">
        <div className="mb-2.5">
          <FormPicker forms={forms} current={current} />
        </div>
        <nav className="flex flex-1 flex-col gap-px" aria-label={current.title}>
          {SECTIONS.map((s) => (
            <Link key={s.path} href={`/forms/${current.id}${s.path}`} aria-current={section === s.path ? "page" : undefined} className={cx(ITEM, section === s.path && "bg-selected hover:bg-selected")}>
              <span className={ICON}>
                <Icon icon={s.icon} />
              </span>
              <span className="flex-1 truncate">{s.label}</span>
              {s.path === "/responses" && current.responses > 0 && <span className="text-[11px] tabular-nums text-muted">{current.responses.toLocaleString("en")}</span>}
            </Link>
          ))}
        </nav>
        <div className="mt-2 flex flex-col gap-px border-t border-sidebar-line pt-2">
          <a href="https://selfhostlayer.com/docs/forms" target="_blank" rel="noreferrer" className={cx(ITEM, "text-muted")}>
            <span className={ICON}>
              <Icon icon={BookTextIcon} />
            </span>
            <span className="flex-1 truncate">Docs</span>
          </a>
          <Link href={manage} className={cx(ITEM, "text-muted")} title="Manage Forms: its deployments, logs, backups and updates">
            <span className={ICON}>
              <Icon icon={PuzzleIcon} />
            </span>
            <span className="flex-1 truncate">Forms</span>
            {version && <span className="font-mono text-[11px] text-dim">{version}</span>}
          </Link>
        </div>
      </div>
    </aside>
  );
}

/** Phones: the picker and the pages as a row of tabs, above the page. */
export function FormsBar({ forms, current }: { forms: NavForm[]; current: NavForm }) {
  const section = useSection(current.id);
  return (
    <div className="grid gap-2 md:hidden">
      <div className="border border-border bg-card">
        <FormPicker forms={forms} current={current} wide />
      </div>
      <nav className="flex gap-0.5 overflow-x-auto border border-border bg-field p-[3px]" aria-label={current.title}>
        {SECTIONS.map((s) => (
          <Link key={s.path} href={`/forms/${current.id}${s.path}`} aria-current={section === s.path ? "page" : undefined} className={cx("whitespace-nowrap px-[13px] py-[5px] transition-colors duration-150", section === s.path ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}>
            {s.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
