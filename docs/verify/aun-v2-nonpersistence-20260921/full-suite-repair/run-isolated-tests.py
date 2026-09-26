import os,sys,subprocess,json,datetime,hashlib,shutil,signal,re,uuid
from urllib.parse import urlsplit,urlunsplit
from pathlib import Path
out=Path('docs/verify/aun-v2-nonpersistence-20260921/full-suite-repair');out.mkdir(exist_ok=True)
name=sys.argv[1];command=[shutil.which('bun'),'--no-env-file','test',*sys.argv[2:]]
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR'] if k in os.environ}
env.update({'LANG':'C','AUN_TEST_WASUREZU_ROOT':'/private/tmp/kusabi-e49-candidate-20260921/.staging/wasurezu-e49abc248382-w5uIce'})
fixture=Path('/tmp/aun-trial-ready-pg-env.json')
if fixture.exists():env.update(json.loads(fixture.read_text()))
bounded=Path('/tmp/aun-full-suite-bounded-env.json')
if bounded.exists():env.update(json.loads(bounded.read_text()))
# Each invocation owns a fresh database; independent test cleanup cannot erase another run.
base=urlsplit(env['DATABASE_URL']);maintenance=urlunsplit(base._replace(path='/postgres'))
database_name='fullrepair_'+re.sub('[^a-z0-9]','_',name.lower())[:25]+'_'+uuid.uuid4().hex[:8]+'_test'
subprocess.run(['createdb','--maintenance-db='+maintenance,database_name],env=env,check=True,capture_output=True)
private_url=urlunsplit(base._replace(path='/'+database_name))
env['DATABASE_URL']=private_url;env['AGENT_COM_TEST_DATABASE_URL']=private_url
with (out/(name+'.migration.log')).open('wb') as stream:
 migrated=subprocess.run([shutil.which('bun'),'--no-env-file','db/migrate.ts'],env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=120)
if migrated.returncode:raise RuntimeError('owned test database migration failed')
source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
diff=subprocess.check_output(['git','diff','--binary'])
sources={}
for relative in subprocess.check_output(['git','ls-files','-z'],text=True).split('\0'):
 p=Path(relative)
 if relative and p.is_file() and (relative.startswith(('core/','bin/','entrypoints/','db/','tests/','cli/','adapters/','hooks/','schemas/','scripts/')) or relative in ('server.ts','package.json','bun.lock','bun.lockb')):
  sources[relative]=hashlib.sha256(p.read_bytes()).hexdigest()
for relative in subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z'],text=True).split('\0'):
 p=Path(relative)
 if relative and p.is_file() and relative.startswith(('core/','bin/','entrypoints/','db/','tests/','cli/','hooks/','scripts/')):
  sources[relative]=hashlib.sha256(p.read_bytes()).hexdigest()
node=subprocess.run(['node','--version'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
(out/(name+'.sources.json')).write_text(json.dumps(sources,sort_keys=True,indent=2))
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/(name+'.log')).open('wb') as stream:
 child=subprocess.Popen(command,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
 try:code=child.wait(timeout=1800)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
  code=124;stream.write(b'\nCOMMAND_TIMEOUT_1800S\n')
subprocess.run(['dropdb','--maintenance-db='+maintenance,'--if-exists','--force',database_name],env=env,check=True,capture_output=True)
end_sources={relative:hashlib.sha256(Path(relative).read_bytes()).hexdigest() for relative in sources if Path(relative).is_file()}
unchanged=end_sources==sources
(out/(name+'.end-sources.json')).write_text(json.dumps(end_sources,sort_keys=True,indent=2))
raw=(out/(name+'.log')).read_bytes()
(out/(name+'.log')).write_bytes(raw)
(out/(name+'.json')).write_text(json.dumps({'source_unchanged':unchanged,'command':command,'private_database_name':database_name,'node_version':node.stdout.strip(),'node_exit_code':node.returncode,'source_manifest_sha256':hashlib.sha256((out/(name+'.sources.json')).read_bytes()).hexdigest(),'source_head':source,'working_diff_sha256':hashlib.sha256(diff).hexdigest(),'started_at':start,'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':code,'log_sha256':hashlib.sha256(raw).hexdigest()},indent=2))
print(raw.decode(errors='replace')[-1800:]);sys.exit(code)
