import { Button, AppAccordion } from "./AppControls";
import { useState } from 'react';
import type { RestorePreview, SkillSummary } from '../shared/types';

export function RestoreReview({ preview, complete, busy, skills, onKeep, onRemoveMissing, onRestore, onReview, onReveal }: {
  preview: RestorePreview | null; complete: string; busy: boolean;
  skills: SkillSummary[]; onKeep: (id: string) => void; onRemoveMissing: (ids: string[]) => void;
  onRestore: () => void; onReview: () => void; onReveal: () => void;
}) {
  const [confirmMissing, setConfirmMissing] = useState(false);
  const missing = skills.filter(skill => skill.contentState === 'missing');
  if (complete) return <div className="restore-review">
    <p role="status">Your skills are now independent of Skills Manager.</p>
    <code className="source-path">{complete}</code>
    <p>You can remove the app and its .skills-manager folder.</p>
    <Button onClick={onReveal}>Show saved skills</Button>
  </div>;
  if (!preview) return <p role="status">Checking skill locations…</p>;
  if (!preview.skills.length && !preview.issues.length) return <p>No managed skills remain.</p>;
  const preserved = preview.skills.flatMap(skill => skill.preservedLocations);
  const restoresDisabled = preview.skills.some(item => skills.some(skill => skill.id === item.id && !skill.enabled && item.locations.some(file => skill.sources.some(source => source.replaced && source.path === file))));
  return <div className="restore-review">
    {preview.skills.some(skill => skill.locations.length) && <p>Restore recorded setup locations and replace current links with skill folders.{restoresDisabled && ' Disabled skills with recorded setup locations become available there again.'}</p>}
    <AppAccordion className="restore-locations" title={<>Skills and locations ({preview.skills.length})</>}>
      {preview.skills.map(skill => <div key={skill.id}><strong>{skill.name}</strong>{skill.locations.length ? skill.locations.map(file => <code key={file}>{file}</code>) : <span>Saved copy only</span>}</div>)}
    </AppAccordion>
    {preserved.length > 0 && <AppAccordion className="restore-locations" title={<>Keep existing entries ({preserved.length})</>}>{preserved.map(file => <code key={file}>{file}</code>)}</AppAccordion>}
    {preview.skills.some(skill => skill.exportOnlyLocations.length) && <AppAccordion className="restore-locations" title={<>Save to export only</>}>{preview.skills.filter(skill => skill.exportOnlyLocations.length).map(skill => <div key={skill.id}><strong>{skill.name}</strong>{skill.exportOnlyLocations.map(file => <code key={file}>{file}</code>)}</div>)}</AppAccordion>}
    <h3>Save all skills to</h3><code className="source-path">{preview.backupPath}</code>
    {!!preview.issues.length && <div className="restore-issues">
      <p role="alert">Resolve these items before restoring.</p>
      {missing.length > 0 && (confirmMissing ? <div className="missing-confirmation">
        <p>Remove {missing.length} saved records and their related links?</p>
        <Button disabled={busy} onClick={() => setConfirmMissing(false)}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => { setConfirmMissing(false); onRemoveMissing(missing.map(skill => skill.id)); }}>Remove records</Button>
      </div> : <Button disabled={busy} onClick={() => setConfirmMissing(true)}>Remove missing records ({missing.length})</Button>)}
      <ul>{preview.issues.map((issue, index) => {
        const skill = skills.find(item => item.canonicalPath === issue.path);
        return <li key={index}><strong>{skill?.name ?? 'Restore blocked'}</strong>
          {skill && <span>{skill.contentState === 'changed' ? 'Files changed' : skill.contentState === 'missing' ? 'Files missing' : 'Files need review'}</span>}
          <AppAccordion title={<>Details</>}><code>{issue.message}</code><code>{issue.path}</code></AppAccordion>
          {skill?.contentState === 'changed' && <Button disabled={busy} onClick={() => onKeep(skill.id)}>Keep current files</Button>}
        </li>;
      })}</ul>
    </div>}
    <div className="modal-actions"><Button disabled={busy} onClick={onReview}>Check again</Button><Button variant="secondary" disabled={busy || !preview.skills.length || !!preview.issues.length} onClick={onRestore}>{busy ? 'Restoring…' : 'Restore skills'}</Button></div>
  </div>;
}
