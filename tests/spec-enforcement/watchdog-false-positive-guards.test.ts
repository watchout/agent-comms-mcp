import {test,expect} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const script=join(import.meta.dir,'../../scripts/watchdog.sh')
test('legacy watchdog delegates one canonical read-only observation and propagates UNKNOWN/failure without restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'watchdog-once-'))
  try {
    const bin=join(dir,'fixture-bun'),log=join(dir,'argv.json')
    writeFileSync(bin,'#!/usr/bin/env python3\nimport sys,json,os\nopen(os.environ["ARGV_LOG"],"w").write(json.dumps(sys.argv[1:]))\nsys.exit(int(os.environ["FIXTURE_EXIT"]))\n')
    chmodSync(bin,0o755)
    for(const code of [0,2,17]) {
      const result=spawnSync('bash',[script],{env:{PATH:process.env.PATH,AUN_WATCHDOG_BUN_BIN:bin,ARGV_LOG:log,FIXTURE_EXIT:String(code),DATABASE_URL:'fixture-only'},encoding:'utf8'})
      expect(result.status).toBe(code)
      const args=JSON.parse(readFileSync(log,'utf8'))
      expect(args).toHaveLength(2)
      expect(args[0]).toEndWith('/bin/aun-watchdog.ts')
      expect(args[1]).toBe('--once')
    }
  } finally {rmSync(dir,{recursive:true,force:true})}
})
