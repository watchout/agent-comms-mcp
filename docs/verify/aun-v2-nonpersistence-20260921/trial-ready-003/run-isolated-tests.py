import os,sys,subprocess,json,datetime,hashlib,shutil
from pathlib import Path
out=Path('docs/verify/aun-v2-nonpersistence-20260921/trial-ready-003');out.mkdir(exist_ok=True)
name=sys.argv[1];command=[shutil.which('bun'),'--no-env-file','test',*sys.argv[2:]]
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR'] if k in os.environ}
env.update({'LANG':'C','AUN_TEST_WASUREZU_ROOT':'/private/tmp/kusabi-e49-candidate-20260921/.staging/wasurezu-e49abc248382-w5uIce'})
fixture=Path('/tmp/aun-trial-ready-pg-env.json')
if fixture.exists():env.update(json.loads(fixture.read_text()))
if any(a.endswith(('test_runtime_observation_nonpersistence_db.test.ts','test_runtime_nonpersist_profile.test.ts')) for a in sys.argv[2:]):env['AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED']='1'
source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
diff=subprocess.check_output(['git','diff','--binary'])
sources={}
for relative in subprocess.check_output(['git','ls-files','-z'],text=True).split('\0'):
 p=Path(relative)
 if relative and p.is_file() and (relative.startswith(('core/','bin/','entrypoints/','db/','tests/','cli/','adapters/','hooks/','schemas/')) or relative in ('server.ts','package.json','bun.lock','bun.lockb')):
  sources[relative]=hashlib.sha256(p.read_bytes()).hexdigest()
for relative in subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z'],text=True).split('\0'):
 p=Path(relative)
 if relative and p.is_file() and relative.startswith(('core/','bin/','entrypoints/','db/','tests/','cli/')):
  sources[relative]=hashlib.sha256(p.read_bytes()).hexdigest()
node=subprocess.run(['node','--version'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
(out/(name+'.sources.json')).write_text(json.dumps(sources,sort_keys=True,indent=2))
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
try:
 r=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=540)
 code=r.returncode;raw=r.stdout
except subprocess.TimeoutExpired as e:
 code=124;raw=(e.stdout or b'')+b'\nCOMMAND_TIMEOUT_540S\n'
(out/(name+'.log')).write_bytes(raw)
(out/(name+'.json')).write_text(json.dumps({'command':command,'node_version':node.stdout.strip(),'node_exit_code':node.returncode,'source_manifest_sha256':hashlib.sha256((out/(name+'.sources.json')).read_bytes()).hexdigest(),'source_head':source,'working_diff_sha256':hashlib.sha256(diff).hexdigest(),'started_at':start,'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':code,'log_sha256':hashlib.sha256(raw).hexdigest()},indent=2))
print(raw.decode(errors='replace')[-14000:]);sys.exit(code)
