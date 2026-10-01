import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Item, Person, Reviewer, Snapshot } from "./types";

const POLL_MS = 30_000;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
/** Chains with more members than this in a section collapse to their first few. */
const CHAIN_PREVIEW = 3;

const SHORTCUTS: [string[], string][] = [
  [["j", "↓"], "Next pull request"],
  [["k", "↑"], "Previous pull request"],
  [["g"], "Jump to the top"],
  [["G"], "Jump to the bottom"],
  [["↵", "o"], "Open on GitHub"],
  [["e"], "Expand or collapse a long chain"],
  [["c"], "Copy link"],
  [["r"], "Refresh now"],
  [["/"], "Filter"],
  [["esc"], "Clear filter"],
  [["?"], "Show shortcuts"],
];

function useQueue() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/queue${force ? "?force=true" : ""}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? response.statusText);
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return { data, error, busy, load };
}

/** Re-renders periodically so relative times stay current. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function ago(from: number, now: number) {
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function matches(item: Item, filter: string) {
  const haystack = `${item.repo} #${item.number} ${item.title} ${item.author.login}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

function collapse(items: Item[], expanded: (chain: string) => boolean) {
  const sizes = new Map<string, number>();
  for (const { chain } of items) if (chain) sizes.set(chain.id, (sizes.get(chain.id) ?? 0) + 1);

  const visible: Item[] = [];
  const hidden = new Map<string, number>();
  const shown = new Map<string, number>();
  for (const item of items) {
    const id = item.chain?.id;
    if (id && sizes.get(id)! > CHAIN_PREVIEW + 1 && !expanded(id)) {
      const count = shown.get(id) ?? 0;
      shown.set(id, count + 1);
      if (count >= CHAIN_PREVIEW) {
        hidden.set(id, (hidden.get(id) ?? 0) + 1);
        continue;
      }
    }
    visible.push(item);
  }
  const collapsible = (id: string) => sizes.get(id)! > CHAIN_PREVIEW + 1;
  return { visible, hidden, collapsible };
}

function Avatar({ person, state }: { person: Person; state?: Reviewer["state"] }) {
  const src = person.avatar_url && `${person.avatar_url}${person.avatar_url.includes("?") ? "&" : "?"}s=48`;
  return (
    <span className="avatar" data-state={state} title={state ? `${person.login}: ${state}` : person.login}>
      {src ? <img src={src} alt="" loading="lazy" /> : person.login.slice(0, 2)}
    </span>
  );
}

interface RowProps {
  item: Item;
  compact: boolean;
  selected: boolean;
  lit: boolean;
  up: boolean;
  down: boolean;
  index: number;
  now: number;
  viewer: Person;
  onSelect: (url: string) => void;
  onHover: (chain: string | null) => void;
}

function Row({ item, compact, selected, lit, up, down, index, now, viewer, onSelect, onHover }: RowProps) {
  const requested = new Date(item.requested_at).getTime();
  const stale = !compact && now - requested > STALE_MS;
  const classes = ["row", compact && "compact", selected && "selected", item.chain && "chain", lit && "lit", up && "up", down && "down"];
  const chip = item.chain
    ? `${item.chain.position}/${item.chain.total}${item.chain.parent ? ` · on #${item.chain.parent}` : ""}`
    : item.stacked_on && `on ${item.stacked_on}`;
  const reviewers = item.reviewers.slice(0, 5).map((reviewer) => (
    <Avatar key={reviewer.login} person={reviewer.me ? viewer : reviewer} state={reviewer.state} />
  ));

  return (
    <a
      className={classes.filter(Boolean).join(" ")}
      href={item.url}
      target="_blank"
      rel="noreferrer"
      data-url={item.url}
      style={{ animationDelay: `${Math.min(index, 14) * 18}ms` }}
      onClick={() => onSelect(item.url)}
      onMouseEnter={() => onHover(item.chain?.id ?? null)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="gutter">
        <i className="node" />
      </span>
      <span className="body">
        <span className="ref">
          <span>{item.repo}</span>
          <span>#{item.number}</span>
          {chip && <span className="chip stack">{chip}</span>}
        </span>
        <span className="title">{item.title}</span>
        <span className="sub">
          {!compact && <span>{item.author.login}</span>}
          <span className={item.urgent ? "reason urgent" : "reason"}>{item.reason}</span>
          {!compact && <span className={stale ? "stale" : undefined}>{ago(requested, now)}</span>}
        </span>
      </span>
      <span className="meta">
        {!compact && (
          <span className="diff">
            <span className="add">+{item.additions}</span> <span className="del">−{item.deletions}</span>
          </span>
        )}
        {!compact && item.ci && <span className={`ci ${item.ci}`} title={`Checks: ${item.ci}`} />}
        <span className="avatars">{reviewers}</span>
      </span>
    </a>
  );
}

export function App() {
  const { data, error, busy, load } = useQueue();
  const now = useNow(15_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sections = useMemo(() => {
    const build = (kind: "mine" | "rest", items: Item[]) => {
      const matching = items.filter((i) => matches(i, filter));
      return { kind, total: matching.length, ...collapse(matching, (id) => !!filter || expanded.has(`${kind}:${id}`)) };
    };
    return { mine: build("mine", data?.needs_you ?? []), rest: build("rest", data?.not_blocked ?? []) };
  }, [data, filter, expanded]);
  const all = useMemo(() => [...sections.mine.visible, ...sections.rest.visible], [sections]);
  const current = all.find((i) => i.url === selected) ?? all[0];
  const litChain = hovered ?? current?.chain?.id ?? null;

  useEffect(() => {
    const count = data?.needs_you.length;
    document.title = count ? `(${count}) Docket` : "Docket";
  }, [data]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(timer);
  }, [toast]);

  const select = useCallback((item: Item | undefined) => {
    if (!item) return;
    setSelected(item.url);
    requestAnimationFrame(() =>
      document.querySelector(`[data-url="${item.url}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }, []);

  const toggleChain = useCallback(
    (kind: "mine" | "rest", chain: string) => {
      const key = `${kind}:${chain}`;
      const next = new Set(expanded);
      const collapsing = next.delete(key);
      if (!collapsing) next.add(key);
      setExpanded(next);
      // Collapsing may hide the selection, so move it to the bottom of the stack.
      if (collapsing) select(sections[kind].visible.find((i) => i.chain?.id === chain));
    },
    [expanded, sections, select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = e.target === filterInput.current;
      const index = current ? all.indexOf(current) : -1;

      if (e.key === "Escape") {
        setHelp(false);
        setFilter("");
        filterInput.current?.blur();
        return;
      }
      if (typing && !["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;

      const actions: Record<string, () => void> = {
        j: () => select(all[Math.min(index + 1, all.length - 1)]),
        k: () => select(all[Math.max(index - 1, 0)]),
        g: () => select(all[0]),
        G: () => select(all[all.length - 1]),
        o: () => current && window.open(current.url, "_blank", "noreferrer"),
        c: () =>
          current && navigator.clipboard.writeText(current.url).then(() => setToast(`Copied link to #${current.number}`)),
        e: () => {
          const kind = sections.mine.visible.includes(current!) ? "mine" : "rest";
          const chain = current?.chain?.id;
          if (chain && !filter && sections[kind].collapsible(chain)) toggleChain(kind, chain);
        },
        r: () => load(true),
        "/": () => filterInput.current?.focus(),
        "?": () => setHelp((open) => !open),
      };
      const aliases: Record<string, string> = { ArrowDown: "j", ArrowUp: "k", Enter: "o" };
      const action = actions[aliases[e.key] ?? e.key];
      if (!action) return;
      e.preventDefault();
      if (typing && e.key === "Enter") filterInput.current?.blur();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, current, filter, load, sections, select, toggleChain]);

  const section = (title: string, { kind, total, visible, hidden, collapsible }: typeof sections.mine, offset: number) => (
    <section className={`section ${kind}`}>
      <header>
        <h2>{title}</h2>
        <span className="count">{total}</span>
      </header>
      {visible.length > 0 ? (
        <div className="list">
          {visible.map((item, i) => {
            const chain = item.chain?.id;
            const last = !!chain && visible[i + 1]?.chain?.id !== chain;
            const toggle = last && !filter && collapsible(chain);
            return (
              <Fragment key={item.url}>
                <Row
                  item={item}
                  compact={kind === "rest"}
                  selected={item === current}
                  lit={!!chain && chain === litChain}
                  up={!!chain && visible[i - 1]?.chain?.id === chain}
                  down={!!chain && (!last || hidden.has(chain))}
                  index={offset + i}
                  now={now}
                  viewer={data!.viewer}
                  onSelect={setSelected}
                  onHover={setHovered}
                />
                {toggle && (
                  <button className={chain === litChain ? "more lit" : "more"} onClick={() => toggleChain(kind, chain)}>
                    <span className="gutter" />
                    {hidden.has(chain) ? `${hidden.get(chain)} more in this chain` : "Show fewer"}
                    <kbd>e</kbd>
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <p className="empty">
          {filter ? "Nothing matches the filter." : kind === "mine" ? "Nothing is waiting on you." : "Nothing else open."}
        </p>
      )}
    </section>
  );

  const scope = data && [data.orgs.join(", "), data.repos.length ? `${data.repos.length} repos` : ""].filter(Boolean).join(" · ");

  return (
    <div className="app">
      <div className="bar">
        <span className="brand">
          <i />
          Docket
        </span>
        {data && <span className="chip">{scope || "All repositories"}</span>}
        <label className="filter">
          <input
            ref={filterInput}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter pull requests"
            spellCheck={false}
          />
          <kbd>/</kbd>
        </label>
        <button className="sync" onClick={() => load(true)} title="Refresh (r)">
          <span className={busy ? "dot busy" : error ? "dot error" : "dot"} />
          {data ? `Synced ${ago(data.fetched_at, now)}` : busy ? "Loading" : "Not synced"}
        </button>
      </div>

      {error && (
        <div className="error" role="alert">
          <strong>Could not refresh.</strong> {error}
        </div>
      )}

      {data ? (
        <main>
          {section("Needs you", sections.mine, 0)}
          {section("Not blocked on you", sections.rest, sections.mine.visible.length)}
        </main>
      ) : (
        !error && (
          <main aria-busy="true">
            <div className="list skeleton">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} />
              ))}
            </div>
          </main>
        )
      )}

      <footer className="keys">
        <span><kbd>j</kbd><kbd>k</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>c</kbd> copy link</span>
        <span><kbd>r</kbd> refresh</span>
        <span><kbd>?</kbd> all shortcuts</span>
      </footer>

      {help && (
        <div className="overlay" onClick={() => setHelp(false)}>
          <div className="help" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            <dl>
              {SHORTCUTS.map(([keys, label]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      <div className={toast ? "toast on" : "toast"} role="status">
        {toast}
      </div>
    </div>
  );
}
