import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { RadioGroup, RadioItem } from "./components/ui/radio-group";
import { Tabs, TabsItem, TabsPanel } from "./components/ui/tabs";
import { Button, AppAccordion } from "./AppControls";
import { useId, useState } from "react";
import { validName, sameName } from "../shared/validation";
import type { Destination, ScannedSkill, SetupPreview } from "../shared/types";

type Props = {
  preview: SetupPreview;
  selected: string[];
  onSelected: (ids: string[]) => void;
  editedNames: Record<string, string>;
  onEditedNames: (names: Record<string, string>) => void;
  destinations: Destination[];
  targets: string[];
  onTargets: (ids: string[]) => void;
  busy: boolean;
};

function groups(skills: ScannedSkill[]): ScannedSkill[][] {
  const grouped = new Map<string, ScannedSkill[]>();
  for (const skill of skills) {
    const group = grouped.get(skill.contentHash) ?? [];
    group.push(skill);
    grouped.set(skill.contentHash, group);
  }
  return [...grouped.values()];
}

function locations(skills: ScannedSkill[]): string[] {
  return [...new Set(skills.flatMap(skill => [skill.path, ...skill.aliases]))];
}

function Locations({ paths }: { paths: string[] }) {
  return <AppAccordion className="setup-locations" title={<>Locations ({paths.length})</>}><ul>{paths.map(path => <li key={path}><code>{path}</code></li>)}</ul></AppAccordion>;
}

