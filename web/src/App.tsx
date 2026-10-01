import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Item, Person, Reviewer, Snapshot } from "./types";

const POLL_MS = 30_000;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
/** Chains with more members than this in a section collapse to their first few. */
const CHAIN_PREVIEW = 3;
const TOAST_MS = 1600;
const WARNING_MS = 4500;
const SNOOZE_KEY = "docket:snoozed";
const COLLAPSE_KEY = "docket:collapse-chains";

const SHORTCUTS: [string[], string][] = [
  [["j", "↓"], "Next pull request"],
  [["k", "↑"], "Previous pull request"],
  [["g"], "Jump to the top"],
  [["G"], "Jump to the bottom"],
  [["↵", "o"], "Open on GitHub"],
  [["e"], "Expand or collapse a long chain"],
  [["E"], "Collapse every chain into one entry"],
  [["c"], "Copy link"],
  [["s"], "Snooze until tomorrow"],
  [["z"], "Show snoozed"],
  [["u"], "Unsnooze, in the snoozed list"],
  [["U"], "Unsnooze the whole chain, in the snoozed list"],
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

function storedSnoozes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** Snoozed pull requests, by URL, with the time each one wakes up. */
function useSnoozed(now: number) {
  const [until, setUntil] = useState(storedSnoozes);

  useEffect(() => localStorage.setItem(SNOOZE_KEY, JSON.stringify(until)), [until]);

  const update = useCallback((change: (next: Record<string, number>) => void) => {
    setUntil((previous) => {
      // Drop expired entries here so storage doesn't grow forever.
      const next = Object.fromEntries(Object.entries(previous).filter(([, time]) => time > Date.now()));
      change(next);
      return next;
    });
  }, []);

  const snooze = useCallback(
    (urls: string[]) =>
      update((next) => {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        for (const url of urls) next[url] = midnight.getTime();
      }),
    [update],
  );
  const unsnooze = useCallback(
    (urls: string[]) =>
      update((next) => {
        for (const url of urls) delete next[url];
      }),
    [update],
  );
  const isSnoozed = useCallback((url: string) => (until[url] ?? 0) > now, [until, now]);

  return { isSnoozed, snooze, unsnooze };
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

function collapse(items: Item[], single: boolean, expanded: (chain: string) => boolean) {
  const sizes = new Map<string, number>();
  for (const { chain } of items) if (chain) sizes.set(chain.id, (sizes.get(chain.id) ?? 0) + 1);

  const preview = single ? 1 : CHAIN_PREVIEW;
  // Outside single mode, a chain just one over the preview isn't worth collapsing.
  const collapsible = (id: string) => sizes.get(id)! > (single ? 1 : CHAIN_PREVIEW + 1);

  const visible: Item[] = [];
  const hidden = new Map<string, number>();
  const shown = new Map<string, number>();
  for (const item of items) {
    const id = item.chain?.id;
    if (id && collapsible(id) && !expanded(id)) {
      const count = shown.get(id) ?? 0;
      shown.set(id, count + 1);
      if (count >= preview) {
        hidden.set(id, (hidden.get(id) ?? 0) + 1);
        continue;
      }
    }
    visible.push(item);
  }
  return { visible, hidden, collapsible };
}

function chainChip(item: Item) {
  return item.chain
    ? `${item.chain.position}/${item.chain.total}${item.chain.parent ? ` · on #${item.chain.parent}` : ""}`
    : item.stacked_on && `on ${item.stacked_on}`;
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
  onSnooze: (item: Item) => void;
  onHover: (chain: string | null) => void;
}

function Row({ item, compact, selected, lit, up, down, index, now, viewer, onSelect, onSnooze, onHover }: RowProps) {
  const requested = new Date(item.requested_at).getTime();
  const stale = !compact && now - requested > STALE_MS;
  const classes = ["row", compact && "compact", selected && "selected", item.chain && "chain", lit && "lit", up && "up", down && "down"];
  const chip = chainChip(item);
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
        <button
          className="snooze"
          title="Snooze until tomorrow (s)"
          aria-label="Snooze until tomorrow"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSnooze(item);
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        </button>
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
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [selectedSnoozed, setSelectedSnoozed] = useState<string | null>(null);
  const { isSnoozed, snooze, unsnooze } = useSnoozed(now);
  const [toast, setToast] = useState<{ text: string; warning?: boolean } | null>(null);
  const [toastOn, setToastOn] = useState(false);
  const filterInput = useRef<HTMLInputElement>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapseChains, setCollapseChains] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "true");
  const toggleCollapseChains = useCallback(() => {
    setCollapseChains((on) => !on);
    setExpanded(new Set());
  }, []);

  useEffect(() => localStorage.setItem(COLLAPSE_KEY, String(collapseChains)), [collapseChains]);

  const sections = useMemo(() => {
    const build = (kind: "mine" | "rest", items: Item[]) => {
      const matching = items.filter((i) => !isSnoozed(i.url) && matches(i, filter));
      return { kind, total: matching.length, ...collapse(matching, collapseChains, (id) => !!filter || expanded.has(`${kind}:${id}`)) };
    };
    return { mine: build("mine", data?.needs_you ?? []), rest: build("rest", data?.not_blocked ?? []) };
  }, [data, filter, expanded, collapseChains, isSnoozed]);
  const snoozed = useMemo(() => {
    const items = [...(data?.needs_you ?? []), ...(data?.not_blocked ?? [])].filter((i) => isSnoozed(i.url));
    // A chain can be split across the two sections, so bring its members back together.
    const chains = new Map<string, Item[]>();
    for (const item of items) {
      const key = item.chain?.id ?? item.url;
      chains.set(key, [...(chains.get(key) ?? []), item]);
    }
    return [...chains.values()].flatMap((members) => members.sort((a, b) => a.chain!.position - b.chain!.position));
  }, [data, isSnoozed]);
  const currentSnoozed = snoozed.find((i) => i.url === selectedSnoozed) ?? snoozed[0];
  const all = useMemo(() => [...sections.mine.visible, ...sections.rest.visible], [sections]);
  const current = all.find((i) => i.url === selected) ?? all[0];
  const litChain = hovered ?? current?.chain?.id ?? null;

  useEffect(() => {
    const count = data?.needs_you.filter((i) => !isSnoozed(i.url)).length;
    document.title = count ? `(${count}) Docket` : "Docket";
  }, [data, isSnoozed]);

  useEffect(() => {
    if (!snoozed.length) setShowSnoozed(false);
  }, [snoozed]);

  useEffect(() => {
    if (!toast) return;
    // The toast keeps its content after it is dismissed, so it doesn't change while fading out.
    setToastOn(true);
    const timer = setTimeout(() => setToastOn(false), toast.warning ? WARNING_MS : TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const select = useCallback((item: Item | undefined, snoozed = false) => {
    if (!item) return;
    (snoozed ? setSelectedSnoozed : setSelected)(item.url);
    requestAnimationFrame(() =>
      document.querySelector(`[data-url="${item.url}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }, []);

  const snoozeItem = useCallback(
    (item: Item) => {
      const chain = collapseChains && item.chain?.id;
      const gone = chain
        ? [...(data?.needs_you ?? []), ...(data?.not_blocked ?? [])].filter((i) => i.chain?.id === chain && !isSnoozed(i.url))
        : [item];
      snooze(gone.map((i) => i.url));
      if (current && gone.includes(current)) {
        const index = all.indexOf(current);
        const remains = (i: Item) => !gone.includes(i);
        select(all.slice(index + 1).find(remains) ?? all.slice(0, index).reverse().find(remains));
      }
      setToast(
        gone.length > 1
          ? { text: `Snoozed the whole chain: ${gone.length} pull requests`, warning: true }
          : { text: `Snoozed #${item.number} until tomorrow` },
      );
    },
    [all, collapseChains, current, data, isSnoozed, snooze, select],
  );

  const unsnoozeItems = useCallback(
    (items: Item[]) => {
      unsnooze(items.map((i) => i.url));
      if (items.includes(currentSnoozed)) {
        const index = snoozed.indexOf(currentSnoozed);
        const remains = (i: Item) => !items.includes(i);
        select(snoozed.slice(index + 1).find(remains) ?? snoozed.slice(0, index).reverse().find(remains), true);
      }
    },
    [snoozed, currentSnoozed, unsnooze, select],
  );
  const snoozedChain = useCallback(
    (item: Item) => (item.chain ? snoozed.filter((i) => i.chain?.id === item.chain!.id) : [item]),
    [snoozed],
  );

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
        setShowSnoozed(false);
        setFilter("");
        filterInput.current?.blur();
        return;
      }
      if (typing && !["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
      if (e.key === "Enter" && e.target instanceof HTMLButtonElement) return;

      const snoozedIndex = snoozed.indexOf(currentSnoozed);
      const snoozedActions: Record<string, () => void> = {
        j: () => select(snoozed[Math.min(snoozedIndex + 1, snoozed.length - 1)], true),
        k: () => select(snoozed[Math.max(snoozedIndex - 1, 0)], true),
        g: () => select(snoozed[0], true),
        G: () => select(snoozed[snoozed.length - 1], true),
        o: () => currentSnoozed && window.open(currentSnoozed.url, "_blank", "noreferrer"),
        u: () => currentSnoozed && unsnoozeItems([currentSnoozed]),
        U: () => currentSnoozed && unsnoozeItems(snoozedChain(currentSnoozed)),
        z: () => setShowSnoozed(false),
      };
      const listActions: Record<string, () => void> = {
        j: () => select(all[Math.min(index + 1, all.length - 1)]),
        k: () => select(all[Math.max(index - 1, 0)]),
        g: () => select(all[0]),
        G: () => select(all[all.length - 1]),
        o: () => current && window.open(current.url, "_blank", "noreferrer"),
        c: () =>
          current && navigator.clipboard.writeText(current.url).then(() => setToast({ text: `Copied link to #${current.number}` })),
        e: () => {
          const kind = sections.mine.visible.includes(current!) ? "mine" : "rest";
          const chain = current?.chain?.id;
          if (chain && !filter && sections[kind].collapsible(chain)) toggleChain(kind, chain);
        },
        s: () => current && snoozeItem(current),
        z: () => setShowSnoozed(snoozed.length > 0),
        E: toggleCollapseChains,
        r: () => load(true),
        "/": () => filterInput.current?.focus(),
        "?": () => setHelp((open) => !open),
      };
      const aliases: Record<string, string> = { ArrowDown: "j", ArrowUp: "k", Enter: "o" };
      const action = (showSnoozed ? snoozedActions : listActions)[aliases[e.key] ?? e.key];
      if (!action) return;
      e.preventDefault();
      if (typing && e.key === "Enter") filterInput.current?.blur();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, current, currentSnoozed, filter, load, sections, select, showSnoozed, snoozed, snoozedChain, snoozeItem, toggleChain, toggleCollapseChains, unsnoozeItems]);

  const section = (title: string, { kind, total, visible, hidden, collapsible }: typeof sections.mine, offset: number) => (
    <section className={`section ${kind}`}>
      <header>
        <h2>{title}</h2>
        <span className="count">{total}</span>
        {kind === "mine" && snoozed.length > 0 && (
          <button className="snoozed-link" onClick={() => setShowSnoozed(true)} title="Show snoozed (z)">
            {snoozed.length} snoozed
          </button>
        )}
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
                  onSnooze={snoozeItem}
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
        <button
          className="switch"
          role="switch"
          aria-checked={collapseChains}
          onClick={toggleCollapseChains}
          title="Show each chain as one entry (E)"
        >
          <i />
          Collapse chains
        </button>
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
        <span><kbd>s</kbd> snooze</span>
        <span><kbd>r</kbd> refresh</span>
        <span><kbd>?</kbd> all shortcuts</span>
      </footer>

      {help && (
        <div className="overlay" onClick={() => setHelp(false)}>
          <div className="dialog" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
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

      {showSnoozed && (
        <div className="overlay" onClick={() => setShowSnoozed(false)}>
          <div className="dialog snoozed" role="dialog" aria-label="Snoozed pull requests" onClick={(e) => e.stopPropagation()}>
            <h2>Snoozed until tomorrow</h2>
            <ul>
              {snoozed.map((item, i) => {
                const chain = item.chain?.id;
                const up = !!chain && snoozed[i - 1]?.chain?.id === chain;
                const last = !!chain && snoozed[i + 1]?.chain?.id !== chain;
                const lit = !!chain && chain === currentSnoozed?.chain?.id;
                const chip = chainChip(item);
                // Unsnoozing a chain is only offered when several of its members are snoozed.
                const whole = last && up;
                const classes = ["entry", item === currentSnoozed && "selected", chain && "chain", lit && "lit", up && "up", (!last || whole) && "down"];
                return (
                  <Fragment key={item.url}>
                    <li className={classes.filter(Boolean).join(" ")} data-url={item.url} onClick={() => setSelectedSnoozed(item.url)}>
                      <span className="gutter">
                        <i className="node" />
                      </span>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        <span className="ref">
                          <span>{item.repo}</span>
                          <span>#{item.number}</span>
                          {chip && <span className="chip stack">{chip}</span>}
                        </span>
                        <span className="title">{item.title}</span>
                      </a>
                      <button onClick={() => unsnoozeItems([item])}>Unsnooze</button>
                    </li>
                    {whole && (
                      <li>
                        <button className={lit ? "more lit" : "more"} onClick={() => unsnoozeItems(snoozedChain(item))}>
                          <span className="gutter" />
                          Unsnooze these {snoozedChain(item).length}
                          <kbd>U</kbd>
                        </button>
                      </li>
                    )}
                  </Fragment>
                );
              })}
            </ul>
            <footer>
              <span><kbd>j</kbd><kbd>k</kbd> move</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>u</kbd> unsnooze</span>
              {snoozed.length > 1 && <button onClick={() => unsnooze(snoozed.map((i) => i.url))}>Unsnooze all</button>}
            </footer>
          </div>
        </div>
      )}

      <div className={["toast", toastOn && "on", toast?.warning && "warning"].filter(Boolean).join(" ")} role="status">
        {toast?.text}
      </div>
    </div>
  );
}
