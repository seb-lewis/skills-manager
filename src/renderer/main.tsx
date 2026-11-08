import { Button, RowMenu, AppDialog, AppAccordion } from "./AppControls";
import { Sidebar, SidebarProvider, SidebarHeader, SidebarContent, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuBadge, SidebarGroupLabel } from './components/ui/sidebar';
import { Switch } from './components/ui/switch';
import { Checkbox } from './components/ui/checkbox';
import { Input } from './components/ui/input';
import { DialogTitle } from './components/ui/dialog';
import { MotionConfig, useReducedMotion } from 'motion/react';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import {
  Search,
  Plus,
  Layers,
  Settings,
  X,
  FolderOpen,
  ArrowUpRight,
  AlertCircle,
} from "lucide-react";
import type {
  BulkAction,
  RestorePreview,
  Destination,
  ImportPreview,
  SetupPreview,
  SkillDetail,
  SkillSummary,
  SkillsBridge,
} from "../shared/types";
import "./style.css";
import { validName, sameName } from "../shared/validation";
import { SetupReview } from "./SetupReview";
import { RestoreReview } from "./RestoreReview";
import { ErrorNotice } from "./ErrorNotice";

declare global {
  interface Window {
    skillsManager: SkillsBridge;
  }
}
type View = "All skills" | "Enabled" | "Disabled" | "Missing skills";
type Review =
  | { kind: "import"; preview: ImportPreview }
  | { kind: "setup"; preview: SetupPreview };

const targetStorageKey = "skills-manager.default-destinations";

function setupSelection(preview: Pick<SetupPreview, "skills" | "conflicts" | "existing">, skipExisting = false): string[] {
  const conflictIds = new Set(preview.conflicts.flatMap((conflict) => conflict.skillIds));
  return preview.skills
    .filter((skill) => !skill.external && !skill.issues.length && !conflictIds.has(skill.id) && (!skipExisting || !preview.existing.some(item => item.name === skill.name && item.contentHash === skill.contentHash)))
    .map((skill) => skill.id);
}

function needsRepair(skill: SkillSummary): boolean {
  return skill.contentState === "ready" && skill.enabled && skill.issues.some((issue) => issue.message === "Some links are missing.");
}
function hasActiveLinks(skill: SkillSummary): boolean { return !skill.enabled && skill.linkedDestinations.length > 0; }

function hasInvalidConflictNames(preview: Pick<SetupPreview, "skills" | "conflicts">, selected: string[], edited: Record<string, string>): boolean {
  const chosen = preview.skills.filter(skill => selected.includes(skill.id));
  const unique = chosen.filter((skill, index) => chosen.findIndex(other => other.contentHash === skill.contentHash) === index);
  const names = unique.map(skill => edited[skill.id]?.trim() ?? skill.name);
  const links = unique.map(skill => edited[skill.id]?.trim() ?? skill.linkName);
  const managed = preview.conflicts.flatMap(conflict => conflict.managed);
  return unique.some(skill => edited[skill.id] !== undefined && !validName(edited[skill.id]!.trim()))
    || names.some(name => !name.trim() || managed.some(skill => sameName(skill.name, name)))
    || links.some(link => !validName(link) || managed.some(skill => sameName(skill.linkName, link)))
    || new Set(names.map(name => name.toLowerCase())).size !== names.length || new Set(links.map(name => name.toLowerCase())).size !== links.length;
}

function conflictNameIssue(preview: Pick<SetupPreview, "skills" | "conflicts">, selected: string[], edited: Record<string, string>, id: string): string {
  const skill = preview.skills.find(item => item.id === id);
  if (!skill) return '';
  const name = edited[id]?.trim() ?? skill.name, link = edited[id]?.trim() ?? skill.linkName;
  if (!name || (edited[id] !== undefined && !validName(name)) || !validName(link)) return 'Use letters, numbers, spaces, dots, underscores, or hyphens.';
  const managed = preview.conflicts.flatMap(conflict => conflict.managed);
  if (managed.some(item => sameName(item.name, name) || sameName(item.linkName, link)) || preview.skills.some(item => selected.includes(item.id) && item.contentHash !== skill.contentHash && (sameName(edited[item.id]?.trim() ?? item.name, name) || sameName(edited[item.id]?.trim() ?? item.linkName, link)))) return 'Choose a unique name.';
  return '';
}

function updateSetupSelection(
  preview: Pick<SetupPreview, "skills" | "conflicts">,
  selected: string[],
  skillId: string,
): string[] {
  const conflict = preview.conflicts.find((item) => item.skillIds.includes(skillId));
  if (!conflict) return selected.includes(skillId) ? selected.filter((id) => id !== skillId) : [...selected, skillId];
  const hash = preview.skills.find((skill) => skill.id === skillId)?.contentHash;
  const matchingIds = new Set(
    conflict.skillIds.filter(
      (id) => preview.skills.find((skill) => skill.id === id)?.contentHash === hash,
    ),
  );
  const next = selected.filter((id) => !matchingIds.has(id));
  if (!selected.includes(skillId)) for (const id of matchingIds) if (!next.includes(id)) next.push(id);
  return next;
}