export function SetupReview({ preview, selected, onSelected, editedNames, onEditedNames, destinations, targets, onTargets, busy }: Props) {
  const tabId = useId();
  const [section, setSection] = useState<"new" | "conflicts">(() => {
    const conflicts = new Set(preview.conflicts.flatMap(conflict => conflict.skillIds));
    const requestedConflicts = preview.selectedSkillIds?.length && preview.selectedSkillIds.every(id => conflicts.has(id));
    return requestedConflicts || preview.conflicts.length && !preview.skills.some(skill => !skill.external && !skill.issues.length && !conflicts.has(skill.id)) ? 'conflicts' : 'new';
  });
  const selectedTab = section === 'new' ? 0 : 1;
  const healthy = preview.skills.filter(skill => !skill.external && !skill.issues.length);
  const conflictIds = new Set(preview.conflicts.flatMap(conflict => conflict.skillIds));
  const newGroups = groups(healthy.filter(skill => !conflictIds.has(skill.id)));
  const unavailable = preview.skills.filter(skill => !skill.external && skill.issues.length);
  const external = preview.skills.filter(skill => skill.external);
  function sourceLabel(group: ScannedSkill[]) {
    return [...new Set(locations(group).map(path => destinations.find(destination => path.startsWith(`${destination.path}/`))?.name ?? (path.includes("/.codex/skills/") ? "Codex" : "Local folder")))].join(" · ");
  }
  function choose(ids: string[], scope: string[]) {
    onSelected([...selected.filter(id => !scope.includes(id)), ...ids]);
  }
  function rename(group: ScannedSkill[], name: string) {
    const next = { ...editedNames };
    for (const skill of group) next[skill.id] = name;
    onEditedNames(next);
  }
  function chooseCopies(copyGroups: ScannedSkill[][], scope: string[]) {
    const nextNames = { ...editedNames };
    const used = new Set([...preview.skills.map(skill => skill.name), ...preview.skills.map(skill => skill.linkName), ...preview.conflicts.flatMap(conflict => conflict.managed.flatMap(skill => [skill.name, skill.linkName])), ...Object.values(editedNames)]);
    for (const group of copyGroups) {
      const first = group[0];
      if (!first) continue;
      if (selected.includes(first.id) && editedNames[first.id] !== undefined) continue;
      let suffix = 2;
      let name = `${first.name.slice(0, 120)}-${suffix}`;
      while ([...used].some(other => sameName(other, name))) name = `${first.name.slice(0, 120)}-${++suffix}`;
      used.add(name);
      for (const skill of group) nextNames[skill.id] = name;
    }
    onEditedNames(nextNames);
    choose(copyGroups.flatMap(group => group.map(skill => skill.id)), scope);
  }
  function fileChanges(group: ScannedSkill[]) {
    const first = group[0]!;
    const renamed = editedNames[first.id]?.trim();
    const name = renamed || first.name;
    const existing = preview.existing.find(skill => skill.contentHash === first.contentHash && skill.name === name && (!renamed || skill.linkName === renamed));
    const linkName = existing?.linkName ?? renamed ?? [...group].sort((a, b) => a.path.localeCompare(b.path))[0]!.linkName;
    const originals = locations(group);
    if (existing && !existing.enabled) return <AppAccordion className="setup-locations" title={<>File changes</>} triggerLabel={`File changes for ${first.name}`}><strong>Keep disabled stored copy</strong><code>{existing.canonicalPath}</code><strong>Remove duplicate entries</strong>{originals.map(file => <code key={file}>{file}</code>)}</AppAccordion>;
    const targetIds = [...new Set([...group.flatMap(skill => skill.destinations), ...targets, ...(existing?.destinations ?? [])])];
    const preferred = [...(existing?.sources.filter(source => source.replaced).map(source => source.path) ?? []), ...originals];
    const links = targetIds.map(id => destinations.find(destination => destination.id === id)).filter((destination): destination is Destination => !!destination?.writable).map(destination => preferred.find(file => file.startsWith(`${destination.path}/`)) ?? `${destination.path}/${linkName}`).filter(file => !originals.includes(file));
    return <AppAccordion className="setup-locations" title={<>File changes</>} triggerLabel={`File changes for ${first.name}`}><strong>{existing ? 'Use stored copy' : 'Copy to'}</strong><code>{existing?.canonicalPath ?? `${preview.storePath}/${linkName}`}</code><strong>Replace with links</strong>{originals.map(file => <code key={file}>{file}</code>)}{links.length > 0 && <><strong>Create links</strong>{links.map(file => <code key={file}>{file}</code>)}</>}</AppAccordion>;
  }
  return <>
    <div className="setup-sections"><Tabs size="compact" selectedIndex={selectedTab} onSelect={index => setSection(index === 0 ? 'new' : 'conflicts')} idPrefix={tabId} aria-label="Setup sections">
      <TabsItem index={0} label={`New skills (${newGroups.length})`} />
      <TabsItem index={1} label={`Name conflicts (${preview.conflicts.length})`} />
    </Tabs></div>
    <div className="setup-body">
      <TabsPanel index={0} selectedIndex={selectedTab} idPrefix={tabId}>
        {newGroups.length > 0 && <div className="import-selection"><span>{newGroups.filter(group => group.every(skill => selected.includes(skill.id))).length} selected</span><Button disabled={busy} onClick={() => choose(newGroups.flatMap(group => group.map(skill => skill.id)), newGroups.flatMap(group => group.map(skill => skill.id)))}>Select all</Button><Button disabled={busy} onClick={() => choose([], newGroups.flatMap(group => group.map(skill => skill.id)))}>Clear</Button></div>}
        {newGroups.map(group => {
          const first = group[0];
          if (!first) return null;
          const ids = group.map(skill => skill.id);
          const checked = ids.every(id => selected.includes(id));
          return <div className="setup-skill" key={first.contentHash}>
            <label className="setup-choice"><Checkbox disabled={busy} checked={checked} onCheckedChange={() => choose(checked ? [] : ids, ids)} /><strong>{first.name}</strong></label>
            <span className="setup-source">{sourceLabel(group)}</span>
            {fileChanges(group)}
          </div>;
        })}
        {!newGroups.length && <p className="setup-empty">No new skills.</p>}
      </TabsPanel>
      <TabsPanel index={1} selectedIndex={selectedTab} idPrefix={tabId}>
        {preview.conflicts.map((conflict, index) => {
          const versions = groups(healthy.filter(skill => conflict.skillIds.includes(skill.id)));
          const chosen = versions.filter(group => group.some(skill => selected.includes(skill.id)));
          const managed = conflict.managed.length > 0;
          const multiple = !managed && (chosen.length > 1 || chosen.some(group => group.some(skill => editedNames[skill.id] !== undefined)));
          return <section className="setup-conflict" key={`${conflict.name}-${index}`}>
            <h3>{conflict.name}</h3>
            {managed && <div className="setup-current"><strong>In collection</strong><Locations paths={conflict.managed.map(skill => skill.path)} /></div>}
            <RadioGroup size="compact" className="w-full" aria-label={conflict.name} inert={busy} selectedIndex={!chosen.length ? 0 : managed || multiple ? 1 : 2 + versions.findIndex(group => group.some(skill => selected.includes(skill.id)))}>
            <RadioItem index={0} label={managed ? "Keep current" : "Skip"} onSelect={() => choose([], conflict.skillIds)} />
            {managed && <RadioItem index={1} label="Keep both" aria-disabled={!versions.length} onSelect={() => { if (versions.length) chooseCopies(versions.slice(0, 1), conflict.skillIds); }} />}
            {!managed && versions.length > 1 && <RadioItem index={1} label="Keep multiple copies" onSelect={() => chooseCopies(versions, conflict.skillIds)} />}
            {versions.map((group, version) => {
              const first = group[0];
              if (!first) return null;
              const checked = group.some(skill => selected.includes(skill.id));
              const name = editedNames[first.id] ?? first.name;
              const otherNames = healthy.filter(skill => selected.includes(skill.id) && skill.contentHash !== first.contentHash).flatMap(skill => [editedNames[skill.id]?.trim() ?? skill.name, editedNames[skill.id]?.trim() ?? skill.linkName]);
              const invalid = !validName(name.trim()) || otherNames.some(other => sameName(other, name.trim())) || preview.conflicts.some(item => item.managed.some(skill => sameName(skill.name, name.trim()) || sameName(skill.linkName, name.trim())));
              const errorId = `setup-name-${index}-${version}`;
              const chooseVersion = () => {
                  const ids = group.map(skill => skill.id);
                  if (managed) {
                    if (checked) choose([], ids);
                    else chooseCopies([...chosen, group], conflict.skillIds);
                  } else if (multiple) choose(checked ? [] : ids, ids);
                  else {
                    const next = { ...editedNames };
                    for (const skill of group) delete next[skill.id];
                    onEditedNames(next);
                    choose(ids, conflict.skillIds);
                  }
              };
              return <div className="setup-version" key={first.contentHash}>
                {managed || multiple
                  ? <label className="setup-choice"><Checkbox disabled={busy} checked={checked} onCheckedChange={chooseVersion} />Copy {version + 1}</label>
                  : <RadioItem index={version + 2} label={`Add this copy (${version + 1})`} onSelect={chooseVersion} />}
                <span className="setup-source">{sourceLabel(group)}</span>
                {fileChanges(group)}
                {checked && (managed || multiple) && <label className="setup-name">Name<Input aria-label={`Name for ${first.name}, copy ${version + 1}`} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} disabled={busy} value={name} onChange={event => rename(group, event.target.value)} />{invalid && <span id={errorId} className="setup-name-error">Choose a unique name using letters, numbers, spaces, dots, underscores, or hyphens.</span>}</label>}
              </div>;
            })}
            </RadioGroup>
          </section>;
        })}
        {!preview.conflicts.length && <p className="setup-empty">No name conflicts.</p>}
      </TabsPanel>
      {preview.issues.length > 0 && <AppAccordion className="review-notices" title={<>Unavailable paths ({preview.issues.length})</>}><ul>{preview.issues.map((issue, index) => <li key={index}><strong>{issue.message}</strong><code>{issue.path}</code>{preview.brokenLinks.some(link => link.path === issue.path) && <small>{preview.brokenLinks.find(link => link.path === issue.path)?.kind === "restore" ? "Restore link" : "Remove link"}</small>}</li>)}</ul></AppAccordion>}
      {unavailable.length > 0 && <AppAccordion className="review-notices" title={<>Unavailable skills ({unavailable.length})</>}><ul>{unavailable.map(skill => <li key={skill.id}><strong>{skill.name}</strong><Locations paths={locations([skill])} />{skill.issues.map((issue, index) => <small key={index}>{issue.message}</small>)}</li>)}</ul></AppAccordion>}
      {external.length > 0 && <AppAccordion className="review-notices" title={<>External skills ({external.length})</>}><ul>{external.map(skill => <li key={skill.id}><strong>{skill.name}</strong><Locations paths={locations([skill])} />{skill.issues.map((issue, index) => <small key={index}>{issue.message}</small>)}</li>)}</ul></AppAccordion>}
      <AppAccordion className="setup-destinations" title={<>Add destinations</>}><div className="target-options">{destinations.filter(destination => destination.writable).map(destination => <label key={destination.id}><Checkbox disabled={busy} checked={targets.includes(destination.id)} onCheckedChange={() => onTargets(targets.includes(destination.id) ? targets.filter(id => id !== destination.id) : [...targets, destination.id])} />{destination.name}</label>)}</div></AppAccordion>
    </div>
  </>;
}
