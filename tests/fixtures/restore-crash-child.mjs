import fs from 'node:fs/promises';
import path from 'node:path';
import { createSkillsService } from '../../src/main/service.ts';
import { resolvePaths } from '../../src/main/paths.ts';
async function main() {
 const config=JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
 const paths=resolvePaths(config.home); const service=createSkillsService(paths);
 const creating = config.phase === 'setup-mkdir' || config.phase === 'import-mkdir';
 const editing = config.phase === 'destinations-rewrite';
 const setting = config.phase === 'setup-commit';
 const preview = editing ? null : config.phase === 'setup-mkdir' || setting ? await service.setupPreview() : config.phase === 'import-mkdir' ? await service.previewImport(config.source, { path: config.source }) : await service.restorePreview();
 const original = creating || editing || setting ? null : preview.skills[0].locations[0];
 const originalMkdir=fs.mkdir.bind(fs), originalSymlink=fs.symlink.bind(fs), originalRename=fs.rename.bind(fs), originalRm=fs.rm.bind(fs), originalCp=fs.cp.bind(fs);
 const stop=()=>{ process.stdout.write(JSON.stringify({ phase:config.phase, event:'SIGKILL after the selected filesystem operation' })+'\n'); process.kill(process.pid,'SIGKILL'); };
 fs.mkdir=async (...args) => {
  const value=await originalMkdir(...args); const file=String(args[0]);
  if(creating && file===path.join(paths.skills,config.name)) stop();
  if(config.phase==='stage-mkdir' && file.endsWith('.tmp')) stop();
  if(config.phase==='nested-directory' && file===original+'/group') stop();
  if(config.phase==='target-mkdir' && file===original) stop();
  return value;
 };
 fs.cp=async (...args)=>{if(config.phase==='stage-permissions' && String(args[1]).endsWith('.tmp')) { await originalCp(String(args[0])+'/group',String(args[1])+'/group',args[2]);stop(); }if(config.phase==='stage-copy' && String(args[1]).endsWith('.tmp')) { await originalCp(String(args[0])+'/a-link',String(args[1])+'/a-link',args[2]);stop(); } return originalCp(...args); };
 fs.symlink=async (...args)=>{ const value=await originalSymlink(...args); if(editing && String(args[1])===config.rewritePath) stop(); if(config.phase==='target-link' && String(args[1])===original+'/a-link') stop(); return value; };
 fs.rename=async (...args)=>{ const value=await originalRename(...args); if(setting && args[1]===paths.catalog) stop(); if(config.phase==='backup-rename' && args[0]===original && String(args[1]).endsWith('.link')) stop(); if(config.phase==='catalog-commit' && args[1]===paths.catalog && (await fs.readFile(paths.catalog,'utf8')).trim()==='[]') stop(); return value; };
 fs.rm=async (...args)=>{ const folder=String(args[0]);if(config.phase==='canonical-cleanup' && folder.startsWith(paths.skills+'/')) { await fs.unlink(folder+'/SKILL.md');stop(); } return originalRm(...args); };
 if (creating || setting) {
  const request = { previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents'] };
  if (config.phase === 'setup-mkdir' || setting) await service.setupApply(request);
  else await service.applyImport(request);
 } else if (editing) await service.setDestinations(config.skillId, ['claude', 'pi']);
 else await service.restoreApply(preview.previewId);console.error('The requested stop was not reached.');process.exit(1);
}
main().catch(e=>{console.error(e);process.exitCode=1});