function App() {
  const reduceMotion = useReducedMotion();
  const [loaded, setLoaded] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [restore, setRestore] = useState<RestorePreview | null>(null);
  const [restoredPath, setRestoredPath] = useState("");
  const importAttempt = useRef(0);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [view, setView] = useState<View>("All skills");
  const [agent, setAgent] = useState("");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [locationDraft, setLocationDraft] = useState<{ skillId: string; destinationIds: string[] } | null>(null);
  const [dialog, setDialog] = useState<"import" | "setup" | "settings" | "restore" | "bulk-delete" | null>(
    null,
  );
  const [deleting, setDeleting] = useState<SkillSummary | null>(null);
  const [source, setSource] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editedNames, setEditedNames] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<string[]>(["agents"]);
  const [busy, setBusy] = useState(false);
  const [workingRows, setWorkingRows] = useState<string[]>([]);
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 1080px)").matches);
  const detailOrigin = useRef<HTMLElement | null>(null);
  const [error, setError] = useState("");
  const [setupTargets, setSetupTargets] = useState<string[]>([]);
  const [retryAction, setRetryAction] = useState<(() => Promise<void>) | null>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const api = window.skillsManager;
  async function run(action: () => Promise<void>, retry = action, rowId?: string) {
    if (rowId) setWorkingRows(ids => [...ids, rowId]); else setBusy(true);
    setError("");
    setRetryAction(() => retry);
    try {
      await action();
      setRetryAction(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (rowId) setWorkingRows(ids => ids.filter(id => id !== rowId)); else setBusy(false);
    }
  }
  useEffect(() => {
    const media = matchMedia('(max-width: 1080px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (detail?.id) document.querySelector<HTMLButtonElement>('.detail-top button')?.focus();
    else if (detailOrigin.current) { const origin = detailOrigin.current; detailOrigin.current = null; if (origin.isConnected) origin.focus(); }
  }, [detail?.id]);
  async function refresh() {
    setSkills(await api.list());
  }
  async function retryFailedAction() {
    const action = retryAction ?? refresh;
    await run(async () => {
      if (dialog !== 'import') await api.rescan();
      await action();
    }, action);
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    void run(async () => {
      await refresh();
      setLoaded(true);
      const scan = await api.scan();
      setDestinations(scan.destinations);
      const defaultTargets = scan.destinations.filter((d) => d.writable).slice(0, 1).map((d) => d.id);
      let savedTargets: string[] = [];
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(targetStorageKey) ?? "null");
        if (Array.isArray(saved)) savedTargets = saved.filter((id): id is string => typeof id === "string" && scan.destinations.some((d) => d.writable && d.id === id));
      } catch {
        savedTargets = [];
      }
      setTargets(savedTargets.length ? savedTargets : defaultTargets);
    });
    const focus = () => {
      void api
        .list()
        .then(setSkills)
        .catch((cause) => setError(String(cause)));
    };
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener('keydown', shortcut); };
  }, []);
  useEffect(() => {
    const id = detail?.id;
    if (!id) return;
    if (!skills.some(skill => skill.id === id)) {
      setDetail(current => current?.id === id ? null : current);
      return;
    }
    let active = true;
    void api.detail(id).then(next => {
      if (active) setDetail(current => current?.id === id ? next : current);
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [skills, detail?.id, api]);
  useEffect(() => {
    setLocationDraft(current => current?.skillId === detail?.id && detail?.contentState === "ready" ? current : null);
  }, [detail?.id, detail?.contentState]);
  useEffect(() => { setChosen([]); }, [query, view, agent]);
  useEffect(() => { setChosen(ids => ids.filter(id => skills.some(skill => skill.id === id))); }, [skills]);
  function rememberFocus(element?: HTMLElement) {
    if (!document.querySelector('.modal[role="dialog"]')) focusOrigin.current = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }
  function closeDialog() {
    if (dialog === 'import') { importAttempt.current++; void api.cancelImport(); }
    setDialog(null); setReview(null); setError(""); setRetryAction(null);
  }
  async function previewImport(input: string) {
    const attempt = ++importAttempt.current;
    setReview(null); setSelected([]); setEditedNames({});
    try {
      const preview = await api.importPreview(input);
      if (attempt !== importAttempt.current) return;
      if (preview.kind === 'setup') {
        setDialog('setup'); setSetupTargets([]);
        setReview({ kind: 'setup', preview });
        setSelected(setupSelection(preview).filter(id => !preview.selectedSkillIds || preview.selectedSkillIds.includes(id)));
      } else {
        setReview({ kind: 'import', preview });
        setSelected(setupSelection(preview, true));
      }
      setEditedNames({});
    } catch (cause) { if (attempt === importAttempt.current) throw cause; }
  }
  async function chooseImportFolder() {
    const attempt = ++importAttempt.current;
    const folder = await api.chooseFolder();
    if (!folder || attempt !== importAttempt.current) return;
    setSource(folder);
    await previewImport(folder);
  }
  async function removeMissingForRestore(ids: string[]) {
    const issues: string[] = [];
    for (const id of ids) {
      const result = await api.removeMissing(id);
      setSkills(result.skills);
      issues.push(...result.issues.map(issue => issue.message));
    }
    setRestore(await api.restorePreview());
    if (issues.length) throw new Error(issues.join('\n'));
  }
  async function keepCurrentFiles(id: string) {
    const result = await api.acceptChanges(id);
    setSkills(result.skills);
    if (dialog === 'restore') setRestore(await api.restorePreview());
  }
  async function showRestore() {
    setDialog('restore'); setRestore(null); setRestoredPath("");
    await run(async () => { await refresh(); setRestore(await api.restorePreview()); });
  }
  async function bulkAction(action: BulkAction, ids = chosen) {
    const result = await api.bulk(action, ids);
    setSkills(result.skills); setChosen(result.failedIds);
    if (action === 'delete' && result.ok) setDialog(null);
    if (!result.ok) {
      setRetryAction(() => () => bulkAction(action, result.failedIds));
      throw new Error(result.issues.map(issue => `${issue.path}: ${issue.message.replace(/^Error:\s*/, '')}`).join('\n'));
    }
  }
  function updateTargets(values: string[]) {
    setTargets(values);
    try {
      localStorage.setItem(targetStorageKey, JSON.stringify(values));
    } catch {
      // The current selection still applies for this session.
    }
  }
  function openImport(event?: React.MouseEvent<HTMLButtonElement>) {
    rememberFocus(event?.currentTarget);
    if (busy) return;
    importAttempt.current++;
    setRetryAction(null);
    setDialog("import");
    setReview(null);
    setSource("");
    setEditedNames({});
    setError("");
  }
  async function showSetup(origin?: HTMLElement) {
    rememberFocus(origin);
    setRetryAction(null);
    setDialog("setup");
    setSetupTargets([]);
    setReview(null);
    await run(async () => {
      const preview = await api.setupPreview();
      setReview({ kind: "setup", preview });
      setSelected(setupSelection(preview));
      setEditedNames({});
    });
  }
  async function toggle(skill: SkillSummary, repair = false) {
    if (skill.contentState !== "ready" || workingRows.includes(skill.id)) return;
    if ((!skill.enabled || repair) && !skill.destinations.some(id => destinations.some(destination => destination.id === id && destination.writable))) {
      await run(async () => {
        const next = await api.detail(skill.id);
        setDetail(next);
        if (next.contentState === "ready") setLocationDraft({ skillId: next.id, destinationIds: next.destinations.filter(id => destinations.some(destination => destination.id === id && destination.writable)) });
      }, () => toggle(skill, repair), skill.id);
      return;
    }
    const operation = skill.enabled && !repair ? api.disable : api.enable;
    await run(async () => {
      const result = await operation(skill.id);
      setSkills(result.skills);
      if (!result.ok)
        throw new Error(result.issues.map((i) => `${i.path}: ${i.message.replace(/^Error:\s*/, '')}`).join("\n") || "The skill action failed.");
    }, () => toggle(skill, repair), skill.id);
  }
  async function removeActiveLinks(id: string) {
    await run(async () => {
      const result = await api.disable(id);
      setSkills(result.skills);
      if (detail?.id === id) setDetail(await api.detail(id));
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('\n'));
    });
  }
  async function saveLocations() {
    if (!locationDraft || detail?.id !== locationDraft.skillId || detail.contentState !== "ready") return;
    const draft = locationDraft;
    const result = await api.setDestinations(draft.skillId, draft.destinationIds);
    setSkills(result.skills);
    if (!result.ok) throw new Error(result.issues.map(issue => `${issue.path}: ${issue.message.replace(/^Error:\s*/, '')}`).join("\n") || "Location changes failed.");
    setLocationDraft(current => current?.skillId === draft.skillId ? null : current);
  }
  async function fixBrokenLinks() {
    if (review?.kind !== "setup") return;
    const result = await api.fixBrokenLinks(review.preview.previewId);
    setSkills(result.skills);
    const preview = await api.setupPreview();
    const unchangedIds = new Set(preview.skills.filter(skill =>
      !skill.external && !skill.issues.length && review.preview.skills.some(previous =>
        previous.id === skill.id && previous.contentHash === skill.contentHash && !previous.external && !previous.issues.length,
      ),
    ).map(skill => skill.id));
    setReview({ kind: "setup", preview });
    setSelected(selected.filter(id => unchangedIds.has(id)));
    setEditedNames(Object.fromEntries(Object.entries(editedNames).filter(([id]) => unchangedIds.has(id))));
    if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message.replace(/^Error:\s*/, '')}`).join("\n"));
  }
  async function applyReview() {
    if (!review) return;
    const request = {
      previewId: review.preview.previewId,
      skillIds: selected,
      destinations: review.kind === "setup" ? setupTargets : targets,
      names: Object.entries(editedNames).filter(([skillId, name]) => selected.includes(skillId) && name.trim()).map(([skillId, name]) => ({ skillId, name: name.trim() })),
    };
    const result = await (review.kind === "setup"
      ? api.setupApply(request)
      : api.importApply(request));
    setSkills(result.skills);
    if (!result.ok)
      throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message.replace(/^Error:\s*/, '')}`).join("\n") || "The import failed.");
    setDialog(null);
    setReview(null);
  }
  const hasMissingSkills = skills.some(skill => skill.contentState === "missing");
  function changeView(next: View) {
    setView(next);
    setDetail(null);
    setQuery("");
    setAgent("");
  }
  const filtered = skills.filter(
    (s) =>
      (view === "Missing skills" ? s.contentState === "missing"
        : view === "All skills" ? s.contentState !== "missing"
          : s.contentState === "ready" && s.enabled === (view === "Enabled")) &&
      (!agent || s.destinations.includes(agent)) &&
      `${s.name} ${s.description} ${s.sources.map((source) => source.repository ?? source.path).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const destinationName = (id: string) =>
    destinations.find((d) => d.id === id)?.name ?? id;
  const flip = (values: string[], id: string) =>
    values.includes(id)
      ? values.filter((value) => value !== id)
      : [...values, id];
  return (
    <SidebarProvider className="app-shell h-dvh min-h-0 p-2 gap-2" width="212px" mobileBreakpoint={0} persist={false} shortcut={null}>
      <Sidebar collapsible="none" bordered={false} rail={false} className="app-sidebar" inert={dialog !== null || deleting !== null || !!(compact && detail)}>
        <SidebarHeader className="brand flex-row"><span className="brand-symbol" aria-hidden="true"><Layers size={18} /></span><span>Skills Manager</span></SidebarHeader>
        <SidebarContent>
          <nav aria-label="Collection"><SidebarMenu>
            {(["All skills", "Enabled", "Disabled", "Missing skills"] satisfies View[]).filter(item => item !== "Missing skills" || hasMissingSkills).map(item => <SidebarMenuItem key={item}>
              <SidebarMenuButton isActive={view === item} dot={item === 'Disabled' ? 'ring' : 'filled'} onClick={() => changeView(item)}>{item}</SidebarMenuButton>
              <SidebarMenuBadge aria-hidden="true">{skills.filter(skill => item === "All skills" && skill.contentState !== "missing" || item === "Enabled" && skill.contentState === "ready" && skill.enabled || item === "Disabled" && skill.contentState === "ready" && !skill.enabled || item === "Missing skills" && skill.contentState === "missing").length}</SidebarMenuBadge>
            </SidebarMenuItem>)}
          </SidebarMenu></nav>
          <SidebarGroupLabel className="destination-label">Destinations</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem><SidebarMenuButton icon={Layers} isActive={!agent} aria-current={undefined} aria-pressed={!agent} onClick={() => setAgent("")}>All destinations</SidebarMenuButton></SidebarMenuItem>
            {destinations.filter(d => d.writable).map(d => <SidebarMenuItem key={d.id}><SidebarMenuButton icon={FolderOpen} isActive={agent === d.id} aria-current={undefined} aria-pressed={agent === d.id} onClick={() => setAgent(d.id)}>{d.name}</SidebarMenuButton></SidebarMenuItem>)}
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton icon={FolderOpen} onClick={event => void showSetup(event.currentTarget)}>Setup</SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton icon={Settings} onClick={event => { rememberFocus(event.currentTarget); setDialog("settings"); }}>Settings</SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarFooter>
      </Sidebar>
      <main className="collection" inert={dialog !== null || deleting !== null || !!(compact && detail)} aria-busy={busy}>
        <header className="toolbar">
          <div>
            <h1>{view}</h1>
          </div>
          {view !== "Missing skills" && <Button variant="secondary" disabled={busy} onClick={openImport}>
            <Plus size={16} />
            Import
          </Button>}
        </header>
        <label className="search">
          <Search size={17} />
          <Input
            aria-label="Search skills" className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            placeholder="Search skills"
            disabled={busy}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? <Button className="clear-search" aria-label="Clear search" disabled={busy} onClick={() => setQuery("")}><X size={16} /></Button> : <kbd>⌘ K</kbd>}
        </label>
        {error && !dialog && !deleting && (
          <ErrorNotice message={error} locations={destinations} busy={busy} onRetry={() => void retryFailedAction()} />
        )}
        {chosen.length > 0 && <div className="bulk-bar" aria-label="Selected skills">
          <span role="status">{chosen.length} selected</span>
          <Button disabled={busy || chosen.some(id => skills.find(skill => skill.id === id)?.contentState !== 'ready')} onClick={() => void run(() => bulkAction('enable'))}>Enable</Button>
          <Button disabled={busy} onClick={() => void run(() => bulkAction('disable'))}>Disable</Button>
          {chosen.some(id => skills.find(skill => skill.id === id)?.contentState === 'changed') && <Button disabled={busy || chosen.some(id => !['ready', 'changed'].includes(skills.find(skill => skill.id === id)?.contentState ?? ''))} onClick={() => void run(() => bulkAction('keep'))}>Keep current files</Button>}
          <Button variant="ghost" className="danger-text text-red-400" disabled={busy} onClick={event => { rememberFocus(event.currentTarget); setError(""); setDialog('bulk-delete'); }}>Delete</Button>
          <Button className="clear-selection" disabled={busy} aria-label="Clear selection" onClick={() => setChosen([])}><X size={16} /></Button>
        </div>}
        {filtered.length > 0 && <>
        <div className="list-heading">
          <label className="select-all"><Checkbox aria-label="Select all visible skills" disabled={busy || !filtered.length} checked={!!filtered.length && filtered.every(skill => chosen.includes(skill.id))} aria-checked={chosen.length > 0 && !filtered.every(skill => chosen.includes(skill.id)) ? "mixed" : undefined} className={chosen.length > 0 && !filtered.every(skill => chosen.includes(skill.id)) ? "selection-partial" : undefined} onCheckedChange={checked => setChosen(checked ? filtered.map(skill => skill.id) : [])} /><span>Skill</span></label>
          {view !== "Missing skills" && <span>Enabled</span>}
        </div>
        <div className="skill-list">
          {filtered.map((skill) => (
            <article
              className={`skill-row ${detail?.id === skill.id ? "current" : ""} ${chosen.includes(skill.id) ? "is-selected" : ""}`}
              key={skill.id}
            >
              <label className="row-checkbox"><Checkbox aria-label={`Select ${skill.name}`} disabled={busy} checked={chosen.includes(skill.id)} onCheckedChange={() => setChosen(ids => flip(ids, skill.id))} /></label>
              <Button
                disabled={busy}
                aria-label={`Open ${skill.name}`}
                variant="ghost" className="skill-select h-auto text-foreground"
                onClick={event => { detailOrigin.current = event.currentTarget; void api.detail(skill.id).then(setDetail).catch(cause => setError(String(cause))); }}
              >
                <span className="skill-symbol" aria-hidden="true">
                  {skill.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="skill-copy">
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                  {hasActiveLinks(skill) && <span className="content-status">Active links</span>}
                  <span className="destinations">
                    {skill.destinations.map((id) => (
                      <span key={id}>{destinationName(id)}</span>
                    ))}
                  </span>
                </span>
                {skill.contentState === "ready" && skill.issues.length > 0 && (
                  <AlertCircle className="issue-icon" size={16} />
                )}
              </Button>
              {skill.contentState === "ready" ? <Switch label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} checked={skill.enabled} thumbTransition={reduceMotion ? { duration: 0 } : undefined}
                disabled={busy} aria-busy={workingRows.includes(skill.id) || undefined} className="skill-toggle [&>span]:sr-only px-1"
                onToggle={() => { if (!workingRows.includes(skill.id)) void toggle(skill); }} /> : <span className="unavailable-status">{skill.contentState === "missing" ? "Files missing" : skill.contentState === "changed" ? "Files changed" : "Files need review"}</span>}
              <RowMenu label={`Actions for ${skill.name}`} actions={[
                ...(skill.contentState === 'changed' ? [{ label: 'Keep current files', disabled: busy, onSelect: () => void run(() => keepCurrentFiles(skill.id)) }] : []),
                ...(needsRepair(skill) ? [{ label: 'Repair', disabled: busy, onSelect: () => void toggle(skill, true) }] : []),
                ...(hasActiveLinks(skill) ? [{ label: 'Remove active links', disabled: busy, onSelect: () => void removeActiveLinks(skill.id) }] : []),
                ...(skill.contentState !== 'missing' ? [{ label: 'Reveal in Finder', onSelect: () => void run(() => api.reveal(skill.id)) }] : []),
                { label: skill.contentState === 'missing' ? 'Remove from collection' : 'Delete skill', destructive: true, disabled: busy,
                  onSelect: origin => { rememberFocus(origin ?? undefined); setDeleting(skill); } },
              ]} />
            </article>
          ))}
        </div>
        </>}
        {loaded && !filtered.length && (
          <div className="empty">
            <Layers size={32} />
            <h2>{query || agent ? "No matching skills" : !skills.length ? "Bring your skills together" : `No ${view.toLowerCase()}`}</h2>
            {!skills.length ? <>
              <Button variant="secondary" disabled={busy} onClick={event => void showSetup(event.currentTarget)}><FolderOpen size={16} />Review existing skills</Button>
              <Button disabled={busy} onClick={openImport}><Plus size={16} />Import skills</Button>
            </> : <Button disabled={busy} onClick={() => { setQuery(""); setAgent(""); setView("All skills"); }}>Show all skills</Button>}
          </div>
        )}
        <footer aria-live="polite">
          {!loaded ? "Loading…" : filtered.length} {filtered.length === 1 ? "skill" : "skills"}
          {busy && <span role="status">Working…</span>}
        </footer>
      </main>
      {detail && <>
        {compact && <div className="detail-backdrop" onClick={() => setDetail(null)} aria-hidden="true" />}
        <aside className="detail" role={compact ? "dialog" : undefined} aria-modal={compact || undefined} aria-label="Skill details" onKeyDown={event => {
          if (event.key === "Escape" && !dialog && !deleting) { event.stopPropagation(); setDetail(null); }
          if (compact && event.key === "Tab") { const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')).filter(node => node.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
        }} inert={dialog !== null || deleting !== null}>
          <div className="detail-top">
            <span>Skill details</span>
            <Button aria-label="Close details" onClick={() => setDetail(null)}>
              <X size={18} />
            </Button>
          </div>
          <div className="detail-content">
            <div className="detail-symbol">
              {detail.name.slice(0, 1).toUpperCase()}
            </div>
            <h2>{detail.name}</h2>
            {detail.contentState !== "ready" && <p className="content-status">{detail.contentState === "missing" ? "Skill folder is missing." : detail.contentState === "changed" ? "Skill files changed." : "Skill files need review."}</p>}
            {needsRepair(detail) && <p className="content-status">Some links are missing.</p>}
            <p className="description">{detail.description}</p>
            <div className="detail-actions">
              {detail.contentState === 'changed' && <Button disabled={busy} onClick={() => void run(() => keepCurrentFiles(detail.id))}>Keep current files</Button>}
              {needsRepair(detail) && <Button disabled={busy} onClick={() => void toggle(detail, true)}>Repair</Button>}
              {hasActiveLinks(detail) && <Button disabled={busy} onClick={() => void removeActiveLinks(detail.id)}>Remove active links</Button>}
              {detail.contentState !== "missing" && <Button onClick={() => void run(() => api.reveal(detail.id))}>
                <FolderOpen size={15} />
                Reveal in Finder
              </Button>}
              <Button
                variant="ghost" className="danger-text text-red-400"
                onClick={event => { rememberFocus(event.currentTarget); setDeleting(detail); }}
              >
                {detail.contentState === "missing" ? "Remove from collection" : "Delete"}
              </Button>
            </div>
            {(detail.destinations.length > 0 || detail.contentState === "ready") && <div className="locations-heading">
              <h3>Destinations</h3>
              {detail.contentState === "ready" && locationDraft?.skillId !== detail.id && <Button disabled={busy} onClick={() => setLocationDraft({ skillId: detail.id, destinationIds: detail.destinations.filter(id => destinations.some(destination => destination.id === id && destination.writable)) })}>Edit locations</Button>}
            </div>}
            {locationDraft?.skillId === detail.id && detail.contentState === "ready" ? <div className="location-editor">
              {destinations.filter(destination => destination.writable).map(destination => <label key={destination.id}>
                <Checkbox disabled={busy} checked={locationDraft.destinationIds.includes(destination.id)} onCheckedChange={() => setLocationDraft(current => current?.skillId === detail.id ? { ...current, destinationIds: flip(current.destinationIds, destination.id) } : current)} />
                {destination.name}
              </label>)}
              <div className="location-actions">
                <Button disabled={busy} onClick={() => setLocationDraft(null)}>Cancel</Button>
                <Button variant="secondary" disabled={busy} onClick={() => void run(saveLocations)}>Save</Button>
              </div>
            </div> : detail.destinations.map((id) => (
              <div className="destination-detail" key={id}>
                <span>{destinationName(id)}</span>
                <small>
                  {detail.linkedDestinations.includes(id)
                    ? "Linked"
                    : "Not linked"}
                </small>
              </div>
            ))}
            {detail.sources.length > 0 && <AppAccordion className="detail-sources" title={<>Source</>}>
            {detail.sources.map((source, index) => (
              <code className="source-path" key={index}>
                {source.repository ?? source.path}
              </code>
            ))}</AppAccordion>}
            {(detail.issues.length > 0 || detail.contentState !== "ready") && <AppAccordion className="content-diagnostics" title={<>Details</>}>

              <code className="source-path">{detail.canonicalPath}</code>
              {detail.issues.map((issue, index) => <div key={index}>{!(detail.contentState === "missing" && issue.message === "Skill folder is missing.") && <p>{issue.message}</p>}{issue.path !== detail.canonicalPath && <code className="source-path">{issue.path}</code>}</div>)}
            </AppAccordion>}
            {detail.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() && <>
            <h3>Instructions</h3>
            <div className="markdown">
              <Markdown
                skipHtml
                components={{
                  img: () => null,
                  a: ({ children }) => <span>{children}</span>,
                }}
              >
                {detail.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}
              </Markdown>
            </div>
            </>}
          </div>
        </aside>
      </>}
      <AppDialog open={dialog !== null} onOpenChange={open => { if (!open && (!busy || (dialog === 'import' && !review))) closeDialog(); }} size={dialog === 'setup' ? 'xl' : 'lg'} className={`modal ${dialog === 'setup' ? 'setup-modal p-0' : ''}`} onCloseAutoFocus={event => { event.preventDefault(); const origin = focusOrigin.current; focusOrigin.current = null; requestAnimationFrame(() => { if (origin?.isConnected) origin.focus(); else document.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')?.focus(); }); }}>
            <div className="modal-heading">
              <DialogTitle id="dialog-title">
                {dialog === "setup"
                  ? "Set up your collection"
                  : dialog === "settings" ? "Settings"
                    : dialog === "restore" ? restoredPath ? "Skills restored" : "Undo setup"
                    : dialog === "bulk-delete" ? `Delete ${chosen.length} ${chosen.length === 1 ? 'skill' : 'skills'}?`
                    : "Import skills"}
              </DialogTitle>
              <Button variant="ghost" type="button" aria-label="Close" disabled={busy && !(dialog === 'import' && !review)} onClick={() => { if (!busy || (dialog === 'import' && !review)) { closeDialog(); } }}>
                <X size={19} />
              </Button>
            </div>
            {dialog === 'restore' ? <RestoreReview preview={restore} complete={restoredPath} busy={busy} skills={skills} onRemoveMissing={ids => void run(() => removeMissingForRestore(ids))} onKeep={id => void run(() => keepCurrentFiles(id))} onReview={() => void showRestore()} onReveal={() => void run(() => api.revealExport())} onRestore={() => void run(async () => {
              if (!restore) return;
              const result = await api.restoreApply(restore.previewId);
              setSkills(result.skills); setDetail(null); setChosen([]); setRestoredPath(result.backupPath);
            })} /> : dialog === 'bulk-delete' ? <>
              <p>This permanently deletes the selected skill files and removes their links.</p>
              <ul className="delete-list">{skills.filter(skill => chosen.includes(skill.id)).map(skill => <li key={skill.id}><strong>{skill.name}</strong>{skill.destinations.length > 0 && <small>{skill.destinations.map(destinationName).join(' · ')}</small>}</li>)}</ul>
              <div className="modal-actions"><Button disabled={busy} onClick={closeDialog}>Cancel</Button><Button variant="destructive" disabled={busy || !chosen.length} onClick={() => void run(() => bulkAction('delete'))}>{busy ? 'Deleting…' : `Delete ${chosen.length} ${chosen.length === 1 ? 'skill' : 'skills'}`}</Button></div>
            </> : dialog === "settings" ? (
              <>
                <h3>Default destinations</h3>
                <div className="target-options">
                  {destinations
                    .filter((d) => d.writable)
                    .map((d) => (
                      <label key={d.id}>
                        <Checkbox
                          checked={targets.includes(d.id)}
                          onCheckedChange={() => updateTargets(flip(targets, d.id))}
                        />
                        {d.name}
                      </label>
                    ))}
                </div>
                <div className="settings-actions"><Button disabled={busy || !skills.length} onClick={() => void showRestore()}>Undo setup…</Button><Button disabled={busy} onClick={() => void run(async () => { await api.rescan(); await refresh(); })}>Rescan skills</Button></div>
              </>
            ) : (
              <>
                {dialog === "import" && !review && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        await previewImport(source);
                      });
                    }}
                  >
                    <label className="field-label" htmlFor="source">
                      Source
                    </label>
                    <Input
                      id="source"
                      className="source-input"
                      autoFocus
                      placeholder="skills.sh link, repository, command, or folder"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                    />
                    <div className="modal-actions">
                      <Button type="button" disabled={busy} onClick={() => void run(chooseImportFolder)}>Choose folder</Button>
                      <Button type="button" disabled={busy} trailingIcon={ArrowUpRight} onClick={() => void run(() => api.browseMarketplace())}>
                        Browse skills.sh
                      </Button>
                      <Button
                        type="submit"
                        variant="secondary"
                        disabled={busy || !source.trim()}
                      >
                        {busy ? "Finding skills…" : "Preview"}
                      </Button>
                    </div>
                  </form>
                )}
                {review?.kind === "setup" && (
                  <>
                    <SetupReview preview={review.preview} selected={selected} onSelected={setSelected} editedNames={editedNames} onEditedNames={setEditedNames} destinations={destinations} busy={busy} targets={setupTargets} onTargets={setSetupTargets} />
                    <div className="modal-actions setup-actions">
                      <Button onClick={event => void showSetup(event.currentTarget)} disabled={busy}>Rescan</Button>
                      <Button onClick={closeDialog} disabled={busy}>Close</Button>
                      {review.preview.brokenLinks.length > 0 && <Button disabled={busy} onClick={() => void run(fixBrokenLinks)}>Fix broken links ({review.preview.brokenLinks.length})</Button>}
                      <Button variant="secondary" disabled={busy || !selected.length || hasInvalidConflictNames(review.preview, selected, editedNames)} onClick={() => void run(applyReview)}>{busy ? "Working…" : `Add skills (${new Set(review.preview.skills.filter(skill => selected.includes(skill.id)).map(skill => skill.contentHash)).size})`}</Button>
                    </div>
                  </>
                )}
                {review?.kind === "import" && (
                  <>
                    {review.preview.duplicates.length > 0 && (
                      <AppAccordion className="duplicate-summary" title={<>Identical copies ({review.preview.duplicates.length})</>}>

                        {review.preview.duplicates.map((duplicate, index) => (
                          <div className="duplicate-group" key={`${duplicate.name}-${index}`}>
                            <span>{duplicate.name}</span>
                            <ul>
                              {duplicate.skillIds
                                .map((id) => { const skill = review.preview.skills.find(item => item.id === id); return skill?.sourcePath ?? skill?.path; })
                                .filter((path): path is string => Boolean(path))
                                .map((path) => <li key={path}>{path}</li>)}
                            </ul>
                          </div>
                        ))}
                      </AppAccordion>
                    )}
                    {review.preview.issues.length > 0 && (
                      <AppAccordion className="review-notices" title={<>Unavailable paths ({review.preview.issues.length})</>}>

                        <ul>
                          {review.preview.issues.map((issue, index) => (
                            <li key={`scan-issue-${index}`}>
                              <strong>{issue.message}</strong>
                              <code>{issue.path}</code>

                            </li>
                          ))}
                        </ul>
                      </AppAccordion>
                    )}
                    <div className="import-selection"><span>{selected.length} selected</span><Button disabled={busy} onClick={() => setSelected(setupSelection(review.preview, true))}>Reset selection</Button><Button disabled={busy} onClick={() => setSelected([])}>Clear</Button></div>
                    <div className="review-list">
                      {review.preview.skills.filter((skill) => !skill.external && !review.preview.conflicts.some((conflict) => conflict.skillIds.includes(skill.id))).map((skill) => (
                        <div className="review-item" key={skill.id}>
                          <label>
                            <Checkbox
                              checked={selected.includes(skill.id)}
                              disabled={
                                skill.external || skill.issues.length > 0
                              }
                              onCheckedChange={() =>
                                setSelected((values) =>
                                  review.preview.conflicts.some((conflict) => conflict.skillIds.includes(skill.id))
                                    ? updateSetupSelection(review.preview, values, skill.id)
                                    : flip(values, skill.id),
                                )
                              }
                            />
                            <span>
                              <strong>{skill.name}</strong>{review.preview.existing.some(item => item.name === skill.name && item.contentHash === skill.contentHash) && <small>In collection</small>}

                              {review.kind === "import" && <small>{skill.description}</small>}
                            </span>
                          </label>
                          <AppAccordion className="setup-locations" title={<>Source</>}><code>{skill.sourcePath ?? skill.path}</code></AppAccordion>
                          {skill.issues.length > 0 && (
                            <AppAccordion className="review-notices" title={<>Issues ({skill.issues.length})</>}>

                              <ul>
                                {skill.issues.map((issue, index) => (
                                  <li key={index}>
                                    <strong>{issue.message}</strong>
                                    <code>{issue.path}</code>
                                  </li>
                                ))}
                              </ul>
                            </AppAccordion>
                          )}
                          {review.kind === "import" && skill.preview && <div className="content-preview"><Markdown skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{skill.preview}</Markdown></div>}
                        </div>
                      ))}
                      {review.preview.conflicts.length > 0 && <h3>Name conflicts</h3>}
                      {review.preview.conflicts.flatMap((conflict) => [
                              <section className="conflict-section" key={`conflict-${conflict.name}-${conflict.skillIds.join("-")}`}>
                              <h3>{conflict.name}</h3>

                              {conflict.skillIds.map((id) => {
                                const skill = review.preview.skills.find((item) => item.id === id);
                                if (!skill) return null;
                                const selectedHashes = new Set(conflict.skillIds.filter((candidateId) => selected.includes(candidateId)).map((candidateId) => review.preview.skills.find((candidate) => candidate.id === candidateId)?.contentHash));
                                const nameIssue = conflictNameIssue(review.preview, selected, editedNames, skill.id);
                                const nameErrorId = `import-name-${skill.id}`;
                                const firstForHash = conflict.skillIds.find((candidateId) => selected.includes(candidateId) && review.preview.skills.find((candidate) => candidate.id === candidateId)?.contentHash === skill.contentHash) === skill.id;
                                return <div className="review-item" key={skill.id}>
                                  <label>
                                    <Checkbox checked={selected.includes(skill.id)} disabled={skill.external || skill.issues.length > 0} onCheckedChange={() => setSelected((values) => updateSetupSelection(review.preview, values, skill.id))} />
                                    <span><strong>{skill.name}</strong>{review.kind === "import" && <small>{skill.description}</small>}{review.kind === "import" && skill.preview && <div className="content-preview"><Markdown skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{skill.preview}</Markdown></div>}</span>
                                  </label>
                                  <AppAccordion className="setup-locations" title={<>Source</>}><code>{skill.sourcePath ?? skill.path}</code></AppAccordion>
                                  {(conflict.managed.length > 0 || selectedHashes.size > 1) && selected.includes(skill.id) && firstForHash && <label className="conflict-name-label">Use name<Input className="conflict-name" aria-invalid={!!nameIssue} aria-describedby={nameIssue ? nameErrorId : undefined} aria-label={`Name for ${skill.name}`} value={editedNames[skill.id] ?? skill.name} onChange={(event) => setEditedNames((names) => { const next = { ...names, [skill.id]: event.target.value }; conflict.skillIds.forEach((candidateId) => { if (review.preview.skills.find((candidate) => candidate.id === candidateId)?.contentHash === skill.contentHash) next[candidateId] = event.target.value; }); return next; })} />{nameIssue && <span id={nameErrorId} className="setup-name-error">{nameIssue}</span>}</label>}

                          {skill.issues.length > 0 && (
                                    <AppAccordion className="review-notices" title={<>Issues ({skill.issues.length})</>}>

                                      <ul>
                                        {skill.issues.map((issue, index) => (
                                          <li key={index}>
                                            <strong>{issue.message}</strong>
                                            <code>{issue.path}</code>
                                          </li>
                                        ))}
                                      </ul>
                                    </AppAccordion>
                                  )}
                                </div>;
                              })}
                              {conflict.managed.map((managed) => <div className="managed-reference" key={managed.path}><small>In collection</small><strong>{managed.name}</strong>{review.kind === "import" && <small>{managed.description}</small>}{review.kind === "import" && managed.preview && <div className="content-preview"><Markdown skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{managed.preview}</Markdown></div>}</div>)}
                            </section>,
                          ])}
                    </div>
                    {review.preview.skills.some((skill) => skill.external) && (
                      <AppAccordion className="review-notices" title={<>External skills ({review.preview.skills.filter((skill) => skill.external).length})</>}>

                        <ul>
                          {review.preview.skills.filter((skill) => skill.external).map((skill) => (
                            <li key={skill.id}>
                              <strong>{skill.name}</strong>
                              <code>{skill.sourcePath ?? skill.path}</code>
                              {skill.aliases.map((alias) => <code key={alias}>{alias}</code>)}
                              {skill.issues.map((issue, index) => <small key={index}>{issue.message}</small>)}
                            </li>
                          ))}
                        </ul>
                      </AppAccordion>
                    )}
                    {!review.preview.skills.length && !review.preview.issues.length && <p>No skills found.</p>}
                    <h3>Destinations</h3>
                    <div className="target-options">
                      {destinations
                        .filter((d) => d.writable)
                        .map((d) => (
                          <label key={d.id}>
                            <Checkbox
                              checked={targets.includes(d.id)}
                              onCheckedChange={() => updateTargets(flip(targets, d.id))}
                            />
                            {d.name}
                          </label>
                        ))}
                    </div>
                    <div className="modal-actions">
                      <Button onClick={() => setReview(null)} disabled={busy}>Back</Button>
                      {review.kind === "import" && (review.preview.issues.length > 0 || review.preview.skills.some((skill) => skill.issues.length > 0)) && (
                        <Button disabled={busy} onClick={() => void run(async () => {
                          await previewImport(source);
                        })}>Retry scan</Button>
                      )}
                      <Button
                        variant="secondary"
                        disabled={busy || !targets.length || !selected.length || hasInvalidConflictNames(review.preview, selected, editedNames)}
                        onClick={() => void run(applyReview)}
                      >
                        {busy
                          ? "Working…"
                          : `Import${selected.length ? ` (${selected.length})` : ""}`}
                      </Button>
                    </div>
                  </>
                )}
                {busy && !review && dialog === "setup" && (
                  <p role="status">Scanning skills…</p>
                )}
              </>
            )}
            {error && (
              <ErrorNotice message={error} locations={destinations} busy={busy} onRetry={retryAction ? () => void retryFailedAction() : undefined} />
            )}
      </AppDialog>
      <AppDialog open={deleting !== null} onOpenChange={open => { if (!open && !busy) { setDeleting(null); setError(""); } }} className="modal delete-modal" onCloseAutoFocus={event => { event.preventDefault(); const origin = focusOrigin.current; focusOrigin.current = null; requestAnimationFrame(() => { if (origin?.isConnected) origin.focus(); else document.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')?.focus(); }); }}>
            {deleting && <><DialogTitle id="delete-title">{deleting.contentState === "missing" ? `Remove ${deleting.name} from collection?` : `Delete ${deleting.name}?`}</DialogTitle>
            {deleting.contentState === "missing" ? <p>Remove its saved record and related links.</p> : <p>
              This permanently deletes the skill files and removes its links
              {deleting?.destinations.length
                ? ` from ${deleting.destinations.map(destinationName).join(", ")}`
                : ""}
              .
            </p>}
            <div className="modal-actions">
              <Button type="button" disabled={busy} onClick={() => { setDeleting(null); setError(""); }}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (deleting)
                    void run(async () => {
                      const result = await (deleting.contentState === "missing" ? api.removeMissing(deleting.id) : api.delete(deleting.id));
                      setSkills(result.skills);
                      if (!result.ok)
                        throw new Error(result.issues.map((i) => i.message).join("\n") || "Delete failed.");
                      else {
                        if (detail?.id === deleting.id) setDetail(null);
                        setDeleting(null);
                      }
                    });
                }}
              >
                {deleting.contentState === "missing" ? "Remove from collection" : "Delete skill"}
              </Button>
            </div>
            {error && (
              <ErrorNotice message={error} locations={destinations} busy={busy} onRetry={retryAction ? () => void retryFailedAction() : undefined} />
            )}
            </>}
      </AppDialog>
    </SidebarProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<MotionConfig reducedMotion="user"><App /></MotionConfig>);
