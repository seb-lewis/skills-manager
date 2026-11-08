import { AppAccordion } from "./AppControls";
import { Button } from "./AppControls";
import type { Destination } from '../shared/types';

export function ErrorNotice({ message, locations, busy, onRetry }: {
  message: string; locations: Destination[]; busy: boolean; onRetry?: () => void;
}) {
  const readable = message.replace(/^(?:Error:\s*)?Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '');
  const importFailure = /Import failed with code|Cannot start Git|fatal:|Cloning into/i.test(readable);
  const technical = importFailure || /\bE[A-Z]{2,}\b|(?:^|[\s'"(])\/|[A-Za-z]:[\\/]|\n/.test(readable) || readable.length > 200;
  const location = locations.find(item => readable.includes(item.path));
  const summary = !technical ? readable
    : importFailure ? 'Could not import these skills.'
    : /\bENOSPC\b/.test(message) ? 'There is not enough free space.'
    : /\bE(?:NOENT|NOTDIR)\b/.test(message) ? 'A file or folder is missing.'
    : /occupied|already exists|\bEEXIST\b/i.test(message) ? location ? `A location in ${location.name} is already in use.` : 'A location is already in use.'
    : /Skill files changed/i.test(message) ? 'Skill files changed.'
    : /supporting link|uses this stored copy/i.test(message) ? 'Another skill uses these files.'
    : location ? `Could not update ${location.name}.` : 'Could not change these files.';
  return <div role="alert" className="error">
    <div className="error-line"><span>{summary}</span>{onRetry && <Button type="button" disabled={busy} onClick={onRetry}>Retry</Button>}</div>
    {technical && <AppAccordion title={<>Details</>}><pre>{message}</pre></AppAccordion>}
  </div>;
}
