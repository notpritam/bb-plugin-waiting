// Link chips, shared by the card, the home overview and the question form.
//
// An item's links open on the web (https or a bb thread); a host path, from
// before links had to, is flagged in red.
import {
  experimental_FileLink as FileLink,
  UrlLink,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { ItemLink } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export const LINK_PILL_CLASS =
  "inline-flex h-4 max-w-56 min-w-0 shrink-0 items-center gap-0.5 rounded-full bg-surface-recessed px-1.5 text-2xs leading-none text-subtle-foreground transition-colors hover:text-foreground";

export function linkLabel(link: ItemLink): string {
  if (link.label !== null && link.label !== "") return link.label;
  switch (link.kind) {
    case "url": {
      try {
        const url = new URL(link.url);
        const text = `${url.host}${url.pathname.replace(/\/$/u, "")}${url.search}`;
        return text.length > 48 ? `${text.slice(0, 45)}…` : text;
      } catch {
        return link.url;
      }
    }
    case "file": {
      const parts = link.path.split("/").filter((part) => part !== "");
      const tail = parts.slice(-2).join("/");
      return tail === "" ? link.path : tail;
    }
    case "thread":
      return "thread";
  }
}

export function LinkPill({ link }: { link: ItemLink }) {
  const navigate = useBbNavigate();
  const label = linkLabel(link);
  const inner = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      <Icon name="ArrowUpRight" className="size-2.5 shrink-0" aria-hidden="true" />
    </>
  );
  switch (link.kind) {
    case "url":
      return (
        <UrlLink href={link.url} className={LINK_PILL_CLASS} title={link.url}>
          {inner}
        </UrlLink>
      );
    case "file":
      // Added before links had to open on the web: flag it, quietly.
      return (
        <FileLink
          target={{ kind: "host", hostId: link.hostId, path: link.path }}
          className={cn(LINK_PILL_CLASS, "text-destructive-text")}
          title={`${link.path}: a file on the host, which doesn't open on the web. Ask the agent for an https link.`}
        >
          <Icon name="TriangleAlert" fallback="Info" className="size-2.5 shrink-0" aria-hidden="true" />
          {inner}
        </FileLink>
      );
    case "thread":
      return (
        <button
          type="button"
          className={LINK_PILL_CLASS}
          title={link.threadId}
          onClick={() => navigate.toThread(link.threadId)}
        >
          {inner}
        </button>
      );
  }
}

/** A link from a payload, checked before it is drawn. */
export function readLink(value: unknown): ItemLink | null {
  if (typeof value !== "object" || value === null) return null;
  const link = value as Record<string, unknown>;
  const label = typeof link.label === "string" ? link.label : null;
  switch (link.kind) {
    case "url":
      return typeof link.url === "string" ? { kind: "url", url: link.url, label } : null;
    case "file":
      return typeof link.hostId === "string" && typeof link.path === "string"
        ? { kind: "file", hostId: link.hostId, path: link.path, label }
        : null;
    case "thread":
      return typeof link.threadId === "string"
        ? { kind: "thread", threadId: link.threadId, label }
        : null;
    default:
      return null;
  }
}
